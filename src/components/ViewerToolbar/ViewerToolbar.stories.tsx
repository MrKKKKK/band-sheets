import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { NavMode, ViewerLayout } from '../../lib/viewerSettings';
import { ViewerToolbar } from './ViewerToolbar';

const PARTS = ['ギター', 'ベース', 'ドラム'];
const STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4];

type SpyProps = {
  onBack: () => void;
  onPlayMode: () => void;
  onOpenSettings: () => void;
  onPartChange: (p: string | null) => void;
  onLayoutChange: (l: ViewerLayout) => void;
  onNavChange: (n: NavMode) => void;
  onScoreHiddenChange: (h: string[]) => void;
  onScoreChartChange: (on: boolean) => void;
  onTransposeChange: (n: number) => void;
  initialTranspose?: number;
  songKey?: string;
  initialLayout?: ViewerLayout;
  initialZoomIndex?: number;
  /** Width of the frame around the bar (default: wide enough for the full bar). */
  frameWidth?: number;
  title?: string;
};

function Demo(spy: SpyProps) {
  const [layout, setLayout] = useState<ViewerLayout>(
    spy.initialLayout ?? 'part',
  );
  const [part, setPart] = useState<string | null>('ドラム');
  const [hidden, setHidden] = useState<string[]>([]);
  const [chart, setChart] = useState(true);
  const [nav, setNav] = useState<NavMode>('page');
  const [tr, setTr] = useState(spy.initialTranspose ?? 0);
  const [zi, setZi] = useState(spy.initialZoomIndex ?? 2);
  return (
    <div style={{ width: spy.frameWidth ?? 1700 }}>
      <ViewerToolbar
        title={spy.title ?? 'きらきら星'}
        layout={layout}
        onLayoutChange={(l) => {
          spy.onLayoutChange(l);
          setLayout(l);
        }}
        partNames={PARTS}
        part={part}
        onPartChange={(p) => {
          spy.onPartChange(p);
          setPart(p);
        }}
        scoreHidden={hidden}
        onScoreHiddenChange={(h) => {
          spy.onScoreHiddenChange(h);
          setHidden(h);
        }}
        scoreChart={chart}
        onScoreChartChange={(on) => {
          spy.onScoreChartChange(on);
          setChart(on);
        }}
        nav={nav}
        onNavChange={(n) => {
          spy.onNavChange(n);
          setNav(n);
        }}
        fontPx={Math.round(22 * STEPS[zi])}
        canZoomOut={zi > 0}
        canZoomIn={zi < STEPS.length - 1}
        onZoomOut={() => setZi((i) => Math.max(0, i - 1))}
        onZoomIn={() => setZi((i) => Math.min(STEPS.length - 1, i + 1))}
        transpose={tr}
        onTransposeChange={(n) => {
          spy.onTransposeChange(n);
          setTr(n);
        }}
        songKey={'songKey' in spy ? spy.songKey : 'C'}
        onBack={spy.onBack}
        onPlayMode={spy.onPlayMode}
        onOpenSettings={spy.onOpenSettings}
      />
    </div>
  );
}

const meta = {
  title: 'Viewer/ViewerToolbar',
  component: Demo,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    onBack: fn(),
    onPlayMode: fn(),
    onOpenSettings: fn(),
    onPartChange: fn(),
    onLayoutChange: fn(),
    onNavChange: fn(),
    onTransposeChange: fn(),
    onScoreHiddenChange: fn(),
    onScoreChartChange: fn(),
  },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PartLayout: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: /編集に戻る/ }));
    await expect(args.onBack).toHaveBeenCalledOnce();
    await userEvent.click(c.getByRole('button', { name: '演奏モード' }));
    await expect(args.onPlayMode).toHaveBeenCalledOnce();
    await userEvent.click(c.getByRole('button', { name: '設定' }));
    await expect(args.onOpenSettings).toHaveBeenCalledOnce();

    await userEvent.click(c.getByRole('button', { name: 'スクロール' }));
    await expect(args.onNavChange).toHaveBeenCalledWith('scroll');

    const trigger = c.getByRole('button', { name: /パート: ドラム/ });
    await userEvent.click(trigger);
    const dialog = within(c.getByRole('dialog', { name: '自分のパート' }));
    await expect(
      dialog.getByRole('button', { name: 'ドラム' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(dialog.getByRole('button', { name: 'コード譜だけ' }));
    await expect(args.onPartChange).toHaveBeenCalledWith(null);
    await expect(
      c.getByRole('button', { name: /パート: コード譜だけ/ }),
    ).toBeVisible();
    await expect(c.queryByRole('dialog')).toBeNull();
  },
};

export const ScoreLayout: Story = {
  args: { initialLayout: 'score' },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.queryByRole('button', { name: /パート:/ })).toBeNull();
    const group = within(c.getByRole('group', { name: '表示するパート' }));
    await expect(group.getByRole('button', { name: 'ベース' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(group.getByRole('button', { name: 'ベース' }));
    await expect(args.onScoreHiddenChange).toHaveBeenCalledWith(['ベース']);
    await expect(group.getByRole('button', { name: 'ベース' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(group.getByRole('button', { name: 'コード譜' }));
    await expect(args.onScoreChartChange).toHaveBeenCalledWith(false);
    await userEvent.click(
      c.getByRole('button', { name: '自分のパート＋コード譜' }),
    );
    await expect(args.onLayoutChange).toHaveBeenCalledWith('part');
  },
};

export const ZoomLimits: Story = {
  args: { initialZoomIndex: 0 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const out = c.getByRole('button', { name: '文字を小さく' });
    const inn = c.getByRole('button', { name: '文字を大きく' });
    await expect(c.getByTestId('font-px')).toHaveTextContent('18px');
    await expect(out).toBeDisabled();
    await userEvent.click(inn);
    await expect(c.getByTestId('font-px')).toHaveTextContent('20px');
    await expect(out).toBeEnabled();
  },
};

export const TouchTargets: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    for (const b of c.getAllByRole('button')) {
      const r = b.getBoundingClientRect();
      await expect(r.height).toBeGreaterThanOrEqual(44);
      await expect(r.width).toBeGreaterThanOrEqual(44);
    }
  },
};

/** At the target tablet width (1194px) nothing wraps and the title stays readable. */
async function expectFits(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  for (const b of c.getAllByRole('button')) {
    const r = b.getBoundingClientRect();
    await expect(r.height, b.textContent ?? '').toBeLessThan(60);
    await expect(r.height).toBeGreaterThanOrEqual(44);
  }
  const bar = c.getByRole('banner');
  await expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
  const title = c.getByRole('heading', { name: /./ });
  await expect(title).toBeVisible();
  await expect(title.getBoundingClientRect().width).toBeGreaterThanOrEqual(48);
  await expect(c.queryByRole('group', { name: 'ページの進め方' })).toBeNull();
  await expect(c.queryByRole('group', { name: '文字の大きさ' })).toBeNull();
}

const LONG = 'とても長い曲名のサンプル その二 (ライブ・アレンジ版)';

export const Tablet1194Part: Story = {
  args: { frameWidth: 1194, title: LONG },
  parameters: { viewport: { defaultViewport: 'tablet' } },
  play: async ({ canvasElement }) => {
    await expectFits(canvasElement);
    await expect(
      within(canvasElement).getByRole('heading', { name: LONG }),
    ).toHaveAttribute('title', LONG);
  },
};

export const Tablet1194Score: Story = {
  args: { frameWidth: 1194, initialLayout: 'score', title: LONG },
  play: async ({ canvasElement }) => {
    await expectFits(canvasElement);
    const c = within(canvasElement);
    await expect(c.queryByRole('group', { name: '表示するパート' })).toBeNull();
    await userEvent.click(c.getByRole('button', { name: /^パート/ }));
    const dialog = within(c.getByRole('dialog', { name: '表示するパート' }));
    await userEvent.click(dialog.getByRole('button', { name: 'ベース' }));
    await expect(
      dialog.getByRole('button', { name: 'ベース' }),
    ).toHaveAttribute('aria-pressed', 'false');
  },
};

const val = (c: ReturnType<typeof within>) => c.getByTestId('transpose-value');

/** Wide bar: the side buttons show the RESULTING value; reset is explicit. */
export const TransposeWide: Story = {
  args: { frameWidth: 2100 },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const reset = c.getByRole('button', { name: '原曲キーに戻す' });
    await expect(val(c)).toHaveTextContent('0');
    await expect(c.getByTestId('transpose-down')).toHaveTextContent('−1');
    await expect(c.getByTestId('transpose-up')).toHaveTextContent('+1');
    await expect(c.getByTestId('transpose-key')).toHaveTextContent('キー C');
    await expect(reset).toBeDisabled();
    for (let i = 0; i < 3; i++)
      await userEvent.click(c.getByTestId('transpose-up'));
    await expect(args.onTransposeChange).toHaveBeenLastCalledWith(3);
    await expect(c.getByTestId('transpose-down')).toHaveTextContent('+2');
    await expect(c.getByTestId('transpose-up')).toHaveTextContent('+4');
    await expect(c.getByTestId('transpose-key')).toHaveTextContent(
      'キー C → E♭（+3）',
    );
    await expect(reset).toBeEnabled();
    // The middle value is display-only: clicking it does nothing.
    await userEvent.click(val(c));
    await expect(val(c)).toHaveTextContent('+3');
    await userEvent.click(reset);
    await expect(args.onTransposeChange).toHaveBeenLastCalledWith(0);
    await expect(val(c)).toHaveTextContent('0');
    await expect(reset).toBeDisabled();
  },
};

export const TransposeLimits: Story = {
  args: { initialTranspose: 6, frameWidth: 2100 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByTestId('transpose-up')).toBeDisabled();
    await expect(c.getByTestId('transpose-down')).toBeEnabled();
    await expect(c.getByTestId('transpose-key')).toHaveTextContent(
      'キー C → F♯（+6）',
    );
    await userEvent.click(c.getByRole('button', { name: '原曲キーに戻す' }));
    await userEvent.click(c.getByTestId('transpose-down'));
    await userEvent.click(c.getByTestId('transpose-down'));
    await expect(val(c)).toHaveTextContent('−2');
  },
};

export const TransposeNoKey: Story = {
  args: { songKey: undefined, frameWidth: 2100 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.queryByTestId('transpose-key')).toBeNull();
    await expect(val(c)).toHaveTextContent('0');
  },
};

/** Between 1600px and the inline width the popover is used as well. */
export const TransposePopoverAt1700: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() =>
      expect(c.queryByTestId('transpose-control')).toBeNull(),
    );
    await expect(c.getByTestId('transpose-button')).toBeVisible();
    const bar = c.getByRole('banner');
    await expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
  },
};

/** Compact bar: 「移調 −2 ▾」 opens the stepper; reset names the original key. */
export const TransposeCompact: Story = {
  args: { frameWidth: 1194, initialTranspose: -2 },
  play: async ({ canvasElement, args }) => {
    await expectFits(canvasElement);
    const c = within(canvasElement);
    await expect(c.queryByTestId('transpose-control')).toBeNull();
    await userEvent.click(c.getByRole('button', { name: /^移調 −2/ }));
    const dialog = within(c.getByRole('dialog', { name: '移調' }));
    await expect(dialog.getByTestId('transpose-down')).toHaveTextContent('−3');
    await expect(dialog.getByTestId('transpose-up')).toHaveTextContent('−1');
    await expect(dialog.getByTestId('transpose-key')).toHaveTextContent(
      'キー C → B♭（−2）',
    );
    await userEvent.click(dialog.getByTestId('transpose-up'));
    await expect(args.onTransposeChange).toHaveBeenLastCalledWith(-1);
    await userEvent.click(
      dialog.getByRole('button', { name: '原曲キーに戻す（C）' }),
    );
    await expect(args.onTransposeChange).toHaveBeenLastCalledWith(0);
    await expect(c.getByRole('button', { name: '移調' })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: '原曲キーに戻す（C）' }),
    ).toBeDisabled();
  },
};
