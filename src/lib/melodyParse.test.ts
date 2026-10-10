import { describe, expect, it } from 'vitest';
import {
  mergeRests,
  parseMelody,
  parseMelodyBeats,
  parseMelodyIgnoringBars,
} from './melodyParse';
import { serializeMelody } from './melodyTex';
import {
  DURATION_TICKS,
  cleanTexText,
  type MelodyEvent,
  type TimeSig,
} from './melody';
import { melodyFixtures } from './fixtures/melodyFixtures';
import { groupsFitBars, TUPLET_UNITS } from './tuplet';

const FOUR: TimeSig = { num: 4, den: 4 };

const n = (pitch: string, ticks: number, extra = {}): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks,
  ...extra,
});
const r = (ticks: number, extra = {}): MelodyEvent => ({
  kind: 'rest',
  ticks,
  ...extra,
});

function ok(src: string, ts = FOUR): MelodyEvent[] {
  const res = parseMelody(src, ts);
  if (!res.ok) throw new Error(`unexpected read-only: ${res.reason}`);
  return res.events;
}

describe('parseMelody: golden fixtures', () => {
  it.each(melodyFixtures.map((f) => [f.name, f] as const))('%s', (_, f) => {
    expect(parseMelody(f.tex, f.ts)).toEqual({
      ok: true,
      events: f.parsed ?? f.events,
    });
  });
});

describe('parseMelody: accepted syntax', () => {
  it('empty / whitespace-only section → no events', () => {
    expect(ok('')).toEqual([]);
    expect(ok('  \n\n\t ')).toEqual([]);
  });

  it('line breaks and spacing carry no meaning; last | optional', () => {
    expect(ok(':4 C4\n\n  D4 E4\tF4 | G4')).toEqual([
      n('C4', 16),
      n('D4', 16),
      n('E4', 16),
      n('F4', 16),
      n('G4', 16),
    ]);
    expect(ok(':1 C4 | D4 | E4 |')).toEqual(ok(':1 C4 |\nD4 |\nE4'));
  });

  it('effects in any order, several spaces between them', () => {
    expect(ok(':4 C4{ch "C"   lyrics "き" d} :8 D4 :2 E4')).toEqual([
      n('C4', 24, { lyric: 'き', chord: 'C' }),
      n('D4', 8),
      n('E4', 32),
    ]);
  });

  it('quoted strings keep inner spaces', () => {
    expect(ok(':1 C4{lyrics "a b" ch "C 7"}')).toEqual([
      n('C4', 64, { lyric: 'a b', chord: 'C 7' }),
    ]);
  });

  it('accidentals and all durations', () => {
    expect(ok(':4 C#4 Bb3 :8 Cb4 :16 E#4 :32 G0 A8 :16 r :8 r |')).toEqual([
      n('C#4', 16),
      n('Bb3', 16),
      n('Cb4', 8),
      n('E#4', 4),
      n('G0', 2),
      n('A8', 2),
      r(12),
    ]);
    expect(ok(':1 C4 | :2 C4 C4')).toEqual([
      n('C4', 64),
      n('C4', 32),
      n('C4', 32),
    ]);
  });

  it('tie merges across barlines and lines; lyric/chord from first piece', () => {
    expect(
      ok(':2 G4 D4{lyrics "ばー" ch "G"} |\n:1 D4{t} |\n:4 D4{t}'),
    ).toEqual([
      n('G4', 32),
      n('D4', 32 + 64 + 16, { lyric: 'ばー', chord: 'G' }),
    ]);
  });

  it('tie inside one bar merges (normalization)', () => {
    expect(ok(':4 C4 C4{t} :2 r')).toEqual([n('C4', 32), r(32)]);
  });

  it('adjacent rests merge unless the later one has a chord', () => {
    expect(ok(':4 r{ch "F"} r :2 r |\n:4 r{ch "G"} r')).toEqual([
      r(64, { chord: 'F' }),
      r(32, { chord: 'G' }),
    ]);
  });

  it('separate same-pitch notes without t stay separate', () => {
    expect(ok(':4 C4 C4')).toEqual([n('C4', 16), n('C4', 16)]);
  });

  it('duration is sticky across barlines; repeated :N is fine', () => {
    expect(ok(':4 :8 C4 C4 C4 C4 C4 C4 C4 C4 | C4')).toHaveLength(9);
  });

  it('other time signatures: bar length follows ts', () => {
    expect(ok(':4 C4 D4 E4 | F4', { num: 3, den: 4 })).toHaveLength(4);
    expect(ok(':8 C4 D4 E4 F4 G4 A4 | B4', { num: 6, den: 8 })).toHaveLength(7);
  });
});

describe('parseMelody: .N duration suffix (alphaTab idiom)', () => {
  it('sets the duration for that beat AND later beats (verified against alphaTab: sticky)', () => {
    expect(ok(':4 C4 C4 C4 C4 | D4.2 E4 |')).toEqual([
      n('C4', 16),
      n('C4', 16),
      n('C4', 16),
      n('C4', 16),
      n('D4', 32),
      n('E4', 32),
    ]);
  });

  it('is sticky across the barline too, like :N', () => {
    expect(ok(':4 C4 C4 C4 C4 | D4.2 E4 | F4 F4 |')).toEqual([
      n('C4', 16),
      n('C4', 16),
      n('C4', 16),
      n('C4', 16),
      n('D4', 32),
      n('E4', 32),
      n('F4', 32),
      n('F4', 32),
    ]);
  });

  it('may open a section on its own (no leading :N needed)', () => {
    expect(ok('D4.2 E4 |')).toEqual([n('D4', 32), n('E4', 32)]);
  });

  it('works on a rest', () => {
    expect(ok('r.4 C4 |')).toEqual([r(16), n('C4', 16)]);
  });

  it('mixes with :N tokens, :N resets the running duration', () => {
    expect(ok(':4 C4.2 D4 | :4 E4 |')).toEqual([
      n('C4', 32),
      n('D4', 32),
      n('E4', 16),
    ]);
  });

  it('the sample song Vocal sections now read (regression)', () => {
    const A = ':4 C4 C4 G4 G4 | A4 A4 G4.2 | :4 F4 F4 E4 E4 | D4 D4 C4.2 |';
    const B = ':4 G4 G4 F4 F4 | E4 E4 D4.2 | :4 G4 G4 F4 F4 | E4 E4 D4.2 |';
    const quarters = (pitches: string[]) => pitches.map((p) => n(p, 16));
    expect(ok(A)).toEqual([
      ...quarters(['C4', 'C4', 'G4', 'G4', 'A4', 'A4']),
      n('G4', 32),
      ...quarters(['F4', 'F4', 'E4', 'E4', 'D4', 'D4']),
      n('C4', 32),
    ]);
    expect(ok(B)).toEqual([
      ...quarters(['G4', 'G4', 'F4', 'F4', 'E4', 'E4']),
      n('D4', 32),
      ...quarters(['G4', 'G4', 'F4', 'F4', 'E4', 'E4']),
      n('D4', 32),
    ]);
  });

  it('.N followed by beat effects only ({d}, {tu}) is accepted (M5)', () => {
    expect(ok(':4 C4 C4.2{d}')).toEqual([n('C4', 16), n('C4', 48)]);
  });

  it.each([
    ['.N followed by {t}: still rejected (note effect after .N)', 'C4.2{t}'],
    ['.N followed by {lyrics}: still rejected', 'C4.2{lyrics "a"}'],
    ['.N followed by {ch}: still rejected', 'C4.2{ch "C"}'],
    ['.N followed by {tu 3 slur}: still rejected', 'C4.8{tu 3 slur "1"}'],
  ])('%s', (_, src) => {
    const res = parseMelody(`:4 C4 ${src}`, FOUR);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/\{\}/);
  });

  it('still rejects fret.string notes (digit base, not r or a pitch)', () => {
    const res = parseMelody(':4 3.2', FOUR);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/\. を使う/);
  });

  it('still rejects lowercase pitch with a dot', () => {
    const res = parseMelody(':4 c4.2', FOUR);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/\. を使う/);
  });

  it('still rejects an invalid N and a double dot', () => {
    for (const src of [':4 C4.3', ':4 C4.2.4']) {
      const res = parseMelody(src, FOUR);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/\. を使う/);
    }
  });
});

describe('parseMelody: read-only (rejected) syntax', () => {
  const cases: [string, string, RegExp][] = [
    ['missing :N at section start', 'C4 D4', /音価/],
    ['missing :N before first rest', 'r :4 C4', /音価/],
    ['short middle bar (pickup)', ':4 C4 | C4 D4 E4 F4', /1 小節目が短/],
    ['overfull bar', ':4 C4 D4 E4 F4 G4 |', /1 小節目が長/],
    ['overfull last bar without |', ':2 C4 D4 | E4 F4 G4', /2 小節目が長/],
    ['empty bar', ':4 C4 D4 E4 F4 | |', /空の小節/],
    ['leading |', '| :4 C4', /空の小節/],
    ['lyric on a rest', ':4 r{lyrics "あ"}', /休符に歌詞/],
    ['tie with different pitch', ':4 C4 D4{t}', /違う音へのタイ/],
    ['tie with enharmonic spelling', ':4 C#4 Db4{t}', /違う音へのタイ/],
    ['tie on first beat', ':4 C4{t} D4', /最初の音にタイ/],
    ['tie after a rest', ':4 r C4{t}', /休符の後/],
    ['tie on a rest', ':4 r r{t}', /休符にタイ/],
    ['tie carrying lyric', ':4 C4 C4{t lyrics "あ"}', /タイ.*歌詞/],
    ['tie carrying chord', ':4 C4 C4{t ch "C"}', /タイ.*コード/],
    ['dotted 32nd', ':32 C4{d}', /付点32分/],
    ['unknown effect', ':4 C4{v}', /効果「v」/],
    ['dead note / double dot', ':4 C4{dd}', /効果「dd」/],
    ['duplicate effect', ':4 C4{d d}', /重複/],
    ['tuplet cut short by a plain beat', ':8 C4{tu 3} D4{tu 3} E4', /2 個しか/],
    ['tuplet cut short by the section end', ':8 C4{tu 3} D4{tu 3}', /2 個しか/],
    ['single tu beat before |', ':4 C4{tu 3} |', /小節線をまたいで/],
    [
      'mixed-length tuplet (4分＋8分)',
      ':4 C4{tu 3} :8 D4{tu 3} E4{tu 3}',
      /長さの違う/,
    ],
    ['tuplet n changes', ':8 C4{tu 3} D4{tu 5} E4{tu 3}', /数が途中/],
    [
      'tuplet crossing a barline',
      ':4 C4 D4 E4 :8 F4{tu 3} G4{tu 3} | A4{tu 3} :4 B4 C5 D5',
      /小節線をまたいで/,
    ],
    ['dotted tuplet slot', ':8 C4{tu 3 d} D4{tu 3} E4{tu 3}', /付点/],
    ['tie inside a tuplet', ':8 C4{tu 3} C4{tu 3 t} E4{tu 3}', /タイ/],
    ['tie out of a tuplet', ':8 C4{tu 3} D4{tu 3} E4{tu 3} E4{t}', /タイ/],
    ['tuplet of whole notes', ':1 C4{tu 3} D4{tu 3} E4{tu 3}', /2分〜32分/],
    ['4-tuplet', ':8 C4{tu 4} D4{tu 4} E4{tu 4} F4{tu 4}', /4 連符/],
    ['wrong denominator', ':8 C4{tu 3 3} D4{tu 3 3} E4{tu 3 3}', /分母/],
    [
      '13 with no denominator',
      `:32 ${'C4{tu 13} '.repeat(13)}`,
      /分母を書いてください/,
    ],
    [
      '14 with no denominator',
      `:32 ${'C4{tu 14} '.repeat(14)}`,
      /分母を書いてください/,
    ],
    [
      '15 with no denominator',
      `:32 ${'C4{tu 15} '.repeat(15)}`,
      /分母を書いてください/,
    ],
    ['tu without number', ':8 C4{tu}', /tu/],
    ['tu with non-integer', ':8 C4{tu x}', /効果「x」|整数/],
    ['duplicate tu', ':8 C4{tu 3 tu 3}', /重複/],
    [
      'overfull bar counted with the span',
      ':4 C4{tu 3} D4{tu 3} E4{tu 3} F4 G4 A4 |',
      /1 小節目が長/,
    ],
    ['braces before .N', ':4 C4{tu 3}.8', /空白/],
    ['chord ( )', ':4 (C4 E4) D4', /和音/],
    ['fret.string note', ':4 3.2', /\. を使う/],
    ['lowercase pitch', ':4 c4', /大文字/],
    ['double sharp', ':4 C##4', /C##4/],
    ['double flat', ':4 Bbb3', /Bbb3/],
    ['octave out of range', ':4 C9', /C9/],
    ['unsupported duration :64', ':64 C4', /:64/],
    ['bare :', ': C4', /音価「:」/],
    ['\\ts metadata', ':4 C4 \\ts 3 4 D4', /\\/],
    ['\\lyrics metadata', '\\lyrics "a"\n:4 C4', /\\/],
    ['backslash in string', ':4 C4{lyrics "a\\b"}', /\\/],
    ['line comment', ':4 C4 // memo', /コメント/],
    ['block comment', ':4 C4 /* memo */ D4', /コメント/],
    ['unbalanced quote', ':4 C4{lyrics "あ}', /引用符/],
    ['unclosed brace', ':4 C4{d', /閉じていません/],
    ['stray }', ':4 C4} D4', /}/],
    ['nested brace', ':4 C4{d {t}}', /入れ子/],
    ['brace separated by space', ':4 C4 {d}', /直後/],
    ['empty braces', ':4 C4{}', /空の \{ \}/],
    ['empty lyric', ':4 C4{lyrics ""}', /空の歌詞/],
    ['lyrics without string', ':4 C4{lyrics}', /"…"/],
    ['line break in a string', ':4 C4{lyrics "a\nb"}', /改行/],
    ['dangling :N at the end', ':4 C4 :8', /音価指定の後/],
    ['text glued after }', ':4 C4{d}D4', /空白/],
    ['barline glued to note', ':4 C4|', /C4\|/],
    ['effect on barline', ':4 C4 D4 E4 F4 |{d}', /小節線/],
    ['repeat / bar metadata', ':4 C4 \\ro D4', /\\/],
    ['unknown word', ':4 C4 x', /「x」/],
  ];

  it.each(cases)('%s', (_, src, reason) => {
    const res = parseMelody(src, FOUR);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(reason);
      expect(res.reason.length).toBeLessThan(60);
    }
  });

  it('throws only for an unusable time signature', () => {
    expect(() => parseMelody(':4 C4', { num: 1, den: 64 })).toThrow(RangeError);
  });
});

/**
 * What a read of serializer output gives back (see melodyParse.ts header):
 * lyric/chord cleaned (cleanTexText; lyric dropped on rests), and a rest
 * merges into a preceding rest unless it has its own chord. Notes never
 * merge: separate events are written without `t`.
 */
function normalize(events: MelodyEvent[]): MelodyEvent[] {
  const out: MelodyEvent[] = [];
  for (const e of events) {
    const lyric = e.kind === 'note' ? cleanTexText(e.lyric) : undefined;
    const chord = cleanTexText(e.chord);
    const last = out[out.length - 1];
    if (
      e.kind === 'rest' &&
      last?.kind === 'rest' &&
      chord === undefined &&
      !e.tuplet &&
      !last.tuplet
    ) {
      last.ticks += e.ticks;
      continue;
    }
    out.push({
      kind: e.kind,
      ...(e.kind === 'note' && { pitch: e.pitch }),
      ticks: e.ticks,
      ...(lyric !== undefined && { lyric }),
      ...(chord !== undefined && { chord }),
      ...(e.tuplet && { tuplet: { ...e.tuplet } }),
    });
  }
  return out;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PITCHES = ['C4', 'C#4', 'Db4', 'E4', 'Bb3', 'G5', 'Cb4', 'E#4', 'A0'];
const TICKS = [64, 48, 32, 24, 16, 12, 8, 6, 4, 2, 40, 10, 96, 168, 30];
const TEXTS = ['き', 'ら', 'ばー', 'a b', 'きゃ', 'x"{y}', ' ', '\\n', 'C\tD'];
const CHORDS = ['C', 'Am7', 'F#m7-5', 'G/B', '{"}', 'D\n'];
const TIME_SIGS: TimeSig[] = [
  FOUR,
  { num: 3, den: 4 },
  { num: 2, den: 4 },
  { num: 6, den: 8 },
  { num: 5, den: 8 },
];

function generate(rand: () => number): MelodyEvent[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const len = Math.floor(rand() * 20);
  return Array.from({ length: len }, () => {
    const rest = rand() < 0.25;
    const e: MelodyEvent = rest
      ? { kind: 'rest', ticks: pick(TICKS) }
      : { kind: 'note', pitch: pick(PITCHES), ticks: pick(TICKS) };
    if (rand() < 0.5) e.lyric = pick(TEXTS);
    if (rand() < 0.3) e.chord = pick(CHORDS);
    return e;
  });
}

describe('round trip parseMelody(serializeMelody(events))', () => {
  it.each(melodyFixtures.map((f) => [f.name, f] as const))(
    'fixture %s',
    (_, f) => {
      expect(parseMelody(serializeMelody(f.events, f.ts), f.ts)).toEqual({
        ok: true,
        events: normalize(f.events),
      });
    },
  );

  it('50 generated sequences (seed 20261003)', () => {
    const rand = mulberry32(20261003);
    for (let i = 0; i < 50; i++) {
      const ts = TIME_SIGS[i % TIME_SIGS.length];
      const events = generate(rand);
      const tex = serializeMelody(events, ts);
      expect(parseMelody(tex, ts), `#${i} ${ts.num}/${ts.den}\n${tex}`).toEqual(
        { ok: true, events: normalize(events) },
      );
    }
  });
});

const TUPLET_NS = [3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];

/** Like `generate`, with tuplet groups mixed in; only bar-fitting results. */
function generateWithTuplets(rand: () => number, bar: number): MelodyEvent[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  for (;;) {
    const events: MelodyEvent[] = [];
    const len = Math.floor(rand() * 8);
    for (let k = 0; k < len; k++) {
      if (rand() < 0.4) {
        const n = pick(TUPLET_NS);
        const ticks = DURATION_TICKS[pick(TUPLET_UNITS)];
        for (let slot = 0; slot < n; slot++) {
          const e: MelodyEvent =
            rand() < 0.3
              ? { kind: 'rest', ticks }
              : { kind: 'note', pitch: pick(PITCHES), ticks };
          if (rand() < 0.4) e.lyric = pick(TEXTS);
          if (rand() < 0.2) e.chord = pick(CHORDS);
          e.tuplet = { n, slot };
          events.push(e);
        }
      } else {
        events.push(...generate(rand).slice(0, 2));
      }
    }
    if (groupsFitBars(events, bar).ok) return events;
  }
}

describe('parseMelody: tuplets (M5)', () => {
  const t = (e: MelodyEvent, n: number, slot: number): MelodyEvent => ({
    ...e,
    tuplet: { n, slot },
  });

  it('groups {tu N} beats n at a time; written ticks per slot, span per bar', () => {
    expect(
      ok(':8 C4{tu 3 lyrics "き"} D4{tu 3} E4{tu 3 ch "C"} :4 F4 G4 A4 |'),
    ).toEqual([
      t(n('C4', 8, { lyric: 'き' }), 3, 0),
      t(n('D4', 8), 3, 1),
      t(n('E4', 8, { chord: 'C' }), 3, 2),
      n('F4', 16),
      n('G4', 16),
      n('A4', 16),
    ]);
  });

  it('six {tu 3} beats are two triplets (like alphaTab)', () => {
    const ev = ok(
      ':8 C4{tu 3} C4{tu 3} C4{tu 3} C4{tu 3} C4{tu 3} C4{tu 3} :2 r',
    );
    expect(ev.slice(0, 6).map((e) => e.tuplet)).toEqual(
      [0, 1, 2, 0, 1, 2].map((slot) => ({ n: 3, slot })),
    );
  });

  it('rests inside a tuplet stay separate (also from neighbouring rests)', () => {
    expect(ok(':4 r :8 r{tu 3} r{tu 3} r{tu 3} :4 r r')).toEqual([
      r(16),
      t(r(8), 3, 0),
      t(r(8), 3, 1),
      t(r(8), 3, 2),
      r(32),
    ]);
  });

  it('{tu 13 8} (explicit denominator) reads fine', () => {
    const a = ok(`:32 ${'C4{tu 13 8} '.repeat(13)}`);
    expect(a).toHaveLength(13);
    expect(a[12].tuplet).toEqual({ n: 13, slot: 12 });
  });

  it.each([9, 10, 11, 12])(
    '{tu %s} with no denominator reads fine (alphaTab has a default)',
    (n) => {
      const ev = ok(`:32 ${`C4{tu ${n}} `.repeat(n)}`);
      expect(ev).toHaveLength(n);
      expect(ev[n - 1].tuplet).toEqual({ n, slot: n - 1 });
    },
  );

  it('accepts the hand-written .N{tu N} form (sticky .N)', () => {
    expect(ok('C4.8{tu 3} D4{tu 3} r.8{tu 3} :4 E4 F4 G4 |')).toEqual(
      ok(':8 C4{tu 3} D4{tu 3} r{tu 3} :4 E4 F4 G4 |'),
    );
  });

  it('a tuplet ending exactly at the barline is fine', () => {
    expect(
      ok(':4 C4 D4 E4 :8 F4{tu 3} G4{tu 3} A4{tu 3} | :1 B4'),
    ).toHaveLength(7);
  });

  it('parseMelodyIgnoringBars: span counts, a | inside a tuplet still fails', () => {
    expect(parseMelodyIgnoringBars(':8 C4{tu 3} D4{tu 3} E4{tu 3} |').ok).toBe(
      true,
    );
    expect(
      parseMelodyIgnoringBars(':8 C4{tu 3} D4{tu 3} | E4{tu 3} |').ok,
    ).toBe(false);
  });

  it('parseMelodyBeats counts one beat per slot', () => {
    const res = parseMelodyBeats(':8 r{tu 3} r{tu 3} C4{tu 3} :4 r r', FOUR);
    expect(res.ok && res.beats).toEqual([1, 1, 1, 2]);
  });

  it('generated sequences with tuplets round-trip (seed 20261004)', () => {
    const rand = mulberry32(20261004);
    for (let i = 0; i < 60; i++) {
      const ts = TIME_SIGS[i % TIME_SIGS.length];
      const events = generateWithTuplets(rand, (ts.num * 64) / ts.den);
      const tex = serializeMelody(events, ts, 'A');
      expect(parseMelody(tex, ts), `#${i} ${ts.num}/${ts.den}\n${tex}`).toEqual(
        { ok: true, events: normalize(events) },
      );
    }
  });
});

describe('parseMelody: melisma slurs', () => {
  const melisma = [n('C4', 16, { lyric: 'る' }), n('D4', 16), n('E4', 16)];

  it('accepts the written slur (quoted or identifier id) and drops it', () => {
    expect(ok(':4 C4{lyrics "る" slur "A-1"} D4 E4{slur "A-1"} |')).toEqual(
      melisma,
    );
    expect(ok(':4 C4{slur s1 lyrics "る"} D4 E4{slur s1} |')).toEqual(melisma);
  });

  it('accepts a melisma without slurs (normalized on write)', () => {
    expect(ok(':4 C4{lyrics "る"} D4 E4 |')).toEqual(melisma);
  });

  it('accepts a slur ending on the last tied piece across a barline', () => {
    expect(
      ok(':2 C4{d lyrics "a" slur "x"} :4 D4 |\nD4{t slur "x"} :2 r |'),
    ).toEqual([n('C4', 48, { lyric: 'a' }), n('D4', 32), r(32)]);
  });

  it.each([
    ['ends early', ':4 C4{lyrics "る" slur "x"} D4{slur "x"} E4 |'],
    ['starts late', ':4 C4{lyrics "る"} D4{slur "x"} E4{slur "x"} |'],
    [
      'over notes that all have lyrics',
      ':4 C4{lyrics "a" slur "x"} D4{lyrics "b" slur "x"} |',
    ],
    ['across a rest', ':4 C4{lyrics "a" slur "x"} r D4{slur "x"} |'],
    ['on a rest', ':4 C4{lyrics "a"} D4 r{slur "x"} |'],
    ['unpaired', ':4 C4{lyrics "a" slur "x"} D4 |'],
    [
      'id used three times',
      ':4 C4{lyrics "a" slur "x"} D4{slur "x"} E4{lyrics "b" slur "x"} F4 |',
    ],
    ['twice on one beat', ':4 C4{lyrics "a" slur "x" slur "y"} D4 |'],
    [
      'ending on the first piece of a tied note',
      ':2 C4{d lyrics "a" slur "x"} :4 D4{slur "x"} |\nD4{t} :2 r |',
    ],
    ['empty id', ':4 C4{lyrics "a" slur ""} D4{slur ""} |'],
    ['numeric identifier id', ':4 C4{lyrics "a" slur 1} D4{slur 1} |'],
  ])('read-only: %s', (_name, src) => {
    expect(parseMelody(src, FOUR).ok).toBe(false);
  });

  it('round trip with a label keeps events and text', () => {
    const tex = serializeMelody(melisma, FOUR, 'A');
    expect(ok(tex)).toEqual(melisma);
    expect(serializeMelody(ok(tex), FOUR, 'A')).toBe(tex);
  });
});

describe('mergeRests', () => {
  it('returns the same array and the identity map when nothing merges', () => {
    const e = [n('C4', 16), r(16), n('D4', 16), r(16, { chord: 'x' })];
    const out = mergeRests(e);
    expect(out.events).toBe(e);
    expect(out.map).toEqual([0, 1, 2, 3]);
  });

  it('merges chordless rests into the previous rest and maps indexes', () => {
    const e = [n('C4', 16), r(16, { chord: 'G' }), r(8), r(8), n('E4', 16)];
    const out = mergeRests(e);
    expect(out.events).toEqual([
      n('C4', 16),
      r(32, { chord: 'G' }),
      n('E4', 16),
    ]);
    expect(out.map).toEqual([0, 1, 1, 1, 2]);
    expect(e[1]).toEqual(r(16, { chord: 'G' })); // not mutated
  });

  it('keeps a rest with its own chord separate; drops lyrics on rests', () => {
    const e = [r(16), r(16, { chord: 'C' }), r(16, { lyric: 'x' })];
    expect(mergeRests(e).events).toEqual([r(16), r(32, { chord: 'C' })]);
    expect(mergeRests([r(16, { lyric: 'x' })]).events).toEqual([r(16)]);
  });

  it('never merges tuplet rests, nor a rest into / out of a tuplet', () => {
    const input = [
      r(16),
      r(8, { tuplet: { n: 3, slot: 0 } }),
      r(8, { tuplet: { n: 3, slot: 1 } }),
      r(8, { tuplet: { n: 3, slot: 2 }, lyric: 'x' }),
      r(16),
      r(16),
    ];
    const res = mergeRests(input);
    expect(res.events).toEqual([
      r(16),
      r(8, { tuplet: { n: 3, slot: 0 } }),
      r(8, { tuplet: { n: 3, slot: 1 } }),
      r(8, { tuplet: { n: 3, slot: 2 } }),
      r(32),
    ]);
    expect(res.map).toEqual([0, 1, 2, 3, 4, 4]);
    const plain = input.slice(1, 3);
    expect(mergeRests(plain).events).toBe(plain);
  });

  it('is what parseMelody does to rests', () => {
    const e = [r(16), r(16), n('C4', 16), r(8), r(8, { chord: 'F' }), r(8)];
    expect(ok(serializeMelody(e, FOUR))).toEqual(mergeRests(e).events);
  });
});

describe('parseMelodyBeats', () => {
  it('counts written beats per event (tie continuations, merged rests)', () => {
    const res = parseMelodyBeats(':4 C4 C4{t} D4 r | :2 r E4 | E4{t} |', FOUR);
    expect(res).toEqual({
      ok: true,
      events: [n('C4', 32), n('D4', 16), r(48), n('E4', 64)],
      beats: [2, 1, 2, 2],
    });
  });

  it('fails like parseMelody', () => {
    expect(parseMelodyBeats(':4 (C4 E4) |', FOUR)).toEqual(
      parseMelody(':4 (C4 E4) |', FOUR),
    );
  });
});

describe('parseMelodyIgnoringBars', () => {
  const THREE: TimeSig = { num: 3, den: 4 };
  const src = ':4 C4 D4 E4 F4 |\nG4 A4 :2 C5 |\nC5{t} |';

  it('accepts content whose bars do not fit the time signature', () => {
    expect(parseMelody(src, THREE)).toEqual({
      ok: false,
      reason: '1 小節目が長すぎます',
    });
    expect(parseMelodyIgnoringBars(src)).toEqual({
      ok: true,
      events: [
        n('C4', 16),
        n('D4', 16),
        n('E4', 16),
        n('F4', 16),
        n('G4', 16),
        n('A4', 16),
        n('C5', 64),
      ],
    });
  });

  it('gives the same events as parseMelody for well-formed bars', () => {
    expect(parseMelodyIgnoringBars(src)).toEqual(parseMelody(src, FOUR));
  });

  it('accepts short middle bars too', () => {
    expect(parseMelodyIgnoringBars(':4 C4 | D4 E4 |')).toEqual({
      ok: true,
      events: [n('C4', 16), n('D4', 16), n('E4', 16)],
    });
  });

  it('still rejects everything else', () => {
    for (const bad of [':4 (C4 E4) |', ':4 C4 | | D4 |', 'C4 |', ':4 r{t} |']) {
      expect(parseMelodyIgnoringBars(bad).ok, bad).toBe(false);
    }
  });
});
