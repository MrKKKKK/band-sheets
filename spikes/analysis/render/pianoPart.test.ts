import { importer, Settings, type model } from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { parseSong } from '../../../src/lib/parseSong';
import { saintsSampleText } from '../../../src/lib/saintsSample';
import { chordTimeline } from './chordTimeline';
import { chordMidi, noteName, pianoPartBody } from './pianoPart';
import type { ChordTimeline } from './types';

function load(body: string): model.Score {
  const imp = new importer.AlphaTexImporter();
  imp.initFromString(`\\tempo 100\n.\n\\track "Piano"\n\\ts 4 4\n${body}\n`, new Settings());
  return imp.readScore();
}

const bars = (score: model.Score) => score.tracks[0].staves[0].bars;
const midis = (bar: model.Bar, beat: number) =>
  bar.voices[0].beats[beat].notes.map((n) => n.realValue).sort((a, b) => a - b);

describe('chordMidi / noteName', () => {
  it('voices triads and sevenths', () => {
    expect(chordMidi('C')).toEqual([36, 60, 64, 67]);
    expect(chordMidi('G7')).toEqual([43, 55, 59, 62, 65]);
    expect(chordMidi('Am')).toEqual([45, 57, 60, 64]);
    expect(chordMidi('Dbmaj7')).toEqual([37, 61, 65, 68, 72]);
    expect(chordMidi('Bm7')).toEqual([47, 59, 62, 66, 69]);
    expect(chordMidi('C/E')).toEqual([40, 60, 64, 67]);
    expect(chordMidi('Bdim')).toEqual([47, 59, 62, 65]);
    expect(chordMidi('Caug')).toEqual([36, 60, 64, 68]);
    expect(chordMidi('Csus4')).toEqual([36, 60, 65, 67]);
  });
  it('names notes', () => {
    expect(noteName(36)).toBe('C2');
    expect(noteName(61)).toBe('C#4');
  });
});

describe('pianoPartBody: 聖者の行進', () => {
  const t = chordTimeline(parseSong(saintsSampleText));
  const body = pianoPartBody(t);
  const score = load(body);

  it('has 32 bars, one chord per beat', () => {
    expect(bars(score)).toHaveLength(32);
    for (const b of bars(score)) {
      expect(b.voices[0].beats).toHaveLength(4);
    }
  });
  it('has a \\section per timeline section', () => {
    expect(body.match(/^\\section "(\w+)"/gm)).toEqual(['\\section "A"', '\\section "B"']);
    expect(bars(score)[0].masterBar.section?.text).toBe('A');
    expect(bars(score)[16].masterBar.section?.text).toBe('B');
  });
  it('plays the right pitches', () => {
    const bs = bars(score);
    expect(midis(bs[0], 0)).toEqual([36, 60, 64, 67]); // C (extended back)
    expect(midis(bs[0], 3)).toEqual([36, 60, 64, 67]);
    expect(midis(bs[7], 0)).toEqual([43, 55, 59, 62, 65]); // G7
    expect(midis(bs[10], 0)).toEqual([36, 60, 64, 67, 70]); // C7
    expect(midis(bs[11], 2)).toEqual([41, 65, 69, 72]); // F
    expect(midis(bs[14], 1)).toEqual([36, 60, 64, 67]); // C before G7 on beat 3
    expect(midis(bs[14], 2)).toEqual([43, 55, 59, 62, 65]);
    expect(midis(bs[31], 3)).toEqual([36, 60, 64, 67]);
  });
});

describe('pianoPartBody: other shapes', () => {
  it('handles x/4 other than 4 and slash chords', () => {
    const t: ChordTimeline = {
      ts: [3, 4],
      bars: 2,
      sections: [{ label: 'A', startBar: 0, bars: 2 }],
      chords: [
        { bar: 0, beat: 0, text: 'C' },
        { bar: 1, beat: 1, text: 'C/E' },
      ],
    };
    const imp = new importer.AlphaTexImporter();
    imp.initFromString(`.\n\\track "P"\n\\ts 3 4\n${pianoPartBody(t)}\n`, new Settings());
    const bs = imp.readScore().tracks[0].staves[0].bars;
    expect(bs).toHaveLength(2);
    expect(bs[1].voices[0].beats).toHaveLength(3);
    expect(midis(bs[1], 2)).toEqual([40, 60, 64, 67]);
  });
});
