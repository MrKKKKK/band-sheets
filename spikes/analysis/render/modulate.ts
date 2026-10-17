// Modulation variants (docs/audio-spike2-plan.md, design decision 11, T23): a song in which some
// chart sections are transposed by n semitones. The chord chart goes through the app's
// `transposeChartSection` (chords), the melody through the app's `transposeScore` (alphaTab model,
// applied to the bars of those sections only), the truth gets `keys`. Read-only use of src/lib.

import type { model } from '@coderline/alphatab';
import { transposeChartSection, transposeKey } from '../../../src/lib/transpose';
import { transposeScore } from '../../../src/lib/transposeScore';
import type { Song } from '../../../src/lib/song';
import { PIANO_TRACK } from './truth';
import type { ChordTimeline, Modulation, TruthKey } from './types';

function checkSections(m: Modulation, count: number): void {
  if (m.sections.length === 0) throw new Error('転調するセクションがありません');
  for (const s of m.sections) {
    if (!Number.isInteger(s) || s < 0 || s >= count) throw new Error(`セクション ${s} がありません（${count} 個）`);
  }
  if (new Set(m.sections).size !== m.sections.length) throw new Error('転調するセクションが重複しています');
  if (!(Number.isInteger(m.semitones) && m.semitones !== 0)) throw new Error(`半音数 ${m.semitones} は 0 以外の整数にしてください`);
}

/** The song with the chords of the listed chart sections transposed (the melody part is untouched). */
export function modulateSong(song: Song, m: Modulation): Song {
  checkSections(m, song.chart.length);
  const target = transposeKey(m.baseKey, m.semitones) ?? undefined;
  const chart = song.chart.map((sec, i) => (m.sections.includes(i) ? transposeChartSection(sec, m.semitones, target) : sec));
  return { ...song, chart };
}

/** [first bar, end bar) of every modulated section, from the (unmodulated) timeline, in bar order. */
export function modulatedBars(timeline: ChordTimeline, m: Modulation): [number, number][] {
  checkSections(m, timeline.sections.length);
  return [...m.sections]
    .sort((a, b) => a - b)
    .map((i) => [timeline.sections[i].startBar, timeline.sections[i].startBar + timeline.sections[i].bars] as [number, number]);
}

/**
 * Truth `keys`: the base key from bar 0, the transposed key over each modulated run, the base key again
 * after it. Adjacent runs with the same key are merged. `pickupBars` (default 0) is subtracted so that
 * bar 0 is the first downbeat (see score.py); a run that ends inside the pickup is dropped.
 */
export function modulationKeys(timeline: ChordTimeline, m: Modulation, pickupBars = 0): TruthKey[] {
  const moved = transposeKey(m.baseKey, m.semitones);
  if (moved === null) throw new Error(`調「${m.baseKey}」を読めません`);
  const inRun = new Set<number>();
  for (const [a, b] of modulatedBars(timeline, m)) for (let i = a; i < b; i++) inRun.add(i);
  const keys: TruthKey[] = [];
  for (let bar = pickupBars; bar < timeline.bars; bar++) {
    const key = inRun.has(bar) ? moved : m.baseKey;
    if (keys.length === 0 || keys[keys.length - 1].key !== key) keys.push({ startBar: bar - pickupBars, key });
  }
  return keys;
}

/**
 * Transposes the melody notes in the given bars of an imported score by `semitones` with the app's
 * `transposeScore` (bars [a, b) of every non-piano, non-percussion staff). The piano track is built
 * from the transposed chords, so it is left alone; drums too (transposeScore skips them).
 */
export function transposeMelodyBars(score: model.Score, ranges: [number, number][], semitones: number): void {
  for (const track of score.tracks) {
    if (track.name === PIANO_TRACK) continue;
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      for (const [a, b] of ranges) {
        // A stand-in staff holding just these bars; its (absent) chord list is not touched twice.
        const part = { isPercussion: false, bars: staff.bars.slice(a, b), chords: undefined };
        transposeScore({ tracks: [{ staves: [part] }] } as unknown as model.Score, semitones);
      }
    }
  }
}
