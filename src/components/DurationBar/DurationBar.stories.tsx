import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { Duration } from '../../lib/melody';
import { DurationBar } from './DurationBar';

function Demo({
  onDurationChange,
  onDottedChange,
  onRest,
}: {
  onDurationChange: (d: Duration) => void;
  onDottedChange: (dotted: boolean) => void;
  onRest: () => void;
}) {
  const [duration, setDuration] = useState<Duration>('4');
  const [dotted, setDotted] = useState(false);
  return (
    <div>
      {/*
       * Stand-in for the melody staff (T11's MelodyStaff isn't owned by
       * this task): a focusable div that should KEEP focus after clicking
       * any DurationBar control, proving the onMouseDown-preventDefault
       * guard works.
       */}
      <div tabIndex={0} data-testid="staff-standin" autoFocus>
        staff
      </div>
      <DurationBar
        duration={duration}
        dotted={dotted}
        onDurationChange={(d) => {
          onDurationChange(d);
          setDuration(d);
        }}
        onDottedChange={(b) => {
          onDottedChange(b);
          setDotted(b);
        }}
        onRest={onRest}
      />
    </div>
  );
}

const meta = {
  title: 'Melody/DurationBar',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: { onDurationChange: fn(), onDottedChange: fn(), onRest: fn() },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const staff = canvas.getByTestId('staff-standin');
    staff.focus();
    expect(document.activeElement).toBe(staff);

    const quarter = canvas.getByRole('button', { name: '4分音符' });
    await expect(quarter).toHaveAttribute('aria-pressed', 'true');

    const half = canvas.getByRole('button', { name: '2分音符' });
    await userEvent.click(half);
    await expect(args.onDurationChange).toHaveBeenCalledOnce();
    await expect(args.onDurationChange).toHaveBeenCalledWith('2');
    await expect(half).toHaveAttribute('aria-pressed', 'true');
    await expect(quarter).toHaveAttribute('aria-pressed', 'false');
    expect(document.activeElement).toBe(staff);

    const whole = canvas.getByRole('button', { name: '全音符' });
    await userEvent.click(whole);
    await expect(args.onDurationChange).toHaveBeenCalledTimes(2);
    await expect(args.onDurationChange).toHaveBeenLastCalledWith('1');
    expect(document.activeElement).toBe(staff);

    const eighth = canvas.getByRole('button', { name: '8分音符' });
    await userEvent.click(eighth);
    await expect(args.onDurationChange).toHaveBeenCalledTimes(3);
    await expect(args.onDurationChange).toHaveBeenLastCalledWith('8');

    const sixteenth = canvas.getByRole('button', { name: '16分音符' });
    await userEvent.click(sixteenth);
    await expect(args.onDurationChange).toHaveBeenCalledTimes(4);
    await expect(args.onDurationChange).toHaveBeenLastCalledWith('16');

    // Back to quarter, proving every one of the 5 buttons calls
    // onDurationChange exactly once per click.
    await userEvent.click(quarter);
    await expect(args.onDurationChange).toHaveBeenCalledTimes(5);
    await expect(args.onDurationChange).toHaveBeenLastCalledWith('4');
    expect(document.activeElement).toBe(staff);

    const dottedToggle = canvas.getByRole('button', { name: '付点' });
    await expect(dottedToggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(dottedToggle);
    await expect(args.onDottedChange).toHaveBeenCalledOnce();
    await expect(args.onDottedChange).toHaveBeenCalledWith(true);
    await expect(dottedToggle).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(dottedToggle);
    await expect(args.onDottedChange).toHaveBeenCalledTimes(2);
    await expect(args.onDottedChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(staff);

    const rest = canvas.getByRole('button', { name: '休符' });
    await userEvent.click(rest);
    await expect(args.onRest).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(staff);
  },
};
