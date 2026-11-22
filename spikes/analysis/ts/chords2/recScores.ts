/**
 * Spike 7 T6: the 8 recording scores (docs/audio-spike7-plan.md §3.2, docs/audio-spike7-t6.md) read with the app's own
 * parser (src/lib/parseSong + dashChart: what the user loads into the viewer), their chords as pitch classes, the
 * right-hand voicing hints of the READMEs, and the coverage of the plan's table (bars per new quality, `/X` points,
 * identical-pair examples). Dev scores: chord-scores/ (committed). Held-out scores: recordings/chd-heldout-scores/
 * (gitignored; this file only counts them, it never prints their chords).
 *
 * CLI (from spikes/analysis): npx tsx ts/chords2/recScores.ts  -> the coverage tables (held-out: totals only)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDashLine, meterOf, parseDashLine } from '../../../../src/lib/dashChart';
import { parseSong } from '../../../../src/lib/parseSong';
import { isRawLine } from '../../../../src/lib/song';
import { noteToPc } from '../bass/score';
import { parseReading, type Reading } from './eval/pairs';
import { bassOnlyAlternative } from './eval/score';
import { IDENTICAL_PAIRS } from './identicalPairs';
import { newQualities, STAGE_ADDS, templates, type Stage } from './vocab';

export const ANALYSIS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEV_DIR = join(ANALYSIS, 'chord-scores');
export const HELDOUT_DIR = join(ANALYSIS, 'recordings', 'chd-heldout-scores');
export const DEV = ['g', 'h', 'i', 'j'] as const;
export const HELDOUT = ['k', 'l', 'm', 'n'] as const;
/** The bars per take and per dash line (1 line = 4 bars: the viewer's auto-scroll unit). */
export const BARS = 16;
export const BARS_PER_LINE = 4;
/** Scoring points per beat (plan §5: 1 beat = 2 points). */
const POINTS_PER_BEAT = 2;
const SIXTEENTHS_PER_BEAT = 4;

export interface ScoreChord {
  text: string;
  /** Sixteenths from the start of the bar / length in sixteenths. */
  start: number;
  length: number;
}
export interface Score {
  tempo: number | undefined;
  key: string | undefined;
  /** Bars of every dash line, in order. */
  bars: ScoreChord[][];
  barsPerLine: number[];
  /** Dash-notation errors of the app (Japanese), with the line number in the chart. */
  errors: string[];
  /** Chart lines that are not dash lines (should be none). */
  otherLines: number;
}

export function readScore(text: string): Score {
  const song = parseSong(text);
  const meter = meterOf(song.meta.time);
  const bars: ScoreChord[][] = [];
  const barsPerLine: number[] = [];
  const errors: string[] = [];
  let otherLines = 0;
  let n = 0;
  for (const section of song.chart) {
    for (const line of section.lines) {
      if (isRawLine(line)) continue;
      n++;
      if (!isDashLine(line)) {
        otherLines++;
        continue;
      }
      const r = parseDashLine(line, meter);
      errors.push(...r.errors.map((e) => `line ${n}: ${e}`));
      barsPerLine.push(r.bars.length);
      for (const b of r.bars) bars.push(b.chords.map((c) => ({ text: c.chord, start: c.start, length: c.length })));
    }
  }
  return { tempo: song.meta.tempo, key: song.meta.key, bars, barsPerLine, errors, otherLines };
}

/** The bar lines (`| C C/D | F |`) of an intake template (.txt): chord texts per bar. */
export function templateBars(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|'))
    .flatMap((l) =>
      l
        .split('|')
        .map((b) => b.trim())
        .filter((b) => b)
        .map((b) => b.split(/\s+/)),
    );
}

export interface Chord extends Reading {
  /** The written `/X` as a pitch class; null = the root is the bass. */
  bass: number | null;
}

/** 'Am7/G' -> { root 9, quality 'min7', bass 7 }; names as ts/chords2/vocab.ts writes them. Throws when unknown. */
export function parseChordText(text: string): Chord {
  const [upper, bass, ...rest] = text.split('/');
  if (rest.length) throw new Error(`bad chord name: ${text}`);
  const r = parseReading(upper);
  const b = bass === undefined ? null : noteToPc(bass);
  return { ...r, bass: b === r.root ? null : b };
}

export const bassPc = (c: Chord): number => c.bass ?? c.root;

const pcSet = (xs: Iterable<number>): string => [...new Set(xs)].sort((a, b) => a - b).join(',');

/** The pitch-class sets the chord may sound as (one per template of its quality), bass included. */
export const chordPcSets = (c: Chord): string[] => templates(c.quality).map((t) => pcSet([...t.map((i) => (c.root + i) % 12), bassPc(c)]));

/**
 * The right hand's notes when the left hand plays only the bass (README §2): the full template without the bass when
 * the chord has 5 notes (9 chords: the left hand keeps the root), else the full template (inversions keep the shape).
 */
export function rightHandPcs(c: Chord): number[] {
  const all = [...new Set(templates(c.quality)[0].map((i) => (c.root + i) % 12))];
  return all.length >= 5 ? all.filter((p) => p !== bassPc(c)) : all;
}

export interface Hint {
  chord: string;
  right: string[];
  left: string;
}

/** The voicing hints of a README: `` `AmM7` = 右手 C・E・G#（左手 A） ``. */
export function parseHints(md: string): Hint[] {
  const re = /`([^`\s]+)` = 右手 ([A-G][#b]?(?:・[A-G][#b]?)*)（左手 ([A-G][#b]?)）/g;
  return [...md.matchAll(re)].map((m) => ({ chord: m[1], right: m[2].split('・'), left: m[3] }));
}

/** Why a hint does not spell its chord (null = fine): left = the bass, right <= 4 notes within a ninth, notes = a template. */
export function hintProblem(h: Hint): string | null {
  const c = parseChordText(h.chord);
  if (noteToPc(h.left) !== bassPc(c)) return 'left hand is not the bass';
  if (h.right.length > 4) return 'more than 4 notes in the right hand';
  const pcs = h.right.map(noteToPc);
  let span = 0; // written low to high, each note above the previous one
  for (let i = 1; i < pcs.length; i++) span += ((pcs[i] - pcs[i - 1] + 11) % 12) + 1;
  if (span > 14) return 'right hand wider than a ninth';
  if (!chordPcSets(c).includes(pcSet([...pcs, noteToPc(h.left)]))) return 'notes are not the chord';
  return null;
}

export interface Coverage {
  /**
   * Bars in which the quality sounds / its length in bars (new qualities of V1-V3 only). A chord whose quality-making
   * note is only in the bass (`AmM7/G#`; score.ts ベースにだけある音) is not counted here but in `bassOnly`, because
   * the scorer leaves it out of the per-quality numbers.
   */
  barsWith: Record<string, number>;
  barsLong: Record<string, number>;
  /** Sum of `barsWith` over the qualities a stage adds (plan §3.2: >= 20 per stage). */
  stage: Record<'V1' | 'V2' | 'V3', number>;
  /** Chords under the ベースにだけある音 rule. */
  bassOnly: number;
  /** Scoring points (2 per beat) of chords with a `/X` other than the root. */
  slashPoints: number;
  /** Chords that are one reading of an identical pair (`6/min7` ...): all / the 食い違う例 (bass not the root). */
  pairs: Record<string, { all: number; conflict: number }>;
}

const pairKey = (q: string): string | null => {
  const p = IDENTICAL_PAIRS.find((x) => x.a === q || x.b === q);
  return p ? `${p.a}/${p.b}` : null;
};

export function coverage(scores: readonly Score[]): Coverage {
  const qs = newQualities('V3');
  const barsWith = Object.fromEntries(qs.map((q) => [q, 0]));
  const barsLong = Object.fromEntries(qs.map((q) => [q, 0]));
  const pairs = Object.fromEntries(IDENTICAL_PAIRS.map((p) => [`${p.a}/${p.b}`, { all: 0, conflict: 0 }]));
  let slashPoints = 0;
  let bassOnly = 0;
  for (const s of scores) {
    for (const bar of s.bars) {
      const total = bar.reduce((a, c) => a + c.length, 0);
      const seen = new Set<string>();
      for (const sc of bar) {
        const c = parseChordText(sc.text);
        const only = c.bass !== null && bassOnlyAlternative(c.quality, (c.bass - c.root + 12) % 12) !== null;
        if (only) bassOnly++;
        else if (c.quality in barsWith) {
          barsLong[c.quality] += sc.length / total;
          if (!seen.has(c.quality)) barsWith[c.quality]++;
          seen.add(c.quality);
        }
        if (c.bass !== null) slashPoints += (sc.length / SIXTEENTHS_PER_BEAT) * POINTS_PER_BEAT;
        const k = pairKey(c.quality);
        if (k) {
          pairs[k].all++;
          if (c.bass !== null) pairs[k].conflict++;
        }
      }
    }
  }
  const sum = (st: Stage): number => STAGE_ADDS[st].reduce((a, q) => a + barsWith[q], 0);
  return { barsWith, barsLong, stage: { V1: sum('V1'), V2: sum('V2'), V3: sum('V3') }, bassOnly, slashPoints, pairs };
}

const KEY_TONIC = /^([A-G][#b]?)m?$/;
/** A bar as degrees above the key's tonic (`Am`-key `Dm7` -> `5|min7|-`): to compare takes in different keys. */
export function degreeBars(s: Score): string[] {
  const m = KEY_TONIC.exec(s.key ?? '');
  if (!m) throw new Error('score without a key');
  const tonic = noteToPc(m[1]);
  const deg = (pc: number): number => (pc - tonic + 12) % 12;
  return s.bars.map((bar) =>
    bar
      .map(({ text }) => {
        const c = parseChordText(text);
        return `${deg(c.root)}|${c.quality}|${c.bass === null ? '-' : deg(c.bass)}`;
      })
      .join(' '),
  );
}

/** Bars of `held` (in degrees) that also occur in `dev`: anywhere / at the same bar number. */
export function degreeOverlap(dev: Score, held: Score): { anywhere: number; samePlace: number } {
  const d = degreeBars(dev);
  const h = degreeBars(held);
  return { anywhere: h.filter((b) => d.includes(b)).length, samePlace: h.filter((b, i) => d[i] === b).length };
}

export const readText = (p: string): string => readFileSync(p, 'utf8');
export const scoreOf = (dir: string, letter: string): Score => readScore(readText(join(dir, `${letter}.song.txt`)));

function table(): string {
  const out: string[] = [];
  const dev = DEV.map((l) => scoreOf(DEV_DIR, l));
  const splits: [string, Score[]][] = [['開発用 g〜j', dev]];
  if (existsSync(HELDOUT_DIR)) splits.push(['ホールドアウト k〜n', HELDOUT.map((l) => scoreOf(HELDOUT_DIR, l))]);
  const cov = splits.map(([name, s]) => [name, coverage(s)] as const);
  out.push(`| 種類 | ${cov.map(([n]) => `${n}: 出る小節（鳴る長さ）`).join(' | ')} |`, `| --- | ${cov.map(() => '---').join(' | ')} |`);
  for (const q of newQualities('V3')) out.push(`| \`${q}\` | ${cov.map(([, c]) => `${c.barsWith[q]}（${c.barsLong[q]}）`).join(' | ')} |`);
  for (const st of ['V1', 'V2', 'V3'] as const) out.push(`| ${st} の合計 | ${cov.map(([, c]) => String(c.stage[st])).join(' | ')} |`);
  out.push(`| ベースにだけある音の和音 | ${cov.map(([, c]) => String(c.bassOnly)).join(' | ')} |`);
  out.push(`| \`/X\` の点 | ${cov.map(([, c]) => String(c.slashPoints)).join(' | ')} |`);
  for (const p of Object.keys(cov[0][1].pairs)) out.push(`| 組 \`${p}\`: 全 / 食い違う | ${cov.map(([, c]) => `${c.pairs[p].all} / ${c.pairs[p].conflict}`).join(' | ')} |`);
  if (splits.length > 1) {
    const ov = HELDOUT.map((_, i) => degreeOverlap(dev[i], splits[1][1][i]));
    out.push('', `度数で同じ小節（ホールドアウト / 対応する開発用、16 小節中、どこか / 同じ位置）: ${ov.map((o) => `${o.anywhere} / ${o.samePlace}`).join('、')}`);
  }
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(table());
