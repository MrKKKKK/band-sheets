import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { sampleSong } from '../../lib/fixtures/sampleSong';
import { parseSong } from '../../lib/parseSong';
import { replaceLine } from '../../lib/textEdit';
import { chordOffsets } from '../ChordLyricLine/alignment';
import { ChartPreview } from './ChartPreview';

const meta = {
  title: 'Chart/ChartPreview',
  parameters: { a11y: { test: 'error' } },
  component: ChartPreview,
  args: { song: sampleSong, onFixFullWidth: fn() },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 480, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChartPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

function expectAligned(root: HTMLElement, count: number) {
  const offsets = chordOffsets(root);
  expect(offsets).toHaveLength(count);
  for (const d of offsets) expect(Math.abs(d)).toBeLessThanOrEqual(1);
}

export const Sample: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('heading', { name: 'A verse' })).toBeVisible();
    expect(canvas.getByRole('heading', { name: 'B chorus' })).toBeVisible();
    expectAligned(canvasElement, 11);
  },
};

const edgeText = `# 自由なコメント行
[C]前置きの[G]行（見出しなし）

{start_of_verse: イントロ}
[(C)] [(E)] [(G)]
[N.C.]
{comment: ここはリフ}
{end_of_verse}

{start_of_chorus: サビ}
[Am]𠮷野家の[F]前で[G]待ち合わせて[C]そのまま夜が明けるまで歩き続けたいと思っていたあの頃の[Em7(b5)]ことを[A7]今も
[C]short [G]English [Am]lyrics [F]wrap like this when the line is long enough to wrap
[Fmaj7]

[C]空行の[G]あと
{end_of_chorus}

{start_of_bridge}
[D]ラベルなし
{end_of_bridge}
`;

export const EdgeCases: Story = {
  args: { song: parseSong(edgeText) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText('(E)')).toBeVisible();
    expect(canvas.getByText('N.C.')).toBeVisible();
    expect(canvas.getByText('Fmaj7')).toBeVisible();
    expect(canvas.getByText('{comment: ここはリフ}')).toBeVisible();
    expect(canvas.getByRole('heading', { name: 'bridge' })).toBeVisible();
    // Implicit section: no heading.
    expect(canvas.getAllByRole('heading')).toHaveLength(3);
    // Chord-only segments are skipped; "[(C)] " has lyrics " ".
    const offsets = chordOffsets(canvasElement);
    expect(offsets.length).toBeGreaterThanOrEqual(15);
    for (const d of offsets) expect(Math.abs(d)).toBeLessThanOrEqual(1);
  },
};

export const Narrow: Story = {
  ...EdgeCases,
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
};

/** Dash lines (§3.6): monospace; a line that fails validation gets a warning. */
export const DashLines: Story = {
  args: {
    song: parseSong(
      [
        '{title: t}',
        '{time: 4/4}',
        '{start_of_verse: A}',
        '|[C]--------|[C]----[F]----|[G]--------|[G]----[G7]----|',
        '|[C]--------|[C]---[F]----|[G]---------|[N.C.]--------|',
        '[C]きらきら[F]ひかる',
        '{end_of_verse}',
        '',
      ].join('\n'),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByTestId('dash-warning-0-0')).toBeNull();
    const w = canvas.getByTestId('dash-warning-0-1');
    expect(w).toHaveTextContent('2小節目');
    expect(w).toHaveTextContent('3小節目');
    expect(w).not.toHaveAttribute('role');
    expect(canvas.queryByTestId('dash-warning-0-2')).toBeNull();
    expect(getComputedStyle(canvas.getByTestId('line-0-0')).fontFamily).toMatch(
      /mono/i,
    );
  },
};

const fullWidthText = [
  '{title: t}',
  '{time: 4/4}',
  '{start_of_verse: A}',
  '｜[C]ーーーーーーーー｜[G]ーーーーーーーー｜',
  '[C]ひかるー[G]ほしー',
  '｜[C]ーーーーーーーー｜[G]ーーーーーーーー｜',
  '{end_of_verse}',
  '',
].join('\n');

function FullWidthHarness({ onFix }: { onFix: (t: string) => void }) {
  const [text, setText] = useState(fullWidthText);
  return (
    <ChartPreview
      song={parseSong(text)}
      onFixFullWidth={(from, to, occurrence) => {
        const edit = replaceLine(text, from, to, occurrence, 0);
        if (!edit) return;
        onFix(edit.text);
        setText(edit.text);
      }}
    />
  );
}

/** Full-width ｜ ー lines get a warning + 「半角に直す」; lyric lines with 「ー」 do not. */
export const FullWidthWarning: Story = {
  render: () => <FullWidthHarness onFix={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const w0 = canvas.getByTestId('fullwidth-warning-0-0');
    expect(w0).toHaveTextContent('全角の記号があります（｜ ー －）。');
    expect(w0).not.toHaveAttribute('role');
    expect(canvas.queryByTestId('fullwidth-warning-0-1')).toBeNull();
    expect(canvas.getByTestId('fullwidth-warning-0-2')).toBeVisible();
    // Fix only the second identical line.
    await userEvent.click(
      within(canvas.getByTestId('fullwidth-warning-0-2')).getByRole('button', {
        name: '半角に直す',
      }),
    );
    expect(canvas.queryByTestId('fullwidth-warning-0-2')).toBeNull();
    expect(canvas.getByTestId('fullwidth-warning-0-0')).toBeVisible();
    expect(canvas.getByTestId('line-0-2')).toHaveTextContent(
      '|C--------|G--------|',
    );
    expect(canvas.getByTestId('line-0-1')).toHaveTextContent('ひかるー');
  },
};
