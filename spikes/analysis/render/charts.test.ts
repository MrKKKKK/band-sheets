import { describe, expect, it } from 'vitest';
import { chartBlockBody, chartKeys, chartSongFor, chartTimeline, chartVariants, validateChartSong } from './charts';
import type { ChartSong } from './charts';
import { chordsPerBeat } from './chordTimeline';
import { REC_HARD, recComp } from './pianoPart';
import { buildScoreTex, buildTruth, generateMidi, importScore, setPrograms } from './truth';
import type { Variant } from './types';

// Generic fixture progressions (not any real song).
const bar = (...cs: [string, number][]): [string, number][] => cs;
const fixture = (over: Partial<ChartSong> = {}): ChartSong => ({
  id: 'chart-02',
  heldOut: false,
  tempo: 100,
  timeSignature: [4, 4],
  eighthsPerBar: 8,
  pickupBeats: 0,
  bars: [bar(['C', 8]), bar(['Am7', 4], ['F', 4]), bar(['G7', 8]), bar(['C', 8]), bar(['D', 8]), bar(['Bm7', 8]), bar(['Em7', 4], ['A7', 4]), bar(['D', 8])],
  keys: [
    { startBar: 0, key: 'C' },
    { startBar: 4, key: 'D' },
  ],
  ...over,
});

describe('validateChartSong', () => {
  it('accepts the fixture and rejects bad ones without naming a chord', () => {
    expect(validateChartSong(fixture())).toEqual(fixture());
    expect(() => validateChartSong({ ...fixture(), id: 'x' })).toThrow('chart-NN');
    expect(() => validateChartSong(fixture({ bars: [bar(['C', 4])] }))).toThrow('小節目の長さ');
    expect(() => validateChartSong(fixture({ bars: [bar(['N.C.', 8])] }))).toThrow('コードがありません');
    expect(() => validateChartSong(fixture({ keys: [{ startBar: 0, key: 'H' }] }))).toThrow('キー');
    expect(() => validateChartSong(fixture({ keys: [{ startBar: 8, key: 'C' }] }))).toThrow('キー');
    expect(() => validateChartSong(fixture({ timeSignature: [3, 4], eighthsPerBar: 6, pickupBeats: 1, bars: [bar(['C', 6])] }))).toThrow('pickupBeats');
  });
});

describe('chartTimeline', () => {
  it('has one section per key run and a chord per written change', () => {
    const t = chartTimeline(fixture());
    expect(t.bars).toBe(8);
    expect(t.sections).toEqual([
      { label: 'S1', startBar: 0, bars: 4 },
      { label: 'S2', startBar: 4, bars: 4 },
    ]);
    expect(t.chords.map((c) => [c.bar, c.beat, c.text])).toEqual([
      [0, 0, 'C'],
      [1, 0, 'Am7'],
      [1, 2, 'F'],
      [2, 0, 'G7'],
      [3, 0, 'C'],
      [4, 0, 'D'],
      [5, 0, 'Bm7'],
      [6, 0, 'Em7'],
      [6, 2, 'A7'],
      [7, 0, 'D'],
    ]);
  });

  it('is one section without keys; N.C. adds no chord; eighth positions round down, later wins', () => {
    const t = chartTimeline(fixture({ keys: [], bars: [bar(['N.C.', 4], ['C', 4]), bar(['F', 3], ['G', 1], ['Am', 4]), bar(['C', 8])] }));
    expect(t.sections).toEqual([{ label: 'S1', startBar: 0, bars: 3 }]);
    expect(t.chords.map((c) => [c.bar, c.beat, c.text])).toEqual([
      [0, 0, 'C'], // the leading N.C.: the first chord moves back to bar 0 beat 0
      [1, 0, 'F'],
      [1, 1, 'G'], // F at eighth 0, G at eighth 3 -> beat 1
      [1, 2, 'Am'],
      [2, 0, 'C'],
    ]);
  });

  it('adds a pickup bar in front (the first chord moves back into it)', () => {
    const t = chartTimeline(fixture({ pickupBeats: 1, keys: [{ startBar: 0, key: 'C' }, { startBar: 4, key: 'D' }] }));
    expect(t.bars).toBe(9);
    expect(t.chords[0]).toMatchObject({ bar: 0, beat: 0, text: 'C' });
    expect(t.chords[1]).toMatchObject({ bar: 2, beat: 0, text: 'Am7' });
    expect(t.sections.map((s) => [s.startBar, s.bars])).toEqual([[0, 5], [5, 4]]);
    expect(chartKeys(fixture({ pickupBeats: 1 }))).toEqual(fixture().keys); // keys count from the first downbeat
  });
});

describe('chartVariants', () => {
  it('gives block / rec / rechard (level CH, piano only); 3/4 only block; held-out passes on', () => {
    const v = chartVariants(fixture({ heldOut: true }));
    expect(v.map((x) => x.name)).toEqual(['chart-02-block', 'chart-02-rec', 'chart-02-rechard']);
    for (const x of v) expect(x).toMatchObject({ song: 'chart', mix: 'piano', level: 'CH', heldOut: true, tempo: 100, click: false, swing: 'none' });
    expect(v[1]).toMatchObject({ comp: 'rec', recSeed: 2 });
    expect(v[2]).toMatchObject({ comp: 'rec', recSeed: 2, recStyle: 'hard' });
    expect(v[0].comp).toBeUndefined();
    expect(chartVariants(fixture({ heldOut: false }))[0].heldOut).toBeUndefined();
    const w = chartVariants(fixture({ timeSignature: [3, 4], eighthsPerBar: 6, bars: [bar(['C', 6])], keys: [] }));
    expect(w.map((x) => x.name)).toEqual(['chart-02-block']);
  });
});

/** Score + truth without synthesising audio. */
function truthOf(cs: ChartSong, v: Variant) {
  const written = chartTimeline(cs);
  const rec = v.comp === 'rec' ? recComp(written, { ...(v.recStyle === 'hard' ? REC_HARD : {}), seed: v.recSeed, pickupBeats: v.pickupBeats ?? 0 }) : null;
  const timeline = rec ? rec.timeline : written;
  const score = importScore(buildScoreTex(chartSongFor(cs), rec ? rec.body : chartBlockBody(cs, written), v));
  setPrograms(score);
  const midi = generateMidi(score);
  const keys = chartKeys(cs);
  return buildTruth({ score, midi, timeline, variant: v, ...(keys.length ? { key: keys[0].key, keys } : {}), sampleRate: 44100, soundFont: 'sonivox.sf2' });
}

describe('truth of the chart variants', () => {
  for (const [label, cs] of [
    ['plain', fixture()],
    ['pickup', fixture({ pickupBeats: 1 })],
  ] as const) {
    it(`builds a truth with keys for block, rec and rechard (${label})`, () => {
      for (const v of chartVariants(cs)) {
        const t = truthOf(cs, v);
        expect(t.keys).toEqual(cs.keys);
        expect(t.key).toEqual({ tonic: 'C', mode: 'major', confidence: 1 });
        expect(t.sections!.map((s) => s.label)).toEqual(['S1', 'S2']);
        expect(t.chords!.length).toBeGreaterThanOrEqual(10);
        expect(t.beats!.filter((b) => b.downbeat)).toHaveLength(cs.bars.length + (cs.pickupBeats ? 1 : 0));
        expect(t.render!.song).toBe('chart');
      }
    });
  }

  it('block with a pickup rests before the pickup beats and the truth chord is the first chord', () => {
    const cs = fixture({ pickupBeats: 2 });
    const body = chartBlockBody(cs, chartTimeline(cs));
    const first = body.split('\n').find((l) => !l.startsWith('\\section'))!;
    expect(first.startsWith(':4 r r (')).toBe(true);
    expect(first.match(/\(/g)).toHaveLength(2);
    const perBeat = chordsPerBeat(chartTimeline(cs))[0];
    expect(new Set(perBeat)).toEqual(new Set(['C']));
  });

  it('a chart without keys has no key in the truth', () => {
    const cs = fixture({ keys: [] });
    const t = truthOf(cs, chartVariants(cs)[0]);
    expect(t.keys).toBeUndefined();
    expect(t.key).toBeUndefined();
  });
});
