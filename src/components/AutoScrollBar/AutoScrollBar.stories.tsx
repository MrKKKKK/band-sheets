import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AutoScrollBar, type AutoScrollBarProps } from './AutoScrollBar';

type DemoProps = Pick<
  AutoScrollBarProps,
  'tempo' | 'ended' | 'onPlay' | 'onPause' | 'onRestart'
> & {
  initialPlaying?: boolean;
  initialSpeed?: number;
  onSpeedChange: (pct: number) => void;
  onCountInChange: (on: boolean) => void;
};

function Demo({
  initialPlaying = false,
  initialSpeed = 100,
  onSpeedChange,
  onCountInChange,
  onPlay,
  onPause,
  ...rest
}: DemoProps) {
  const [playing, setPlaying] = useState(initialPlaying);
  const [speed, setSpeed] = useState(initialSpeed);
  const [countIn, setCountIn] = useState(true);
  return (
    <AutoScrollBar
      {...rest}
      playing={playing}
      speedPct={speed}
      countIn={countIn}
      onPlay={() => {
        onPlay();
        setPlaying(true);
      }}
      onPause={() => {
        onPause();
        setPlaying(false);
      }}
      onSpeedChange={(pct) => {
        onSpeedChange(pct);
        setSpeed(pct);
      }}
      onCountInChange={(on) => {
        onCountInChange(on);
        setCountIn(on);
      }}
    />
  );
}

const meta = {
  title: 'Viewer/AutoScrollBar',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: {
    tempo: 100,
    onPlay: fn(),
    onPause: fn(),
    onRestart: fn(),
    onSpeedChange: fn(),
    onCountInChange: fn(),
  },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Stopped: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('auto-scroll-tempo')).toHaveTextContent(
      '♩=100',
    );
    await expect(canvas.getByText('(1小節)')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '再生' }));
    await expect(args.onPlay).toHaveBeenCalledOnce();
    // Now playing: the button turns into pause and the panel is translucent.
    await userEvent.click(canvas.getByRole('button', { name: '一時停止' }));
    await expect(args.onPause).toHaveBeenCalledOnce();
  },
};

export const Playing: Story = {
  args: { initialPlaying: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: '一時停止' }),
    ).toBeVisible();
    await expect(canvas.getByTestId('auto-scroll-bar')).toHaveAttribute(
      'data-playing',
      'true',
    );
  },
};

export const Speed: Story = {
  args: { tempo: 120 },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const down = canvas.getByRole('button', { name: '速度を下げる' });
    const up = canvas.getByRole('button', { name: '速度を上げる' });
    await userEvent.click(up);
    await expect(args.onSpeedChange).toHaveBeenLastCalledWith(105);
    await expect(canvas.getByTestId('auto-scroll-speed')).toHaveTextContent(
      '105%',
    );
    // 120 * 1.05 = 126
    await expect(canvas.getByTestId('auto-scroll-tempo')).toHaveTextContent(
      '♩=126',
    );
    await userEvent.click(down);
    await userEvent.click(down);
    await expect(args.onSpeedChange).toHaveBeenLastCalledWith(95);
  },
};

export const SpeedLimits: Story = {
  args: { initialSpeed: 50 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: '速度を下げる' }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole('button', { name: '速度を上げる' }),
    ).toBeEnabled();
  },
};

export const SpeedMax: Story = {
  args: { initialSpeed: 150 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: '速度を上げる' }),
    ).toBeDisabled();
  },
};

export const CountInSwitch: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const sw = canvas.getByRole('switch', { name: /カウントイン/ });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sw);
    await expect(args.onCountInChange).toHaveBeenCalledWith(false);
    await expect(sw).toHaveAttribute('aria-checked', 'false');
  },
};

export const Ended: Story = {
  args: { ended: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '最初から' }));
    await expect(args.onRestart).toHaveBeenCalledOnce();
  },
};

export const TouchTargets: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const el of [
      canvas.getByRole('button', { name: '再生' }),
      canvas.getByRole('button', { name: '速度を下げる' }),
      canvas.getByRole('button', { name: '速度を上げる' }),
      canvas.getByRole('switch', { name: /カウントイン/ }),
    ]) {
      const r = el.getBoundingClientRect();
      await expect(r.width).toBeGreaterThanOrEqual(44);
      await expect(r.height).toBeGreaterThanOrEqual(44);
    }
  },
};
