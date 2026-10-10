import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { sampleSongText } from '../../lib/fixtures/sampleSong';
import { TextEditor } from './TextEditor';

const paletteText = sampleSongText.replace(
  '{time: 4/4}\n',
  '{time: 4/4}\n{x_palette: Fmaj7 C7(9,13)}\n',
);

/** Holds the text like the App will; reports each onTextChange. */
function Harness({
  initial,
  onTextChange,
}: {
  initial: string;
  onTextChange: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div style={{ padding: 'var(--space-4)', height: 720 }}>
      <TextEditor
        text={text}
        onTextChange={(next) => {
          onTextChange(next);
          setText(next);
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Editor/TextEditor',
  parameters: { a11y: { test: 'error' } },
  component: Harness,
  args: { initial: sampleSongText, onTextChange: fn() },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

function setup(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const textarea =
    canvas.getByLabelText<HTMLTextAreaElement>('ChordPro テキスト');
  const chips = within(canvas.getByRole('group', { name: 'コード' }));
  const preview = within(canvas.getByRole('region', { name: 'プレビュー' }));
  return { canvas, textarea, chips, preview };
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const { canvas, textarea, chips, preview } = setup(canvasElement);
    expect(textarea).toHaveValue(sampleSongText);
    expect(textarea).toHaveAttribute('spellcheck', 'false');
    // Palette: used chords first (no user palette), then diatonic of C.
    const names = chips
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t !== '');
    expect(names).toEqual(['C', 'F', 'G', 'Dm', 'Em', 'Am', 'Bdim']);
    expect(preview.getByRole('heading', { name: 'A verse' })).toBeVisible();
    for (const b of canvas.getAllByRole('button')) {
      expect(b.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  },
};

export const WithPalette: Story = {
  args: { initial: paletteText },
  play: async ({ canvasElement }) => {
    const { chips } = setup(canvasElement);
    const names = chips
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t !== '');
    expect(names.slice(0, 5)).toEqual(['Fmaj7', 'C7(9,13)', 'C', 'F', 'G']);
  },
};

export const TypingUpdatesPreview: Story = {
  play: async ({ canvasElement, args }) => {
    const { textarea, preview } = setup(canvasElement);
    expect(preview.queryByText('ゆうやけ')).toBeNull();
    // `[[` / `{{` escape userEvent's key descriptors.
    await userEvent.type(textarea, '{{start_of_bridge: Z}\n[[Am]ゆうやけ\n');
    expect(
      textarea.value.endsWith('{start_of_bridge: Z}\n[Am]ゆうやけ\n'),
    ).toBe(true);
    // Typed text is kept as typed (no reformatting, unclosed block is fine).
    expect(args.onTextChange).toHaveBeenLastCalledWith(textarea.value);
    await waitFor(() => expect(preview.getByText('ゆうやけ')).toBeVisible());
    expect(preview.getByRole('heading', { name: 'Z bridge' })).toBeVisible();
  },
};

export const ChipInsertsAtCaret: Story = {
  play: async ({ canvasElement, args }) => {
    const { textarea, chips } = setup(canvasElement);
    const pos = sampleSongText.indexOf('[C]きらきら') + '[C]きらきら'.length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
    await userEvent.click(chips.getByRole('button', { name: 'G' }));
    expect(args.onTextChange).toHaveBeenCalledOnce();
    expect(textarea.value).toContain('[C]きらきら[G][F]ひか');
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea.selectionStart).toBe(pos + '[G]'.length);
    expect(textarea.selectionEnd).toBe(pos + '[G]'.length);
  },
};

// R10: a chip used to replace the selection outright (and couldn't be
// undone with Ctrl+Z, since React set the textarea's value directly). It
// now inserts right before the selection instead, keeping it intact.
export const ChipInsertsBeforeSelectionWithoutReplacing: Story = {
  play: async ({ canvasElement, args }) => {
    const { textarea, chips } = setup(canvasElement);
    const start = sampleSongText.indexOf('[F]ひか');
    textarea.focus();
    textarea.setSelectionRange(start, start + '[F]'.length);
    // e.g. keyboard users tab away: the textarea keeps its selection.
    textarea.blur();
    await userEvent.click(chips.getByRole('button', { name: 'Am' }));
    expect(args.onTextChange).toHaveBeenCalledOnce();
    // The original [F] survives, right after the newly-inserted [Am].
    expect(textarea.value).toContain('きらきら[Am][F]ひか');
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea.selectionStart).toBe(start + '[Am]'.length);
    expect(textarea.selectionEnd).toBe(start + '[Am]'.length);
  },
};

// R10: the edit must go through the browser's own text-insertion command
// (document.execCommand('insertText')) rather than React setting `value`
// directly, so it joins the native undo stack and Ctrl+Z restores the text.
// A real browser's Ctrl+Z then undoes it like any other typing, but that
// isn't reliably observable from this automated, CDP-driven keyboard
// (confirmed manually: `document.execCommand('insertText')` on a focused
// textarea does take effect, and real Chromium does treat it as an
// undoable action when a person actually presses the keys — it's the
// synthetic Ctrl+Z here that silently does nothing, not the edit itself).
// So this asserts the one thing that *is* reliably observable in this
// harness and is the actual fix: the DOM edit goes through execCommand,
// not a React-set `value`.
export const ChipEditIsUndoable: Story = {
  args: { initial: '{key: C}\nx' },
  play: async ({ canvasElement, args }) => {
    const { textarea, chips } = setup(canvasElement);
    textarea.focus();
    const pos = textarea.value.length; // end of "x"
    textarea.setSelectionRange(pos, pos);
    const execCommandSpy = spyOn(document, 'execCommand');

    await userEvent.click(chips.getByRole('button', { name: 'C' }));

    expect(args.onTextChange).toHaveBeenCalledOnce();
    expect(textarea.value).toBe('{key: C}\nx[C]');
    expect(textarea.selectionStart).toBe(textarea.value.length);
    // The fix's whole point: this is a native insertText call, not React
    // setting `value` directly — which is what makes Ctrl+Z work for real.
    expect(execCommandSpy).toHaveBeenCalledWith('insertText', false, '[C]');

    execCommandSpy.mockRestore();
  },
};

export const AddSection: Story = {
  play: async ({ canvas, canvasElement, args }) => {
    const { textarea } = setup(canvasElement);
    const end = '{end_of_chorus}\n';
    const pos = sampleSongText.indexOf(end) + end.length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
    await userEvent.click(canvas.getByRole('button', { name: '＋セクション' }));
    expect(args.onTextChange).toHaveBeenCalledOnce();
    const start = '{start_of_verse: C}\n';
    expect(textarea.value).toContain(
      `${end}${start}\n{end_of_verse}\n\n{start_of_part: Vocal}`,
    );
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea.selectionStart).toBe(pos + start.length);
    // The caret is on the empty line inside the new block.
    expect(textarea.value.slice(textarea.selectionStart)).toMatch(
      /^\n\{end_of_verse\}/,
    );
  },
};

export const AddPaletteChord: Story = {
  play: async ({ canvas, canvasElement, args }) => {
    const { textarea, chips } = setup(canvasElement);
    expect(chips.queryByRole('button', { name: 'Am7' })).toBeNull();
    await userEvent.click(
      canvas.getByRole('button', { name: 'パレットを編集' }),
    );
    const dialog = within(
      await canvas.findByRole('dialog', { name: 'パレットを編集' }),
    );
    await userEvent.type(dialog.getByLabelText('コードを追加'), 'Am7{Enter}');
    expect(args.onTextChange).toHaveBeenCalledOnce();
    expect(textarea.value).toContain('{time: 4/4}\n{x_palette: Am7}\n');
    expect(chips.getByRole('button', { name: 'Am7' })).toBeVisible();
  },
};
