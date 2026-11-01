import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { fakeAudio } from '../../hooks/testing/fakeAudio';
import { makeTake } from '../MicRecorder/micStoryFixtures';
import { TakeCard, type TakePlaybackDeps } from './TakeCard';

const take = makeTake();

/** A fake <audio> so ▶ works without a sound device. */
const fakeDeps: TakePlaybackDeps = {
  audio: {
    createElement: () => {
      const audio = fakeAudio({ duration: 24 });
      setTimeout(() => audio.loadMetadata(), 0);
      return audio as unknown as HTMLAudioElement;
    },
    createUrl: () => 'blob:fake',
    revokeUrl: () => {},
  },
  createTone: () => ({
    start: () => 0,
    stop: () => {},
    now: () => 0,
    playOne: () => {},
    close: () => {},
  }),
};

const meta = {
  title: 'Mic/TakeCard',
  component: TakeCard,
  parameters: { a11y: { test: 'error' }, layout: 'padded' },
  decorators: [
    (Story) => (
      <section style={{ width: 880, maxWidth: '100%' }}>
        <h2 style={{ margin: 0, fontSize: '1.125rem' }}>1. 歌の音を受け取る</h2>
        <Story />
      </section>
    ),
  ],
  args: {
    take,
    end: 'user',
    onRetake: fn(),
    saveName: () => '鼻歌_聖者の行進_Aメロ_20261031-1200.wav',
    save: fn(),
    playbackDeps: fakeDeps,
    headingRef: { current: null },
  },
} satisfies Meta<typeof TakeCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('録れました')).toBeVisible();
    expect(c.getByTestId('take-info')).toHaveTextContent(
      '長さ 0:24（約 9 小節）',
    );
    expect(c.queryByTestId('take-end-notice')).toBeNull();
    await userEvent.click(c.getByRole('button', { name: '録音を保存（wav）' }));
    expect(args.save).toHaveBeenCalledWith(
      take.file,
      '鼻歌_聖者の行進_Aメロ_20261031-1200.wav',
    );
    await userEvent.click(c.getByRole('button', { name: '録り直す' }));
    expect(args.onRetake).toHaveBeenCalled();
  },
};

export const EndedByLimit: Story = {
  args: { end: 'limit' },
  play: ({ canvasElement }) => {
    expect(within(canvasElement).getByTestId('take-end-notice')).toBeVisible();
  },
};

export const Playing: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: '▶ 聞く' }));
    await waitFor(() =>
      expect(c.getByRole('button', { name: '⏸ 止める' })).toBeVisible(),
    );
  },
};
