import { describe, expect, it } from 'vitest';
import type { model } from '@coderline/alphatab';
import { parseSong } from '../../../src/lib/parseSong';
import { saintsSampleText } from '../../../src/lib/saintsSample';
import { chordTimeline } from './chordTimeline';
import { chordEtude, chordEtudeAABA } from './etude';
import { CHORD_INTERVALS, pianoPartBody, REC_HARD, REC_HARD_DEFAULTS, recComp } from './pianoPart';
import type { RecHardOptions } from './pianoPart';
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

/** Sounding notes of a voice with ties merged: [start, end) in sixteenths, MIDI pitch. */
function sounding(score: model.Score, voice: number): { at16: number; end16: number; midi: number; dyn: number }[] {
  const out: { at16: number; end16: number; midi: number; dyn: number }[] = [];
  const open = new Map<number, (typeof out)[number]>();
  for (const bar of score.tracks[0].staves[0].bars) {
    for (const b of bar.voices[voice].beats) {
      const at16 = (bar.index * 3840 + b.playbackStart) / 240;
      const end16 = at16 + b.playbackDuration / 240;
      for (const n of b.notes) {
        const o = open.get(n.realValue);
        if (n.isTieDestination) {
          expect(o, `tie without origin at ${at16}`).toBeDefined();
          expect(o!.end16).toBe(at16);
          o!.end16 = end16;
        } else {
          const x = { at16, end16, midi: n.realValue, dyn: b.dynamics };
          out.push(x);
          open.set(n.realValue, x);
        }
      }
    }
  }
  return out;
}

describe('recComp hard style (T4b)', () => {
  const hard = (h: Partial<RecHardOptions>, x: object = {}) =>
    recComp(etude, { ...REC_HARD, missShare: 0, ...x, hard: { ...REC_HARD_DEFAULTS, ...h } });
  const pcsOf = (text: string) => {
    const c = parseChordSymbol(text);
    return { c, pcs: CHORD_INTERVALS[c.quality].map((i) => (c.root + i) % 12) };
  };
  /** Chord of the returned timeline at a sixteenth. */
  const chordAt = (r: ReturnType<typeof recComp>, at16: number) => {
    let k = 0;
    while (k + 1 < r.timeline.chords.length && r.timeline.chords[k + 1].bar * 16 + r.timeline.chords[k + 1].beat * 4 <= at16) k++;
    return r.timeline.chords[k].text;
  };

  it('is deterministic and leaves the T4 style alone', () => {
    expect(recComp(saints, REC_HARD)).toEqual(recComp(saints, REC_HARD));
    expect(recComp(saints, { ...REC_HARD, seed: 2 }).body).not.toBe(recComp(saints, REC_HARD).body);
    expect(recComp(saints, { seed: 1 }).body).not.toBe(recComp(saints, REC_HARD).body);
  });

  it('imports as four full voices (left hand ff, the rest mf) with valid ties', () => {
    for (const t of [saints, etude]) {
      const score = load(recComp(t, REC_HARD).body);
      const bars = score.tracks[0].staves[0].bars;
      expect(bars).toHaveLength(32);
      for (const b of bars) {
        expect(b.voices).toHaveLength(4);
        for (const v of b.voices) expect(v.beats.reduce((n, x) => n + x.playbackDuration, 0)).toBe(3840);
      }
      // DynamicValue: MF = 4, FF = 6.
      for (let v = 0; v < 4; v++) for (const n of sounding(score, v)) expect(n.dyn).toBe(v === 0 ? 6 : 4);
    }
  });

  it('passing chords: halfBarShare 1 changes every one-chord bar on beat 3 and returns on the next bar', () => {
    const none = hard({ halfBarShare: 0 }, { anticipateShare: 0 });
    expect(none.timeline.chords).toEqual(etude.chords);
    const all = hard({ halfBarShare: 1 }, { anticipateShare: 0 });
    const writtenChange = new Set(etude.chords.filter((c) => c.beat !== 0).map((c) => c.bar));
    for (let bar = 0; bar < 31; bar++) {
      if (writtenChange.has(bar)) continue;
      const mid = all.timeline.chords.find((c) => c.bar === bar && c.beat === 2);
      expect(mid, `bar ${bar}`).toBeDefined();
      expect(chordAt(all, bar * 16 + 15)).not.toBe(chordAt(all, bar * 16));
      expect(chordAt(all, (bar + 1) * 16)).toBe(chordAt(none, (bar + 1) * 16));
    }
    // The written chords are all still there (truth stays exact: it is the returned timeline).
    for (const c of etude.chords) expect(chordAt(all, c.bar * 16 + c.beat * 4)).toBe(c.text);
  });

  it('power chords: no third in the right hand at thirdShare 0; always at 1', () => {
    for (const [share, want] of [[0, false], [1, true]] as const) {
      const r = hard({ thirdShare: share, minorThirdShare: share, pedalEighths: 0 });
      const score = load(r.body);
      for (const v of [1, 2]) {
        const hits = new Map<number, number[]>();
        for (const n of sounding(score, v)) hits.set(n.at16, [...(hits.get(n.at16) ?? []), n.midi % 12]);
        for (const [at16, pcs] of hits) {
          const { c, pcs: chord } = pcsOf(chordAt(r, at16));
          if (c.quality === 'sus4') continue;
          expect(pcs.includes(chord[1]), `${c.text} at ${at16}: ${pcs}`).toBe(want);
        }
      }
    }
  });

  it('inverted power chords: the left hand starts on the 5th (invertShare 1) or on the bass (0)', () => {
    for (const share of [0, 1]) {
      const r = hard({ invertShare: share });
      const lh = sounding(load(r.body), 0);
      let inverted = 0;
      for (const ch of r.timeline.chords) {
        const at16 = ch.bar * 16 + ch.beat * 4;
        if (ch.bar === 31) continue;
        const { c, pcs } = pcsOf(ch.text);
        const low = lh.find((n) => n.at16 === at16)!.midi;
        expect(low).toBeLessThan(48);
        const plain = share === 0 || c.bass !== null || c.quality === 'sus4';
        expect(low % 12, `${ch.text} at ${at16}`).toBe(plain ? (c.bass ?? c.root) : pcs[2]);
        if (!plain) {
          inverted++;
          // then the root (a 4th above; a tritone for dim), unless the half bar restarts the figure
          if (at16 % 8 < 6) expect(lh.find((n) => n.at16 === at16 + 2)!.midi % 12).toBe(c.root);
        }
      }
      if (share === 1) expect(inverted).toBeGreaterThan(20);
    }
  });

  it('sustain: the last right-hand pair of a chord rings into the next one, without re-struck pitches', () => {
    const crossing = (r: ReturnType<typeof recComp>) => {
      const score = load(r.body);
      const changes = r.timeline.chords.slice(1).map((c) => c.bar * 16 + c.beat * 4);
      const rh = [...sounding(score, 1), ...sounding(score, 2)];
      let n = 0;
      for (const x of rh) {
        const ch = changes.find((c) => x.at16 < c && x.end16 > c);
        if (ch === undefined) continue;
        n++;
        expect(x.end16 - ch).toBeLessThanOrEqual(8);
        expect(rh.some((y) => y.at16 === ch && y.midi === x.midi)).toBe(false);
      }
      return n;
    };
    expect(crossing(hard({ pedalEighths: 0 }))).toBe(0);
    expect(crossing(hard({ pedalEighths: 4 }))).toBeGreaterThan(20);
  });

  it('melody: held non-chord tones on beats 1 / 3 at longNonChordShare 1', () => {
    const r = hard({ longNonChordShare: 1 });
    const mel = sounding(load(r.body), 3);
    const held = mel.filter((n) => n.end16 - n.at16 >= 4 && n.at16 % 8 === 0);
    expect(held.length).toBeGreaterThan(40);
    for (const n of held) expect(pcsOf(chordAt(r, n.at16)).pcs).not.toContain(n.midi % 12);
  });

  it('pickup (etude3): bar 0 only has the melody pickup', () => {
    const t = chordTimeline(parseSong(chordEtudeAABA(3).text));
    const r = recComp(t, { ...REC_HARD, seed: 3, pickupBeats: 1 });
    const score = load(r.body);
    expect(score.tracks[0].staves[0].bars).toHaveLength(33);
    expect(Math.min(...sounding(score, 0).map((n) => n.at16))).toBe(16);
    for (const v of [1, 2]) expect(Math.min(...sounding(score, v).map((n) => n.at16))).toBeGreaterThanOrEqual(16);
    expect(sounding(score, 3).filter((n) => n.at16 < 16).map((n) => n.at16)).toEqual([12, 14]);
  });
});
