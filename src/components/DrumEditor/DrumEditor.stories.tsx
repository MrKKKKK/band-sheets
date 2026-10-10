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
import { parseSong } from '../../lib/parseSong';
import { serializeSong } from '../../lib/serializeSong';
import type { Song } from '../../lib/song';
import { DrumEditor } from './DrumEditor';

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
      <DrumEditor
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
  title: 'Drums/DrumEditor',
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

const withDrums = (body: string) => `${CHART_AB}
{start_of_part: Drums}
\\instrument percussion
${body}
{end_of_part}
`;

const textOf = (el: HTMLElement) =>
  within(el).getByTestId('song-text').textContent ?? '';

const staffOf = (el: HTMLElement) => within(el).getByRole('application');

const shift = (code: string) => `{Shift>}[${code}]{/Shift}`;

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

/** The sample song's drum part (for the screenshot and a quick look). */
export const SampleSong: Story = {
  args: { initialText: sampleSongText },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByLabelText('パート名')).toHaveValue('Drums');
    expect(canvas.getByTestId('beat-0')).toBeInTheDocument();
    expect(canvas.getByRole('button', { name: 'なし' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(canvas.getByTestId('mode-status')).toHaveTextContent('入力中');
  },
};

/**
 * Empty song: an 8-beat typed with keys only (H, Shift+J / Shift+F on the
 * previous beat). The first input creates the Drums part; one onChange per
 * key.
 */
export const TypeEightBeat: Story = {
  args: { initialText: CHART_AB },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/最初の入力で作られます/)).toBeInTheDocument();
    // No beats yet: shuffle cannot be chosen.
    expect(canvas.getByRole('button', { name: '8分' })).toBeDisabled();
    staffOf(canvasElement).focus();
    const hh = '[KeyH]';
    await userEvent.keyboard(
      [
        hh + shift('KeyJ'),
        hh,
        hh + shift('KeyF'),
        hh,
        hh + shift('KeyJ'),
        hh + shift('KeyJ'),
        hh + shift('KeyF'),
        hh,
      ].join(''),
    );
    const text = textOf(canvasElement);
    expect(text).toContain('{start_of_part: Drums}\n\\instrument percussion');
    expect(text).toContain(
      '\\section "A"\n\\tf none\n:8 (HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |',
    );
    expect(text).not.toContain('\\section "B"');
    expect(args.onChange).toHaveBeenCalledTimes(13);
    expect(canvas.getByTestId('staff-live')).toHaveTextContent(
      '8 番目: 8分 ハイハット（クローズ）',
    );
    expect(canvas.getByLabelText('パート名')).toHaveValue('Drums');
    expect(canvas.getByRole('button', { name: '8分' })).toBeEnabled();
  },
};

/** Shift+key announces add/remove; Shift+click on a pad does the same. */
export const ToggleOnPreviousAnnounced: Story = {
  args: { initialText: withDrums('\\section "A"\n:4 HH HH HH HH |') },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const live = canvas.getByTestId('staff-live');
    staffOf(canvasElement).focus();
    await userEvent.keyboard(shift('KeyF'));
    expect(live).toHaveTextContent('スネアを追加しました');
    expect(textOf(canvasElement)).toContain(':4 HH HH HH (HH SD) |');
    fireEvent.click(canvas.getByRole('button', { name: 'スネア（F）' }), {
      shiftKey: true,
    });
    await waitFor(() => expect(live).toHaveTextContent('スネアを外しました'));
    expect(textOf(canvasElement)).toContain(':4 HH HH HH HH |');
    expect(args.onChange).toHaveBeenCalledTimes(2);
    // The pad never took the focus away from the staff.
    expect(staffOf(canvasElement)).toHaveFocus();
  },
};

const FULL_BAR = withDrums('\\section "A"\n:4 BD SD BD SD |');

/**
 * Insert a 3連符 at the end, fill it with keys, then pick シャッフル 8分:
 * the section text gets `\tf triplet8th` and keeps the `{tu 3}` beats.
 */
export const TripletAndShuffle: Story = {
  args: { initialText: FULL_BAR },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const live = canvas.getByTestId('staff-live');
    staffOf(canvasElement).focus();
    await pickTuplet(canvasElement, '3連符');
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(textOf(canvasElement)).toContain('r{tu 3} r{tu 3} r{tu 3}');
    expect(live).toHaveTextContent('3連符を挿入しました');
    await waitFor(() => expect(staffOf(canvasElement)).toHaveFocus());

    await userEvent.keyboard('[KeyH]');
    expect(live).toHaveTextContent(
      '5 番目: 3連の 1 つ目、ハイハット（クローズ）',
    );
    await userEvent.keyboard('[KeyF][KeyJ]');
    expect(textOf(canvasElement)).toContain('HH{tu 3} SD{tu 3} BD{tu 3}');
    expect(args.onChange).toHaveBeenCalledTimes(4);

    await userEvent.click(canvas.getByRole('button', { name: '8分' }));
    expect(args.onChange).toHaveBeenCalledTimes(5);
    const text = textOf(canvasElement);
    expect(text).toContain('\\section "A"\n\\tf triplet8th\n');
    expect(text).toContain('{tu 3}');
    expect(canvas.getByRole('button', { name: '8分' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(live).toHaveTextContent('シャッフル 8分');
    // The staff draws the Shuffle marking; focus is back on the staff.
    expect(staffOf(canvasElement)).toHaveFocus();

    await userEvent.click(canvas.getByRole('button', { name: 'なし' }));
    expect(textOf(canvasElement)).toContain('\\section "A"\n\\tf none\n');
    expect(args.onChange).toHaveBeenCalledTimes(6);
  },
};

/** 「連符を削除」 removes the group around the cursor. */
export const RemoveTripletViaButton: Story = {
  args: {
    initialText: withDrums(
      '\\section "A"\n:4 BD SD :8 r{tu 3} r{tu 3} r{tu 3} |',
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    staffOf(canvasElement).focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    const dialog = await openTupletPicker(canvasElement);
    await userEvent.click(
      within(dialog).getByRole('button', { name: '連符を削除' }),
    );
    expect(textOf(canvasElement)).not.toContain('tu 3');
    expect(textOf(canvasElement)).toContain(':4 BD SD |');
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(canvas.getByTestId('staff-live')).toHaveTextContent(
      '連符を削除しました',
    );
    await waitFor(() => expect(staffOf(canvasElement)).toHaveFocus());
  },
};

/** S = ghost on/off, A = accent cycle; buttons do the same. */
export const GhostAndAccent: Story = {
  args: { initialText: withDrums('\\section "A"\n:4 SD SD SD HH |') },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const live = canvas.getByTestId('staff-live');
    staffOf(canvasElement).focus();
    await userEvent.keyboard('[KeyS]');
    expect(textOf(canvasElement)).toContain(':4 SD SD SD HH{g} |');
    expect(live).toHaveTextContent('ハイハット（クローズ）（ゴースト）');
    await userEvent.keyboard('[KeyA]');
    expect(textOf(canvasElement)).toContain(':4 SD SD SD HH{ac} |');
    await userEvent.keyboard('[KeyA]');
    expect(textOf(canvasElement)).toContain(':4 SD SD SD HH{hac} |');
    await userEvent.click(canvas.getByRole('button', { name: 'アクセント' }));
    expect(textOf(canvasElement)).toContain(':4 SD SD SD HH |');
    await userEvent.click(canvas.getByRole('button', { name: 'ゴースト' }));
    expect(textOf(canvasElement)).toContain(':4 SD SD SD HH{g} |');
    expect(args.onChange).toHaveBeenCalledTimes(5);
    expect(staffOf(canvasElement)).toHaveFocus();
  },
};

/**
 * S on a multi-instrument beat whose instruments were never input/clicked:
 * refused with the reason (T13's rule) — shown and announced, no write.
 */
export const GhostOnChordNeedsInstrument: Story = {
  args: { initialText: withDrums('\\section "A"\n:4 SD SD SD (HH SD) |') },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    staffOf(canvasElement).focus();
    await userEvent.keyboard('[KeyS]');
    expect(args.onChange).not.toHaveBeenCalled();
    // R6: shown as plain text and announced ONCE, by the live region only.
    expect(canvas.getByTestId('editor-error')).toHaveTextContent(
      'ゴースト・アクセントを付ける楽器が決まっていません',
    );
    expect(canvas.queryByRole('alert')).toBeNull();
    const live = canvas.getByTestId('staff-live');
    expect(live).toHaveTextContent(
      'ゴースト・アクセントを付ける楽器が決まっていません',
    );
    // The same refusal again changes the live text, so it is read again.
    const first = live.textContent;
    await userEvent.keyboard('[KeyS]');
    expect(live.textContent).not.toBe(first);
    expect(live).toHaveTextContent(
      'ゴースト・アクセントを付ける楽器が決まっていません',
    );
    // After Shift+F (SD becomes the last instrument… and is toggled off),
    // Shift+F again puts it back; now S targets SD.
    await userEvent.keyboard(shift('KeyF') + shift('KeyF') + '[KeyS]');
    expect(textOf(canvasElement)).toContain(':4 SD SD SD (HH SD{g}) |');
    expect(canvas.queryByTestId('editor-error')).toBeNull();
  },
};

/** A section outside the drum subset: notice, nothing editable. */
export const ReadOnlySection: Story = {
  args: { initialText: withDrums('\\section "A"\n:4 SD{gr} SD SD SD |') },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(/このセクションはアプリでは編集できません（理由: /),
    ).toBeInTheDocument();
    expect(canvas.queryByRole('application')).toBeNull();
    expect(canvas.getByTestId('mode-status')).toHaveTextContent('読み取り専用');
    expect(canvas.getByRole('button', { name: 'スネア（F）' })).toBeDisabled();
    expect(canvas.getByRole('button', { name: '休符' })).toBeDisabled();
    expect(canvas.getByRole('button', { name: 'ゴースト' })).toBeDisabled();
    expect(canvas.getByRole('button', { name: '8分' })).toBeDisabled();
    expect(canvas.getByRole('button', { name: '連符' })).toBeDisabled();
    const before = textOf(canvasElement);
    await userEvent.click(canvas.getByRole('img', { name: /読み取り専用/ }));
    await userEvent.keyboard('[KeyF][KeyJ]{Backspace}');
    expect(textOf(canvasElement)).toBe(before);
    expect(args.onChange).not.toHaveBeenCalled();
    // Section B (missing) is editable.
    await userEvent.click(canvas.getByRole('button', { name: 'B' }));
    expect(canvas.getByRole('application')).toBeInTheDocument();
  },
};

/** 4/4 beats, song switched to 3/4 → notice → 引き直す → editable. */
export const TimeChangeReflow: Story = {
  args: {
    initialText: withDrums('\\section "A"\n\\tf triplet8th\n:4 BD SD BD SD |'),
    setTimeTo: '3/4',
  },
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

    await userEvent.click(
      canvas.getByRole('button', { name: '新しい拍子で小節を引き直す' }),
    );
    const dialog = await canvas.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '引き直す' }),
    );
    expect(args.onChange).toHaveBeenCalledOnce();
    // Re-barred; the section's shuffle is kept.
    expect(textOf(canvasElement)).toContain(
      '\\section "A"\n\\tf triplet8th\n:4 BD SD BD |\nSD |',
    );
    expect(canvas.queryByText(/拍子が変わったため/)).toBeNull();
    expect(canvas.getByRole('application')).toBeInTheDocument();
    expect(canvas.getByTestId('staff-live')).toHaveTextContent(
      '小節を引き直しました',
    );
  },
};

/**
 * 3 quarters then an 8th-note triplet flush against the barline: a 16th
 * triplet at the very start would push it across → refused, shown and
 * announced.
 */
export const RejectedBarCrossingShowsMessage: Story = {
  args: {
    initialText: withDrums(
      '\\section "A"\n:4 BD SD BD :8 r{tu 3} r{tu 3} r{tu 3} |',
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const live = canvas.getByTestId('staff-live');
    const before = textOf(canvasElement);
    staffOf(canvasElement).focus();
    await userEvent.keyboard('{ArrowLeft}'.repeat(6));
    await userEvent.keyboard('[Digit6]');
    await pickTuplet(canvasElement, '3連符');
    expect(args.onChange).not.toHaveBeenCalled();
    expect(textOf(canvasElement)).toBe(before);
    expect(canvas.getByTestId('editor-error')).toHaveTextContent(
      '1 小節目の 3 連符が小節線をまたぎます',
    );
    expect(canvas.queryByRole('alert')).toBeNull();
    expect(live).toHaveTextContent('1 小節目の 3 連符が小節線をまたぎます');
    await waitFor(() => expect(staffOf(canvasElement)).toHaveFocus());
  },
};

const TWO_SECTIONS = withDrums(
  '\\section "A"\n:4 BD SD BD SD |\n\\section "B"\n:4 HH HH HH HH |',
);

/** Each section keeps its own cursor. */
export const SectionsKeepCursor: Story = {
  args: { initialText: TWO_SECTIONS },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const section = (name: string) =>
      userEvent.click(canvas.getByRole('button', { name }));
    staffOf(canvasElement).focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    await section('B');
    await section('A');
    staffOf(canvasElement).focus();
    await userEvent.keyboard('[Digit4][KeyU]');
    await waitFor(() =>
      expect(textOf(canvasElement)).toContain(
        '\\section "A"\n\\tf none\n:4 BD SD CR BD |\nSD |',
      ),
    );
    expect(args.onChange).toHaveBeenCalledOnce();
  },
};

/** `{time: 3/4}` with a 4/4 drum body (the review's R1 repros). */
const withDrums34 = (body: string) =>
  withDrums(body).replace('{time: 4/4}', '{time: 3/4}');

/**
 * R1: a half note crossing the new 3/4 barline used to throw in the staff
 * layout (whole app white). Now: notice + a drawable (cut) staff, and
 * 引き直す re-bars it.
 */
export const BarMismatchBeatCrossesBarline: Story = {
  args: { initialText: withDrums34('\\section "A"\n:2 SD SD |') },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(/拍子が変わったため小節が合いません（.+）/),
    ).toBeInTheDocument();
    expect(canvas.getByTestId('drum-staff-svg')).toBeInTheDocument();
    expect(canvas.getByTestId('head-0-SD')).toBeInTheDocument();
    expect(canvas.getByTestId('mode-status')).toHaveTextContent('読み取り専用');
    await userEvent.click(
      canvas.getByRole('button', { name: '新しい拍子で小節を引き直す' }),
    );
    const dialog = await canvas.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '引き直す' }),
    );
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(textOf(canvasElement)).toContain(':2 SD :4 SD |');
    expect(canvas.getByRole('application')).toBeInTheDocument();
  },
};

/** R1: the same thing typed by hand in 4/4 (`:4 SD :2 SD SD |`). */
export const BarMismatchHandTyped: Story = {
  args: { initialText: withDrums('\\section "A"\n:4 SD :2 SD SD |') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(/拍子が変わったため小節が合いません（.+）/),
    ).toBeInTheDocument();
    expect(canvas.getByTestId('drum-staff-svg')).toBeInTheDocument();
  },
};

/**
 * R1: a triplet that crosses the NEW barline is drawn as plain beats (no
 * crash); 引き直す cannot fix it and says why — shown and announced once.
 */
export const BarMismatchTupletCrossesBarline: Story = {
  args: {
    initialText: withDrums34(
      '\\section "A"\n:8 SD :4 SD SD :8 SD{tu 3} SD{tu 3} SD{tu 3} :8 SD |',
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('drum-staff-svg')).toBeInTheDocument();
    expect(canvas.queryByTestId('tuplet-3')).toBeNull();
    await userEvent.click(
      canvas.getByRole('button', { name: '新しい拍子で小節を引き直す' }),
    );
    const dialog = await canvas.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '引き直す' }),
    );
    expect(args.onChange).not.toHaveBeenCalled();
    expect(canvas.getByTestId('editor-error')).toHaveTextContent(
      '1 小節目の 3 連符が小節線をまたぎます',
    );
    expect(canvas.getByTestId('staff-live')).toHaveTextContent(
      '1 小節目の 3 連符が小節線をまたぎます',
    );
    expect(canvas.queryByRole('alert')).toBeNull();
  },
};

/**
 * R2: section B has no `\\tf` of its own, so alphaTab draws it with A's
 * shuffle — the editor shows that, and the first edit writes it explicitly.
 */
export const InheritedShuffle: Story = {
  args: {
    initialText: withDrums(
      '\\section "A"\n\\tf triplet8th\n:4 SD SD SD SD |\n\\section "B"\n:4 BD BD BD BD |',
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'B' }));
    expect(canvas.getByRole('button', { name: '8分' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(canvas.getByTestId('shuffle-mark')).toBeInTheDocument();
    staffOf(canvasElement).focus();
    await userEvent.keyboard('[KeyJ]');
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(textOf(canvasElement)).toContain(
      '\\section "B"\n\\tf triplet8th\n:4 BD BD BD BD |\n:8 BD |',
    );
  },
};

/**
 * R2: changing A's shuffle does not change how B (no `\\tf`) is drawn: B
 * gets its previous value written explicitly.
 */
export const ShuffleChangeKeepsLaterSection: Story = {
  args: {
    initialText: withDrums(
      '\\section "A"\n:4 SD SD SD SD |\n\\section "B"\n:4 BD BD BD BD |',
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '8分' }));
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(textOf(canvasElement)).toContain(
      '\\section "A"\n\\tf triplet8th\n:4 SD SD SD SD |\n\\section "B"\n\\tf none\n:4 BD BD BD BD |',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'B' }));
    expect(canvas.getByRole('button', { name: 'なし' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  },
};

/** R8: the mode line counts 「N 番目」 (not a musical 「拍目」). */
export const SelectedSaysBanme: Story = {
  args: { initialText: withDrums('\\section "A"\n:4 SD SD SD SD |') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    staffOf(canvasElement).focus();
    await userEvent.keyboard('{Enter}');
    expect(canvas.getByTestId('mode-status')).toHaveTextContent(
      '4 番目を選択中',
    );
    expect(canvas.getByTestId('staff-live')).toHaveTextContent(
      '選択中 4 番目: 4分 スネア',
    );
  },
};
