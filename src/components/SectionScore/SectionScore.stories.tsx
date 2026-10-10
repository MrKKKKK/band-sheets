import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent, waitFor, within } from 'storybook/test';
import { SectionScore, type SystemBox } from './SectionScore';

/**
 * One section as `sectionScoreTex` builds it: a melody track (chords on
 * beat 1, an 8th triplet) and a drum track in shuffle (`\tf triplet8th`)
 * with an 8th triplet too.
 */
const TEX = String.raw`\track "Vo"
\staff {score}
\ts 4 4
\section "A"
:4 E4{ch "Am7"} E4 G4 A4 |
:4 C5{ch "Dm7"} :8 B4{tu 3} A4{tu 3} G4{tu 3} :2 E4 |
:4 D4{ch "G7"} E4 F4 G4 |
:1 E4{ch "Cmaj7"}

\track "Dr"
\instrument percussion
\articulation HH 42
\articulation SD 38
\articulation BD 36
\articulation CR 49
\articulation RD 51
\articulation HO 46
\articulation T1 50
\articulation T2 48
\articulation FT 41
\clef neutral
\ts 4 4
\tf triplet8th
\section "A"
:8 (CR BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
:8 (HH BD) HH (HH SD) HH (HH BD) HH (HH SD){tu 3} SD{tu 3} SD{tu 3} |
:8 (HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
:4 (HH BD) (HH SD) (HH BD) (HH SD)
`;

const BAND_LINE = '\u200b';

function Harness({
  zoom: initialZoom,
  width,
}: {
  zoom: number;
  width: number;
}) {
  const [zoom, setZoom] = useState(initialZoom);
  const [w, setW] = useState(width);
  const [calls, setCalls] = useState<SystemBox[][]>([]);
  return (
    <div>
      <button type="button" onClick={() => setZoom(1.5)}>
        拡大
      </button>
      <button type="button" onClick={() => setW(480)}>
        狭く
      </button>
      <div style={{ width: w }} data-testid="frame">
        <SectionScore
          tex={TEX}
          trackCount={2}
          zoom={zoom}
          firstBar={9}
          shuffleMarks={[{ track: 1, shuffle: '8' }]}
          onLayout={(s) => setCalls((c) => [...c, s])}
        />
      </div>
      <pre data-testid="layout-calls">{JSON.stringify(calls)}</pre>
    </div>
  );
}

const meta = {
  title: 'Viewer/SectionScore',
  component: Harness,
  args: { zoom: 1, width: 900 },
  parameters: { a11y: { test: 'error' } },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

const lastLayout = (root: HTMLElement): SystemBox[][] =>
  JSON.parse(within(root).getByTestId('layout-calls').textContent ?? '[]');

const waitRendered = async (root: HTMLElement, minCalls = 1) => {
  const score = within(root).getByTestId('section-score');
  await waitFor(
    () => {
      expect(score.dataset.state).toBe('rendered');
      expect(lastLayout(root).length).toBeGreaterThanOrEqual(minCalls);
    },
    { timeout: 15000 },
  );
  // Let a possible second postRenderFinished (font load) settle.
  await new Promise((r) => setTimeout(r, 300));
  return score;
};

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Visible alphaTab text (chord names, tuplet numbers, credit line…). */
const alphaTabTexts = (score: HTMLElement) =>
  [...score.querySelectorAll('svg text')].filter(
    (t) =>
      !t.closest('[data-testid="shuffle-mark"]') &&
      (t.textContent ?? '').trim() !== '' &&
      t.textContent !== BAND_LINE &&
      // Bravura glyphs (private use area) report font-sized boxes far
      // larger than the ink, so only plain text is checked.
      !/[\ue000-\uf8ff]/.test(t.textContent ?? ''),
  );

async function checkLayout(root: HTMLElement) {
  const score = await waitRendered(root);
  const rootRect = score.getBoundingClientRect();

  // The "rendered by alphaTab" line is drawn but cut off below the bottom.
  const credit = alphaTabTexts(score).find((t) =>
    t.textContent?.includes('rendered by alphaTab'),
  );
  expect(credit).toBeDefined();
  expect(credit!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    rootRect.bottom - 1,
  );

  // Systems tile the component from 0 to its bottom.
  const systems = lastLayout(root).at(-1)!;
  expect(systems[0].top).toBe(0);
  for (let i = 1; i < systems.length; i++) {
    expect(systems[i].top).toBeCloseTo(
      systems[i - 1].top + systems[i - 1].height,
    );
  }
  const lastSys = systems.at(-1)!;
  expect(lastSys.top + lastSys.height).toBeCloseTo(rootRect.height, 0);
  expect(systems.reduce((n, s) => n + s.barCount, 0)).toBe(4);
  expect(systems[0].barStart).toBe(0);

  // Song-wide bar numbers, one per system, starting at firstBar.
  const numbers = within(score).getAllByTestId('bar-number');
  expect(numbers.map((n) => Number(n.textContent))).toEqual(
    systems.map((s) => 9 + s.barStart),
  );

  // Exactly one Shuffle mark (no alphaTab one), on the drum staff: below
  // the melody's first bar number, and not over any alphaTab text.
  const marks = within(score).getAllByTestId('shuffle-mark');
  expect(marks).toHaveLength(1);
  expect(marks[0].dataset.shuffle).toBe('8');
  const markRect = marks[0].getBoundingClientRect();
  expect(markRect.top).toBeGreaterThan(
    numbers[0].getBoundingClientRect().bottom,
  );
  const texts = alphaTabTexts(score);
  expect(texts.some((t) => t.textContent?.includes('Am7'))).toBe(true);
  for (const t of texts) {
    const r = t.getBoundingClientRect();
    expect(overlaps(markRect, r), `mark vs "${t.textContent}"`).toBe(false);
    for (const n of numbers) {
      expect(
        overlaps(n.getBoundingClientRect(), r),
        `bar ${n.textContent} vs "${t.textContent}"`,
      ).toBe(false);
    }
  }
  return systems;
}

export const MelodyAndDrums: Story = {
  play: async ({ canvasElement }) => {
    await checkLayout(canvasElement);
  },
};

export const Zoom150: Story = {
  args: { zoom: 1.5 },
  play: async ({ canvasElement }) => {
    await checkLayout(canvasElement);
  },
};

/** Zoom and width changes re-render through the same api and re-report. */
export const RerenderOnZoomAndWidth: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const before = await checkLayout(canvasElement);
    const n = lastLayout(canvasElement).length;
    fireEvent.click(c.getByRole('button', { name: '拡大' }));
    await waitFor(
      () => {
        const s = lastLayout(canvasElement).at(-1)!;
        expect(lastLayout(canvasElement).length).toBeGreaterThan(n);
        expect(s[0].height).toBeGreaterThan(before[0].height);
      },
      { timeout: 15000 },
    );
    const zoomed = await checkLayout(canvasElement);
    fireEvent.click(c.getByRole('button', { name: '狭く' }));
    await waitFor(
      () =>
        expect(lastLayout(canvasElement).at(-1)!.length).toBeGreaterThan(
          zoomed.length,
        ),
      { timeout: 15000 },
    );
    await checkLayout(canvasElement);
  },
};

const DRUMS_ONLY = TEX.slice(TEX.indexOf('\\track "Dr"')).replace(
  '\\tf triplet8th',
  '\\tf triplet16th',
);

/** The drum staff on top: the mark makes room for the bar number. */
export const DrumsOnly16: Story = {
  render: () => (
    <div style={{ width: 900 }}>
      <SectionScore
        tex={DRUMS_ONLY}
        trackCount={1}
        zoom={1}
        firstBar={1}
        shuffleMarks={[{ track: 0, shuffle: '16' }]}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(
      () =>
        expect(c.getByTestId('section-score').dataset.state).toBe('rendered'),
      { timeout: 15000 },
    );
    const mark = c.getByTestId('shuffle-mark');
    expect(mark.dataset.shuffle).toBe('16');
    const [n] = c.getAllByTestId('bar-number');
    expect(n).toHaveTextContent('1');
    expect(
      overlaps(mark.getBoundingClientRect(), n.getBoundingClientRect()),
    ).toBe(false);
  },
};

/** Zoom 1 and 1.5 side by side (docs/m6-t13-section-score.png). */
export const ZoomComparison: Story = {
  render: () => (
    <div data-testid="frame" style={{ width: 900 }}>
      {[1, 1.5].map((zoom) => (
        <section key={zoom} aria-label={`倍率 ${zoom}`}>
          <p>倍率 {zoom}（小節番号 9〜、ドラムはシャッフル）</p>
          <SectionScore
            tex={TEX}
            trackCount={2}
            zoom={zoom}
            firstBar={9}
            shuffleMarks={[{ track: 1, shuffle: '8' }]}
          />
        </section>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const scores = within(canvasElement).getAllByTestId('section-score');
    await waitFor(
      () => scores.forEach((s) => expect(s.dataset.state).toBe('rendered')),
      { timeout: 15000 },
    );
    expect(within(canvasElement).getAllByTestId('shuffle-mark')).toHaveLength(
      2,
    );
  },
};

export const InvalidTex: Story = {
  render: () => (
    <SectionScore
      tex={'\\track "Vo"\n:4 C4{'}
      trackCount={1}
      zoom={1}
      firstBar={1}
    />
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole('alert')).toBeVisible(), {
      timeout: 15000,
    });
    expect(c.getByTestId('section-score').dataset.state).toBe('error');
  },
};

const BASS =
  String.raw`\track "Ba"
\staff {score}
\clef F4
\ts 4 4
\section "A"
` +
  Array.from({ length: 12 }, () => ':4 A2 A2 E2 E2').join(' |\n') +
  '\n';

/**
 * R1: the top track has no chord names (score layout with Vocal hidden),
 * so the bar numbers have little room above the staff. Every number must
 * lie inside its own system box, including the first one (not clipped by
 * the component's top edge).
 */
function NoChordsHarness() {
  const [calls, setCalls] = useState<SystemBox[][]>([]);
  return (
    <div style={{ width: 600 }}>
      <SectionScore
        tex={`.\n${BASS}\n${DRUMS_ONLY.replace('\\tf triplet16th\n', '')}`}
        trackCount={2}
        zoom={1.2}
        firstBar={13}
        onLayout={(s) => setCalls((c) => [...c, s])}
      />
      <pre data-testid="layout-calls">{JSON.stringify(calls)}</pre>
    </div>
  );
}

export const NumbersInsideSystems: Story = {
  render: () => <NoChordsHarness />,
  play: async ({ canvasElement }) => {
    const score = await waitRendered(canvasElement);
    const systems = lastLayout(canvasElement).at(-1)!;
    expect(systems.length).toBeGreaterThan(1);
    const top = score.getBoundingClientRect().top;
    const numbers = within(score).getAllByTestId('bar-number');
    expect(numbers.map((n) => Number(n.textContent))).toEqual(
      systems.map((s) => 13 + s.barStart),
    );
    numbers.forEach((n, i) => {
      const r = n.getBoundingClientRect();
      const sys = systems[i];
      expect(r.top - top, `bar ${n.textContent} top`).toBeGreaterThanOrEqual(
        sys.top - 0.5,
      );
      expect(r.bottom - top, `bar ${n.textContent} bottom`).toBeLessThanOrEqual(
        sys.top + sys.height + 0.5,
      );
    });
  },
};

/** R5: two drum tracks (Drums + Perc) each get their own mark. */
export const TwoDrumTracks: Story = {
  render: () => (
    <div style={{ width: 900 }}>
      <SectionScore
        tex={`.\n${TEX}\n${DRUMS_ONLY.replace('\\track "Dr"', '\\track "Perc"')}`}
        trackCount={3}
        zoom={1}
        firstBar={1}
        shuffleMarks={[
          { track: 1, shuffle: '8' },
          { track: 2, shuffle: '16' },
        ]}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const score = within(canvasElement).getByTestId('section-score');
    await waitFor(() => expect(score.dataset.state).toBe('rendered'), {
      timeout: 15000,
    });
    await new Promise((r) => setTimeout(r, 300));
    const marks = within(score).getAllByTestId('shuffle-mark');
    expect(marks.map((m) => m.dataset.shuffle)).toEqual(['8', '16']);
    // The second mark is lower (above the third staff), and they don't touch.
    const [a, b] = marks.map((m) => m.getBoundingClientRect());
    expect(b.top).toBeGreaterThan(a.bottom);
    for (const t of alphaTabTexts(score)) {
      for (const m of [a, b]) {
        expect(overlaps(m, t.getBoundingClientRect())).toBe(false);
      }
    }
  },
};
