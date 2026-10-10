import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, waitFor } from 'storybook/test';
import { sampleSong } from '../../lib/fixtures/sampleSong';
import type { Song } from '../../lib/song';
import { PartScore } from './PartScore';

const meta = {
  title: 'PartScore',
  component: PartScore,
  args: { song: sampleSong },
} satisfies Meta<typeof PartScore>;

export default meta;
type Story = StoryObj<typeof meta>;

const waitForRender = async (root: HTMLElement) => {
  const host = root.querySelector('[data-state]') as HTMLElement;
  await waitFor(() => expect(host.dataset.state).toBe('rendered'), {
    timeout: 15000,
  });
  return host;
};

export const AllParts: Story = {
  play: async ({ canvasElement }) => {
    const host = await waitForRender(canvasElement);
    expect(host.querySelectorAll('svg').length).toBeGreaterThan(0);
  },
};

export const DrumsOnly: Story = {
  args: { partNames: ['Drums'] },
  play: async ({ canvasElement }) => {
    await waitForRender(canvasElement);
  },
};

const titledSong = (title: string): Song => ({
  ...sampleSong,
  meta: { ...sampleSong.meta, title },
});

const RAPID_TITLES = ['Song A', 'Song B', 'Song C', 'Final Title'];

/**
 * Stateful harness: changes the rendered song's title several times in
 * quick succession (faster than `debounceMs`), then settles. Used to prove
 * that (a) the final render reflects only the last value — the debounce
 * coalesces the in-between ones — and (b) the AlphaTabApi instance is
 * created once, not recreated on every change (T15).
 */
function RapidChangeHarness() {
  const [title, setTitle] = useState(RAPID_TITLES[0]);

  useEffect(() => {
    const timers = RAPID_TITLES.map((t, i) =>
      setTimeout(() => setTitle(t), i * 15),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <PartScore song={titledSong(title)} partNames={['Vocal']} debounceMs={80} />
  );
}

export const DebouncedRapidChanges: Story = {
  render: () => <RapidChangeHarness />,
  play: async ({ canvasElement }) => {
    const host = await waitForRender(canvasElement);
    // Only the last of the rapid changes should have reached alphaTab.
    expect(host.textContent).toContain('Final Title');
    // The api was created exactly once despite the title changing 4 times.
    expect(host.dataset.apiCreates).toBe('1');
  },
};

/**
 * Mounts PartScore inside a `display: none` container (reproducing `App`'s
 * `Tabs`, which keeps every panel mounted-but-hidden — M4 review M2) and
 * reveals it 300ms later without any further song/tex change. alphaTab
 * skips rendering entirely while width is 0; this proves PartScore notices
 * the container regaining width and nudges a render on its own instead of
 * staying stuck on `data-state="loading"` with 0 rendered svgs.
 */
function HiddenThenVisibleHarness() {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setHidden(false), 300);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div style={{ display: hidden ? 'none' : 'block' }}>
      <PartScore song={sampleSong} partNames={['Vocal']} />
    </div>
  );
}

export const RecoversAfterHiddenMount: Story = {
  render: () => <HiddenThenVisibleHarness />,
  play: async ({ canvasElement }) => {
    const host = await waitForRender(canvasElement);
    expect(host.querySelectorAll('svg').length).toBeGreaterThan(0);
  },
};
