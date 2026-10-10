import { describe, expect, it } from 'vitest';
import { parseSong } from '../../../src/lib/parseSong';
import { saintsSampleText } from '../../../src/lib/saintsSample';
import type { Song } from '../../../src/lib/song';
import { chordsPerBeat, chordTimeline } from './chordTimeline';
import {
  applyTempoCurve,
  buildScoreTex,
  buildTruth,
  generateMidi,
  importScore,
  PIANO_TRACK,
  setPrograms,
  type TruthInput,
} from './truth';
import type { ChordTimeline, Mix, Variant } from './types';

const saints = parseSong(saintsSampleText);
const timeline = chordTimeline(saints);

/** Stand-in for T4's pianoPartBody: one C4 quarter per beat, with \section lines. */
function stubPianoBody(t: ChordTimeline): string {
  return t.sections
    .map(
      (s) =>
        `\\section "${s.label}"\n:4 ` +
        Array.from({ length: s.bars }, () => 'C4 C4 C4 C4 |').join('\n'),
    )
    .join('\n');
}
const pianoBody = stubPianoBody(timeline);

function variant(
  mix: Mix,
  tempo: number,
  swing: Variant['swing'],
): Variant {
  return {
    song: 'saints',
    mix,
    tempo,
    swing,
    click: false,
    name: `${mix}-t${tempo}-${swing}`,
  };
}

function input(tex: string, v: Variant, t: ChordTimeline = timeline): TruthInput {
  const score = importScore(tex);
  applyTempoCurve(score, v);
  setPrograms(score);
  return {
    score,
    midi: generateMidi(score),
    timeline: t,
    variant: v,
    key: saints.meta.key,
    sampleRate: 44100,
    soundFont: 'sonivox.sf2',
  };
}

function truthFor(v: Variant, song: Song = saints) {
  return buildTruth(input(buildScoreTex(song, pianoBody, v), v));
}

const BEAT = 60 / 116;
const BAR = 4 * BEAT;

describe('buildScoreTex', () => {
  const trackNames = (tex: string) =>
    [...tex.matchAll(/^\\track "([^"]*)"/gm)].map((m) => m[1]);

  it('puts Drums first, then Piano, then the melody part, per mix', () => {
    expect(trackNames(buildScoreTex(saints, pianoBody, variant('full', 116, 'asWritten')))).toEqual(
      ['Drums', PIANO_TRACK, 'Vocal'],
    );
    expect(
      trackNames(buildScoreTex(saints, pianoBody, variant('piano+drums', 116, 'asWritten'))),
    ).toEqual(['Drums', PIANO_TRACK]);
    expect(trackNames(buildScoreTex(saints, pianoBody, variant('piano', 80, 'none')))).toEqual([
      PIANO_TRACK,
    ]);
  });

  it('uses the variant tempo and replaces every \\tf with none for straight', () => {
    const straight = buildScoreTex(saints, pianoBody, variant('full', 80, 'none'));
    expect(straight).toMatch(/^\\tempo 80$/m);
    expect(straight).not.toMatch(/triplet8th/);
    expect(straight.match(/^\\tf none$/gm)).toHaveLength(2);
    const shuffle = buildScoreTex(saints, pianoBody, variant('full', 116, 'asWritten'));
    expect(shuffle.match(/^\\tf triplet8th$/gm)).toHaveLength(2);
  });

  it('rejects a song without the parts the mix needs', () => {
    const noDrums = { ...saints, parts: saints.parts.filter((p) => p.name !== 'Drums') };
    expect(() => buildScoreTex(noDrums, pianoBody, variant('piano+drums', 116, 'none'))).toThrow(
      /ドラム/,
    );
    const pianoNamed = {
      ...saints,
      parts: saints.parts.map((p) => (p.name === 'Vocal' ? { ...p, name: PIANO_TRACK } : p)),
    };
    expect(() => buildScoreTex(pianoNamed, pianoBody, variant('full', 116, 'none'))).toThrow(
      /Piano/,
    );
  });
});

describe('buildTruth: 聖者の行進 at 116 BPM (full, shuffle as written)', () => {
  const v = variant('full', 116, 'asWritten');
  const truth = truthFor(v);

  it('has the fixed header, render info, key and time signature', () => {
    expect(truth.format).toBe('band-sheets-analysis');
    expect(truth.version).toBe(1);
    expect(truth.analyzer.name).toBe('ground-truth');
    expect(truth.source.kind).toBe('synthetic');
    expect(truth.source.click).toBe(false);
    expect(truth.source.durationSec).toBeCloseTo(32 * BAR, 5); // 66.207
    expect(truth.render).toMatchObject({
      song: 'saints',
      variant: v.name,
      tempo: 116,
      tracks: ['Drums', 'Piano', 'Vocal'],
      sampleRate: 44100,
      alphaTab: '1.8.4',
      soundFont: 'sonivox.sf2',
    });
    expect(truth.render!.programs).toEqual({ Piano: 0, Vocal: 65 });
    expect(truth.key).toEqual({ tonic: 'C', mode: 'major', confidence: 1 });
    expect(truth.timeSignature).toEqual({ num: 4, den: 4, confidence: 1 });
  });

  it('has 128 beats and 32 downbeats, bar 1 at 4 × 60/116 s', () => {
    const beats = truth.beats!;
    expect(beats).toHaveLength(128);
    expect(beats.filter((b) => b.downbeat)).toHaveLength(32);
    expect(beats[0]).toEqual({ t: 0, downbeat: true, bar: 0, beat: 0 });
    expect(beats[4].t).toBeCloseTo(2.069, 3);
    expect(beats[4]).toMatchObject({ downbeat: true, bar: 1, beat: 0 });
    expect(beats[5]).toMatchObject({ downbeat: false, bar: 1, beat: 1 });
    beats.forEach((b, i) => expect(b.t).toBeCloseTo(i * BEAT, 6));
  });

  it('starts the melody right after beat 1 (pickup bar opens with a quarter rest)', () => {
    const notes = truth.melody!.notes;
    expect(notes[0].start).toBeCloseTo(0.517, 3);
    expect(notes[0].end).toBeCloseTo(2 * BEAT, 3);
    expect(notes[0].midi).toBe(60);
    // "saints": G4 whole note filling bar 1.
    expect(notes[3]).toMatchObject({ midi: 67 });
    expect(notes[3].start).toBeCloseTo(BAR, 6);
    expect(notes[3].end).toBeCloseTo(2 * BAR, 6);
    // Last "shine": C4 whole note in bar 31, ending at the end of the song.
    const last = notes.at(-1)!;
    expect(last.midi).toBe(60);
    expect(last.start).toBeCloseTo(31 * BAR, 6);
    expect(last.end).toBeCloseTo(32 * BAR, 6);
    // Every sung note of the Vocal part, none dropped: 34 per section.
    expect(notes).toHaveLength(68);
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].start).toBeGreaterThanOrEqual(notes[i - 1].start);
    }
  });

  it('puts the shuffled off-beat hi-hat at 2/3 of the beat', () => {
    const offs = truth.drums!.filter(
      (d) => d.inst === 'HH' && d.t > BAR + 0.01 && d.t < BAR + BEAT - 0.01,
    );
    expect(offs).toHaveLength(1);
    expect(offs[0].t).toBeCloseTo(BAR + (2 / 3) * BEAT, 6);
    expect(truth.swing).toEqual({ kind: '8', confidence: 1 });
  });

  it('names drum hits from the app articulation table', () => {
    const drums = truth.drums!;
    const at = (t: number) =>
      drums
        .filter((d) => Math.abs(d.t - t) < 1e-6)
        .map((d) => d.inst)
        .sort();
    expect(at(0)).toEqual(['HH']);
    expect(at(BAR)).toEqual(['BD', 'CR']);
    expect(at(BAR + BEAT)).toEqual(['HH', 'SD']);
    // Last bar `:2 (CR BD) r` — a full bar of its own (bar 31).
    expect(at(31 * BAR)).toEqual(['BD', 'CR']);
    expect(drums.filter((d) => d.t > 31 * BAR + 1e-6)).toEqual([]);
    expect(new Set(drums.map((d) => d.inst))).toEqual(new Set(['HH', 'SD', 'BD', 'CR']));
    for (const d of drums) {
      expect(d.strength).toBeGreaterThan(0);
      expect(d.strength).toBeLessThanOrEqual(1);
    }
  });

  it('has sections A at 0 and B at bar 16', () => {
    expect(truth.sections).toHaveLength(2);
    const [a, b] = truth.sections!;
    expect(a.label).toBe('A');
    expect(a.start).toBe(0);
    expect(a.end).toBeCloseTo(16 * BAR, 6); // 33.103
    expect(b.label).toBe('B');
    expect(b.start).toBeCloseTo(16 * BAR, 6);
    expect(b.end).toBeCloseTo(32 * BAR, 6);
  });

  it('has chords that line up with chordsPerBeat', () => {
    const chords = truth.chords!;
    expect(chords).toHaveLength(timeline.chords.length);
    expect(chords[0].start).toBe(0);
    expect(chords.at(-1)!.end).toBeCloseTo(32 * BAR, 6);
    for (let i = 1; i < chords.length; i++) {
      expect(chords[i].start).toBeCloseTo(chords[i - 1].end, 9);
    }
    const perBeat = chordsPerBeat(timeline);
    perBeat.forEach((row, bar) =>
      row.forEach((text, beat) => {
        const mid = bar * BAR + (beat + 0.5) * BEAT;
        const c = chords.find((x) => x.start <= mid && mid < x.end);
        expect(c?.text, `bar ${bar} beat ${beat}`).toBe(text);
      }),
    );
    const g7 = chords.find((c) => c.text === 'G7')!;
    expect(g7).toMatchObject({ root: 'G', quality: '7', bass: null, confidence: 1 });
    expect(chords.find((c) => c.text === 'C')).toMatchObject({ root: 'C', quality: 'maj' });
  });
});

describe('buildTruth: straight and partial mixes', () => {
  it('keeps the off-beat hi-hat at 1/2 of the beat when straight, and has no swing', () => {
    const truth = truthFor(variant('piano+drums', 116, 'none'));
    const off = truth.drums!.find(
      (d) => d.inst === 'HH' && d.t > BAR + 0.01 && d.t < BAR + BEAT - 0.01,
    )!;
    expect(off.t).toBeCloseTo(BAR + BEAT / 2, 6);
    expect(truth.swing).toBeUndefined();
    expect(truth.melody).toBeUndefined();
    expect(truth.render!.tracks).toEqual(['Drums', 'Piano']);
  });

  it('scales times with the tempo and omits drums/melody for piano only', () => {
    const truth = truthFor(variant('piano', 80, 'none'));
    expect(truth.beats).toHaveLength(128);
    expect(truth.beats![4].t).toBeCloseTo(3, 6); // 4 × 60/80
    expect(truth.source.durationSec).toBeCloseTo(96, 6);
    expect(truth.drums).toBeUndefined();
    expect(truth.melody).toBeUndefined();
    expect(truth.render!.programs).toEqual({ Piano: 0 });
  });

  it('shifts every time by leadInSec and records leadInSec / audioSec', () => {
    const base = variant('full', 116, 'asWritten');
    const a = truthFor(base);
    const v = { ...base, leadInSec: 1.37 };
    const b = buildTruth({ ...input(buildScoreTex(saints, pianoBody, v), v), audioSec: 70 });
    const L = 1.37;
    expect(b.source.leadInSec).toBe(L);
    expect(b.source.audioSec).toBe(70);
    expect(a.source.leadInSec).toBe(0);
    expect(a.source.audioSec).toBeUndefined();
    expect(b.source.durationSec).toBeCloseTo(a.source.durationSec + L, 5);
    a.beats!.forEach((x, i) => expect(b.beats![i].t).toBeCloseTo(x.t + L, 5));
    a.chords!.forEach((x, i) => {
      expect(b.chords![i].start).toBeCloseTo(x.start + L, 5);
      expect(b.chords![i].end).toBeCloseTo(x.end + L, 5);
    });
    a.sections!.forEach((x, i) => {
      expect(b.sections![i].start).toBeCloseTo(x.start + L, 5);
      expect(b.sections![i].end).toBeCloseTo(x.end + L, 5);
    });
    a.melody!.notes.forEach((x, i) => {
      expect(b.melody!.notes[i].start).toBeCloseTo(x.start + L, 5);
      expect(b.melody!.notes[i].end).toBeCloseTo(x.end + L, 5);
    });
    a.drums!.forEach((x, i) => expect(b.drums![i].t).toBeCloseTo(x.t + L, 5));
    expect(b.beats![0].t).toBeCloseTo(L, 6);
  });

  it('omits the key when the song has none', () => {
    const v = variant('piano', 116, 'none');
    const t = buildTruth({
      ...input(buildScoreTex(saints, pianoBody, v), v),
      key: undefined,
    });
    expect(t.key).toBeUndefined();
  });
});

describe('buildTruth: consistency checks', () => {
  const v = variant('full', 116, 'asWritten');
  const tex = buildScoreTex(saints, pianoBody, v);

  /** Moves the `\track "Drums"` block after the other tracks. */
  function drumsLast(src: string): string {
    const [head, ...tracks] = src.split(/\n(?=\\track ")/);
    const drums = tracks.filter((t) => t.startsWith('\\track "Drums"'));
    const rest = tracks.filter((t) => !t.startsWith('\\track "Drums"'));
    return [head, ...rest, ...drums].join('\n');
  }

  it('rejects a score whose drum track is not first', () => {
    expect(() => buildTruth(input(drumsLast(tex), v))).toThrow(/ドラム.*先頭/);
  });

  it('rejects a tempo other than the variant tempo', () => {
    expect(() => buildTruth(input(tex, { ...v, tempo: 120 }))).toThrow(/テンポ/);
  });

  it('rejects a curve that was not applied to the score', () => {
    const curved = { ...v, tempoCurve: Array.from({ length: 32 }, (_, i) => 116 + (i % 2)) };
    const score = importScore(tex);
    setPrograms(score);
    expect(() => buildTruth({ ...input(tex, v), score, midi: generateMidi(score), variant: curved })).toThrow(
      /テンポ/,
    );
  });

  it('rejects a tempo change inside the song', () => {
    const changed = tex.replace(
      /(\\track "Vocal"[\s\S]*?\\section "B"\n)/,
      '$1\\tempo 90\n',
    );
    expect(changed).not.toBe(tex);
    expect(() => buildTruth(input(changed, v))).toThrow(/テンポ/);
  });

  it('rejects sections that differ from the chart', () => {
    const swapped: ChordTimeline = {
      ...timeline,
      sections: [
        { label: 'B', startBar: 0, bars: 16 },
        { label: 'A', startBar: 16, bars: 16 },
      ],
    };
    expect(() => buildTruth(input(tex, v, swapped))).toThrow(/セクション/);
  });

  it('rejects a timeline whose bar count differs from the score', () => {
    expect(() => buildTruth(input(tex, v, { ...timeline, bars: 31 }))).toThrow(/小節/);
  });

  it('rejects a part that is a bar short (padded by alphaTab)', () => {
    const short = tex.replace(/\n:2 \(CR BD\) r \|/, '');
    expect(short).not.toBe(tex);
    expect(() => buildTruth(input(short, v))).toThrow(/Drums.*小節/);
  });

  it('rejects a shuffle in a straight variant', () => {
    expect(() => buildTruth(input(tex, { ...v, swing: 'none' }))).toThrow(/シャッフル/);
  });
});

describe('tempo drift (variant.tempoCurve)', () => {
  // Bar 0 at 116, bar 1 at 117, then 118, 117, 116, 115, … (±1 BPM per bar).
  const curve = Array.from({ length: 32 }, (_, i) => 116 + [0, 1, 2, 1, 0, -1, -2, -1][i % 8]);
  const BAR0 = (4 * 60) / 116; // 2.068966
  const BAR1 = (4 * 60) / 117; // 2.051282
  const barStart = (bar: number) => {
    let t = 0;
    for (let i = 0; i < bar; i++) t += (4 * 60) / curve[i];
    return t;
  };
  const curved = (v: Variant): Variant => ({ ...v, tempoCurve: curve, name: `${v.name}-drift` });

  it('applyTempoCurve sets one tempo automation per master bar, and nothing without a curve', () => {
    const v = curved(variant('full', 116, 'asWritten'));
    const score = importScore(buildScoreTex(saints, pianoBody, v));
    applyTempoCurve(score, v);
    expect(score.tempo).toBe(116);
    score.masterBars.forEach((mb, i) => {
      expect(mb.tempoAutomations.map((a) => [a.ratioPosition, a.value, a.isLinear])).toEqual([
        [0, curve[i], false],
      ]);
    });
    const plain = variant('full', 116, 'asWritten');
    const s2 = importScore(buildScoreTex(saints, pianoBody, plain));
    applyTempoCurve(s2, plain);
    expect(s2.masterBars.map((mb) => mb.tempoAutomations.length)).toEqual([1, ...Array(31).fill(0)]);
  });

  it('applyTempoCurve rejects a curve of the wrong length, a bad tempo, or bar 0 ≠ variant tempo', () => {
    const v = variant('full', 116, 'asWritten');
    const tex = buildScoreTex(saints, pianoBody, v);
    expect(() => applyTempoCurve(importScore(tex), { ...v, tempoCurve: curve.slice(1) })).toThrow(
      /tempoCurve.*31.*32/,
    );
    expect(() =>
      applyTempoCurve(importScore(tex), { ...v, tempoCurve: curve.map((x, i) => (i === 5 ? 0 : x)) }),
    ).toThrow(/tempoCurve/);
    expect(() =>
      applyTempoCurve(importScore(tex), { ...v, tempoCurve: curve.map((x, i) => (i === 0 ? 120 : x)) }),
    ).toThrow(/tempoCurve.*116/);
  });

  it('times beats piecewise: bar 1 at 4 × 60/116 s, bar 2 at that + 4 × 60/117 s', () => {
    const truth = truthFor(curved(variant('full', 116, 'asWritten')));
    const beats = truth.beats!;
    expect(beats).toHaveLength(128);
    expect(beats[0].t).toBe(0);
    expect(beats[4]).toMatchObject({ bar: 1, beat: 0, downbeat: true });
    expect(beats[4].t).toBeCloseTo(BAR0, 6);
    expect(beats[5].t).toBeCloseTo(BAR0 + 60 / 117, 6);
    expect(beats[8].t).toBeCloseTo(BAR0 + BAR1, 6);
    expect(beats[12].t).toBeCloseTo(BAR0 + BAR1 + (4 * 60) / 118, 6);
    beats.forEach((b, i) => {
      const [bar, beat] = [Math.floor(i / 4), i % 4];
      expect(b).toMatchObject({ bar, beat });
      expect(b.t).toBeCloseTo(barStart(bar) + (beat * 60) / curve[bar], 6);
    });
    expect(truth.source.durationSec).toBeCloseTo(barStart(32), 6);
    expect(truth.render!.tempo).toBe(116);
    const [a, b] = truth.sections!;
    expect(a.end).toBeCloseTo(barStart(16), 6);
    expect(b.start).toBeCloseTo(barStart(16), 6);
    expect(b.end).toBeCloseTo(barStart(32), 6);
    expect(truth.chords!.at(-1)!.end).toBeCloseTo(barStart(32), 6);
  });

  it('keeps notes from the MIDI: the melody G4 fills bar 1 at 117 BPM, the last note ends the song', () => {
    const notes = truthFor(curved(variant('full', 116, 'asWritten'))).melody!.notes;
    expect(notes[0].start).toBeCloseTo(60 / 116, 6);
    expect(notes[3]).toMatchObject({ midi: 67 });
    expect(notes[3].start).toBeCloseTo(BAR0, 6);
    expect(notes[3].end).toBeCloseTo(BAR0 + BAR1, 6);
    expect(notes.at(-1)!.start).toBeCloseTo(barStart(31), 6);
    expect(notes.at(-1)!.end).toBeCloseTo(barStart(32), 6);
  });

  it('combines with shuffle: the off-beat hi-hat of bar 1 is at 2/3 of a 117 BPM beat', () => {
    const truth = truthFor(curved(variant('full', 116, 'asWritten')));
    const offs = truth.drums!.filter(
      (d) => d.inst === 'HH' && d.t > BAR0 + 0.01 && d.t < BAR0 + 60 / 117 - 0.01,
    );
    expect(offs).toHaveLength(1);
    expect(offs[0].t).toBeCloseTo(BAR0 + (2 / 3) * (60 / 117), 6);
    expect(truth.swing).toEqual({ kind: '8', confidence: 1 });
    // Straight: at 1/2 of the beat.
    const straight = truthFor(curved(variant('piano+drums', 116, 'none')));
    const off = straight.drums!.find(
      (d) => d.inst === 'HH' && d.t > BAR0 + 0.01 && d.t < BAR0 + 60 / 117 - 0.01,
    )!;
    expect(off.t).toBeCloseTo(BAR0 + 60 / 117 / 2, 6);
  });

  it('combines with leadInSec: every time shifts by it', () => {
    const v = { ...curved(variant('full', 116, 'asWritten')), leadInSec: 1.37 };
    const a = truthFor(curved(variant('full', 116, 'asWritten')));
    const b = truthFor(v);
    const L = 1.37;
    expect(b.beats![4].t).toBeCloseTo(L + BAR0, 6);
    expect(b.beats![8].t).toBeCloseTo(L + BAR0 + BAR1, 6);
    expect(b.source.durationSec).toBeCloseTo(L + barStart(32), 5);
    a.beats!.forEach((x, i) => expect(b.beats![i].t).toBeCloseTo(x.t + L, 5));
    a.melody!.notes.forEach((x, i) => expect(b.melody!.notes[i].start).toBeCloseTo(x.start + L, 5));
    a.drums!.forEach((x, i) => expect(b.drums![i].t).toBeCloseTo(x.t + L, 5));
    a.chords!.forEach((x, i) => expect(b.chords![i].start).toBeCloseTo(x.start + L, 5));
  });

  it('rejects a MIDI tempo that differs from the curve', () => {
    const v = curved(variant('full', 116, 'asWritten'));
    const tex = buildScoreTex(saints, pianoBody, v);
    const score = importScore(tex);
    applyTempoCurve(score, v);
    score.masterBars[10].tempoAutomations[0].value = 130;
    expect(() => buildTruth({ ...input(tex, v), score, midi: generateMidi(score) })).toThrow(
      /11 小節目.*テンポ/,
    );
  });
});
