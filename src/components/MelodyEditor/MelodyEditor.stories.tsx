import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import {
  expect,
  fireEvent,
  fn,
  userEvent,
  waitFor,
  within,
} from 'storybook/test';
import { sampleSongText } from '../../lib/fixtures/sampleSong';
import { melodyTimeSignature } from '../../lib/melody';
import { readSection } from '../../lib/melodyPart';
import { parseSong } from '../../lib/parseSong';
import { serializeSong } from '../../lib/serializeSong';
import type { Song } from '../../lib/song';
import { layoutMelody } from '../../lib/staffLayout';
import { MelodyEditor } from './MelodyEditor';

type HarnessProps = {
  initialText: string;
  onChange: (song: Song) => void;
  /** Shows a button that sets `{time: …}` to this (like 曲情報 would). */
  setTimeTo?: string;
};

/** Holds a Song like App does (song → serializeSong → text → parseSong). */
function Harness({ initialText, onChange, setTimeTo }: HarnessProps) {
  const [text, setText] = useState(initialText);
  const song = parseSong(text);
  return (
    <div>
      {setTimeTo && (
        <button
          type="button"
          onClick={() =>
            setText((t) => t.replace(/\{time: [^}]*\}/, `{time: ${setTimeTo}}`))
          }
        >
          拍子を {setTimeTo} にする
        </button>
      )}
      <MelodyEditor
        song={song}
        onChange={(next) => {
          onChange(next);
          setText(serializeSong(next));
        }}
      />
      <pre data-testid="song-text">{text}</pre>
    </div>
  );
}

const meta = {
  title: 'Melody/MelodyEditor',
  component: Harness,
  parameters: { a11y: { test: 'error' }, layout: 'padded' },
  args: { initialText: '', onChange: fn() },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

const CHART_AB = `{title: テスト}
{key: C}
{time: 4/4}

{start_of_verse: A}
[C]きらきら
{end_of_verse}

{start_of_chorus: B}
[G]ひかる
{end_of_chorus}
`;

const KIRAKIRA = sampleSongText.replace(/^\\lyrics .*\n/m, '');

const textOf = (el: HTMLElement) =>
  within(el).getByTestId('song-text').textContent ?? '';

const staffOf = (el: HTMLElement) => within(el).getByRole('application');

/** Clicks the notehead of event `index` of section `label` (Vocal part). */
async function clickNote(el: HTMLElement, label: string, index: number) {
  const song = parseSong(textOf(el));
  const ts = melodyTimeSignature(song.meta.time);
  const vocal = song.parts.find((p) => p.name === 'Vocal')!;
  const read = readSection(vocal.body, label, ts);
  if (read.status !== 'ok') throw new Error('section not editable');
  const svg = within(el).getByTestId('melody-staff-svg');
  const layout = layoutMelody(read.events, ts, {
    width: Number(svg.getAttribute('width')),
    key: song.meta.key,
  });
  const p = layout.pieces.find((q) => q.eventIndex === index)!;
  const r = svg.getBoundingClientRect();
  await fireEvent.click(svg, { clientX: r.left + p.x, clientY: r.top + p.y });
}

/** 1. Empty song: the first notes create the Vocal part and section A. */
export const TypeFirstNotes: Story = {
  args: { initialText: CHART_AB },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/最初の入力で作られます/)).toBeInTheDocument();
    staffOf(canvasElement).focus();
    await userEvent.keyboard('asd');
    const text = textOf(canvasElement);
    expect(text).toContain('{start_of_part: Vocal}');
    expect(text).toContain('\\section "A"\n:4 C4 D4 E4 |');
    expect(text).not.toContain('\\section "B"');
    expect(args.onChange).toHaveBeenCalledTimes(3);
    expect(canvas.getByLabelText('パート名')).toHaveValue('Vocal');
  },
};

/** 2. Duration key, then a note key: a half note. */
export const HalfNote: Story = {
  args: { initialText: CHART_AB },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    staffOf(canvasElement).focus();
    await userEvent.keyboard('2');
    expect(args.onChange).not.toHaveBeenCalled();
    expect(canvas.getByRole('button', { name: '2分音符' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.keyboard('g');
    expect(textOf(canvasElement)).toContain('\\section "A"\n:2 G4 |');
    expect(args.onChange).toHaveBeenCalledOnce();
  },
};

const FOUR_NOTES = `${CHART_AB}
{start_of_part: Vocal}
\\section "A"
:4 C4 D4 E4 F4 |
{end_of_part}
`;

/**
 * M5 T21 follow-up: DrumEditor found that a never-stored section state got
 * re-derived as "cursor at the end of the NEW events" after an edit whose
 * returned `EditorState` happened to be the SAME object reference as the
 * (unstored) one passed in — `setState` only wrote to `states` on
 * `next !== state`. `MelodyEditor`'s `setState` has the same shape, so it
 * got the same `states[stateKey] === undefined` guard (always store on the
 * section's first operation, regardless of reference equality).
 *
 * The very first interaction below (↑ transposing the last note, input
 * mode) goes through exactly that reference-preserving path
 * (`applyRaw`'s `stateOrSame`): events change (F4 → F#4) but the returned
 * state is the SAME object as the one `MelodyEditor` passed in, because the
 * cursor didn't move. A subsequent ← + Backspace then must still act at the
 * correct index (2, before the cursor at 3) — if the first operation's
 * state had been silently dropped, re-deriving it from the post-onChange
 * events would coincidentally still land on the right cursor for THIS
 * fixture (transposing doesn't change the note count), so this guards the
 * underlying invariant rather than reproducing a currently-visible glitch.
 */
export const FirstOperationPersistsCursor: Story = {
  args: { initialText: FOUR_NOTES },
  play: async ({ canvasElement, args }) => {
    staffOf(canvasElement).focus();
    // First-ever interaction with this section: transpose the last note.
    await userEvent.keyboard('{ArrowUp}');
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(textOf(canvasElement)).toContain(':4 C4 D4 E4 F#4 |');
    // Cursor is still right after F#4 (index 4): ← then Backspace must
    // delete E4 (index 2), not some other note.
    await userEvent.keyboard('{ArrowLeft}{Backspace}');
    expect(textOf(canvasElement)).toContain(':4 C4 D4 F#4 |');
    expect(args.onChange).toHaveBeenCalledTimes(2);
  },
};

/** 3. Click selects; ↑ raises the selected note; Backspace deletes it. */
export const SelectEditDelete: Story = {
  args: { initialText: FOUR_NOTES },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await clickNote(canvasElement, 'A', 1);
    expect(canvas.getByTestId('selection')).toBeInTheDocument();
    expect(staffOf(canvasElement)).toHaveFocus();
    expect(args.onChange).not.toHaveBeenCalled();
    await userEvent.keyboard('{ArrowUp}');
    expect(textOf(canvasElement)).toContain(':4 C4 D#4 E4 F4 |');
    await userEvent.keyboard('{Backspace}');
    expect(textOf(canvasElement)).toContain(':4 C4 E4 F4 |');
    expect(canvas.queryByTestId('selection')).toBeNull();
    expect(args.onChange).toHaveBeenCalledTimes(2);
    // Piano key at the cursor (after C4): inserts that exact pitch.
    await userEvent.click(canvas.getByRole('button', { name: 'ソ4' }));
    expect(textOf(canvasElement)).toContain(':4 C4 G4 E4 F4 |');
    expect(args.onChange).toHaveBeenCalledTimes(3);
  },
};

/** 4. Import the chart's lyrics, then のばす (N) on a selected note. */
export const ImportLyricsAndExtend: Story = {
  args: { initialText: KIRAKIRA },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: 'コード譜から歌詞を取り込む' }),
    );
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(canvas.getByTestId('lyric-0')).toHaveTextContent('き');
    expect(canvas.getByTestId('lyric-4')).toHaveTextContent('ひ');
    expect(textOf(canvasElement)).toContain('C4{lyrics "き"}');

    await clickNote(canvasElement, 'A', 3);
    await userEvent.keyboard('n');
    expect(args.onChange).toHaveBeenCalledTimes(2);
    expect(canvas.queryByTestId('lyric-4')).toBeNull();
    expect(canvas.getByTestId('lyric-5')).toHaveTextContent('ひ');
    // のばす made a melisma (events 3–4): automatic slur, also in the text
    expect(canvas.getByTestId('slur-3')).toBeInTheDocument();
    expect(textOf(canvasElement)).toContain(
      'G4{lyrics "ら" slur "A-1"} |\nA4{slur "A-1"}',
    );
    expect(canvas.getByText('音節が1個足りません')).toBeInTheDocument();
  },
};

/** 5. Sample song: part-level \lyrics → convert to per-note lyrics. */
export const ConvertPartLevelLyrics: Story = {
  args: { initialText: sampleSongText },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/歌詞をまとめて書く形式です/)).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: '音符ごとの歌詞に変換' }),
    );
    expect(args.onChange).toHaveBeenCalledOnce();
    const text = textOf(canvasElement);
    expect(text).not.toContain('\\lyrics');
    expect(text).toContain(':4 C4{lyrics "き"} C4{lyrics "ら"}');
    expect(canvas.queryByText(/歌詞をまとめて書く形式です/)).toBeNull();
    expect(canvas.getByTestId('lyric-0')).toHaveTextContent('き');
  },
};

/** 3b. The mode status line and its 「入力に戻る」 button (no behaviour change). */
export const ModeStatus: Story = {
  args: { initialText: FOUR_NOTES },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByTestId('mode-status');
    expect(status).toHaveTextContent('入力中（カーソル位置に音を追加）');
    expect(
      canvas.queryByRole('button', { name: '入力に戻る' }),
    ).not.toBeInTheDocument();

    await clickNote(canvasElement, 'A', 1);
    expect(status).toHaveTextContent('2 音目を選択中');
    expect(status).toHaveTextContent('Esc または五線の空いた所をクリック');
    expect(status).toHaveAttribute('data-mode', 'select');

    await userEvent.click(canvas.getByRole('button', { name: '入力に戻る' }));
    expect(status).toHaveTextContent('入力中');
    expect(canvas.queryByTestId('selection')).toBeNull();
    expect(
      canvas.queryByRole('button', { name: '入力に戻る' }),
    ).not.toBeInTheDocument();
    // The staff kept focus and the cursor is right after the selected note.
    expect(staffOf(canvasElement)).toHaveFocus();
    await userEvent.keyboard('g');
    expect(textOf(canvasElement)).toContain(':4 C4 D4 G4 E4 |\nF4 |');
  },
};

const READ_ONLY = `${CHART_AB}
{start_of_part: Vocal}
\\section "A"
:4 (C4 E4) D4 E4 F4 |
{end_of_part}
`;

/** 6. A section outside the subset: notice, no input. */
export const ReadOnlySection: Story = {
  args: { initialText: READ_ONLY },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(/このセクションはアプリでは編集できません（理由: /),
    ).toBeInTheDocument();
    expect(canvas.queryByRole('application')).toBeNull();
    expect(canvas.getByTestId('mode-status')).toHaveTextContent('読み取り専用');
    expect(
      canvas.getByRole('img', { name: /読み取り専用/ }),
    ).toBeInTheDocument();
    expect(canvas.getByRole('button', { name: 'ド4' })).toBeDisabled();
    expect(canvas.getByRole('button', { name: '休符' })).toBeDisabled();
    const before = textOf(canvasElement);
    await userEvent.click(canvas.getByRole('img', { name: /読み取り専用/ }));
    await userEvent.keyboard('asd{Backspace}');
    expect(textOf(canvasElement)).toBe(before);
    expect(args.onChange).not.toHaveBeenCalled();
    // Section B (missing) is editable.
    await userEvent.click(canvas.getByRole('button', { name: 'B' }));
    expect(canvas.getByRole('application')).toBeInTheDocument();
  },
};

const TWO_SECTIONS = `${CHART_AB}
{start_of_part: Vocal}
\\section "A"
:4 C4 D4 E4 F4 |
\\section "B"
:4 G4 A4 B4 C5 |
{end_of_part}
`;

/** 7. Each section keeps its own cursor. */
export const SectionsKeepCursor: Story = {
  args: { initialText: TWO_SECTIONS },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const section = (name: string) =>
      userEvent.click(canvas.getByRole('button', { name }));
    staffOf(canvasElement).focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    await section('B');
    staffOf(canvasElement).focus();
    await userEvent.keyboard('{ArrowLeft}');
    await section('A');
    staffOf(canvasElement).focus();
    await userEvent.keyboard('g');
    await waitFor(() =>
      expect(textOf(canvasElement)).toContain(
        '\\section "A"\n:4 C4 D4 G4 E4 |\nF4 |',
      ),
    );
    await section('B');
    staffOf(canvasElement).focus();
    await userEvent.keyboard('a');
    expect(textOf(canvasElement)).toContain(
      '\\section "B"\n:4 G4 A4 B4 C4 |\nC5 |',
    );
    expect(args.onChange).toHaveBeenCalledTimes(2);
  },
};

/** No chart sections and no \section: the read-only implicit choice. */
export const NoSections: Story = {
  args: {
    initialText: `{title: なし}

{start_of_part: Vocal}
:4 C4 D4 E4 F4 |
{end_of_part}
`,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByRole('button', { name: '（セクションなし）' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      canvas.getByText('コード譜でセクションを作ってください'),
    ).toBeInTheDocument();
    expect(canvas.getByTestId('note-0-0')).toBeInTheDocument();
  },
};

/** Part rename with validation. */
export const RenamePart: Story = {
  args: { initialText: FOUR_NOTES },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('パート名');
    await userEvent.clear(input);
    await userEvent.click(canvas.getByRole('button', { name: '保存' }));
    expect(canvas.getByRole('alert')).toHaveTextContent(
      'パート名を入力してください',
    );
    await userEvent.type(input, 'Lead');
    await userEvent.click(canvas.getByRole('button', { name: '保存' }));
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(textOf(canvasElement)).toContain('{start_of_part: Lead}');
    expect(canvas.getByLabelText('パート名')).toHaveValue('Lead');
  },
};

const REST_GAP = `${CHART_AB}
{start_of_part: Vocal}
\\section "A"
:4 C4 r E4 F4 |
{end_of_part}
`;

/** M1 regression: R right after a rest, then A, lands where the cursor is. */
export const RestThenNoteKeepsPosition: Story = {
  args: { initialText: REST_GAP },
  play: async ({ canvasElement }) => {
    staffOf(canvasElement).focus();
    // Cursor after the rest (before E4).
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    await userEvent.keyboard('r');
    // The two quarter rests merge into one half rest…
    expect(textOf(canvasElement)).toContain(':4 C4 :2 r :4 E4 |');
    // …and the next note still goes right after it, before E4.
    await userEvent.keyboard('a');
    expect(textOf(canvasElement)).toContain(':4 C4 :2 r :4 C4 |\nE4 F4 |');
  },
};

const FOUR_IN_THREE = `{title: テスト}
{key: C}
{time: 4/4}

{start_of_verse: A}
[C]きらきら
{end_of_verse}

{start_of_part: Vocal}
\\section "A"
:4 C4 D4 E4 F4 |
{end_of_part}
`;

/** M3: 4/4 notes, song switched to 3/4 → notice → 引き直す → editable. */
export const TimeChangeReflow: Story = {
  args: { initialText: FOUR_IN_THREE, setTimeTo: '3/4' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('application')).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: '拍子を 3/4 にする' }),
    );
    expect(
      canvas.getByText(/拍子が変わったため小節が合いません（.+）/),
    ).toBeInTheDocument();
    expect(canvas.queryByRole('application')).toBeNull();
    expect(canvas.getByTestId('note-3-0')).toBeInTheDocument();

    const reflow = canvas.getByRole('button', {
      name: '新しい拍子で小節を引き直す',
    });
    // Cancel first: nothing changes.
    await userEvent.click(reflow);
    let dialog = await canvas.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'このセクションの小節線を 3/4 で引き直します。よろしいですか？',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'キャンセル' }),
    );
    expect(args.onChange).not.toHaveBeenCalled();

    await userEvent.click(reflow);
    dialog = await canvas.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '引き直す' }),
    );
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(textOf(canvasElement)).toContain('\\section "A"\n:4 C4 D4 E4 |\nF4');
    expect(canvas.queryByText(/拍子が変わったため/)).toBeNull();
    expect(canvas.getByRole('application')).toBeInTheDocument();
    expect(canvas.getByTestId('staff-live')).toHaveTextContent(
      '小節を引き直しました',
    );
  },
};

/** M6 + M8: Enter selects the note before the cursor; the live region speaks. */
export const KeyboardOnlySelection: Story = {
  args: { initialText: KIRAKIRA },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const live = canvas.getByTestId('staff-live');
    staffOf(canvasElement).focus();
    await userEvent.keyboard('8');
    expect(live).toHaveTextContent('8分音符');
    await userEvent.keyboard('[Period]');
    expect(live).toHaveTextContent('付点あり');
    await userEvent.keyboard('[Period]4');
    expect(live).toHaveTextContent('4分音符');
    await userEvent.keyboard('{Control>}{ArrowUp}{/Control}');
    expect(live).toHaveTextContent('基準オクターブ 5');
    expect(args.onChange).not.toHaveBeenCalled();

    // Enter: select the last note (before the cursor at the end).
    await userEvent.keyboard('{Enter}');
    expect(canvas.getByTestId('selection')).toBeInTheDocument();
    expect(live).toHaveTextContent(/^選択中 /);
    // Duration key on the selection rewrites it (one onChange).
    await userEvent.keyboard('8');
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(live).toHaveTextContent(/選択中 .*8分音符/);
    // Escape back to input mode; Enter again re-selects.
    await userEvent.keyboard('{Escape}');
    expect(canvas.queryByTestId('selection')).toBeNull();
    // Lyrics: import, then select a note by keyboard and press N.
    await userEvent.click(
      canvas.getByRole('button', { name: 'コード譜から歌詞を取り込む' }),
    );
    expect(live).toHaveTextContent('歌詞を取り込みました');
    staffOf(canvasElement).focus();
    for (let i = 0; i < 20; i++) await userEvent.keyboard('{ArrowLeft}');
    await userEvent.keyboard(
      '{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}',
    );
    await userEvent.keyboard('{Enter}n');
    expect(live).toHaveTextContent('のばしました');
    expect(canvas.queryByTestId('lyric-4')).toBeNull();
    expect(canvas.getByTestId('lyric-5')).toHaveTextContent('ひ');
  },
};

/** M12: no notes → the import is disabled and never creates a part. */
export const ImportNeedsNotes: Story = {
  args: { initialText: CHART_AB },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByRole('button', { name: 'コード譜から歌詞を取り込む' }),
    ).toBeDisabled();
    expect(canvas.getByText('先に音符を入力してください')).toBeInTheDocument();
    expect(args.onChange).not.toHaveBeenCalled();
  },
};

/** M9: dragging the selected note writes one change. */
export const DragSelectedNote: Story = {
  args: { initialText: FOUR_NOTES },
  play: async ({ canvasElement, args }) => {
    await clickNote(canvasElement, 'A', 1);
    const song = parseSong(textOf(canvasElement));
    const ts = melodyTimeSignature(song.meta.time);
    const read = readSection(song.parts[0].body, 'A', ts);
    if (read.status !== 'ok') throw new Error('section not editable');
    const svg = within(canvasElement).getByTestId('melody-staff-svg');
    const layout = layoutMelody(read.events, ts, {
      width: Number(svg.getAttribute('width')),
      key: song.meta.key,
    });
    const p = layout.pieces.find((q) => q.eventIndex === 1)!;
    const r = svg.getBoundingClientRect();
    const pt = (dy: number) => ({
      clientX: r.left + p.x,
      clientY: r.top + p.y + dy,
      pointerId: 5,
    });
    await fireEvent.pointerDown(svg, pt(0));
    await fireEvent.pointerMove(svg, pt(-layout.staffSpace / 2));
    await fireEvent.pointerMove(svg, pt(-layout.staffSpace * 1.5));
    await fireEvent.pointerUp(svg, pt(-layout.staffSpace * 1.5));
    expect(args.onChange).toHaveBeenCalledOnce();
    // D4 up three staff steps → G4.
    expect(textOf(canvasElement)).toContain(':4 C4 G4 E4 F4 |');
    expect(within(canvasElement).getByTestId('selection')).toBeInTheDocument();
  },
};

const OVERRIDES = `${CHART_AB}
{start_of_part: Vocal}
\\ts 3 4
\\ks F
\\section "A"
:4 C4 D4 E4 |
{end_of_part}
`;

/** M11: the part's own \ts / \ks win over the song info (4/4, C). */
export const PartPreambleOverrides: Story = {
  args: { initialText: OVERRIDES },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(/このパートの冒頭で拍子\/キーが指定されています/),
    ).toHaveTextContent('拍子 3/4、キー F');
    staffOf(canvasElement).focus();
    // Key F (not the song's C): the U key gives Bb, not A#; 3/4 bars.
    await userEvent.keyboard('u');
    expect(textOf(canvasElement)).toContain(':4 C4 D4 E4 |\nBb4 |');
  },
};

/** M11: a preamble \ts the app cannot read → whole part read-only. */
export const PartPreambleUnsupported: Story = {
  args: {
    initialText: OVERRIDES.replace('\\ts 3 4', '\\ts common'),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/パート冒頭の拍子・キー/)).toBeInTheDocument();
    expect(canvas.queryByRole('application')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'B' }));
    expect(canvas.queryByRole('application')).toBeNull();
  },
};

// ---------------------------------------------------------------------------
// M5 T20: TupletPicker wired into the input controls.
// ---------------------------------------------------------------------------

async function openTupletPicker(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: '連符' }));
  return canvas.findByRole('dialog', { name: '連符' });
}

/** Opens the picker and clicks a preset ('3連符' etc.) or '連符を削除'. */
async function pickTuplet(canvasElement: HTMLElement, buttonName: string) {
  await openTupletPicker(canvasElement);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: buttonName }));
}

/** 1 full 4/4 bar: C4 D4 (quarters) then a trailing 8th-note triplet. */
const TRAILING_TRIPLET = `${CHART_AB}
{start_of_part: Vocal}
\\section "A"
:4 C4 D4 :8 r{tu 3} r{tu 3} r{tu 3} |
{end_of_part}
`;

/** Insert a 3連符 at the end, then fill its 3 rests with note keys. */
export const InsertTripletAndFillViaKeys: Story = {
  args: { initialText: FOUR_NOTES },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const live = canvas.getByTestId('staff-live');
    // Cursor starts at the end (after F4, a full bar): inserting here opens
    // a new bar, so the group cannot cross a barline.
    staffOf(canvasElement).focus();
    await pickTuplet(canvasElement, '3連符');
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(textOf(canvasElement)).toContain('r{tu 3} r{tu 3} r{tu 3}');
    expect(live).toHaveTextContent('5音目: 3連の 1 つ目');
    // The popover's onDone returned focus to the staff; keys fill the slots.
    expect(staffOf(canvasElement)).toHaveFocus();

    await userEvent.keyboard('a');
    expect(live).toHaveTextContent('5音目: ド4、3連の 1 つ目');
    await userEvent.keyboard('s');
    expect(live).toHaveTextContent('6音目: レ4、3連の 2 つ目');
    await userEvent.keyboard('d');
    expect(live).toHaveTextContent('7音目: ミ4、3連の 3 つ目');

    expect(textOf(canvasElement)).toContain('C4{tu 3} D4{tu 3} E4{tu 3}');
    expect(args.onChange).toHaveBeenCalledTimes(4);
  },
};

/** Backspace at the start of an all-rest group removes the whole group. */
export const RemoveTripletViaBackspace: Story = {
  args: { initialText: TRAILING_TRIPLET },
  play: async ({ canvasElement, args }) => {
    staffOf(canvasElement).focus();
    // Cursor at the end (5) → the triplet's start (2).
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    await userEvent.keyboard('{Backspace}');
    expect(textOf(canvasElement)).not.toContain('tu 3');
    expect(textOf(canvasElement)).toContain(':4 C4 D4');
    expect(args.onChange).toHaveBeenCalledOnce();
  },
};

/** 「連符を削除」 removes the group the cursor sits inside. */
export const RemoveTripletViaButton: Story = {
  args: { initialText: TRAILING_TRIPLET },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    staffOf(canvasElement).focus();
    // Cursor at the end (5) → strictly inside the triplet (3).
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    const dialog = await openTupletPicker(canvasElement);
    expect(
      within(dialog).getByRole('button', { name: '連符を削除' }),
    ).toBeEnabled();
    await userEvent.click(
      within(dialog).getByRole('button', { name: '連符を削除' }),
    );
    expect(textOf(canvasElement)).not.toContain('tu 3');
    expect(textOf(canvasElement)).toContain(':4 C4 D4');
    expect(args.onChange).toHaveBeenCalledOnce();
    // onDone returned focus to the staff.
    await waitFor(() => expect(staffOf(canvasElement)).toHaveFocus());
    expect(canvas.queryByRole('dialog')).toBeNull();
  },
};

/**
 * 1 full 4/4 bar with no slack: 3 quarters then an 8th-note triplet flush
 * against the barline (3*16 + 2*8 = 64). Shifting its start by any amount
 * that is not itself a multiple of the bar length makes it cross the
 * barline.
 */
const FLUSH_TRAILING_TRIPLET = `${CHART_AB}
{start_of_part: Vocal}
\\section "A"
:4 C4 D4 E4 :8 r{tu 3} r{tu 3} r{tu 3} |
{end_of_part}
`;

/** Inserting at the very start would push the trailing triplet across the
 * barline: refused, with the reason shown and announced. */
export const RejectedBarCrossingShowsMessage: Story = {
  args: { initialText: FLUSH_TRAILING_TRIPLET },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const live = canvas.getByTestId('staff-live');
    const before = textOf(canvasElement);
    staffOf(canvasElement).focus();
    // Cursor starts at the end (6) → 0, before the leading C4.
    await userEvent.keyboard('{ArrowLeft}'.repeat(6));
    // A 16th-note triplet (span 8 ticks) shifts the trailing group just
    // enough (48 → 56) to push it 8 ticks past the barline.
    await userEvent.keyboard('6');
    await pickTuplet(canvasElement, '3連符');
    expect(args.onChange).not.toHaveBeenCalled();
    expect(textOf(canvasElement)).toBe(before);
    // R6: plain text + the live region only (announced once).
    expect(canvas.getByTestId('editor-error')).toHaveTextContent(
      'この操作はできません（1 小節目の 3 連符が小節線をまたぎます）',
    );
    expect(canvas.queryByRole('alert')).toBeNull();
    expect(live).toHaveTextContent(
      'この操作はできません（1 小節目の 3 連符が小節線をまたぎます）',
    );
    // onDone still ran: focus is back on the staff, not the trigger.
    await waitFor(() => expect(staffOf(canvasElement)).toHaveFocus());
  },
};

const MIXED_DURATION_TUPLET = `${CHART_AB}
{start_of_part: Vocal}
\\section "A"
:4 C4{tu 3} :8 D4{tu 3} E4{tu 3}
{end_of_part}
`;

/** A tuplet mixing note lengths (4分＋8分) stays read-only (M5 設計判断 1). */
export const MixedDurationTupletStaysReadOnly: Story = {
  args: { initialText: MIXED_DURATION_TUPLET },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(/このセクションはアプリでは編集できません（理由: /),
    ).toHaveTextContent('長さの違う');
    expect(canvas.queryByRole('application')).toBeNull();
    expect(canvas.getByRole('button', { name: '連符' })).toBeDisabled();
  },
};

/** 4/4 melody whose triplet crosses a barline once the song is in 3/4. */
const TRIPLET_ACROSS = `{title: テスト}
{key: C}
{time: 4/4}

{start_of_verse: A}
[C]きらきら
{end_of_verse}

{start_of_part: Vocal}
\\section "A"
:8 C4 :4 C4 C4 :8 C4{tu 3} C4{tu 3} C4{tu 3} :8 C4 |
{end_of_part}
`;

/**
 * R1: a tuplet crossing the NEW barline (song switched to 3/4) used to
 * throw in the staff layout (whole app white). Now: notice + staff with the
 * group drawn as plain notes; 引き直す says why it can't (shown, announced).
 */
export const BarMismatchTupletAfterTimeChange: Story = {
  args: { initialText: TRIPLET_ACROSS, setTimeTo: '3/4' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: '拍子を 3/4 にする' }),
    );
    expect(
      canvas.getByText(/拍子が変わったため小節が合いません（.+）/),
    ).toBeInTheDocument();
    expect(canvas.getByTestId('melody-staff-svg')).toBeInTheDocument();
    expect(canvas.getByTestId('note-4-0')).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: '新しい拍子で小節を引き直す' }),
    );
    const dialog = await canvas.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '引き直す' }),
    );
    expect(args.onChange).not.toHaveBeenCalled();
    expect(canvas.getByTestId('editor-error')).toHaveTextContent(
      '連符が小節線をまたぎます',
    );
    expect(canvas.getByTestId('staff-live')).toHaveTextContent(
      '連符が小節線をまたぎます',
    );
    expect(canvas.queryByRole('alert')).toBeNull();
  },
};

/** R1: the same crossing caused by the part's own `\\ts 3 4`. */
export const BarMismatchTupletPartTimeSig: Story = {
  args: {
    initialText: TRIPLET_ACROSS.replace(
      '{start_of_part: Vocal}\n',
      '{start_of_part: Vocal}\n\\ts 3 4\n',
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/拍子 3\/4/)).toBeInTheDocument();
    expect(
      canvas.getByText(/拍子が変わったため小節が合いません（.+）/),
    ).toBeInTheDocument();
    expect(canvas.getByTestId('melody-staff-svg')).toBeInTheDocument();
  },
};

/** Issue #6 fixture: chart chords on 「き」「ひ」, lyrics already on the notes. */
const CHORDS_SONG = `{title: コード}
{key: C}
{time: 4/4}

{start_of_verse: A}
[C]きらきら[G7]ひかる
{end_of_verse}

{start_of_part: Vocal}
\\section "A"
:4 C4{lyrics "き"} C4{lyrics "ら"} G4{lyrics "き"} G4{lyrics "ら"} |
A4{lyrics "ひ"} A4{lyrics "か"} :2 G4{lyrics "る"} |
{end_of_part}
`;

const liveOf = (el: HTMLElement) =>
  within(el).getByTestId('staff-live').textContent ?? '';

/** Copy the chart's chords, then change / delete one with the keyboard. */
export const CopyChordsThenEdit: Story = {
  args: { initialText: CHORDS_SONG },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: 'コード譜からコードを写す' }),
    );
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(canvas.getByTestId('chord-0')).toHaveTextContent('C');
    expect(canvas.getByTestId('chord-4')).toHaveTextContent('G7');
    expect(textOf(canvasElement)).toContain('C4{lyrics "き" ch "C"}');
    expect(liveOf(canvasElement)).toContain('コードを 2 個、音符に写しました');

    // Select 「ひ」 by clicking it, Shift+C → popover.
    await clickNote(canvasElement, 'A', 4);
    await userEvent.keyboard('{Shift>}C{/Shift}');
    const dialog = await canvas.findByRole('dialog', { name: 'コードを変更' });
    const input = within(dialog).getByLabelText('コード');
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.clear(input);
    await userEvent.type(input, 'G7sus4{Enter}');
    expect(canvas.getByTestId('chord-4')).toHaveTextContent('G7sus4');
    expect(liveOf(canvasElement)).toContain(
      '5音目のコードを G7sus4 にしました',
    );
    await waitFor(() => expect(staffOf(canvasElement)).toHaveFocus());

    await userEvent.keyboard('{Shift>}{Backspace}{/Shift}');
    expect(canvas.queryByTestId('chord-4')).toBeNull();
    expect(canvas.getByTestId('chord-slot')).toBeInTheDocument();
    expect(liveOf(canvasElement)).toContain('5音目のコードを消しました');
    // Shift+⌫ never deletes the note itself.
    expect(canvas.getByTestId('note-4-0')).toBeInTheDocument();
  },
};

/** Shift+C with nothing before the cursor: refused with a reason. */
export const ChordKeyNeedsANote: Story = {
  args: { initialText: CHORDS_SONG },
  play: async ({ canvasElement }) => {
    staffOf(canvasElement).focus();
    await userEvent.keyboard('{Home}');
    for (let i = 0; i < 8; i++) await userEvent.keyboard('{ArrowLeft}');
    await userEvent.keyboard('{Shift>}C{/Shift}');
    expect(within(canvasElement).getByTestId('editor-error')).toHaveTextContent(
      'コードを付ける音符を選んでください',
    );
  },
};
