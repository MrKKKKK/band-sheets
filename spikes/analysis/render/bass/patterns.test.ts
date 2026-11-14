import { describe, expect, it } from 'vitest';
import { parseChordSymbol } from '../chordSymbol';
import { importScore } from '../truth';
import { partsToAlphaTex } from '../../../../src/lib/partsToAlphaTex';
import { applyMarks, BASS_STYLES, bassLine, bassPartBody, HEAD_HI, segmentsOf } from './patterns';
import { generateSong, SLASH_KINDS, type BassSong } from './progressions';
import { bassMaterial } from './render';
import { BASS_HI, BASS_LO } from './timbres';
import { allBassVariants, streamOf } from './variants';

const variants = allBassVariants();
const songs: BassSong[] = variants.filter((v) => v.level === 0).map((v) => generateSong(streamOf(v, 'song')));

describe('bass progressions', () => {
  it('4 sections of 4 bars, chords on beat 0 / 2, two plain sections; over all songs no slash on more than half the chords', () => {
    let slash = 0;
    let total = 0;
    for (const s of songs) {
      expect(s.timeline.bars).toBe(16);
      expect(s.kinds.filter((k) => k === 'plain').length).toBe(2);
      for (const c of s.timeline.chords) {
        expect([0, 2]).toContain(c.beat);
        const p = parseChordSymbol(c.text);
        total++;
        if (p.bass !== null) slash++;
      }
      // no repeated identical chord back to back inside a section (a section may start on the chord the last one ended on)
      const ch = s.timeline.chords;
      ch.forEach((c, i) => i > 0 && c.bar % 4 + c.beat > 0 && expect(c.text).not.toBe(ch[i - 1].text));
    }
    expect(slash / total).toBeLessThan(0.5);
    expect(slash / total).toBeGreaterThan(0.15);
  });

  it('every slash kind appears in every split (tuning, dev, held-out)', () => {
    for (const split of ['tuning', 'dev', 'heldOut'] as const) {
      const kinds = new Set(variants.filter((v) => v.level === 0 && v.split === split).flatMap((v) => generateSong(streamOf(v, 'song')).kinds));
      for (const k of SLASH_KINDS) expect(kinds.has(k), `${split} ${k}`).toBe(true);
    }
  });

  it('templates: cliche bass descends by semitones under one chord, pedal keeps the tonic under changing chords', () => {
    for (const s of songs) {
      const segs = segmentsOf(s);
      s.kinds.forEach((kind, sec) => {
        const inSec = segs.filter((g) => Math.floor(g.at16 / 64) === sec);
        if (kind === 'cliche' || kind === 'clicheMin') {
          const d = inSec.slice(0, 4).map((g) => g.bassPc);
          for (let i = 1; i < 4; i++) expect((d[i - 1] - d[i] + 12) % 12).toBe(1);
        }
        if (kind === 'pedal') expect(new Set(inSec.map((g) => g.bassPc)).size).toBe(1);
      });
    }
  });
});

describe('bass lines', () => {
  it('every style: head on each chord start playing the written bass, notes fill the bars, range E1..G3', () => {
    for (const s of songs.slice(0, 12))
      for (const style of BASS_STYLES) {
        const notes = bassLine(s, style, () => 0.3);
        const segs = segmentsOf(s);
        const heads = notes.filter((n) => n.role === 'head');
        expect(heads.length).toBe(segs.length);
        heads.forEach((h, i) => {
          expect(h.at16).toBe(segs[i].at16);
          expect(h.midi % 12).toBe(segs[i].bassPc);
          expect(h.midi).toBeLessThanOrEqual(HEAD_HI);
        });
        for (const n of notes) {
          expect(n.midi).toBeGreaterThanOrEqual(BASS_LO);
          expect(n.midi).toBeLessThanOrEqual(BASS_HI);
        }
        expect(() => bassPartBody(s, notes)).not.toThrow();
      }
  });

  it('stepwise lines move by step: consecutive cliche heads are a semitone apart (no octave jump)', () => {
    for (const s of songs) {
      const notes = bassLine(s, 'whole', () => 0);
      const segs = segmentsOf(s);
      s.kinds.forEach((kind, sec) => {
        if (kind !== 'cliche' && kind !== 'clicheMin') return;
        const idx = segs.map((g, i) => [g, i] as const).filter(([g]) => Math.floor(g.at16 / 64) === sec).map(([, i]) => i);
        for (let k = 1; k < 4; k++) expect(notes[idx[k - 1]].midi - notes[idx[k]].midi).toBe(1);
      });
    }
  });

  it('marks change only roles / velocity / length flags of fill notes, never times or pitches', () => {
    const notes = bassLine(songs[0], 'rock8', () => 0.5);
    const marked = applyMarks(notes, () => 0.1);
    expect(marked.map((n) => [n.at16, n.len16, n.midi])).toEqual(notes.map((n) => [n.at16, n.len16, n.midi]));
    expect(marked.filter((n) => n.role === 'head')).toEqual(notes.filter((n) => n.role === 'head'));
    expect(marked.some((n) => n.role === 'ghost' && n.short)).toBe(true);
  });

  it('the alphaTex of the line imports into alphaTab with the same bars and notes', () => {
    const v = variants.find((x) => x.name === 'syn-b2-sync16-tA-s2')!;
    const { song, notes } = bassMaterial(v);
    const score = importScore(partsToAlphaTex({ meta: { title: '', tempo: 100, time: '4/4' }, chart: [], parts: [{ name: 'Bass', body: bassPartBody(song, notes) }] }));
    expect(score.masterBars.length).toBe(16);
    const beats = score.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats);
    expect(beats.map((b) => b.notes[0].realValue)).toEqual(notes.map((n) => n.midi));
  });

  it('the seed fixes the song and line: every level and timbre of a seed / style plays the same notes', () => {
    const same = variants.filter((v) => v.style === 'walking' && v.seed === 4);
    const lines = same.map((v) => JSON.stringify(bassMaterial(v).notes.map((n) => [n.at16, n.midi])));
    expect(new Set(lines).size).toBe(1);
  });
});
