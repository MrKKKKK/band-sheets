import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { parseSong } from '../../lib/parseSong';
import { ViewerChartBlock } from './ViewerChartBlock';

const song = parseSong(`{start_of_verse: A}
[C]きらきら[F]ひか[C]る
[F]おそらの[G7]ほしよ
{end_of_verse}
{start_of_chorus: サビ}
[C] [G7] [C]
{end_of_chorus}
うたの[Am]まえ
`);

const meta = {
  title: 'Viewer/ViewerChartBlock',
  parameters: { a11y: { test: 'error' } },
  component: ViewerChartBlock,
  args: { section: song.chart[0], sectionKey: '0' },
  decorators: [
    (Story) => (
      <div style={{ width: 1000, padding: 'var(--space-4)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ViewerChartBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Labeled: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('region', { name: 'A' })).toBeVisible();
    expect(canvas.getByTestId('section-mark')).toHaveTextContent('A');
    expect(canvas.getByTestId('chord-0-0-0')).toHaveTextContent('C');
    const units = canvasElement.querySelectorAll('[data-unit]');
    expect(units).toHaveLength(2);
    expect(units[0]).not.toHaveAttribute('data-keep-with-next');
    expect(units[1]).toHaveAttribute('data-keep-with-next');
    expect(units[0].getBoundingClientRect().height).toBeGreaterThan(0);
  },
};

export const Playing: Story = {
  args: { playing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('section-mark')).toHaveAttribute('data-playing');
    expect(canvas.getByRole('region', { name: 'A' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  },
};

export const Zoomed: Story = {
  args: { fontSize: '30.8px' },
  play: async ({ canvasElement }) => {
    const unit = canvasElement.querySelector('[data-unit]') as HTMLElement;
    const big = unit.getBoundingClientRect().height;
    const lyric = canvasElement.querySelector(
      '[data-testid="seg-0-0-0"]',
    ) as HTMLElement;
    expect(parseFloat(getComputedStyle(lyric).fontSize)).toBeCloseTo(30.8, 0);
    // Rows are em-based too, so a line is taller than at the 22px default (~58px).
    expect(big).toBeGreaterThan(70);
  },
};

/** The rehearsal-mark box grows with the zoom (36px at 22px). */
export const ZoomedGutter: Story = {
  args: { fontSize: '30.8px' },
  play: async ({ canvasElement }) => {
    const mark = within(canvasElement).getByTestId('section-mark');
    expect(mark.getBoundingClientRect().height).toBeCloseTo(50.4, 0);
    const gutter = mark.parentElement!;
    expect(gutter.getBoundingClientRect().width).toBeCloseTo(50.4, 0);
  },
};

/** A repeated section gets its own region name from the sheet. */
export const AriaLabelOverride: Story = {
  args: { ariaLabel: 'A（2回目）' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('region', { name: 'A（2回目）' })).toBeVisible();
    // The visible mark keeps the plain label.
    expect(canvas.getByTestId('section-mark')).toHaveTextContent(/^A$/);
  },
};

export const Unlabeled: Story = {
  args: { section: song.chart[2], sectionKey: '2' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByTestId('section-mark')).toBeNull();
    expect(canvas.queryByRole('region')).toBeNull();
    // The gutter keeps its width without a label.
    const gutter = canvasElement.querySelector('[aria-hidden="true"]');
    expect(gutter?.getBoundingClientRect().width).toBeGreaterThan(30);
  },
};

export const ChordOnlyAndRaw: Story = {
  args: { section: song.chart[1], sectionKey: '1' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('section-mark')).toHaveTextContent('サビ');
    expect(canvasElement.querySelectorAll('[data-unit]')).toHaveLength(1);
  },
};

/** Dash lines are monospace and never show validation warnings in the viewer. */
export const DashLines: Story = {
  args: {
    section: parseSong(
      [
        '{start_of_verse: A}',
        '|[C]--------|[C]----[F]----|[G]--------|[G]----[G7]----|',
        '|[C]--------|[C]---[F]----|[G]---------|[N.C.]--------|',
        '[C]きらきら[F]ひかる',
        '{end_of_verse}',
        '',
      ].join('\n'),
    ).chart[0],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByText(/小節目/)).toBeNull();
    expect(getComputedStyle(canvas.getByTestId('line-0-0')).fontFamily).toMatch(
      /mono/i,
    );
  },
};
