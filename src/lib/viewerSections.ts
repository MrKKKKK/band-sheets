/**
 * The viewer's sections (M6, docs/m6-plan.md 設計判断 2–4, T12): which
 * section blocks to show in which order, and for every part of every block a
 * self-contained alphaTex track that renders exactly that section.
 *
 * ## Order (`buildViewerSections`)
 *
 * - Chart sections, in chart order. A label used k times in the chart is
 *   paired with the part's k-th (non-empty) section of that label; when the
 *   part has fewer, with its first one. Chart sections with an empty label
 *   (implicit blocks, `{start_of_verse}` without a label) get no parts.
 * - Part sections the chart has no slot for (labels only parts use, and
 *   extra instances beyond the chart's count) are inserted right after the
 *   block that shows the part's preceding section (at the top when there is
 *   none), after any part-only blocks already placed there by earlier parts.
 *   Later parts join an existing part-only block of the same label (k-th
 *   instance with k-th block).
 * - Notes before a part's first `\section` form one unlabeled block at the
 *   very top, shared by every part that has them.
 * - A part section with no content (only blank / `//` / `\` lines) does not
 *   count: the part is simply absent from that block.
 * - A part alphaTab cannot read is left out entirely and reported in
 *   `errors`; the rest still shows.
 *
 * ## Section documents (`ViewerPartSection.trackTex`)
 *
 * `\track "<name>"` + the part's preamble `\` lines (no `\lyrics`: a
 * part-level lyrics line would be misaligned once cut into sections) + the
 * carried-over state + the section body. The carried-over state is read
 * from alphaTab's import of the WHOLE part (`partsToAlphaTex` of that part
 * alone, so the editor's defaults apply), at the master bar where the
 * section starts: `\ts`, `\ks`, `\clef` (+ `\ottava` when set), and for drum
 * parts `\tf`; they are always written (later lines in the same bar win, so
 * the preamble's own values are overridden, and the section's own lines
 * after them win in turn). When the section's first beat has no `:N`, the
 * duration in effect there (the last beat before the section) is written in
 * front of it — this also keeps a bare note right after a `\section` header
 * a note, where the whole-part read swallows it as the header's second
 * argument (docs/m6-alphatab-findings.md §7, T1 item 3: accepted
 * difference). The `\section` header itself is not written (the viewer
 * hides alphaTab's markers anyway).
 *
 * `bars` come from reading that section document alone (= what is drawn),
 * so a part keeps its own time signature even when another part of the same
 * block differs (T1 item 4). `ViewerSection.bars` is the longest part's,
 * over ALL parts (shown or not), so bar numbers never depend on which parts
 * are visible; chart-only blocks have `bars: []` and do not advance
 * `firstBar`.
 *
 * ## Time signature from the song meta
 *
 * An invalid or missing `{time:}` is not written into the part (same as
 * `partsToAlphaTex`), so alphaTab uses its default 4/4; `songTimeSig` gives
 * the same answer for callers that need a bar without any part (chart-only
 * blocks in the auto-scroll estimate).
 *
 * ## Shuffle
 *
 * `shuffle` is the drum section's effective `\tf` (own or inherited, as
 * alphaTab reads it — same rule as drumPart.ts R2); a triplet feel other
 * than straight / 8th / 16th triplets is `'other'`. `shuffleMark` is what
 * the viewer draws at the head of the block (m6-plan.md 確認したい点 2 (a)):
 * the shuffle on every shuffled block, and `'none'` (= "Straight") on the
 * first straight block after a block that was not straight, in viewer
 * order (repeats included).
 */
import { importer, model, Settings } from '@coderline/alphatab';
import type { Shuffle } from './drum';
import { partSections } from './melodyPart';
import { parseTimeSignature, partsToAlphaTex } from './partsToAlphaTex';
import {
  isDrumPart,
  type ChartSection,
  type Part,
  type Song,
  type SongMeta,
} from './song';

export interface BarInfo {
  num: number;
  den: number;
}

export interface ViewerPartSection {
  part: string;
  isDrum: boolean;
  /** トラック 1 本分（`\track` から）。持ち越しの補いを含む */
  trackTex: string;
  bars: BarInfo[];
  /** ドラムだけ。読めない `\tf` は 'other'（表記なし） */
  shuffle?: Shuffle | 'other';
  /**
   * ドラムだけ。この位置に描く Shuffle 表記（'none' は「Straight」）。
   * 表記しないときは undefined。
   */
  shuffleMark?: Shuffle;
}

export interface ViewerSection {
  key: string; // React の key（`<index>-<label>`）
  label: string; // '' = ラベルなし
  chart?: ChartSection;
  parts: ViewerPartSection[]; // 曲のパートの順
  /** そのセクションの小節（全パートの最長）。どのパートにも無ければ [] */
  bars: BarInfo[];
  /** 曲全体での最初の小節番号（1 始まり） */
  firstBar: number;
}

export interface ViewerPartError {
  part: string;
  message: string;
}

/** The song's `{time:}` as a bar; 4/4 (alphaTab's default) when invalid. */
export function songTimeSig(meta: SongMeta): BarInfo {
  const ts = parseTimeSignature(meta.time);
  return ts ? { num: ts[0], den: ts[1] } : { num: 4, den: 4 };
}

// ---------------------------------------------------------------------------
// alphaTab

function readTex(tex: string): model.Score {
  const imp = new importer.AlphaTexImporter();
  imp.logErrors = false;
  imp.initFromString(tex, new Settings());
  return imp.readScore();
}

const MAJOR = 'Cb Gb Db Ab Eb Bb F C G D A E B F# C#'.split(' ');
const MINOR = 'Ab Eb Bb F C G D A E B F# C# G# D# A#'.split(' ');

const CLEF: Record<number, string> = {
  [model.Clef.Neutral]: 'neutral',
  [model.Clef.C3]: 'alto',
  [model.Clef.C4]: 'tenor',
  [model.Clef.F4]: 'bass',
  [model.Clef.G2]: 'treble',
};

const OTTAVA: Record<number, string> = {
  [model.Ottavia._15ma]: '15ma',
  [model.Ottavia._8va]: '8va',
  [model.Ottavia._8vb]: '8vb',
  [model.Ottavia._15mb]: '15mb',
};

const TRIPLET_FEEL: Record<number, string> = {
  [model.TripletFeel.NoTripletFeel]: 'none',
  [model.TripletFeel.Triplet16th]: 'triplet16th',
  [model.TripletFeel.Triplet8th]: 'triplet8th',
  [model.TripletFeel.Dotted16th]: 'dotted16th',
  [model.TripletFeel.Dotted8th]: 'dotted8th',
  [model.TripletFeel.Scottish16th]: 'scottish16th',
  [model.TripletFeel.Scottish8th]: 'scottish8th',
};

function shuffleOf(tf: model.TripletFeel): Shuffle | 'other' {
  if (tf === model.TripletFeel.NoTripletFeel) return 'none';
  if (tf === model.TripletFeel.Triplet8th) return '8';
  if (tf === model.TripletFeel.Triplet16th) return '16';
  return 'other';
}

function keyName(bar: model.Bar): string {
  const i = bar.keySignature + 7;
  return bar.keySignatureType === model.KeySignatureType.Minor
    ? `${MINOR[i]}minor`
    : MAJOR[i];
}

/** The state alphaTab carries into bar `index` of a single-track score. */
interface Carry {
  lines: string[];
  shuffle: Shuffle | 'other';
  /** Duration in effect (the last beat before the bar); undefined = none yet. */
  duration?: number;
}

function carryAt(score: model.Score, index: number, isDrum: boolean): Carry {
  const bars = score.tracks[0].staves[0].bars;
  const at = Math.min(index, bars.length - 1);
  const bar = bars[at];
  const mb = score.masterBars[at];
  const lines = [
    `\\ts ${mb.timeSignatureNumerator} ${mb.timeSignatureDenominator}`,
    `\\ks ${keyName(bar)}`,
    `\\clef ${CLEF[bar.clef] ?? 'treble'}`,
  ];
  const ottava = OTTAVA[bar.clefOttava];
  if (ottava) lines.push(`\\ottava ${ottava}`);
  if (isDrum) lines.push(`\\tf ${TRIPLET_FEEL[mb.tripletFeel] ?? 'none'}`);

  let duration: number | undefined;
  for (let i = Math.min(index, bars.length) - 1; i >= 0 && !duration; i--) {
    const beats = bars[i].voices[0]?.beats ?? [];
    for (let j = beats.length - 1; j >= 0; j--) {
      const b = beats[j];
      if (b.isEmpty || b.graceType !== model.GraceType.None) continue;
      if (b.duration > 0) duration = b.duration;
      break;
    }
  }
  return { lines, shuffle: shuffleOf(mb.tripletFeel), duration };
}

// ---------------------------------------------------------------------------
// Section documents

const isMetaLine = (t: string) => t.startsWith('\\');
const isLyricsLine = (t: string) => /^\\lyrics\b/i.test(t);
const isSkippable = (t: string) => t === '' || t.startsWith('//');

/**
 * The section body with `:N` written before its first beat when that beat
 * has no duration; null when the body has no beats at all.
 */
function withDuration(body: string, duration: number | undefined) {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => {
    const t = l.trim();
    return !isSkippable(t) && !isMetaLine(t);
  });
  if (i < 0) return null;
  const m = /^(\s*)(.*)$/.exec(lines[i])!;
  if (!m[2].startsWith(':')) {
    lines[i] = `${m[1]}:${duration ?? 4} ${m[2]}`;
  }
  return lines.join('\n');
}

/** `\track …` + body through `partsToAlphaTex` (the editor's defaults). */
function trackTexOf(name: string, body: string): string {
  const doc = partsToAlphaTex({
    meta: { title: '' },
    chart: [],
    parts: [{ name, body }],
  });
  return doc.replace(/^\.\n/, '').replace(/\n$/, '');
}

function barsOf(trackTex: string): BarInfo[] | null {
  const score = readTex(`.\n${trackTex}\n`);
  const bars = score.tracks[0].staves[0].bars;
  if (bars.every((b) => b.isEmpty)) return null;
  return bars.map((b) => {
    const mb = score.masterBars[b.index];
    return { num: mb.timeSignatureNumerator, den: mb.timeSignatureDenominator };
  });
}

interface PartRead {
  /** Notes before the first `\section`. */
  preamble?: ViewerPartSection;
  /** Per `\section` (text order), null when it has no beats. */
  sections: { label: string; vps: ViewerPartSection | null }[];
}

function readPart(part: Part, meta: SongMeta): PartRead {
  const isDrum = isDrumPart(part);
  const whole = readTex(
    partsToAlphaTex({
      meta: { title: '', time: meta.time },
      chart: [],
      parts: [part],
    }),
  );
  const starts = whole.masterBars
    .filter((mb) => mb.section)
    .map((mb) => ({
      index: mb.index,
      label: mb.section!.marker || mb.section!.text,
    }));
  const ps = partSections(part.body);
  const preambleLines = ps.preamble === '' ? [] : ps.preamble.split('\n');
  const head = preambleLines.filter((l) => {
    const t = l.trim();
    return isMetaLine(t) && !isLyricsLine(t);
  });

  const make = (body: string, carry: Carry): ViewerPartSection | null => {
    const trackTex = trackTexOf(part.name, body);
    const bars = barsOf(trackTex);
    if (!bars) return null;
    const vps: ViewerPartSection = { part: part.name, isDrum, trackTex, bars };
    if (isDrum) vps.shuffle = carry.shuffle;
    return vps;
  };

  const result: PartRead = { sections: [] };

  if (ps.unlabeled !== undefined) {
    // Leading `\` lines, then the carried state at bar 0, then the rest.
    const kept = preambleLines.filter((l) => !isLyricsLine(l.trim()));
    let n = 0;
    while (n < kept.length) {
      const t = kept[n].trim();
      if (!isSkippable(t) && !isMetaLine(t)) break;
      n++;
    }
    const carry = carryAt(whole, 0, isDrum);
    const body = [...kept.slice(0, n), ...carry.lines, ...kept.slice(n)];
    result.preamble = make(body.join('\n'), carry) ?? undefined;
  }

  let next = 0;
  for (const sec of ps.sections) {
    const probe = withDuration(sec.body, undefined);
    if (probe === null) {
      result.sections.push({ label: sec.label, vps: null });
      continue;
    }
    // A section with beats starts a master bar labelled like it; anything
    // else (e.g. a `\section` inside a block comment) is not consumed.
    let index: number;
    if (next < starts.length && starts[next].label === sec.label) {
      index = starts[next++].index;
    } else {
      index = next < starts.length ? starts[next].index : Infinity;
    }
    const carry = carryAt(whole, index, isDrum);
    const body = [
      ...head,
      ...carry.lines,
      withDuration(sec.body, carry.duration)!,
    ];
    result.sections.push({
      label: sec.label,
      vps: make(body.join('\n'), carry),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Order

interface Draft {
  label: string;
  chart?: ChartSection;
  /** Part-only block (not from the chart, not the preamble block). */
  partOnly: boolean;
  parts: Map<number, ViewerPartSection>;
}

export function buildViewerSections(song: Song): {
  sections: ViewerSection[];
  errors: ViewerPartError[];
} {
  const errors: ViewerPartError[] = [];
  const reads: (PartRead | null)[] = song.parts.map((part) => {
    try {
      return readPart(part, song.meta);
    } catch {
      errors.push({
        part: part.name,
        message: `${part.name} は読み込めませんでした（テキスト入力で確認してください）`,
      });
      return null;
    }
  });

  const drafts: Draft[] = song.chart.map((chart) => ({
    label: chart.label,
    chart,
    partOnly: false,
    parts: new Map(),
  }));

  const preambleBlock: Draft = {
    label: '',
    partOnly: false,
    parts: new Map(),
  };
  reads.forEach((r, p) => {
    if (r?.preamble) preambleBlock.parts.set(p, r.preamble);
  });
  if (preambleBlock.parts.size) drafts.unshift(preambleBlock);

  reads.forEach((r, p) => {
    if (!r) return;
    const present = r.sections.filter(
      (s): s is { label: string; vps: ViewerPartSection } => s.vps !== null,
    );
    let prev: Draft | undefined;
    const extraCount = new Map<string, number>();
    present.forEach(({ label, vps }, j) => {
      const k = present.slice(0, j).filter((s) => s.label === label).length;
      const n = present.filter((s) => s.label === label).length;
      const chartSlots =
        label === '' ? [] : drafts.filter((d) => d.chart && d.label === label);
      if (k < chartSlots.length) {
        chartSlots.forEach((d, m) => {
          if (m === k || (k === 0 && m >= n)) d.parts.set(p, vps);
        });
        prev = chartSlots[k];
        return;
      }
      // No chart slot: join the matching part-only block or insert one.
      const e = extraCount.get(label) ?? 0;
      extraCount.set(label, e + 1);
      const existing = drafts.filter((d) => d.partOnly && d.label === label)[e];
      if (existing && !existing.parts.has(p)) {
        existing.parts.set(p, vps);
        prev = existing;
        return;
      }
      let at = prev
        ? drafts.indexOf(prev) + 1
        : preambleBlock.parts.size
          ? 1
          : 0;
      while (at < drafts.length && drafts[at].partOnly) at++;
      const d: Draft = { label, partOnly: true, parts: new Map([[p, vps]]) };
      drafts.splice(at, 0, d);
      prev = d;
    });
  });

  const lastShuffle = new Map<number, Shuffle | 'other'>();
  let firstBar = 1;
  const sections = drafts.map((d, i): ViewerSection => {
    const parts = [...d.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([p, vps]) => {
        const out = { ...vps };
        if (vps.shuffle !== undefined) {
          const before = lastShuffle.get(p);
          if (vps.shuffle === '8' || vps.shuffle === '16') {
            out.shuffleMark = vps.shuffle;
          } else if (
            vps.shuffle === 'none' &&
            before !== undefined &&
            before !== 'none'
          ) {
            out.shuffleMark = 'none';
          }
          lastShuffle.set(p, vps.shuffle);
        }
        return out;
      });
    const bars = parts.reduce<BarInfo[]>(
      (longest, vps) => (vps.bars.length > longest.length ? vps.bars : longest),
      [],
    );
    const section: ViewerSection = {
      key: `${i}-${d.label}`,
      label: d.label,
      parts,
      bars,
      firstBar,
    };
    if (d.chart) section.chart = d.chart;
    firstBar += bars.length;
    return section;
  });

  return { sections, errors };
}

// ---------------------------------------------------------------------------
// Score document

/** A Shuffle / Straight mark to draw on one drum track of a score. */
export interface ShuffleMarkAt {
  track: number;
  shuffle: Shuffle;
}

/**
 * One alphaTex document with the shown parts of `section` as tracks (song
 * order, whatever order `partNames` lists them in). `shuffleMarks` has one
 * entry per drum track that has a mark to draw (see top; m6-review.md R5:
 * every drum track gets its own, not just the first).
 */
export function sectionScoreTex(
  section: ViewerSection,
  partNames: readonly string[],
): {
  tex: string;
  trackCount: number;
  shuffleMarks?: ShuffleMarkAt[];
} | null {
  const shown = section.parts.filter((p) => partNames.includes(p.part));
  if (!shown.length) return null;
  const result: {
    tex: string;
    trackCount: number;
    shuffleMarks?: ShuffleMarkAt[];
  } = {
    tex: `.\n${shown.map((p) => p.trackTex).join('\n\n')}\n`,
    trackCount: shown.length,
  };
  const marks = shown.flatMap((p, track) =>
    p.isDrum && p.shuffleMark !== undefined
      ? [{ track, shuffle: p.shuffleMark }]
      : [],
  );
  if (marks.length) result.shuffleMarks = marks;
  return result;
}
