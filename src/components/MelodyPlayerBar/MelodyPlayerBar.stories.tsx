import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { MelodyPlayerBar, type MelodyPlayerBarProps } from './MelodyPlayerBar';

/** Holds `playing` so 再生 / 停止 can be exercised. */
function Demo(props: MelodyPlayerBarProps) {
  const [playing, setPlaying] = useState(props.playing);
  return (
    <MelodyPlayerBar
      {...props}
      playing={playing}
      onPlay={() => {
        props.onPlay();
        setPlaying(true);
      }}
      onStop={() => {
        props.onStop();
        setPlaying(false);
      }}
    />
  );
}

const meta = {
  title: 'Melody/MelodyPlayerBar',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: {
    playing: false,
    disabled: false,
    hint: 'カーソルの位置（3 小節目の 1 拍目）から鳴らします',
    position: { label: '3 小節目の 2 拍目', bar: 3, bars: 4 },
    tempo: 100,
    tempoSet: true,
    onPlay: fn(),
    onPlayFromHead: fn(),
    onStop: fn(),
  },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Stopped: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByText(args.hint)).toBeVisible();
    await expect(c.getByText('（曲の設定）')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: '再生' }));
    await expect(args.onPlay).toHaveBeenCalled();
    // now playing: the same button stops, 最初から waits
    await expect(c.getByText('3 小節目の 2 拍目')).toBeVisible();
    await expect(
      c.getByRole('button', { name: 'セクションの最初から再生' }),
    ).toBeDisabled();
    await userEvent.click(c.getByRole('button', { name: '停止' }));
    await expect(args.onStop).toHaveBeenCalled();
  },
};

export const Playing: Story = {
  args: { playing: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('3 / 4 小節')).toBeVisible();
    await expect(c.getByRole('group', { name: '再生' })).toHaveAttribute(
      'data-state',
      'playing',
    );
  },
};

export const NoTempo: Story = {
  args: { tempoSet: false, hint: 'セクションの最初から鳴らします' },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('（未設定）')).toBeVisible();
    await expect(c.getByText(/♩＝100/)).toBeVisible();
  },
};

export const ReadOnlyDisabled: Story = {
  args: {
    disabled: true,
    describedBy: 'notice',
    hint: '読み取り専用のセクションは再生できません',
  },
  render: (args) => (
    <>
      <p id="notice">このセクションはアプリでは編集できません。</p>
      <Demo {...args} />
    </>
  ),
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const play = c.getByRole('button', { name: '再生' });
    await expect(play).toBeDisabled();
    await expect(play).toHaveAccessibleDescription(
      'このセクションはアプリでは編集できません。',
    );
    await expect(
      c.getByRole('button', { name: 'セクションの最初から再生' }),
    ).toBeDisabled();
    await expect(args.onPlay).not.toHaveBeenCalled();
  },
};

export const Narrow: Story = {
  render: (args) => (
    <div style={{ width: 420 }}>
      <Demo {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole('group', { name: '再生' });
    // wraps instead of overflowing
    await expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth + 1);
  },
};
