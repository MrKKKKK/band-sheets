import { describe, expect, it } from 'vitest';
import type { model } from '@coderline/alphatab';
import { parseSong } from '../../../src/lib/parseSong';
import { saintsSampleText } from '../../../src/lib/saintsSample';
import { chordTimeline } from './chordTimeline';
import { chordEtude, chordEtudeAABA } from './etude';
import { CHORD_INTERVALS, pianoPartBody, recComp } from './pianoPart';
import { parseChordSymbol } from './chordSymbol';
import { buildTruth, generateMidi, importScore, setPrograms } from './truth';
import type { ChordTimeline, Variant } from './types';

const load = (body: string): model.Score => importScore(`\\tempo 120\n.\n\\track "Piano"\n\\ts 4 4\n${body}\n`);

/** Every note start (in eighths from the song start) per voice: [eighth, midi[]]. */
function voiceNotes(score: model.Score, voice: number): { at16: number; midi: number[] }[] {
  const out: { at16: number; midi: number[] }[] = [];
  for (const bar of score.tracks[0].staves[0].bars) {
    for (const b of bar.voices[voice].beats) {
      if (b.isRest || b.notes.length === 0) continue;
      out.push({ at16: (bar.index * 3840 + b.playbackStart) / 240, midi: b.notes.map((n) => n.realValue).sort((x, y) => x - y) });
    }
  }
  return out;
}

const saints = chordTimeline(parseSong(saintsSampleText));
const etude = chordTimeline(parseSong(chordEtude(1).text));

/** Hand-made 3-bar timeline: C | C (G on beat 3) | F, sections A. */
const small: ChordTimeline = {
  ts: [4, 4],
  bars: 3,
  sections: [{ label: 'A', startBar: 0, bars: 3 }],
  chords: [
    { bar: 0, beat: 0, text: 'C' },
    { bar: 1, beat: 2, text: 'G' },
    { bar: 2, beat: 0, text: 'F' },
  ],
};

describe('recComp', () => {
  it('is deterministic per seed and differs between seeds', () => {
    expect(recComp(saints, { seed: 1 })).toEqual(recComp(saints, { seed: 1 }));
    expect(recComp(saints, { seed: 2 }).body).not.toBe(recComp(saints, { seed: 1 }).body);
  });

  it('imports as three voices with the right bars and sections', () => {
    const { body } = recComp(saints);
    const score = load(body);
    const bars = score.tracks[0].staves[0].bars;
    expect(bars).toHaveLength(32);
    for (const b of bars) expect(b.voices).toHaveLength(3);
    expect(bars[0].masterBar.section?.text).toBe('A');
    expect(bars[16].masterBar.section?.text).toBe('B');
    for (const b of bars) for (const v of b.voices) expect(v.beats.reduce((n, x) => n + x.playbackDuration, 0)).toBe(3840);
  });

  it('anticipates a beat-3 change to the "and" of beat 2 (eighth-note truth)', () => {
    const r = recComp(small, { anticipateShare: 1 });
    expect(r.timeline.chords).toEqual([
      { bar: 0, beat: 0, text: 'C' },
      { bar: 1, beat: 1.5, text: 'G' }, // bar 1, the "and" of beat 2
      { bar: 1, beat: 3.5, text: 'F' }, // bar head change -> the "and" of beat 4
    ]);
    const none = recComp(small, { anticipateShare: 0 });
    expect(none.timeline.chords).toEqual(small.chords);
    // The audio follows: in bar 1 the left hand plays C 1-5-8, then G's root (G2 = 43) on the "and" of
    // beat 2 (sixteenth 16 + 6), then F's root (F2 = 41) on the "and" of beat 4 (sixteenth 16 + 14).
    const lh = voiceNotes(load(r.body), 0).filter((n) => n.at16 >= 16 && n.at16 < 32);
    expect(lh.map((n) => n.midi[0])).toEqual([36, 43, 48, 43, 43, 50, 55, 41]);
    expect(lh[3].at16).toBe(22);
  });

  it('puts the anticipated chord start at the right second in the truth', () => {
    const r = recComp(small, { anticipateShare: 1 });
    const score = load(r.body);
    setPrograms(score);
    const v: Variant = { song: 'etude', mix: 'piano', tempo: 120, swing: 'none', click: false, name: 't' };
    const truth = buildTruth({ score, midi: generateMidi(score), timeline: r.timeline, variant: v, sampleRate: 44100, soundFont: 'x' });
    // beat = 0.5 s; bar 1 + 1.5 beats = 5.5 beats = 2.75 s
    expect(truth.chords!.map((c) => [c.text, c.start])).toEqual([['C', 0], ['G', 2.75], ['F', 3.75]]);
  });

  it('starts every chord span with the bass (root) in the left hand', () => {
    for (const t of [saints, etude]) {
      const r = recComp(t, { seed: 5 });
      const lh = voiceNotes(load(r.body), 0);
      const lastBar = t.bars - 1;
      for (const c of r.timeline.chords) {
        const at16 = c.bar * 16 + c.beat * 4;
        const note = lh.find((n) => n.at16 === at16);
        const sym = parseChordSymbol(c.text);
        expect(note, `${c.text} at bar ${c.bar} beat ${c.beat}`).toBeDefined();
        expect(note!.midi[0] % 12).toBe(sym.bass ?? sym.root);
        if (c.bar < lastBar) expect(note!.midi[0]).toBeLessThan(48);
      }
    }
  });

  it('left hand plays 1-5-8-5 eighths; right hand uses 2 chord tones (plus rare wrong notes)', () => {
    const r = recComp(small, { anticipateShare: 0, missShare: 0 });
    const score = load(r.body);
    const lh = voiceNotes(score, 0).filter((n) => n.at16 < 16).map((n) => n.midi[0]);
    expect(lh).toEqual([36, 43, 48, 43, 36, 43, 48, 43]);
    for (const n of voiceNotes(score, 1)) {
      expect(n.midi).toHaveLength(2);
    }
    // With missShare 1 every hit gets a third note a semitone away from one of the pair.
    const wrong = voiceNotes(load(recComp(saints, { missShare: 1 }).body), 1);
    expect(wrong.filter((n) => n.midi.length === 3).length).toBeGreaterThan(wrong.length * 0.9);
  });

  it('right-hand pairs come from the chord, the third included for triads', () => {
    const r = recComp(etude, { missShare: 0, seed: 3 });
    const score = load(r.body);
    const at = (at16: number) => {
      let k = 0;
      while (k + 1 < r.timeline.chords.length) {
        const c = r.timeline.chords[k + 1];
        if (c.bar * 16 + c.beat * 4 <= at16) k++;
        else break;
      }
      return parseChordSymbol(r.timeline.chords[k].text);
    };
    for (const n of voiceNotes(score, 1)) {
      const c = at(n.at16);
      const pcs = CHORD_INTERVALS[c.quality].map((i) => (c.root + i) % 12);
      for (const m of n.midi) expect(pcs).toContain(m % 12);
      if (c.quality === 'maj' || c.quality === 'min') expect(n.midi.map((m) => m % 12)).toContain(pcs[1]);
    }
  });

  it('has a melody voice above the right hand with some non-chord tones', () => {
    const score = load(recComp(etude, { seed: 1 }).body);
    const mel = voiceNotes(score, 2);
    expect(mel.length).toBeGreaterThan(40);
    for (const n of mel) expect(n.midi[0]).toBeGreaterThanOrEqual(70);
    expect(mel.some((n) => n.at16 % 2 === 1)).toBe(true); // sixteenths
  });

  it('pickup: bar 0 only has the melody pickup on its last beat', () => {
    const t = chordTimeline(parseSong(chordEtudeAABA(3).text));
    const r = recComp(t, { pickupBeats: 1 });
    const score = load(r.body);
    expect(score.tracks[0].staves[0].bars).toHaveLength(33);
    expect(voiceNotes(score, 0)[0].at16).toBe(16);
    expect(voiceNotes(score, 1)[0].at16).toBe(16);
    const m = voiceNotes(score, 2);
    expect(m.filter((n) => n.at16 < 16).map((n) => n.at16)).toEqual([12, 14]);
  });

  it('rejects non-4/4 and is refused by pianoPartBody', () => {
    expect(() => recComp({ ...small, ts: [3, 4] })).toThrow();
    expect(() => pianoPartBody(small, 'rec')).toThrow();
  });
});
