import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { parseChordLine } from '../../lib/parseSong';
import { ChordLyricLine } from './ChordLyricLine';
import { chordOffsets } from './alignment';

const meta = {
  title: 'Chart/ChordLyricLine',
  parameters: { a11y: { test: 'error' } },
  component: ChordLyricLine,
  args: {
    line: { segments: parseChordLine('[C]きらきら[F]ひか[C]る') },
    lineKey: '0-0',
  },
} satisfies Meta<typeof ChordLyricLine>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryAllByRole('button')).toHaveLength(0);
    const offsets = chordOffsets(canvasElement);
    expect(offsets).toHaveLength(3);
    for (const d of offsets) expect(Math.abs(d)).toBeLessThanOrEqual(1);
  },
};

export const LeadingLyricsAndLongChord: Story = {
  args: {
    line: {
      segments: parseChordLine('あの[C7(9,13)]る[Fmaj7]ひかり[N.C.]'),
    },
  },
};

export const Editable: Story = {
  args: { onCharClick: fn(), onChordClick: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const chars = canvas.getAllByRole('button', { name: /文字目/ });
    expect(chars).toHaveLength(7);
    for (const b of chars)
      expect(b.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

    await userEvent.click(
      canvas.getByRole('button', { name: '5文字目「ひ」にコードを置く' }),
    );
    expect(args.onCharClick).toHaveBeenLastCalledWith(4, expect.anything());

    await userEvent.click(
      canvas.getByRole('button', { name: '行末にコードを置く' }),
    );
    expect(args.onCharClick).toHaveBeenLastCalledWith(7, expect.anything());

    const chord = canvas.getByRole('button', { name: 'コード F を編集' });
    expect(chord.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(chord);
    expect(args.onChordClick).toHaveBeenCalledOnce();
    expect(args.onChordClick).toHaveBeenCalledWith(1, expect.anything());

    for (const d of chordOffsets(canvasElement))
      expect(Math.abs(d)).toBeLessThanOrEqual(1);
  },
};

export const ActiveChar: Story = {
  args: { onCharClick: fn(), activeCharIndex: 2 },
};

export const ActiveLineEnd: Story = {
  args: { onCharClick: fn(), activeCharIndex: 7 },
};

export const SurrogatePair: Story = {
  args: {
    line: { segments: parseChordLine('[Am]𠮷野家の[G]𠮷') },
    onCharClick: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getAllByRole('button', { name: /文字目/ })).toHaveLength(5);
    await userEvent.click(
      canvas.getByRole('button', { name: '5文字目「𠮷」にコードを置く' }),
    );
    expect(args.onCharClick).toHaveBeenLastCalledWith(4, expect.anything());
    await userEvent.click(
      canvas.getByRole('button', { name: '行末にコードを置く' }),
    );
    expect(args.onCharClick).toHaveBeenLastCalledWith(5, expect.anything());
  },
};

export const GraphemeClusters: Story = {
  args: {
    line: {
      segments: [
        // NFD 'が': base 'か' + combining dakuten U+3099 (one grapheme, two
        // code points) — `Array.from` would wrongly split it in two.
        { lyrics: 'が' },
        // 👍🏽: thumbs-up + skin-tone modifier (one grapheme, two code points).
        { chord: 'C', lyrics: '👍\u{1F3FD}' },
        // 👨‍👩‍👧: ZWJ family sequence (one grapheme, five code points).
        { lyrics: '👨‍👩‍👧' },
      ],
    },
    onCharClick: fn(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // One character button per grapheme cluster (3), not per code point
    // (which would be 2 + 2 + 5 = 9) — R8.
    expect(canvas.getAllByRole('button', { name: /文字目/ })).toHaveLength(3);

    const ga = canvas.getByTestId('char-0-0-0');
    expect(ga).toHaveTextContent('が');
    expect(ga).toHaveAttribute('aria-label', '1文字目「が」にコードを置く');

    const thumb = canvas.getByTestId('char-0-0-1');
    expect(thumb).toHaveTextContent('👍\u{1F3FD}');

    const family = canvas.getByTestId('char-0-0-2');
    expect(family).toHaveTextContent('👨‍👩‍👧');

    await userEvent.click(family);
    expect(canvas.getByTestId('char-0-0-3')).toHaveAttribute(
      'aria-label',
      '行末にコードを置く',
    );
  },
};

export const ChordOnlyEditable: Story = {
  args: {
    line: { segments: parseChordLine('[(C)] [(E)] [(G)]') },
    onCharClick: fn(),
    onChordClick: fn(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const c of ['(C)', '(E)', '(G)'])
      expect(
        canvas.getByRole('button', { name: `コード ${c} を編集` }),
      ).toBeVisible();
  },
};

/** Dash notation (docs/audio-integration-plan.md §3.6): chords over `-` / `=`. */
export const DashLine: Story = {
  args: {
    line: {
      segments: parseChordLine(
        '|[C]--------|[C]----[F]----|[G]--------|[G]----[G7]----|',
      ),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryAllByRole('button')).toHaveLength(0);
    expect(canvas.getAllByTestId(/^chord-/)).toHaveLength(6);
  },
};

export const DashLinesStacked: Story = {
  render: () => (
    <div>
      {[
        '|[C]--------|[C]----[F]----|[G]--------|[G]----[G7]----|',
        '|[Dm]---[Am7]- --[Abm7]--|[Cmaj7(9,13)]----[F#m7b5]----|[G]--------|[N.C.]--------|',
        '|[C]=-------[G]=-------|[Am]----[F]----|[G]----[C]----|[C]--------|',
        '| [C][G] |[F]--------|--------|[Am?]----[G]----|',
      ].map((t, i) => (
        <ChordLyricLine
          key={i}
          line={{ segments: parseChordLine(t) }}
          lineKey={`d-${i}`}
        />
      ))}
    </div>
  ),
};
