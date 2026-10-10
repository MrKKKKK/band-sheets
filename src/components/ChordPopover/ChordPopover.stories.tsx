import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '../Button/Button';
import { PopoverAnchor } from '../Popover/Popover';
import { ChordPopover } from './ChordPopover';

type HarnessProps = {
  initialChord?: string;
  palette: string[];
  diatonic: string[];
  keyLabel?: string;
  withDelete?: boolean;
  onCommit: (chord: string) => void;
  onDelete: () => void;
  onClose: () => void;
};

/** Trigger button + popover; starts open. Commit/delete keep it open. */
function Harness({ withDelete, onClose, ...props }: HarnessProps) {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div style={{ padding: 'var(--space-4)', minHeight: 480 }}>
      <PopoverAnchor>
        <Button
          ref={anchorRef}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          コード
        </Button>
        <ChordPopover
          {...props}
          open={open}
          anchorRef={anchorRef}
          onDelete={withDelete ? props.onDelete : undefined}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      </PopoverAnchor>
    </div>
  );
}

const meta = {
  title: 'Editor/ChordPopover',
  parameters: { a11y: { test: 'error' } },
  component: Harness,
  args: {
    palette: ['C7(9,13)', 'F', 'G7'],
    diatonic: ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim'],
    keyLabel: 'C',
    onCommit: fn(),
    onDelete: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

const dialogOf = async (canvasElement: HTMLElement, name: string) =>
  within(await within(canvasElement).findByRole('dialog', { name }));

export const Place: Story = {
  play: async ({ canvasElement, args }) => {
    const dialog = await dialogOf(canvasElement, 'コードを置く');
    const input = dialog.getByLabelText('コード');
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue('');
    expect(dialog.getByText('この曲のパレット')).toBeVisible();
    expect(dialog.getByText('キー C のダイアトニック')).toBeVisible();
    expect(dialog.queryByRole('button', { name: '削除' })).toBeNull();

    await userEvent.type(input, ' Am7 {Enter}');
    expect(args.onCommit).toHaveBeenCalledOnce();
    expect(args.onCommit).toHaveBeenCalledWith('Am7');
  },
};

export const PlaceWithButton: Story = {
  play: async ({ canvasElement, args }) => {
    const dialog = await dialogOf(canvasElement, 'コードを置く');
    await userEvent.type(dialog.getByLabelText('コード'), 'E7');
    await userEvent.click(dialog.getByRole('button', { name: '置く' }));
    expect(args.onCommit).toHaveBeenCalledOnce();
    expect(args.onCommit).toHaveBeenCalledWith('E7');
  },
};

export const ChipCommitsImmediately: Story = {
  play: async ({ canvasElement, args }) => {
    const dialog = await dialogOf(canvasElement, 'コードを置く');
    const chips = dialog.getAllByRole('button', { name: 'C7(9,13)' });
    expect(chips).toHaveLength(1);
    for (const b of dialog.getAllByRole('button', { name: /^[A-G]/ }))
      expect(b.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(chips[0]);
    expect(args.onCommit).toHaveBeenCalledOnce();
    expect(args.onCommit).toHaveBeenCalledWith('C7(9,13)');

    // Diatonic chip.
    await userEvent.click(dialog.getByRole('button', { name: 'Am' }));
    expect(args.onCommit).toHaveBeenCalledTimes(2);
    expect(args.onCommit).toHaveBeenLastCalledWith('Am');
  },
};

export const EditExisting: Story = {
  args: { initialChord: 'F', withDelete: true },
  play: async ({ canvasElement, args }) => {
    const dialog = await dialogOf(canvasElement, 'コードを変更');
    const input = dialog.getByLabelText('コード') as HTMLInputElement;
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue('F');
    // Prefilled text is selected, so typing replaces it.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(1);
    await userEvent.keyboard('Fmaj7');
    await userEvent.click(dialog.getByRole('button', { name: '変更' }));
    expect(args.onCommit).toHaveBeenCalledOnce();
    expect(args.onCommit).toHaveBeenCalledWith('Fmaj7');
  },
};

export const Delete: Story = {
  args: { initialChord: 'F', withDelete: true },
  play: async ({ canvasElement, args }) => {
    const dialog = await dialogOf(canvasElement, 'コードを変更');
    await userEvent.click(dialog.getByRole('button', { name: '削除' }));
    expect(args.onDelete).toHaveBeenCalledOnce();
    expect(args.onCommit).not.toHaveBeenCalled();
  },
};

export const InvalidInput: Story = {
  play: async ({ canvasElement, args }) => {
    const dialog = await dialogOf(canvasElement, 'コードを置く');
    const input = dialog.getByLabelText('コード');
    await userEvent.type(input, 'C 7{Enter}');
    expect(args.onCommit).not.toHaveBeenCalled();
    expect(input).toHaveAccessibleDescription('空白や [ ] { } は使えません');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    await userEvent.clear(input);
    await userEvent.type(input, '[[C]'); // '[[' types a literal '['
    expect(input).not.toHaveAccessibleDescription();
    await userEvent.click(dialog.getByRole('button', { name: '置く' }));
    expect(args.onCommit).not.toHaveBeenCalled();
    expect(input).toHaveAccessibleDescription('空白や [ ] { } は使えません');

    await userEvent.clear(input);
    await userEvent.keyboard('{Enter}');
    expect(args.onCommit).not.toHaveBeenCalled();
    expect(input).toHaveAccessibleDescription('コードを入力してください');
  },
};

export const NoDiatonic: Story = {
  args: { diatonic: [], keyLabel: undefined, palette: [] },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'コードを置く');
    expect(dialog.queryByText(/ダイアトニック/)).toBeNull();
    expect(dialog.queryByText('この曲のパレット')).toBeNull();
  },
};

export const EscCloses: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await dialogOf(canvasElement, 'コードを置く');
    await userEvent.keyboard('{Escape}');
    expect(args.onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    expect(args.onCommit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'コード' })).toHaveFocus(),
    );
  },
};
