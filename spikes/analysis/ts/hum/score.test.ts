import { describe, expect, it } from 'vitest';
import {
  KEYBOARD_DEFAULT_TICKS,
  dropShortTruth,
  editScript,
  f0Scores,
  f0TrackScores,
  gridCandidateHit,
  keyboardSteps,
  matchNotes,
  maxBipartiteMatching,
  midiToHz,
  noteScoreSet,
  noteScores,
  notesToEvents,
  pitchCandidateHit,
  quantScores,
  quantizedToEvents,
  type ScoreNote,
  type TickNote,
} from './score';

const n = (start: number, end: number, midi: number, cents = 0): ScoreNote => ({ start, end, midi, cents });
const REF: ScoreNote[] = [n(0, 0.5, 60), n(0.5, 1, 62), n(1, 1.5, 64), n(1.5, 2, 65)];
const withNote = (i: number, f: (x: ScoreNote) => ScoreNote) => REF.map((x, k) => (k === i ? f(x) : x));
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 12);

describe('note F (hand calculated, mir_eval definitions)', () => {
  it('identical', () => {
    for (const s of Object.values(noteScoreSet(REF, REF))) {
      expect(s.f).toBe(1);
      expect(s.matched).toBe(4);
    }
  });
  it('onset: 50 ms is inside (<=, after rounding to 4 decimals), 60 ms outside; the 100 ms variant takes 60 ms', () => {
    const at50 = noteScoreSet(REF, withNote(1, (x) => ({ ...x, start: x.start + 0.05 })));
    expect(at50.onset.matched).toBe(4); // 0.55 - 0.5 = 0.05000000000000004 -> rounds to 0.05
    const at60 = noteScoreSet(REF, withNote(1, (x) => ({ ...x, start: x.start + 0.06 })));
    expect(at60.onset.matched).toBe(3);
    close(at60.onset.precision, 3 / 4);
    close(at60.onset.f, 3 / 4);
    expect(at60.onset100ms.matched).toBe(4);
  });
  it('offset tolerance is max(50 ms, 20 % of the reference duration)', () => {
    // note 0 lasts 0.5 s -> tolerance 0.1 s
    expect(noteScoreSet(REF, withNote(0, (x) => ({ ...x, end: x.end + 0.09 }))).onsetOffset.matched).toBe(4);
    const bad = noteScoreSet(REF, withNote(0, (x) => ({ ...x, end: x.end + 0.12 })));
    expect(bad.onsetOffset.matched).toBe(3);
    expect(bad.onset.matched).toBe(4); // offsets ignored
    // a 0.1 s reference note: 20 % = 20 ms < 50 ms -> tolerance 50 ms
    const short = [n(0, 0.1, 60)];
    expect(noteScores(short, [n(0, 0.15, 60)], {}).matched).toBe(1);
    expect(noteScores(short, [n(0, 0.16, 60)], {}).matched).toBe(0);
    // a 2 s reference note: tolerance 0.4 s
    const long = [n(0, 2, 60)];
    expect(noteScores(long, [n(0, 2.39, 60)], {}).matched).toBe(1);
    expect(noteScores(long, [n(0, 2.41, 60)], {}).matched).toBe(0);
  });
  it('pitch: 40 cents ok, 60 cents not; semitone variant ok; octave error only pitch class', () => {
    const p40 = noteScoreSet(REF, withNote(2, (x) => ({ ...x, cents: 40 })));
    expect(p40.onset.matched).toBe(4);
    const p60 = noteScoreSet(REF, withNote(2, (x) => ({ ...x, cents: 60 })));
    expect(p60.onset.matched).toBe(3);
    expect(p60.onsetSemitone.matched).toBe(4);
    expect(p60.onsetPitchClass.matched).toBe(3); // 60 cents is outside the 50-cent class tolerance too
    const oct = noteScoreSet(REF, withNote(3, (x) => ({ ...x, midi: x.midi + 12 })));
    expect(oct.onset.matched).toBe(3);
    expect(oct.onsetSemitone.matched).toBe(3);
    expect(oct.onsetPitchClass.matched).toBe(4);
    // octave plus 70 cents: not even a pitch class match
    expect(noteScoreSet(REF, withNote(3, (x) => ({ ...x, midi: x.midi + 12, cents: 70 }))).onsetPitchClass.matched).toBe(3);
    // octave below with -40 cents: pitch class ok
    expect(noteScoreSet(REF, withNote(3, (x) => ({ ...x, midi: x.midi - 12, cents: -40 }))).onsetPitchClass.matched).toBe(4);
  });
  it('miss and extra: recall / precision', () => {
    const miss = noteScores(REF, REF.slice(0, 3), { offsetRatio: null });
    close(miss.recall, 3 / 4);
    close(miss.precision, 1);
    close(miss.f, (2 * 0.75) / 1.75);
    const extra = noteScores(REF, [...REF, n(2, 2.5, 67)], { offsetRatio: null });
    close(extra.precision, 4 / 5);
    close(extra.recall, 1);
    close(extra.f, (2 * 0.8) / 1.8);
  });
  it('split (one reference note sung as two) and merge', () => {
    const ref = [n(0, 1, 60)];
    const split = [n(0, 0.5, 60), n(0.5, 1, 60)];
    const s = noteScoreSet(ref, split);
    expect(s.onset.matched).toBe(1);
    close(s.onset.precision, 1 / 2);
    close(s.onset.recall, 1);
    close(s.onset.f, 2 / 3);
    expect(s.onsetOffset.matched).toBe(0); // first part ends 0.5 s early, tolerance 0.2 s
    const m = noteScoreSet([n(0, 0.5, 60), n(0.5, 1, 60)], [n(0, 1, 60)]);
    close(m.onset.precision, 1);
    close(m.onset.recall, 1 / 2);
    expect(m.onsetOffset.matched).toBe(0);
  });
  it('is a maximum (not greedy) matching', () => {
    // ref A matches est x and y, ref B only x: greedy A-x leaves B unmatched, maximum gives 2
    const ref = [n(0.05, 1, 60), n(0.0, 1, 60)];
    const est = [n(0.0, 1, 60), n(0.1, 1, 60)];
    // A(0.05): x(0.0) d=.05 ok, y(0.1) d=.05 ok; B(0.0): x ok, y d=.1 no
    expect(matchNotes(ref, est, { offsetRatio: null }).length).toBe(2);
    expect(maxBipartiteMatching(2, 2, [[0, 1], [0]]).size).toBe(2);
    // two reference notes, one estimate: only one match
    expect(noteScores([n(0, 1, 60), n(0.06, 1, 60)], [n(0.03, 1, 60)], { offsetRatio: null }).matched).toBe(1);
  });
  it('empty inputs give zeros', () => {
    expect(noteScores([], REF).f).toBe(0);
    expect(noteScores(REF, []).f).toBe(0);
  });
});

describe('f0 metrics', () => {
  const t = [0, 0.01, 0.02, 0.03, 0.04, 0.05];
  const ref = [220, 220, 220, 0, 0, 0];
  it('perfect pitch, voicing everywhere: recall 1, false alarm 1', () => {
    const s = f0Scores(t, ref, t, [220, 220, 220, 220, 220, 220]);
    expect(s).toMatchObject({ rawPitchAccuracy: 1, rawChromaAccuracy: 1, voicingRecall: 1, voicingFalseAlarm: 1, octaveErrorRate: 0 });
  });
  it('octave error: pitch 0, chroma 1', () => {
    const s = f0Scores(t, ref, t, [440, 440, 440, 0, 0, 0]);
    expect(s).toMatchObject({ rawPitchAccuracy: 0, rawChromaAccuracy: 1, voicingRecall: 1, voicingFalseAlarm: 0, octaveErrorRate: 1 });
  });
  it('one of three voiced frames wrong by 100 cents; one not voiced; negative = unvoiced guess', () => {
    const wrong = 220 * Math.pow(2, 100 / 1200);
    const s = f0Scores(t, ref, t, [220, wrong, -220, 0, 0, 0]);
    close(s.rawPitchAccuracy, 2 / 3); // the guess in the unvoiced frame still counts for raw pitch
    close(s.rawChromaAccuracy, 2 / 3);
    close(s.voicingRecall, 2 / 3);
    expect(s.voicingFalseAlarm).toBe(0);
  });
  it('49 cents inside, 51 cents outside', () => {
    const f = (c: number) => 220 * Math.pow(2, c / 1200);
    const s = f0Scores(t, ref, t, [f(49), f(-51), 220, 0, 0, 0]);
    close(s.rawPitchAccuracy, 2 / 3);
  });
  it('no voiced reference frames: pitch 0, recall 1 (mir_eval)', () => {
    const s = f0Scores(t, [0, 0, 0, 0, 0, 0], t, [220, 0, 0, 0, 0, 0]);
    expect(s.rawPitchAccuracy).toBe(0);
    expect(s.voicingRecall).toBe(1);
    close(s.voicingFalseAlarm, 1 / 6);
  });
  it('estimate on another time base is linearly resampled to the reference', () => {
    // est every 20 ms, constant pitch: resampled values stay 220
    const s = f0Scores(t, ref, [0, 0.02, 0.04, 0.06], [220, 220, 220, 220]);
    close(s.rawPitchAccuracy, 1);
  });
  it('track helper: unvoiced frames (voiced < 0.5) keep their pitch guess for raw pitch only', () => {
    const truth = { t0: 0, hopSec: 0.01, hz: ref };
    const est = { t0: 0, hopSec: 0.01, hz: [220, 220, 220, 220, 0, 0], voiced: [1, 1, 0.2, 0.9, 0, 0] };
    const s = f0TrackScores(truth, est);
    close(s.rawPitchAccuracy, 1);
    close(s.voicingRecall, 2 / 3);
    close(s.voicingFalseAlarm, 1 / 3);
  });
  it('midiToHz', () => {
    close(midiToHz(69), 440);
    close(midiToHz(60), 261.6255653005986);
  });
});

const tn = (startTick: number, ticks: number, midi: number): TickNote => ({ startTick, ticks, midi });
const ev = (notes: TickNote[]) => notesToEvents(notes);

describe('edit count (hand calculated)', () => {
  const truth = [tn(0, 4, 60), tn(4, 4, 62), tn(8, 8, 64)];
  it('identical = 0', () => {
    const r = editScript(ev(truth), ev(truth));
    expect(r.edits).toBe(0);
    expect(r.editsPerNote).toBe(0);
  });
  it('change pitch / change duration / both', () => {
    expect(editScript(ev(truth), ev([tn(0, 4, 60), tn(4, 4, 63), tn(8, 8, 64)])).counts).toMatchObject({ pitch: 1, duration: 0 });
    // duration change of the last note only: nothing after it, so no shift
    const d = editScript(ev(truth), ev([tn(0, 4, 60), tn(4, 4, 62), tn(8, 4, 64)]));
    expect(d.edits).toBe(1);
    expect(d.counts.duration).toBe(1);
    const both = editScript(ev(truth), ev([tn(0, 4, 60), tn(4, 4, 63), tn(8, 4, 64)]));
    expect(both.edits).toBe(2);
    close(both.editsPerNote, 2 / 3);
  });
  it('a longer middle note shifts the next one in time only: 1 duration edit', () => {
    // out: 60(4) 62(8) 64(8): truth has 62 at 4..8 and 64 at 8..16 -> change duration of 62 (8->4); 64 keeps its length
    const r = editScript(ev(truth), ev([tn(0, 4, 60), tn(4, 8, 62), tn(12, 8, 64)]));
    expect(r.edits).toBe(1);
    expect(r.counts.duration).toBe(1);
  });
  it('extra note = 1 delete, missing note = 1 insert', () => {
    const extra = editScript(ev(truth), ev([tn(0, 4, 60), tn(4, 4, 62), tn(8, 4, 70), tn(12, 4, 64), tn(16, 4, 64)]));
    // extra N70 (delete) + the truth note 64(8) split into two 64(4) in the output (merge) = 2
    expect(extra.edits).toBe(2);
    const del = editScript(ev(truth), ev([tn(0, 4, 60), tn(4, 4, 62), tn(8, 8, 64), tn(16, 4, 66)]));
    expect(del.edits).toBe(1);
    expect(del.counts.delete).toBe(1);
    const ins = editScript(ev(truth), ev([tn(0, 4, 60), tn(8, 8, 64)])); // 62 missing -> rest of 4 in its place: insert note replaced rest
    // out events: N60(4) R4 N64(8); truth N60 N62 N64: rest -> note is delete + insert = 2
    expect(ins.edits).toBe(2);
    const ins2 = editScript(ev(truth), [
      { kind: 'note', startTick: 0, ticks: 4, midi: 60 },
      { kind: 'note', startTick: 4, ticks: 8, midi: 64 },
    ]);
    // out N60(4) N64(8) vs truth N60(4) N62(4) N64(8): insert N62 = 1
    expect(ins2.edits).toBe(1);
    expect(ins2.counts.insert).toBe(1);
  });
  it('octave error is one pitch change', () => {
    const r = editScript(ev(truth), ev([tn(0, 4, 60), tn(4, 4, 74), tn(8, 8, 64)]));
    expect(r.edits).toBe(1);
    expect(r.counts.pitch).toBe(1);
  });
  it('split: output has one long note, truth two equal-pitch notes = 1', () => {
    const r = editScript(ev([tn(0, 4, 60), tn(4, 4, 60)]), ev([tn(0, 8, 60)]));
    expect(r.edits).toBe(1);
    expect(r.counts.split).toBe(1);
    // second part has another pitch: split + change pitch = 2
    const r2 = editScript(ev([tn(0, 4, 60), tn(4, 4, 62)]), ev([tn(0, 8, 60)]));
    expect(r2.edits).toBe(2);
  });
  it('merge: output has two fragments, truth one note = 1', () => {
    const r = editScript(ev([tn(0, 8, 60)]), ev([tn(0, 4, 60), tn(4, 4, 60)]));
    expect(r.edits).toBe(1);
    expect(r.counts.merge).toBe(1);
  });
  it('rests: start shifted by a rest of different length = 1; missing leading rest = 1 insert', () => {
    const t = [tn(4, 4, 60)];
    expect(editScript(ev(t), ev([tn(8, 4, 60)])).edits).toBe(1); // R8 N4 vs R4 N4: change duration of the rest
    expect(editScript(ev(t), ev([tn(0, 4, 60)])).edits).toBe(1); // insert rest
  });
  it('trailing rests are ignored', () => {
    const r = editScript(ev(truth), [...ev(truth), { kind: 'rest', startTick: 16, ticks: 8 }]);
    expect(r.edits).toBe(0);
  });
  it('empty output: insert every event', () => {
    const r = editScript(ev(truth), []);
    expect(r.edits).toBe(3);
    expect(r.counts.insert).toBe(3);
  });
  it('keyboard baseline: events + duration switches (initial duration = a quarter)', () => {
    expect(KEYBOARD_DEFAULT_TICKS).toBe(16);
    // truth 4,4,8: first event 4 != 16 -> switch; second same; third 8 -> switch: 3 events + 2 switches
    expect(keyboardSteps(ev(truth))).toBe(5);
    expect(keyboardSteps(ev([tn(0, 16, 60), tn(16, 16, 62)]))).toBe(2);
    const r = editScript(ev(truth), ev([tn(0, 4, 60), tn(4, 4, 63), tn(8, 4, 64)]));
    close(r.ratioToKeyboard, 2 / 5);
  });
  it('quantizedToEvents strips trailing rests and keeps order', () => {
    const e = quantizedToEvents({
      events: [
        { kind: 'rest', startTick: 0, ticks: 4 },
        { kind: 'note', startTick: 4, ticks: 4, midi: 60, src: 0, candidates: [], gridCandidates: [], confidence: 1 },
        { kind: 'rest', startTick: 8, ticks: 4 },
      ],
    });
    expect(e.length).toBe(2);
  });
  it('dropShortTruth drops notes shorter than a 16th', () => {
    expect(dropShortTruth([tn(0, 2, 60), tn(2, 4, 62)]).length).toBe(1);
  });
});

describe('rounded-note accuracy and candidates', () => {
  const truth = [tn(0, 4, 60), tn(4, 4, 62), tn(8, 8, 64)];
  const out = [tn(0, 4, 60), tn(4, 4, 63), tn(8, 4, 64), tn(12, 4, 64)];
  it('start / pitch / duration fractions', () => {
    const q = quantScores(truth, out);
    close(q.startAcc, 3 / 3);
    close(q.startPitchAcc, 2 / 3);
    close(q.startTicksAcc, 2 / 3);
    close(q.exactAcc, 1 / 3);
    close(q.exactPrecision, 1 / 4);
    // alignment: merge of the last two output notes; sub pairs are (0,0),(1,1) -> pitch equal only for the first
    close(q.pitchOnlyAcc, 1 / 3);
  });
  it('grid candidate hit: chosen wrong but second candidate right', () => {
    const o = [
      { startTick: 0, ticks: 4, midi: 60, gridCandidates: [] },
      { startTick: 4, ticks: 8, midi: 62, gridCandidates: [{ startTick: 4, ticks: 4 }] },
      { startTick: 12, ticks: 4, midi: 64, gridCandidates: [] },
    ];
    const t = [tn(0, 4, 60), tn(4, 4, 62), tn(8, 8, 64)];
    // edit alignment: sub, sub (duration), sub (start 12 vs 8, duration) -> pairs for all three? rest handling:
    // output events N0-4 N4-12 N12-16 ; truth N0-4 N4-8 N8-16 : all three substitutions
    close(gridCandidateHit(t, o, 1), 1 / 3);
    close(gridCandidateHit(t, o, 2), 2 / 3);
  });
  it('pitch candidate hit rate pairs by onset only', () => {
    const t = [n(0, 0.5, 60), n(0.5, 1, 62), n(1, 1.5, 64)];
    const est = [
      { start: 0.01, end: 0.5, midi: 60, candidates: [] },
      { start: 0.52, end: 1, midi: 63, candidates: [{ midi: 62, confidence: 0.3 }] },
      { start: 1.0, end: 1.5, midi: 52, candidates: [{ midi: 51, confidence: 0.2 }] },
    ];
    close(pitchCandidateHit(t, est, 1), 1 / 3);
    close(pitchCandidateHit(t, est, 2), 2 / 3);
  });
});
