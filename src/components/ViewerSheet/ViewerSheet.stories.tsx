import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, fireEvent, waitFor, within } from 'storybook/test';
import {
  chartOnlySongText,
  unreadablePartSongText,
  viewerSongText,
} from '../../lib/fixtures/viewerFixtures';
import { parseSong } from '../../lib/parseSong';
import type { ViewerLayout } from '../../lib/viewerSettings';
import {
  sheetAnchorAt,
  sheetAnchorY,
  type SheetAnchor,
  type SheetLayout,
} from './sheetModel';
import { ViewerSheet } from './ViewerSheet';

interface HarnessProps {
  text: string;
  layout: ViewerLayout;
  part: string | null;
  scoreHidden: string[];
  scoreChart: boolean;
  zoom: number;
  playingSection?: string;
}

/**
 * The sheet in a 1194px (tablet landscape) frame. The latest reported
 * layout is kept in `data-layout` for the play functions; 「拡大」 zooms to
 * 1.4 after remembering the reading anchor at 60% of the sheet's height.
 */
function Harness({ text, zoom: initialZoom, ...rest }: HarnessProps) {
  const song = useMemo(() => parseSong(text), [text]);
  const [zoom, setZoom] = useState(initialZoom);
  const [layout, setLayout] = useState<SheetLayout | null>(null);
  const [anchor, setAnchor] = useState<SheetAnchor | null>(null);
  return (
    <div
      data-testid="harness"
      data-layout={layout ? JSON.stringify(layout) : ''}
      data-anchor={anchor ? JSON.stringify(anchor) : ''}
      style={{ width: 1194, background: 'var(--bg)' }}
    >
      <button
        type="button"
        onClick={() => {
          if (layout) {
            const last = layout.units.at(-1)!;
            setAnchor(sheetAnchorAt(layout.units, 0.6 * last.top));
          }
          setZoom(1.4);
        }}
      >
        拡大
      </button>
      <ViewerSheet song={song} zoom={zoom} onLayout={setLayout} {...rest} />
    </div>
  );
}

const meta = {
  title: 'Viewer/ViewerSheet',
  component: Harness,
  parameters: {
    // Repeated sections get unique region names ("A（2回目）") on both the
    // chart blocks and the sheet's own rows, so landmark-unique stays on.
    a11y: { test: 'error' },
  },
  args: {
    text: viewerSongText,
    layout: 'part',
    part: 'Vocal',
    scoreHidden: [],
    scoreChart: true,
    zoom: 1,
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

const readLayout = (root: HTMLElement): SheetLayout | null => {
  const raw = within(root).getByTestId('harness').dataset.layout;
  return raw ? (JSON.parse(raw) as SheetLayout) : null;
};

/** Waits until every score has rendered and the units have settled. */
async function waitReady(root: HTMLElement): Promise<SheetLayout> {
  await waitFor(() => expect(readLayout(root)?.ready).toBe(true), {
    timeout: 20000,
  });
  // A second postRenderFinished (font load) may still re-report.
  await new Promise((r) => setTimeout(r, 400));
  const l = readLayout(root)!;
  expect(l.ready).toBe(true);
  return l;
}

/** Units are in order and never overlap (pagination relies on it). */
function checkUnits(l: SheetLayout) {
  for (let i = 1; i < l.units.length; i++) {
    const a = l.units[i - 1];
    expect(a.height, a.id).toBeGreaterThan(0);
    expect(a.top + a.height, `${a.id} / ${l.units[i].id}`).toBeLessThanOrEqual(
      l.units[i].top + 0.5,
    );
  }
  for (let i = 1; i < l.timedUnits.length; i++) {
    expect(l.timedUnits[i].top).toBeGreaterThanOrEqual(l.timedUnits[i - 1].top);
  }
}

const block = (root: HTMLElement, label: string, nth = 0) =>
  [...root.querySelectorAll<HTMLElement>('[data-block]')].filter((b) =>
    b.dataset.block!.endsWith(`-${label}`),
  )[nth];

const barNumbers = (el: HTMLElement) =>
  within(el)
    .getAllByTestId('bar-number')
    .map((n) => Number(n.textContent));

export const PartLayout: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const l = await waitReady(canvasElement);
    checkUnits(l);

    // Part-level \lyrics of Vocal is dropped, with a note.
    expect(c.getByTestId('sheet-lyrics-note')).toHaveTextContent('Vocal');
    expect(c.queryByTestId('sheet-errors')).toBeNull();

    // Chart + the Vocal staff per section, bar numbers song-wide.
    const a2 = block(canvasElement, 'A', 1);
    expect(within(a2).getAllByTestId('section-score')).toHaveLength(1);
    expect(barNumbers(a2)[0]).toBe(10);
    expect(barNumbers(block(canvasElement, 'C'))[0]).toBe(14);

    // The last chart line of A keeps with A's first system.
    const aUnits = l.units.filter((u) => u.section === l.units[1].section);
    const lastLine = aUnits.filter((u) => u.id.startsWith('line:')).at(-1)!;
    expect(lastLine.keepWithNext).toBe(true);
    expect(aUnits[aUnits.indexOf(lastLine) + 1].id).toMatch(/^score:/);

    // Fill has no Vocal and no chart: a placeholder carries its bar.
    const fill = block(canvasElement, 'Fill');
    expect(fill).toHaveTextContent('1 小節');
    const fillTimed = l.timedUnits.filter((u) => u.section.endsWith('-Fill'));
    expect(fillTimed).toHaveLength(1);
    expect(fillTimed[0].bars).toHaveLength(1);

    // Every bar of the song is timed exactly once (4+4+1+4+2).
    expect(l.timedUnits.reduce((n, u) => n + u.bars.length, 0)).toBe(15);

    // One credit for the whole sheet, alphaTab's own lines are cut off.
    expect(
      canvasElement.querySelectorAll('[data-sheet-tail="credit"]'),
    ).toHaveLength(1);
    for (const t of canvasElement.querySelectorAll('svg text')) {
      if (t.textContent !== 'rendered by alphaTab') continue;
      const score = t.closest('[data-testid="section-score"]')!;
      expect(t.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        score.getBoundingClientRect().bottom - 1,
      );
    }
    expect(l.units.at(-1)!.id).toBe('credit');
  },
};

export const ScoreLayout: Story = {
  args: { layout: 'score' },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const l = await waitReady(canvasElement);
    checkUnits(l);
    // Shuffle on the drum staff of B and the drum-only Fill, "Straight"
    // where the repeated A returns to straight; never on C.
    const marks = (label: string, nth = 0) =>
      within(block(canvasElement, label, nth))
        .queryAllByTestId('shuffle-mark')
        .map((m) => m.dataset.shuffle);
    expect(marks('B')).toEqual(['8']);
    expect(marks('Fill')).toEqual(['8']);
    expect(marks('A', 1)).toEqual(['none']);
    expect(marks('C')).toEqual([]);
    expect(marks('A', 0)).toEqual([]);
    // Fill: score only → its label sits in the score row's gutter.
    expect(c.getByRole('region', { name: 'Fill' })).toBeVisible();
    expect(l.timedUnits.reduce((n, u) => n + u.bars.length, 0)).toBe(15);
  },
};

export const ScoreWithoutChartAndDrums: Story = {
  args: { layout: 'score', scoreChart: false, scoreHidden: ['Drums'] },
  play: async ({ canvasElement }) => {
    const l = await waitReady(canvasElement);
    checkUnits(l);
    expect(l.units.some((u) => u.id.startsWith('line:'))).toBe(false);
    expect(
      within(canvasElement).getByRole('region', { name: 'A（2回目）' }),
    ).toBeVisible();
    expect(canvasElement.querySelector('[data-chart]')).toBeNull();
    // Hidden drums: Fill is a placeholder; bar numbers are unchanged.
    expect(block(canvasElement, 'Fill')).toHaveTextContent('1 小節');
    expect(barNumbers(block(canvasElement, 'C'))[0]).toBe(14);
    expect(within(canvasElement).queryAllByTestId('shuffle-mark')).toHaveLength(
      0,
    );
  },
};

export const ChartOnly: Story = {
  args: { text: chartOnlySongText, part: null },
  play: async ({ canvasElement }) => {
    const l = await waitReady(canvasElement);
    checkUnits(l);
    // Bars estimated from the chords (one per chord), in 3/4.
    expect(l.timedUnits.map((u) => u.bars.length)).toEqual([3, 2]);
    expect(l.timedUnits[0].bars[0]).toEqual({ num: 3, den: 4 });
    // No score: no credit, no keep-with-next.
    expect(
      canvasElement.querySelector('[data-sheet-tail="credit"]'),
    ).toBeNull();
    expect(l.units.some((u) => u.keepWithNext)).toBe(false);
  },
};

export const UnreadablePart: Story = {
  args: { text: unreadablePartSongText, layout: 'score' },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const l = await waitReady(canvasElement);
    expect(c.getByTestId('sheet-errors')).toHaveTextContent(
      'Guitar は読み込めませんでした（テキスト入力で確認してください）',
    );
    expect(l.units[0].id).toBe('notice:0');
    expect(c.getAllByTestId('section-score')).toHaveLength(1);
  },
};

export const Playing: Story = {
  args: { layout: 'score', playingSection: '1-B' },
  play: async ({ canvasElement }) => {
    await waitReady(canvasElement);
    const b = block(canvasElement, 'B');
    expect(b).toHaveAttribute('data-playing');
    expect(within(b).getByTestId('section-mark')).toHaveAttribute(
      'data-playing',
    );
    expect(block(canvasElement, 'A')).not.toHaveAttribute('data-playing');
  },
};

/** Zoom re-lays out every score and the reading anchor maps back. */
export const ZoomKeepsAnchor: Story = {
  args: { layout: 'score' },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const before = await waitReady(canvasElement);
    const height = (l: SheetLayout) =>
      l.units.at(-1)!.top + l.units.at(-1)!.height;
    fireEvent.click(c.getByRole('button', { name: '拡大' }));
    await waitFor(
      () => {
        const l = readLayout(canvasElement)!;
        expect(l.ready).toBe(true);
        expect(height(l)).toBeGreaterThan(height(before) * 1.2);
      },
      { timeout: 20000 },
    );
    const after = await waitReady(canvasElement);
    checkUnits(after);
    const anchor = JSON.parse(
      c.getByTestId('harness').dataset.anchor!,
    ) as SheetAnchor;
    const y = sheetAnchorY(after.units, anchor);
    const unit = after.units.find((u) => y >= u.top && y < u.top + u.height)!;
    expect(unit.section).toBe(anchor.section);
    if (anchor.bar !== undefined) {
      expect(unit.bars!.start).toBeLessThanOrEqual(anchor.bar);
      expect(anchor.bar).toBeLessThan(unit.bars!.start + unit.bars!.count);
    }
    // Chart text follows the zoom too.
    const lyric = canvasElement.querySelector('[data-testid^="seg-"]')!;
    expect(parseFloat(getComputedStyle(lyric).fontSize)).toBeCloseTo(30.8, 0);
  },
};
