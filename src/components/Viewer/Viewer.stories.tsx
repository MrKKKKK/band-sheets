import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import {
  chartOnlySongText,
  viewerSongText,
} from '../../lib/fixtures/viewerFixtures';
import { parseSong } from '../../lib/parseSong';
import {
  createMemoryStorage,
  viewerSettingsKey,
  type KeyValueStorage,
} from '../../lib/storage';
import type { ViewerSettings } from '../../lib/viewerSettings';
import { Viewer } from './Viewer';
import { createManualClock, type ViewerClock } from './viewerClock';

const SONG_ID = 'story';
const onExit = fn();

interface FrameProps {
  text: string;
  /** Stored settings the viewer starts from. */
  initial?: Partial<ViewerSettings>;
  clock?: ViewerClock;
}

/**
 * The viewer in a 1194×834 (tablet landscape) frame with its own memory
 * storage; the last saved settings JSON is mirrored into `data-saved`.
 */
function Frame({ text, initial, clock }: FrameProps) {
  const song = useMemo(() => parseSong(text), [text]);
  const [saved, setSaved] = useState('');
  const [storage] = useState<KeyValueStorage>(() => {
    const mem = createMemoryStorage(
      initial ? { [viewerSettingsKey(SONG_ID)]: JSON.stringify(initial) } : {},
    );
    return {
      getItem: mem.getItem,
      removeItem: mem.removeItem,
      setItem: (k, v) => {
        mem.setItem(k, v);
        setSaved(v);
      },
    };
  });
  return (
    <div
      data-testid="frame"
      data-saved={saved}
      style={{ width: 1194, height: 834, border: '1px solid var(--border)' }}
    >
      <Viewer
        song={song}
        songId={SONG_ID}
        storage={storage}
        onExit={onExit}
        clock={clock}
      />
    </div>
  );
}

const meta = {
  title: 'Viewer/Viewer',
  component: Frame,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: { text: viewerSongText },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every score rendered and the measured layout settled. */
async function waitReady(root: HTMLElement) {
  const viewer = within(root).getByTestId('viewer');
  await waitFor(() => expect(viewer).toHaveAttribute('data-ready'), {
    timeout: 20000,
  });
  // A second postRenderFinished (font load) may still re-report.
  await sleep(400);
  expect(viewer).toHaveAttribute('data-ready');
  return viewer;
}

const pageText = (root: HTMLElement) =>
  within(root).getByTestId('page-count').textContent!.trim();
const pageNo = (root: HTMLElement) => Number(pageText(root).split('/')[0]);
const pageCount = (root: HTMLElement) => Number(pageText(root).split('/')[1]);

/** The [data-block] at the top of what the page shows. */
function blockAtPageTop(root: HTMLElement): HTMLElement {
  const vp = within(root)
    .getByTestId('viewer-viewport')
    .getBoundingClientRect();
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-block]')];
  const y = vp.top + 20;
  return (
    blocks.find((b) => {
      const r = b.getBoundingClientRect();
      return r.top <= y && y < r.bottom;
    }) ?? blocks.find((b) => b.getBoundingClientRect().top >= y)!
  );
}

/** Bottom (in client px) of the uncovered part of the page. */
function visibleBottom(root: HTMLElement): number {
  const vp = within(root)
    .getByTestId('viewer-viewport')
    .getBoundingClientRect();
  const cover = root.querySelector('[data-testid="page-cover"]');
  return cover ? cover.getBoundingClientRect().top : vp.bottom;
}

/** Default settings: my part (Vocal) + chart, page turns. */
export const PartLayout: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    expect(c.getByRole('button', { name: /パート: Vocal/ })).toBeVisible();
    expect(c.getAllByTestId('section-score').length).toBeGreaterThan(0);
    expect(pageNo(canvasElement)).toBe(1);
  },
};

/** Transposed −2 from storage: chart chords move, the drum score does not. */
export const Transposed: Story = {
  args: { initial: { transpose: -2 } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    const chords = [
      ...canvasElement.querySelectorAll('[data-testid^="chord-"]'),
    ].map((e) => e.textContent);
    // Key G → F: G Em C D → F Dm Bb C
    expect(chords.slice(0, 4)).toEqual(['F', 'Dm', 'Bb', 'C']);
    await userEvent.click(c.getByRole('button', { name: /^移調 −2/ }));
    const dialog = within(c.getByRole('dialog', { name: '移調' }));
    expect(dialog.getByTestId('transpose-key')).toHaveTextContent(
      'キー G → F（−2）',
    );
    await userEvent.click(
      dialog.getByRole('button', { name: '原曲キーに戻す（G）' }),
    );
    await waitFor(() =>
      expect(
        canvasElement.querySelector('[data-testid^="chord-"]')?.textContent,
      ).toBe('G'),
    );
    expect(JSON.parse(c.getByTestId('frame').dataset.saved!).transpose).toBe(0);
  },
};

/** Score: all parts aligned per section, chart on top of each. */
export const ScoreLayout: Story = {
  args: { initial: { layout: 'score' } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    // At 1194px the chips are collapsed into one popover button.
    expect(c.getByRole('button', { name: /^パート/ })).toBeVisible();
    expect(c.getAllByTestId('shuffle-mark').length).toBeGreaterThan(0);
  },
};

/** Page turns: tap zones (touch), keys, the edge bump, the cover. */
export const PageFlip: Story = {
  args: { initial: { zoom: 1.4 } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    expect(pageNo(canvasElement)).toBe(1);
    const total = pageCount(canvasElement);
    expect(total).toBeGreaterThanOrEqual(3);

    // The cover hides the next page's head, above the bottom row.
    const vp = c.getByTestId('viewer-viewport').getBoundingClientRect();
    expect(visibleBottom(canvasElement)).toBeLessThanOrEqual(
      vp.bottom - 44 + 1,
    );

    await userEvent.pointer({
      keys: '[TouchA]',
      target: c.getByTestId('tap-next'),
    });
    await waitFor(() => expect(pageNo(canvasElement)).toBe(2));
    expect(c.getByTestId('viewer-content').style.transform).toMatch(
      /translateY\(-\d/,
    );
    // The tapped zone does not keep focus (a pedal's Space would re-click it).
    expect(document.activeElement).not.toBe(c.getByTestId('tap-next'));
    expect(c.getByTestId('viewer-live')).toHaveTextContent(
      `2 / ${total} ページ`,
    );

    await userEvent.pointer({
      keys: '[TouchA]',
      target: c.getByTestId('tap-prev'),
    });
    await waitFor(() => expect(pageNo(canvasElement)).toBe(1));

    // Pedal keys: PageDown / → / Space forward, PageUp / ← / Shift+Space back.
    await userEvent.keyboard('{PageDown}');
    await waitFor(() => expect(pageNo(canvasElement)).toBe(2));
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(pageNo(canvasElement)).toBe(3));
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(pageNo(canvasElement)).toBe(2));
    await userEvent.keyboard(' ');
    await waitFor(() => expect(pageNo(canvasElement)).toBe(3));
    await userEvent.keyboard('{Shift>} {/Shift}');
    await waitFor(() => expect(pageNo(canvasElement)).toBe(2));

    // To the end; one more "next" only bumps.
    for (let i = 2; i < total; i++) await userEvent.keyboard('{PageDown}');
    await waitFor(() => expect(pageNo(canvasElement)).toBe(total));
    expect(c.getByTestId('tap-next')).toBeDisabled();
    await userEvent.keyboard('{PageDown}');
    expect(pageNo(canvasElement)).toBe(total);
    expect(c.getByTestId('viewer-viewport')).toHaveAttribute(
      'data-bump',
      'end',
    );
    expect(c.getByTestId('viewer-live')).toHaveTextContent('最後のページです');
    // The last page shows the credit line.
    const credit = canvasElement.querySelector('[data-sheet-tail="credit"]')!;
    expect(credit.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      visibleBottom(canvasElement) + 1,
    );
  },
};

/** A+ re-paginates and keeps the passage being read on screen. */
export const ZoomKeepsPosition: Story = {
  args: { initial: { layout: 'score' } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    await userEvent.keyboard('{PageDown}');
    await waitFor(() => expect(pageNo(canvasElement)).toBe(2));
    const before = pageCount(canvasElement);
    const key = blockAtPageTop(canvasElement).dataset.block!;

    // The bar has no zoom control at 1194px; use the settings drawer.
    await userEvent.click(c.getByRole('button', { name: '設定' }));
    const dialog = within(c.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: '文字を大きく' }));
    await userEvent.click(dialog.getByRole('button', { name: '文字を大きく' }));
    await waitFor(() =>
      expect(dialog.getByTestId('size-px')).toHaveTextContent('26px'),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(c.queryByRole('dialog')).toBeNull());
    await waitFor(
      () => expect(pageCount(canvasElement)).toBeGreaterThan(before),
      { timeout: 20000 },
    );
    await waitReady(canvasElement);

    const block = canvasElement.querySelector<HTMLElement>(
      `[data-block="${CSS.escape(key)}"]`,
    )!;
    const r = block.getBoundingClientRect();
    const vp = c.getByTestId('viewer-viewport').getBoundingClientRect();
    // Still (at least partly) on the page shown.
    expect(r.bottom).toBeGreaterThan(vp.top);
    expect(r.top).toBeLessThan(visibleBottom(canvasElement));
    expect(pageNo(canvasElement)).toBeGreaterThan(1);
    // Saved for this song.
    const saved = JSON.parse(c.getByTestId('frame').dataset.saved!);
    expect(saved.zoom).toBe(1.2);
  },
};

/** Scroll mode: the pedal scrolls ~85% of the viewport. */
export const ScrollMode: Story = {
  args: { initial: { nav: 'scroll', zoom: 1.4 } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    const vp = c.getByTestId('viewer-viewport');
    expect(c.queryByTestId('page-nav')).toBeNull();
    expect(vp.scrollHeight).toBeGreaterThan(vp.clientHeight);
    await userEvent.keyboard('{PageDown}');
    await waitFor(() =>
      expect(Math.abs(vp.scrollTop - 0.85 * vp.clientHeight)).toBeLessThan(3),
    );
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() => expect(vp.scrollTop).toBe(0));
  },
};

const autoClock = createManualClock();

/**
 * Auto-scroll on a manual clock: 1-bar count-in (♩=120 → 0.5s a beat, no
 * scrolling), then scrolling with the playing section highlighted, speed
 * +5% keeping the position, pause, and the stop at the end.
 */
export const AutoScroll: Story = {
  args: { initial: { nav: 'auto', countIn: true }, clock: autoClock },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const viewer = await waitReady(canvasElement);
    const vp = c.getByTestId('viewer-viewport');
    expect(c.getByTestId('auto-scroll-tempo')).toHaveTextContent('♩=120');

    await userEvent.click(c.getByRole('button', { name: '再生' }));
    await waitFor(() =>
      expect(c.getByTestId('count-in')).toHaveTextContent('1'),
    );
    expect(viewer).toHaveAttribute('data-play-state', 'countIn');
    autoClock.advance(600);
    await waitFor(() =>
      expect(c.getByTestId('count-in')).toHaveTextContent('2'),
    );
    expect(vp.scrollTop).toBe(0);
    autoClock.advance(1500);
    await waitFor(() =>
      expect(viewer).toHaveAttribute('data-play-state', 'playing'),
    );
    expect(c.queryByTestId('count-in')).toBeNull();

    autoClock.advance(9000);
    await waitFor(() => expect(vp.scrollTop).toBeGreaterThan(50));
    // Past A's 4 bars (8s): the second section (B) is highlighted.
    await waitFor(() =>
      expect(
        canvasElement.querySelector('[data-block][data-playing]'),
      ).toHaveAttribute('data-block', '1-B'),
    );

    // +5%: the tempo shown follows, the position stays.
    const at = vp.scrollTop;
    await userEvent.click(c.getByRole('button', { name: '速度を上げる' }));
    expect(c.getByTestId('auto-scroll-tempo')).toHaveTextContent('♩=126');
    autoClock.advance(16);
    expect(Math.abs(vp.scrollTop - at)).toBeLessThan(5);

    // Pause: time passes, nothing moves.
    await userEvent.click(c.getByRole('button', { name: '一時停止' }));
    expect(viewer).toHaveAttribute('data-play-state', 'paused');
    const paused = vp.scrollTop;
    autoClock.advance(2000);
    expect(vp.scrollTop).toBe(paused);

    // Resume without count-in, run to the end: stops, ▶ becomes ⟲.
    await userEvent.click(c.getByRole('switch', { name: /カウントイン/ }));
    await userEvent.click(c.getByRole('button', { name: '再生' }));
    expect(viewer).toHaveAttribute('data-play-state', 'playing');
    autoClock.advance(16);
    expect(Math.abs(vp.scrollTop - paused)).toBeLessThan(5);
    autoClock.advance(60000, 100);
    await waitFor(() =>
      expect(viewer).toHaveAttribute('data-play-state', 'ended'),
    );
    expect(c.getByRole('button', { name: '最初から' })).toBeVisible();
    expect(vp.scrollTop).toBeGreaterThan(paused);
    expect(c.getByTestId('viewer-live')).toHaveTextContent('最後まで来ました');
    // Space restarts from the top.
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(viewer).toHaveAttribute('data-play-state', 'playing'),
    );
    expect(vp.scrollTop).toBe(0);
    await userEvent.keyboard('{Enter}');
    expect(viewer).toHaveAttribute('data-play-state', 'paused');
  },
};

/** No {tempo:}: ♩=100 with a note. */
export const AutoWithoutTempo: Story = {
  args: { text: chartOnlySongText, initial: { nav: 'auto' } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    expect(c.getByText('テンポ未設定（♩=100）')).toBeVisible();
    expect(c.getByTestId('auto-scroll-tempo')).toHaveTextContent('♩=100');
  },
};

/** Play mode: chrome hidden, strip → bar, pedal still turns pages, Esc ends. */
export const PlayMode: Story = {
  args: { initial: { zoom: 1.4 } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    await userEvent.click(c.getByRole('button', { name: '演奏モード' }));
    const viewer = c.getByTestId('viewer');
    expect(viewer).toHaveAttribute('data-play-mode');
    expect(c.queryByRole('button', { name: '演奏モード' })).toBeNull();
    expect(c.queryByTestId('page-count')).toBeNull();
    // Wider, hint-less tap zones.
    const zone = c.getByRole('button', { name: '次のページ' });
    expect(zone.getBoundingClientRect().width).toBeCloseTo(0.32 * 1194, -1);

    await userEvent.pointer({ keys: '[TouchA]', target: zone });
    await userEvent.click(c.getByRole('button', { name: '操作バーを表示' }));
    const bar = await c.findByTestId('play-mode-bar');
    expect(within(bar).getByTestId('play-mode-page')).toHaveTextContent(
      /^2 \//,
    );

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(viewer).not.toHaveAttribute('data-play-mode'));
    expect(c.getByRole('button', { name: '演奏モード' })).toBeVisible();
    expect(pageNo(canvasElement)).toBe(2);
  },
};

/** Drawer changes are saved per song; 編集に戻る calls onExit. */
export const SettingsAndBack: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    const settingsBtn = c.getByRole('button', { name: '設定' });
    await userEvent.click(settingsBtn);
    const dialog = c.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: /スコア（全パート）/ }),
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: /縦スクロール/ }),
    );
    const saved = JSON.parse(c.getByTestId('frame').dataset.saved!);
    expect(saved).toMatchObject({ layout: 'score', nav: 'scroll' });
    // Pedal keys do nothing while the drawer is open.
    await userEvent.keyboard('{PageDown}');
    expect(c.getByTestId('viewer-viewport').scrollTop).toBe(0);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(c.queryByRole('dialog')).toBeNull());
    // R2: focus goes to the sheet, so the pedal's Space is not a click on 設定.
    expect(c.getByTestId('viewer-viewport')).toHaveFocus();
    expect(c.getByTestId('viewer')).toHaveAttribute('data-nav', 'scroll');

    await userEvent.click(c.getByRole('button', { name: /編集に戻る/ }));
    expect(onExit).toHaveBeenCalled();
  },
};

/** R2: after a pointer click on a toolbar button / closing the drawer, Space / Enter go to the sheet. */
export const PedalAfterButtons: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    const vp = c.getByTestId('viewer-viewport');
    // (The bar has no zoom control at 1194px: a layout button stands in.)
    await userEvent.click(
      within(c.getByRole('group', { name: '表示の組み合わせ' })).getByRole(
        'button',
        {
          name: '自分のパート＋コード譜',
        },
      ),
    );
    expect(vp).toHaveFocus();
    // Enter moves on from page 1 and leaves the zoom alone.
    const total = pageCount(canvasElement);
    if (total > 1) {
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(pageNo(canvasElement)).toBe(2));
    }
    expect(pageCount(canvasElement)).toBe(total);

    await userEvent.click(c.getByRole('button', { name: '設定' }));
    await userEvent.click(c.getByRole('button', { name: /閉じる/ }));
    await waitFor(() => expect(c.queryByRole('dialog')).toBeNull());
    expect(vp).toHaveFocus();
    const now = pageNo(canvasElement);
    await userEvent.keyboard(' ');
    expect(c.queryByRole('dialog')).toBeNull();
    if (now < total)
      await waitFor(() => expect(pageNo(canvasElement)).toBe(now + 1));
  },
};

/** R13: a pointer press on a chip inside the 「パート ▾」 popover hands focus to the sheet, so the pedal pages instead of pressing the chip again. */
export const PedalAfterPopoverChip: Story = {
  args: { initial: { layout: 'score' } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    const vp = c.getByTestId('viewer-viewport');
    await userEvent.click(c.getByRole('button', { name: /^パート/ }));
    const pop = within(c.getByRole('group', { name: '表示するパート' }));
    const bass = pop.getByRole('button', { name: 'Bass' });
    const before = bass.getAttribute('aria-pressed');
    await userEvent.click(bass);
    const after = bass.getAttribute('aria-pressed');
    expect(after).not.toBe(before);
    // The popover stays open (several chips can be toggled); focus is on the sheet.
    expect(vp).toHaveFocus();
    expect(c.getByRole('dialog')).toBeVisible();
    await userEvent.keyboard('{Enter}');
    expect(bass.getAttribute('aria-pressed')).toBe(after);
    // Keyboard activation (detail 0) keeps the focus on the chip.
    bass.focus();
    await userEvent.keyboard('{Enter}');
    expect(bass.getAttribute('aria-pressed')).not.toBe(after);
    expect(bass).toHaveFocus();
  },
};

/** R4 / R8: no page announcement in scroll mode; repeated text toggles U+00A0. */
export const LiveRegion: Story = {
  args: { initial: { zoom: 1.4 } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    const live = c.getByTestId('viewer-live');
    const total = pageCount(canvasElement);
    c.getByTestId('viewer-viewport').focus();
    for (let i = 0; i < total + 1; i++) await userEvent.keyboard('{PageDown}');
    await waitFor(() => expect(live.textContent).toMatch(/^最後のページです/));
    const seen: string[] = [live.textContent!];
    for (let i = 0; i < 3; i++) {
      const prev = live.textContent;
      await userEvent.keyboard('{PageDown}');
      await waitFor(() => expect(live.textContent).not.toBe(prev));
      seen.push(live.textContent!);
    }
    // Same words each time, a trailing U+00A0 toggled on and off.
    const base = '最後のページです';
    for (const t of seen) expect(t.replace('\u00A0', '')).toBe(base);
    expect(seen.some((t) => t.endsWith('\u00A0'))).toBe(true);
    expect(seen.some((t) => t.endsWith(' '))).toBe(false);
  },
};

export const NoPageAnnounceInScroll: Story = {
  args: { initial: { nav: 'scroll', zoom: 1 } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    await userEvent.click(c.getByRole('button', { name: '設定' }));
    const d = within(c.getByRole('dialog'));
    await userEvent.click(d.getByRole('button', { name: '文字を大きく' }));
    await userEvent.click(d.getByRole('button', { name: '閉じる' }));
    await sleep(800);
    expect(c.getByTestId('viewer-live').textContent).not.toMatch(/ページ$/);
  },
};

/** R6: ▶ is disabled until the sheet is laid out, then works. */
export const PlayWaitsForLayout: Story = {
  args: { initial: { nav: 'auto' }, clock: autoClock },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const viewer = c.getByTestId('viewer');
    if (!viewer.hasAttribute('data-ready')) {
      expect(c.getByRole('button', { name: '再生' })).toBeDisabled();
    }
    await waitReady(canvasElement);
    expect(c.getByRole('button', { name: '再生' })).toBeEnabled();
    await userEvent.click(c.getByRole('button', { name: '再生' }));
    expect(viewer).not.toHaveAttribute('data-play-state', 'ended');
  },
};

/** R11: a speed change during the count-in changes the beat length. */
export const CountInFollowsSpeed: Story = {
  args: {
    initial: { nav: 'auto', countIn: true, speedPct: 100 },
    clock: autoClock,
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitReady(canvasElement);
    await userEvent.click(c.getByRole('button', { name: '再生' }));
    await waitFor(() =>
      expect(c.getByTestId('count-in')).toHaveTextContent('1'),
    );
    // 120 BPM at 100%: 0.5s a beat. Halve the speed (-50%): 1s a beat.
    for (let i = 0; i < 10; i++) {
      await userEvent.click(c.getByRole('button', { name: '速度を下げる' }));
    }
    autoClock.advance(600);
    await sleep(50);
    expect(c.getByTestId('count-in')).toHaveTextContent('1');
    autoClock.advance(600);
    await waitFor(() =>
      expect(c.getByTestId('count-in')).toHaveTextContent('2'),
    );
  },
};
