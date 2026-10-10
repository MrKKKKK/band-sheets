import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PianoKeyboard } from './PianoKeyboard';

const meta = {
  title: 'Melody/PianoKeyboard',
  component: PianoKeyboard,
  parameters: { a11y: { test: 'error' } },
  args: { baseOctave: 4, onKey: fn() },
  render: (args) => (
    <div>
      {/*
       * Stand-in for the melody staff (T11's MelodyStaff isn't owned by
       * this task): a focusable div that should KEEP focus after clicking
       * any key, proving the onMouseDown-preventDefault guard works.
       */}
      <div tabIndex={0} data-testid="staff-standin" autoFocus>
        staff
      </div>
      <PianoKeyboard {...args} />
    </div>
  ),
} satisfies Meta<typeof PianoKeyboard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const staff = canvas.getByTestId('staff-standin');
    staff.focus();
    expect(document.activeElement).toBe(staff);

    const c4 = canvas.getByRole('button', { name: 'ド4' });
    await userEvent.click(c4);
    await expect(args.onKey).toHaveBeenCalledOnce();
    await expect(args.onKey).toHaveBeenCalledWith('C4');
    expect(document.activeElement).toBe(staff);

    // First-octave key hints (docs/m4-decisions.md): A S D F G H J K white,
    // W E T Y U black.
    expect(c4).toHaveTextContent('A');
    const cSharp4 = canvas.getByRole('button', { name: 'ド♯4' });
    expect(cSharp4).toHaveTextContent('W');

    const d4 = canvas.getByRole('button', { name: 'レ4' });
    await userEvent.click(d4);
    await expect(args.onKey).toHaveBeenCalledTimes(2);
    await expect(args.onKey).toHaveBeenLastCalledWith('D4');
    expect(document.activeElement).toBe(staff);

    // Top C (baseOctave + 2): no key hint, since only the first octave
    // (semitones 0-12) has one.
    const topC = canvas.getByRole('button', { name: 'ド6' });
    expect(topC).toHaveTextContent('');
  },
};

export const KeyF: Story = {
  args: { keySignature: 'F' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Key F is spelled with flats: the black key between A4 and B4 is
    // シ♭4 (Bb4), not ド♯4-style sharp spelling.
    const bFlat4 = canvas.getByRole('button', { name: 'シ♭4' });
    await userEvent.click(bFlat4);
    await expect(args.onKey).toHaveBeenCalledOnce();
    await expect(args.onKey).toHaveBeenCalledWith('Bb4');
  },
};

/** M13: highlight compares by MIDI number, whatever the spelling. */
export const HighlightBySound: Story = {
  args: { highlight: ['Db4', 'A#4'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('button', { name: 'ド♯4' })).toHaveAttribute(
      'data-highlighted',
      'true',
    );
    expect(canvas.getByRole('button', { name: 'ラ♯4' })).toHaveAttribute(
      'data-highlighted',
      'true',
    );
    expect(canvas.getByRole('button', { name: 'ド4' })).not.toHaveAttribute(
      'data-highlighted',
    );
  },
};
