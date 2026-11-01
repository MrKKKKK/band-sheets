import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { sampleSong } from '../../lib/fixtures/sampleSong';
import { lyricsText } from '../../lib/lyrics';
import { parseSong } from '../../lib/parseSong';
import type { Song } from '../../lib/song';
import { EasyEditor, type Step } from './EasyEditor';

const emptySong: Song = {
  meta: { title: '新しい曲', key: 'G' },
  chart: [],
  parts: [],
};

/** A lyric line with literal `{ }` / unclosed `[` written in editor B. */
const bracketSong: Song = {
  meta: { title: 'テスト' },
  chart: [
    {
      kind: 'verse',
      label: 'A',
      lines: [
        { segments: [{ lyrics: 'foo {bar}' }] },
        { segments: [{ lyrics: 'a [b' }] },
        { segments: [{ chord: 'C', lyrics: 'ひかる' }] },
      ],
    },
  ],
  parts: [],
};

/**
 * A chorded segment preceded by an NFD-decomposed dakuten character: 'か' +
 * U+3099 is 1 grapheme cluster (same user-perceived character as the
 * precomposed 'が') but 2 code points. Catches `segmentStart` counting code
 * points instead of grapheme clusters (m3-review.md N4).
 */
const combiningSong: Song = {
  meta: { title: 'テスト' },
  chart: [
    {
      kind: 'verse',
      label: 'A',
      lines: [
        {
          segments: [
            { chord: 'C', lyrics: 'が' },
            { chord: 'G', lyrics: 'ほし' },
          ],
        },
      ],
    },
  ],
  parts: [],
};

/** Keeps the song in state so edits show up; reports each onChange. */
function Harness({
  initial,
  onChange,
}: {
  initial: Song;
  onChange: (song: Song) => void;
}) {
  const [song, setSong] = useState(initial);
  // Mirrors how App lifts editor A's step-1 draft, base and notice
  // (m3-review.md R3/N1). There is no editor B here, so the notice never
  // fires in these stories, but the harness keeps the same contract.
  const [step, setStep] = useState<Step>(() =>
    lyricsText(initial) === '' ? 'lyrics' : 'chords',
  );
  const [draft, setDraft] = useState(() => lyricsText(initial));
  const [base, setBase] = useState(() => lyricsText(initial));
  const currentLyrics = lyricsText(song);
  return (
    <div style={{ padding: 'var(--space-4)', maxWidth: 720, minHeight: 640 }}>
      <EasyEditor
        song={song}
        onChange={(next) => {
          onChange(next);
          setSong(next);
        }}
        step={step}
        onStepChange={setStep}
        draft={draft}
        onDraftChange={(next) => {
          setDraft(next);
          if (next === currentLyrics) setBase(currentLyrics);
        }}
        lyricsChangedNotice={draft !== base && currentLyrics !== base}
        onResetDraft={() => {
          setDraft(currentLyrics);
          setBase(currentLyrics);
        }}
        onKeepDraft={() => setBase(currentLyrics)}
      />
    </div>
  );
}

const meta = {
  title: 'Editor/EasyEditor',
  parameters: { a11y: { test: 'error' } },
  component: Harness,
  args: { initial: sampleSong, onChange: fn() },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

const currentStep = (canvasElement: HTMLElement) =>
  canvasElement.querySelector('[aria-current="step"]')?.textContent;

export const EmptySong: Story = {
  args: { initial: emptySong },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(currentStep(canvasElement)).toBe('1歌詞');
    const textarea = canvas.getByLabelText('歌詞を貼り付け');
    expect(textarea).toHaveValue('');
    // No lyrics yet → nothing to cancel back to.
    expect(canvas.queryByRole('button', { name: 'キャンセル' })).toBeNull();

    await userEvent.click(textarea);
    await userEvent.paste('きらきらひかる\nおそらのほしよ\n\nみんなのうたが');
    await userEvent.click(canvas.getByRole('button', { name: '反映' }));
    expect(args.onChange).toHaveBeenCalledOnce();

    expect(currentStep(canvasElement)).toBe('2コード');
    expect(canvas.queryByLabelText('歌詞を貼り付け')).toBeNull();
    const a = canvas.getByRole('region', { name: 'A' });
    expect(within(a).getByTestId('line-0-0')).toHaveTextContent(
      'きらきらひかる',
    );
    expect(within(a).getByTestId('line-0-1')).toHaveTextContent(
      'おそらのほしよ',
    );
    expect(canvas.getByRole('region', { name: 'B' })).toHaveTextContent(
      'みんなのうたが',
    );
  },
};

export const KirakiraBoshi: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(currentStep(canvasElement)).toBe('2コード');
    expect(canvas.getByRole('region', { name: 'A' })).toBeVisible();
    expect(canvas.getByRole('region', { name: 'B' })).toBeVisible();
    expect(canvas.getByTestId('char-0-0-0')).toBeVisible();
  },
};

export const PlaceChordFromChip: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // 「おそら」の「そ」.
    const char = canvas.getByTestId('char-0-1-1');
    await userEvent.click(char);
    const dialog = within(
      await canvas.findByRole('dialog', { name: 'コードを置く' }),
    );
    expect(char).toHaveAttribute('data-active');
    expect(dialog.getByText('キー C のダイアトニック')).toBeVisible();
    // Popover sits below the line.
    const popover = canvas.getByRole('dialog');
    expect(popover.getBoundingClientRect().top).toBeGreaterThan(
      char.getBoundingClientRect().bottom,
    );

    await userEvent.click(dialog.getByRole('button', { name: 'F' }));
    expect(args.onChange).toHaveBeenCalledOnce();
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());

    // The new chord is the segment starting at 「そ」, aligned above it.
    const line = within(canvas.getByTestId('line-0-1'));
    const chord = line.getByTestId('chord-0-1-1');
    expect(chord).toHaveTextContent('F');
    expect(line.getByTestId('seg-0-1-1')).toHaveTextContent(/^Fそら$/);
    const newChar = canvas.getByTestId('char-0-1-1');
    expect(
      Math.abs(
        chord.getBoundingClientRect().left -
          newChar.getBoundingClientRect().left,
      ),
    ).toBeLessThanOrEqual(1);
    expect(newChar).not.toHaveAttribute('data-active');
    await waitFor(() => expect(newChar).toHaveFocus());
  },
};

export const PlaceChordByTyping: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Line end of 「みんなのうたが」.
    await userEvent.click(canvas.getByTestId('char-1-0-7'));
    const dialog = within(await canvas.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText('コード'), 'D7{Enter}');
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(canvas.getByTestId('chord-1-0-2')).toHaveTextContent('D7');
  },
};

export const ChangeExistingChord: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const line = within(canvas.getByTestId('line-0-1'));
    await userEvent.click(
      line.getByRole('button', { name: 'コード G を編集' }),
    );
    const dialog = within(
      await canvas.findByRole('dialog', { name: 'コードを変更' }),
    );
    // Segment start 「ほ」 is highlighted.
    expect(canvas.getByTestId('char-0-1-4')).toHaveAttribute('data-active');
    const input = dialog.getByLabelText('コード');
    await waitFor(() => expect(input).toHaveValue('G'));
    await userEvent.keyboard('G7{Enter}');
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(canvas.getByTestId('chord-0-1-2')).toHaveTextContent('G7');
  },
};

export const DeleteChord: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const line = within(canvas.getByTestId('line-0-0'));
    await userEvent.click(
      line.getByRole('button', { name: 'コード F を編集' }),
    );
    const dialog = within(
      await canvas.findByRole('dialog', { name: 'コードを変更' }),
    );
    await userEvent.click(dialog.getByRole('button', { name: '削除' }));
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(line.queryByRole('button', { name: 'コード F を編集' })).toBeNull();
    expect(canvas.getByTestId('line-0-0')).toHaveTextContent(
      /^CきらきらひかCる$/,
    );
  },
};

export const EscClosesWithoutChange: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const char = canvas.getByTestId('char-0-0-2');
    await userEvent.click(char);
    await canvas.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    expect(args.onChange).not.toHaveBeenCalled();
    expect(char).not.toHaveAttribute('data-active');
    await waitFor(() => expect(char).toHaveFocus());
  },
};

export const LyricsWithBrackets: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '歌詞を編集' }));
    expect(currentStep(canvasElement)).toBe('1歌詞');
    const textarea = canvas.getByLabelText('歌詞を貼り付け');
    expect(textarea).toHaveValue(
      'きらきらひかる\nおそらのほしよ\n\nみんなのうたが\nとどくといいな',
    );
    await userEvent.click(textarea);
    await userEvent.paste('\n[C]あいうえお');
    await userEvent.click(canvas.getByRole('button', { name: '反映' }));
    expect(args.onChange).not.toHaveBeenCalled();
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(canvas.getByRole('alert')).toHaveTextContent(
      '歌詞に [ ] { } は使えません',
    );
    expect(currentStep(canvasElement)).toBe('1歌詞');
  },
};

export const EditLyricsKeepsChords: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '歌詞を編集' }));
    const textarea = canvas.getByLabelText('歌詞を貼り付け');
    await userEvent.click(textarea);
    await userEvent.paste('\n\nほしがまたたく');
    await userEvent.click(canvas.getByRole('button', { name: '反映' }));
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(currentStep(canvasElement)).toBe('2コード');
    // Unchanged lines keep their chords; the new block becomes section C.
    expect(canvas.getByTestId('chord-0-0-1')).toHaveTextContent('F');
    expect(canvas.getByRole('region', { name: 'C' })).toHaveTextContent(
      'ほしがまたたく',
    );
  },
};

export const HashLineRejected: Story = {
  args: { initial: emptySong },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const textarea = canvas.getByLabelText('歌詞を貼り付け');
    await userEvent.click(textarea);
    // A line starting with '#' would be re-parsed as a comment and vanish
    // (m3-review.md R2).
    await userEvent.paste('きらきらひかる\n#1 きらきら');
    await userEvent.click(canvas.getByRole('button', { name: '反映' }));
    expect(args.onChange).not.toHaveBeenCalled();
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(canvas.getByRole('alert')).toHaveTextContent(
      '2行目: 行頭に # は使えません（コメントになります）',
    );
    expect(currentStep(canvasElement)).toBe('1歌詞');
  },
};

export const UnchangedBracketLineAllowed: Story = {
  args: { initial: bracketSong },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The song already has lyric lines with literal [ ] { } (written in
    // editor B); re-applying them unchanged must not block editing A
    // (m3-review.md R9).
    expect(currentStep(canvasElement)).toBe('2コード');
    await userEvent.click(canvas.getByRole('button', { name: '歌詞を編集' }));
    const textarea = canvas.getByLabelText('歌詞を貼り付け');
    expect(textarea).toHaveValue('foo {bar}\na [b\nひかる');
    await userEvent.click(canvas.getByRole('button', { name: '反映' }));
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(currentStep(canvasElement)).toBe('2コード');
  },
};

export const EditingUnrelatedLineKeepsBracketLines: Story = {
  args: { initial: bracketSong },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '歌詞を編集' }));
    const textarea = canvas.getByLabelText('歌詞を貼り付け');
    await userEvent.click(textarea);
    await userEvent.clear(textarea);
    // Only the third line changes; the two bracket lines are re-pasted
    // unchanged, so only the changed line is validated.
    await userEvent.paste('foo {bar}\na [b\nひかるよ');
    await userEvent.click(canvas.getByRole('button', { name: '反映' }));
    expect(args.onChange).toHaveBeenCalledOnce();
  },
};

export const ChangingBracketLineIsValidated: Story = {
  args: { initial: bracketSong },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '歌詞を編集' }));
    const textarea = canvas.getByLabelText('歌詞を貼り付け');
    await userEvent.click(textarea);
    await userEvent.clear(textarea);
    // Changing the bracket line itself makes it a new line, so it is
    // validated like any other.
    await userEvent.paste('foo {baz}\na [b\nひかる');
    await userEvent.click(canvas.getByRole('button', { name: '反映' }));
    expect(args.onChange).not.toHaveBeenCalled();
    expect(canvas.getByRole('alert')).toHaveTextContent(
      '歌詞に [ ] { } は使えません',
    );
  },
};

export const ChordAfterCombiningCharacterSegment: Story = {
  args: { initial: combiningSong },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The first segment is 1 grapheme cluster but 2 code points, so the
    // second segment's chord ("G") must be anchored at char index 1 (「ほ」),
    // not the code-point count of 2 (「し」) — m3-review.md N4.
    await userEvent.click(
      canvas.getByRole('button', { name: 'コード G を編集' }),
    );
    const dialog = within(
      await canvas.findByRole('dialog', { name: 'コードを変更' }),
    );
    expect(canvas.getByTestId('char-0-0-1')).toHaveAttribute('data-active');
    expect(canvas.getByTestId('char-0-0-2')).not.toHaveAttribute('data-active');
    // Deleting the chord removes its button from the DOM (the two segments
    // merge into one), so focus has to move to the recreated char button —
    // proving the highlighted position above is also the real one used for
    // focus management, not just a coincidentally correct display value.
    await userEvent.click(dialog.getByRole('button', { name: '削除' }));
    expect(args.onChange).toHaveBeenCalledOnce();
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    const newChar = canvas.getByTestId('char-0-0-1');
    expect(newChar).not.toHaveAttribute('data-active');
    await waitFor(() => expect(newChar).toHaveFocus());
  },
};

export const CancelLyricsEdit: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '歌詞を編集' }));
    await userEvent.type(canvas.getByLabelText('歌詞を貼り付け'), 'あ');
    await userEvent.click(canvas.getByRole('button', { name: 'キャンセル' }));
    expect(args.onChange).not.toHaveBeenCalled();
    expect(currentStep(canvasElement)).toBe('2コード');
    // Re-entering step 1 starts from the song again, not the old draft.
    await userEvent.click(canvas.getByRole('button', { name: '歌詞を編集' }));
    expect(canvas.getByLabelText('歌詞を貼り付け')).not.toHaveValue(
      expect.stringContaining('あ\n'),
    );
  },
};

/** Dash lines (audio-integration-plan §3.6) are not lyrics and not clickable. */
export const DashLinesReadOnly: Story = {
  args: {
    initial: parseSong(
      [
        '{title: t}',
        '{start_of_verse: A}',
        '|[C]--------|[C]----[F]----|[G]--------|[G]----[G7]----|',
        '[C]きらきら[F]ひかる',
        '{end_of_verse}',
        '',
      ].join('\n'),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(currentStep(canvasElement)).toBe('2コード');
    expect(canvas.getByTestId('line-0-0')).toHaveTextContent('|');
    // No per-character buttons on the dash line; the lyric line has them.
    expect(canvas.queryByTestId('char-0-0-0')).toBeNull();
    expect(canvas.getByTestId('char-0-1-0')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '歌詞を編集' }));
    expect(canvas.getByLabelText('歌詞を貼り付け')).toHaveValue(
      'きらきらひかる',
    );
  },
};
