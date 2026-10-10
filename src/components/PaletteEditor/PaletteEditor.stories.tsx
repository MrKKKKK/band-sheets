import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { page } from '@vitest/browser/context';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { sampleSong } from '../../lib/fixtures/sampleSong';
import { addToPalette } from '../../lib/palette';
import type { Song } from '../../lib/song';
import { PaletteEditor } from './PaletteEditor';

const withPalette: Song = addToPalette(
  addToPalette(sampleSong, 'Fmaj7'),
  'C7(9,13)',
);

/** Keeps the song in state so adds/removes show up; reports each onChange. */
function Harness({
  initial,
  onChange,
  rightAlign,
}: {
  initial: Song;
  onChange: (song: Song) => void;
  /** Pushes the anchor near the right edge, as a trailing chip-row "＋" does. */
  rightAlign?: boolean;
}) {
  const [song, setSong] = useState(initial);
  return (
    <div
      style={{
        display: rightAlign ? 'flex' : undefined,
        justifyContent: rightAlign ? 'flex-end' : undefined,
        padding: 'var(--space-4)',
        minHeight: 560,
      }}
    >
      <PaletteEditor
        song={song}
        onChange={(next) => {
          onChange(next);
          setSong(next);
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Editor/PaletteEditor',
  parameters: { a11y: { test: 'error' } },
  component: Harness,
  args: { initial: withPalette, onChange: fn(), rightAlign: false },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

async function openEditor(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const trigger = canvas.getByRole('button', { name: 'パレットを編集' });
  await userEvent.click(trigger);
  const dialogEl = await canvas.findByRole('dialog', {
    name: 'パレットを編集',
  });
  return { canvas, trigger, dialogEl, dialog: within(dialogEl) };
}

export const Closed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'パレットを編集' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(trigger.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(canvas.queryByRole('dialog')).toBeNull();
  },
};

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const { dialog } = await openEditor(canvasElement);
    const input = dialog.getByLabelText('コードを追加');
    await waitFor(() => expect(input).toHaveFocus());
    expect(dialog.getByText('Fmaj7')).toBeVisible();
    expect(dialog.getByText('C7(9,13)')).toBeVisible();
    expect(dialog.getByText('この曲で使用中（自動）')).toBeVisible();
    expect(dialog.getByText('キー C のダイアトニック（自動）')).toBeVisible();
    // Automatic groups are read-only text, not buttons.
    expect(dialog.queryByRole('button', { name: 'G' })).toBeNull();
    expect(dialog.queryByRole('button', { name: 'Dm' })).toBeNull();
  },
};

export const NoKey: Story = {
  args: {
    initial: { ...withPalette, meta: { ...withPalette.meta, key: undefined } },
  },
  play: async ({ canvasElement }) => {
    const { dialog } = await openEditor(canvasElement);
    expect(dialog.queryByText(/ダイアトニック/)).toBeNull();
    expect(dialog.getByText('この曲で使用中（自動）')).toBeVisible();
  },
};

export const AddChord: Story = {
  play: async ({ canvasElement, args }) => {
    const { dialog } = await openEditor(canvasElement);
    const input = dialog.getByLabelText('コードを追加');
    await userEvent.type(input, 'Am7');
    await userEvent.click(dialog.getByRole('button', { name: '追加' }));
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(
      dialog.getByRole('button', { name: 'Am7 をパレットから外す' }),
    ).toBeVisible();
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();

    // Enter also adds.
    await userEvent.type(input, 'E7{Enter}');
    expect(args.onChange).toHaveBeenCalledTimes(2);
    expect(
      dialog.getByRole('button', { name: 'E7 をパレットから外す' }),
    ).toBeVisible();
    expect(input).toHaveFocus();
  },
};

export const InvalidChord: Story = {
  play: async ({ canvasElement, args }) => {
    const { dialog } = await openEditor(canvasElement);
    const input = dialog.getByLabelText('コードを追加');
    await userEvent.type(input, 'C 7{Enter}');
    expect(args.onChange).not.toHaveBeenCalled();
    expect(input).toHaveAccessibleDescription('空白や [ ] { } は使えません');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue('C 7');

    // Typing clears the error.
    await userEvent.type(input, '{Backspace}');
    expect(input).not.toHaveAccessibleDescription();
  },
};

export const DuplicateChord: Story = {
  play: async ({ canvasElement, args }) => {
    const { dialog } = await openEditor(canvasElement);
    const input = dialog.getByLabelText('コードを追加');
    await userEvent.type(input, 'Fmaj7');
    await userEvent.click(dialog.getByRole('button', { name: '追加' }));
    expect(args.onChange).not.toHaveBeenCalled();
    expect(input).toHaveAccessibleDescription('すでにパレットにあります');
  },
};

export const RemoveChord: Story = {
  play: async ({ canvasElement, args }) => {
    const { dialog } = await openEditor(canvasElement);
    await userEvent.click(
      dialog.getByRole('button', { name: 'Fmaj7 をパレットから外す' }),
    );
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(dialog.queryByText('Fmaj7')).toBeNull();
    // Focus moves to the next remove button, not lost to <body>.
    const next = dialog.getByRole('button', {
      name: 'C7(9,13) をパレットから外す',
    });
    await waitFor(() => expect(next).toHaveFocus());
  },
};

export const EscClosesAndReturnsFocus: Story = {
  play: async ({ canvasElement }) => {
    const { canvas, trigger } = await openEditor(canvasElement);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const CloseButtonReturnsFocus: Story = {
  play: async ({ canvasElement }) => {
    const { canvas, trigger, dialog } = await openEditor(canvasElement);
    await userEvent.click(dialog.getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

// R6: on a narrow screen, a "＋" anchor near the right edge (e.g. the last
// chip in a wrapped row) must not push the popover past the viewport.
export const NarrowViewportDoesNotOverflow: Story = {
  args: { rightAlign: true },
  play: async ({ canvasElement }) => {
    await page.viewport(390, 700);
    await waitFor(() => expect(window.innerWidth).toBe(390));
    try {
      const { dialogEl } = await openEditor(canvasElement);
      await waitFor(() => {
        const r = dialogEl.getBoundingClientRect();
        expect(r.right).toBeLessThanOrEqual(window.innerWidth);
      });
      expect(dialogEl.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        window.innerWidth,
      );
    } finally {
      await page.viewport(1024, 768);
    }
  },
};
