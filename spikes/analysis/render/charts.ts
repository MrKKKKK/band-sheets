// Private chart-based songs (spike 2, T28): the pure part. py/charts.py turns a user's chord-chart .txt into
// recordings/charts/chart-NN.song.json (gitignored); this module turns that into a chord timeline, the piano
// bodies and the variants (chartsCli.ts renders them). Nothing here knows or prints a song title or chord names.

import { parseSong } from '../../../src/lib/parseSong';
import type { Song } from '../../../src/lib/song';
import { parseChordSymbol } from './chordSymbol';
import { chordsPerBeat } from './chordTimeline';
import { chordMidi, noteName, pianoPartBody } from './pianoPart';
import type { ChordTimeline, TimelineChord, TruthKey, Variant } from './types';

export interface ChartSong {
  id: string;
  heldOut: boolean;
  tempo: number;
  timeSignature: [number, 4];
  eighthsPerBar: number;
  /** Beats of pickup before the first bar of `bars` (4/4 only). */
  pickupBeats: number;
  /** Per bar [chord text, eighths]; 'N.C.' = no chord. */
  bars: [string, number][][];
  /** From the first downbeat = bar 0 (bars of `bars`). */
  keys: TruthKey[];
}

/** The `skipped` reason of a raw song.json (e.g. 'compound meter': registered but not rendered), or null. */
export function chartSkipReason(x: unknown): string | null {
  const r = (x as { skipped?: unknown } | null)?.skipped;
  return typeof r === 'string' && r.length > 0 ? r : null;
}

const KEY_RE = /^[A-G][#b]?m?$/;

/** Checks a parsed song.json; throws a Japanese Error naming the problem (never a chord or file name). */
export function validateChartSong(x: unknown): ChartSong {
  const s = x as Partial<ChartSong>;
  const bad = (m: string): never => {
    throw new Error(`${s?.id ?? '(id なし)'}: ${m}`);
  };
  if (!s || typeof s.id !== 'string' || !/^chart-\d+$/.test(s.id)) throw new Error('song.json の id が chart-NN ではありません');
  if (typeof s.heldOut !== 'boolean') bad('heldOut がありません');
  if (!(typeof s.tempo === 'number' && s.tempo >= 30 && s.tempo <= 300)) bad('tempo が 30〜300 ではありません');
  const ts = s.timeSignature;
  if (!Array.isArray(ts) || ts[1] !== 4 || !(ts[0] >= 2 && ts[0] <= 7)) bad('拍子が n/4 ではありません');
  const num = ts![0];
  if (s.eighthsPerBar !== num * 2) bad('eighthsPerBar が拍子と合いません');
  const pickup = s.pickupBeats ?? 0;
  if (!Number.isInteger(pickup) || pickup < 0 || pickup >= num || (pickup > 0 && num !== 4)) bad('pickupBeats が使えない値です');
  if (!Array.isArray(s.bars) || s.bars.length === 0) bad('小節がありません');
  let anyChord = false;
  s.bars!.forEach((bar, i) => {
    if (!Array.isArray(bar) || bar.reduce((n, e) => n + e[1], 0) !== s.eighthsPerBar) bad(`${i + 1} 小節目の長さが合いません`);
    for (const [text] of bar) {
      if (text === 'N.C.') continue;
      parseChordSymbol(text); // throws on anything the renderer cannot play (message names the chord: not logged by the CLI)
      anyChord = true;
    }
  });
  if (!anyChord) bad('コードがありません');
  const keys = s.keys ?? [];
  let prev = -1;
  for (const k of keys) {
    if (!KEY_RE.test(k.key) || !Number.isInteger(k.startBar) || k.startBar <= prev || k.startBar >= s.bars!.length) bad('キーの指定が正しくありません');
    prev = k.startBar;
  }
  return { id: s.id, heldOut: s.heldOut!, tempo: s.tempo!, timeSignature: [num, 4], eighthsPerBar: s.eighthsPerBar!, pickupBeats: pickup, bars: s.bars!, keys };
}

/** The anonymous number of `chart-NN` (the comp seed). */
export const chartNumber = (id: string): number => Number(id.split('-')[1]);

/**
 * Chord timeline: one section per key run (S1, S2 ...; one section without keys), the bars of the chart after an
 * optional pickup bar. A chord on an odd eighth is rounded down to its beat (the later chord wins); N.C. adds no
 * chord (the previous one keeps sounding); the first chord is moved back to bar 0 beat 0.
 */
export function chartTimeline(cs: ChartSong): ChordTimeline {
  const off = cs.pickupBeats > 0 ? 1 : 0;
  const num = cs.timeSignature[0];
  const eighthsPerBeat = cs.eighthsPerBar / num;
  const placed: TimelineChord[] = [];
  cs.bars.forEach((bar, i) => {
    let pos = 0;
    for (const [text, n] of bar) {
      if (text !== 'N.C.') {
        const c = { bar: i + off, beat: Math.floor(pos / eighthsPerBeat), text };
        const last = placed.at(-1);
        if (last && last.bar === c.bar && last.beat === c.beat) placed.pop();
        placed.push(c);
      }
      pos += n;
    }
  });
  placed[0] = { ...placed[0], bar: 0, beat: 0 };
  const total = cs.bars.length + off;
  const starts = [0, ...cs.keys.filter((k) => k.startBar > 0).map((k) => k.startBar + off)];
  const sections = starts.map((startBar, k) => ({
    label: `S${k + 1}`,
    startBar,
    bars: (k + 1 < starts.length ? starts[k + 1] : total) - startBar,
  }));
  return { ts: [num, 4], bars: total, sections, chords: placed };
}

/** Block-chord piano body (the L0 style); with a pickup the first bar has rests before the pickup beats. */
export function chartBlockBody(cs: ChartSong, timeline: ChordTimeline): string {
  const body = pianoPartBody(timeline, 'block4');
  if (cs.pickupBeats === 0) return body;
  const row = chordsPerBeat(timeline)[0];
  const lines = body.split('\n');
  const first = lines.findIndex((l) => !l.startsWith('\\section'));
  const notes = row
    .slice(4 - cs.pickupBeats)
    .map((c) => `(${chordMidi(c!).map(noteName).join(' ')})`)
    .join(' ');
  lines[first] = `:4 ${Array.from({ length: 4 - cs.pickupBeats }, () => 'r').join(' ')} ${notes} |`;
  return lines.join('\n');
}

/** The Song handed to buildScoreTex (only meta is used; the piano part is added by it). No title, no key. */
export function chartSongFor(cs: ChartSong): Song {
  return parseSong(`{title: ${cs.id}}\n{tempo: ${Math.round(cs.tempo)}}\n{time: ${cs.timeSignature[0]}/4}\n`);
}

/** Truth keys of a chart (bar 0 = first downbeat), as written in song.json. */
export const chartKeys = (cs: ChartSong): TruthKey[] => cs.keys.map((k) => ({ ...k }));

/** block (L0-like), rec (REC-like) and rechard (REC_HARD); rec ones need 4/4. All level CH, piano only, no click. */
export function chartVariants(cs: ChartSong): Variant[] {
  const base = {
    song: 'chart' as const,
    mix: 'piano' as const,
    tempo: Math.round(cs.tempo),
    swing: 'none' as const,
    click: false,
    level: 'CH' as const,
    ...(cs.heldOut ? { heldOut: true } : {}),
    ...(cs.pickupBeats > 0 ? { pickupBeats: cs.pickupBeats } : {}),
  };
  const out: Variant[] = [{ ...base, name: `${cs.id}-block` }];
  if (cs.timeSignature[0] === 4) {
    out.push({ ...base, name: `${cs.id}-rec`, comp: 'rec', recSeed: chartNumber(cs.id) });
    out.push({ ...base, name: `${cs.id}-rechard`, comp: 'rec', recSeed: chartNumber(cs.id), recStyle: 'hard' });
  }
  return out;
}
