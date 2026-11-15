/**
 * Spike 7 T4: reproduction check on spike 6's synthetic TUNING split (no dev / hold-out data is opened: no look).
 *
 *   npx tsx ts/chords2/eval/repro_t4.ts --spike6 <spike 6 spikes/analysis folder>
 *
 * A. scoring: spike 6's saved v1a results (out/bass-results/t8-tuning) against the tuning truths, scored by spike 6's
 *    scoreBass / editCounts / name-hit rule (ts/bass) and by chords2 `scoreChords` / `editCounts` in 落; must be equal.
 * B. input: the tuning WAVs through `prepareInput` with normalization off must equal spike 6's loadMono (resample to
 *    22,050 Hz) sample for sample; the median whole-file RMS of the 72 files is spike 6 R3's target (-22.0 dBFS); with
 *    normalization on, each file's gain equals spike 6's normalizeGainDb(rms, peak, median).
 * Prints numbers only. Exit 1 when any equality fails.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeWav } from '../../browser/wav';
import { toMono } from '../../dsp/core/resample';
import { argOf, at, json } from '../../bass/evalCommon';
import { selectVariants, type GuardVariant } from '../../bass/heldout_guard';
import { levelDb as levelDb6, loadMono, normalizeGainDb as gain6 } from '../../bass/rec_eval';
import { beatWindows, editCounts as editCounts6, mapVocab, median, normalizeTruthSlash, noteToPc, scoreBass, type ScoreBeat, type ScoreChord } from '../../bass/score';
import { levelDb, normalizeGainDb } from '../../../../../src/lib/analysis/inputLevel';
import { prepareInput } from './input';
import { editCounts, scoreChords } from './score';

const root = resolve(argOf(process.argv, '--spike6') ?? '');
const OUT = join(root, 'out', 'bass');
let ok = true;
const check = (what: string, a: unknown, b: unknown): void => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) ok = false;
  console.log(`${same ? 'same' : 'DIFF'}\t${what}\t${JSON.stringify(a)}${same ? '' : ` vs ${JSON.stringify(b)}`}`);
};

const all = json<{ variants: (GuardVariant & { wav: string; truth: string })[] }>(join(OUT, 'manifest.json')).variants;
const tuning = selectVariants(all, ['tuning']);
console.log(`tuning variants: ${tuning.length}`);

// A. scoring
const sum = { points: 0, slashTruth: 0, slashResult: 0, slashHit: 0, noSlash: 0, falseSlash: 0, editTotal: 0, editBeats: 0, nameSpike6: 0, nameNew: 0, nameUnits: 0 };
const sum2 = { points: 0, slashTruth: 0, slashResult: 0, slashHit: 0, noSlash: 0, falseSlash: 0, editTotal: 0, editBeats: 0 };
for (const v of tuning) {
  const t = json<{ beats: ScoreBeat[]; chords: ScoreChord[] }>(join(OUT, v.truth));
  const res = json<{ chords: ScoreChord[] }>(join(root, 'out', 'bass-results', 't8-tuning', `${v.name}.json`)).chords.map((c) => ({ start: c.start, end: c.end, root: c.root, quality: c.quality, bass: null }));
  const tn = normalizeTruthSlash(t.chords);
  const a = scoreBass(tn, res, t.beats);
  const e6 = editCounts6(tn, res, t.beats);
  sum.points += a.nPoints; sum.slashTruth += a.slash.truthSlash; sum.slashResult += a.slash.resultSlash; sum.slashHit += a.slash.hit;
  sum.noSlash += a.wrongSlash.noSlashTruth; sum.falseSlash += a.wrongSlash.falseSlash; sum.editTotal += e6.total; sum.editBeats += e6.nBeats;
  // spike 6's name-hit rule (t9_sweep.ts nameHits): root and vocab quality, dropped truth skipped, bass ignored
  for (const w of beatWindows(t.beats))
    for (const f of [0.25, 0.75]) {
      const x = w[0] + f * (w[2] - w[0]);
      const tc = at(tn, x);
      if (!tc || mapVocab(tc.quality) === null) continue;
      const rc = at(res, x);
      if (rc && noteToPc(rc.root) === noteToPc(tc.root) && mapVocab(rc.quality) === mapVocab(tc.quality)) sum.nameSpike6 += 0.5;
    }
  const b = scoreChords(t.chords, res, t.beats, 'down');
  const e = editCounts(t.chords, res, t.beats, 'down');
  sum2.points += b.nPoints; sum2.slashTruth += b.slash.truthSlash; sum2.slashResult += b.slash.resultSlash; sum2.slashHit += b.slash.hit;
  sum2.noSlash += b.wrongSlash.noSlashTruth; sum2.falseSlash += b.wrongSlash.falseSlash; sum2.editTotal += e.total; sum2.editBeats += e.nBeats;
  // name hit with /X ignored = root and quality: the same rule when the result has no /X (v1a results here)
  sum.nameNew += scoreChords(t.chords.map((c) => ({ ...c, bass: null })), res, t.beats, 'down').name.points.hit;
}
const { nameSpike6, nameNew, nameUnits: _u, ...s1 } = sum;
check('A scoring (v1a tuning results, 落 vs spike 6): points / slash / wrong-/X / edits', sum2, s1);
check('A name hit (root + quality; truth /X ignored on both sides) 落 vs spike 6 nameHits', nameNew, nameSpike6);
console.log(`A numbers: scored points ${sum.points}, name accuracy ${(nameSpike6 / sum.points).toFixed(4)}, wrong-/X ${(sum.falseSlash / sum.noSlash).toFixed(4)}, edits per 100 beats ${((sum.editTotal / sum.editBeats) * 100).toFixed(3)}`);

// B. input
const rmsOf = new Map<string, { rms: number; peak: number }>();
let offSame = 0;
for (const v of tuning) {
  const wav = decodeWav(new Uint8Array(readFileSync(join(OUT, v.wav))));
  const mine = prepareInput(toMono(wav.channels), wav.sampleRate, false).y;
  const ref = loadMono(join(OUT, v.wav));
  if (mine.length === ref.length && mine.every((x, i) => x === ref[i])) offSame++;
  const l = levelDb(mine);
  const l6 = levelDb6(ref);
  if (l.rmsDb !== l6.rmsDb || l.peakDb !== l6.peakDb) ok = false;
  rmsOf.set(v.name, { rms: l.rmsDb, peak: l.peakDb });
}
check('B off: files bit-equal to spike 6 loadMono', offSame, tuning.length);
const med = median([...rmsOf.values()].map((x) => x.rms));
console.log(`B median whole-file RMS of the tuning files: ${med.toFixed(3)} dBFS (spike 6 R3 target -22.0)`);
let gainSame = 0;
let maxDiff = 0;
let capped = 0;
for (const v of tuning) {
  const wav = decodeWav(new Uint8Array(readFileSync(join(OUT, v.wav))));
  const on = prepareInput(toMono(wav.channels), wav.sampleRate, true);
  const { rms, peak } = rmsOf.get(v.name)!;
  const g6 = gain6(rms, peak, -22);
  if (on.gainDb === g6 && normalizeGainDb(rms, peak) === g6) gainSame++;
  maxDiff = Math.max(maxDiff, Math.abs(on.gainDb - gain6(rms, peak, med)));
  if (g6 < -22 - rms - 1e-9) capped++;
}
check('B on: per-file gain equals spike 6 normalizeGainDb(rms, peak, -22)', gainSame, tuning.length);
console.log(`B on: largest |gain(-22) - gain(actual median)| = ${maxDiff.toFixed(3)} dB; peak-capped files: ${capped}`);
process.exit(ok ? 0 : 1);
