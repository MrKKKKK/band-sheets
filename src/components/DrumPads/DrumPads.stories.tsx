import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, within } from 'storybook/test';
import { DrumPads } from './DrumPads';

const meta = {
  title: 'Drums/DrumPads',
  component: DrumPads,
  parameters: { a11y: { test: 'error' } },
  args: { onInput: fn(), onToggleOnPrevious: fn() },
  render: (args) => (
    <div>
      {/*
       * Stand-in for the drum staff (T18 isn't owned by this task): a
       * focusable div that should KEEP focus after clicking any pad,
       * proving the onMouseDown-preventDefault guard works (same pattern
       * as PianoKeyboard's story).
       */}
      <div tabIndex={0} data-testid="staff-standin" autoFocus>
        staff
      </div>
      <DrumPads {...args} />
    </div>
  ),
} satisfies Meta<typeof DrumPads>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const staff = canvas.getByTestId('staff-standin');
    staff.focus();
    expect(document.activeElement).toBe(staff);

    // Staff order (top of staff to bottom = DRUM_KIT order): key hints
    // F J H G K L ; U I are all present, each with its Japanese name.
    const snare = canvas.getByRole('button', { name: 'スネア（F）' });
    await userEvent.click(snare);
    await expect(args.onInput).toHaveBeenCalledOnce();
    await expect(args.onInput).toHaveBeenCalledWith('SD');
    await expect(args.onToggleOnPrevious).not.toHaveBeenCalled();
    // Clicking never steals focus from the staff.
    expect(document.activeElement).toBe(staff);

    expect(snare).toHaveTextContent('F');
    expect(
      canvas.getByRole('button', { name: 'バスドラム（J）' }),
    ).toHaveTextContent('J');
    expect(
      canvas.getByRole('button', { name: 'ハイハット（クローズ）（H）' }),
    ).toHaveTextContent('H');
    expect(
      canvas.getByRole('button', { name: 'ハイハット（オープン）（G）' }),
    ).toHaveTextContent('G');
    expect(
      canvas.getByRole('button', { name: 'ハイタム（K）' }),
    ).toHaveTextContent('K');
    expect(
      canvas.getByRole('button', { name: 'ミッドタム（L）' }),
    ).toHaveTextContent('L');
    expect(
      canvas.getByRole('button', { name: 'フロアタム（;）' }),
    ).toHaveTextContent(';');
    expect(
      canvas.getByRole('button', { name: 'クラッシュ（U）' }),
    ).toHaveTextContent('U');
    expect(
      canvas.getByRole('button', { name: 'ライド（I）' }),
    ).toHaveTextContent('I');
  },
};

/** Shift+click adds/removes the instrument on the previous beat instead. */
export const ShiftClick: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const bass = canvas.getByRole('button', { name: 'バスドラム（J）' });

    // fireEvent (not userEvent.click) so the dispatched click carries
    // shiftKey: true directly — userEvent's keyboard-held-during-click
    // pattern doesn't propagate the modifier onto the click event here.
    await fireEvent.click(bass, { shiftKey: true });

    await expect(args.onToggleOnPrevious).toHaveBeenCalledOnce();
    await expect(args.onToggleOnPrevious).toHaveBeenCalledWith('BD');
    await expect(args.onInput).not.toHaveBeenCalled();
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const snare = canvas.getByRole('button', { name: 'スネア（F）' });
    expect(snare).toBeDisabled();

    await userEvent.click(snare);
    await expect(args.onInput).not.toHaveBeenCalled();
    await expect(args.onToggleOnPrevious).not.toHaveBeenCalled();
  },
};
