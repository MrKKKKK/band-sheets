import { describe, expect, it } from 'vitest';
import { parseDrums, parseDrumsIgnoringBars } from './drumParse';
import type { DrumEvent, DrumHit } from './drum';
import type { DrumInstrument } from './drumKit';
import type { TimeSig } from './melody';
import { drumFixtures, drumReadVariants } from './fixtures/drumFixtures';

const FOUR: TimeSig = { num: 4, den: 4 };

const h = (inst: DrumInstrument, extra: Partial<DrumHit> = {}): DrumHit => ({
  inst,
  ...extra,
});
const b = (ticks: number, ...insts: DrumInstrument[]): DrumEvent => ({
  hits: insts.map((i) => h(i)),
  ticks,
});
const r = (ticks: number): DrumEvent => ({ hits: [], ticks });

function ok(src: string, ts = FOUR) {
  const res = parseDrums(src, ts);
  if (!res.ok) throw new Error(`unexpected read-only: ${res.reason}`);
  return res;
}

describe('parseDrums: golden fixtures', () => {
  it.each(drumFixtures.map((f) => [f.name, f] as const))('%s', (_, f) => {
    expect(parseDrums(f.tex, f.ts)).toEqual({
      ok: true,
      events: f.events,
      shuffle: f.tex === '' ? 'none' : f.shuffle,
    });
  });
});

describe('parseDrums: hand-written read variants', () => {
  it.each(drumReadVariants.map((v) => [v.name, v] as const))('%s', (_, v) => {
    expect(parseDrums(v.tex, v.ts)).toEqual({
      ok: true,
      events: v.events,
      shuffle: v.shuffle,
    });
  });
});

describe('parseDrums: accepted syntax', () => {
  it('empty / whitespace-only body → no events, shuffle none', () => {
    expect(ok('')).toEqual({ ok: true, events: [], shuffle: 'none' });
    expect(ok('  \n\n\t ')).toEqual({ ok: true, events: [], shuffle: 'none' });
  });

  it('a \\tf with no beats keeps the read shuffle', () => {
    expect(ok('\\tf t16')).toEqual({ ok: true, events: [], shuffle: '16' });
  });

  it.each([
    ['none', 'none'],
    ['no', 'none'],
    ['NoTripletFeel', 'none'],
    ['0', 'none'],
    ['triplet8th', '8'],
    ['T8', '8'],
    ['triplet-8th', '8'],
    ['2', '8'],
    ['triplet16th', '16'],
    ['t16', '16'],
    ['Triplet-16th', '16'],
    ['1', '16'],
  ])('\\tf %s → shuffle %s', (v, shuffle) => {
    expect(ok(`\\tf ${v}\n:4 SD`).shuffle).toBe(shuffle);
  });

  it('blank lines before \\tf and \\tf on the same line as beats', () => {
    expect(ok('\n\n  \\tf t8 :4 SD BD |')).toEqual({
      ok: true,
      events: [b(16, 'SD'), b(16, 'BD')],
      shuffle: '8',
    });
  });

  it('line breaks and spacing carry no meaning; last | optional', () => {
    expect(ok(':4 SD\n\n  BD\tSD BD | SD').events).toEqual([
      b(16, 'SD'),
      b(16, 'BD'),
      b(16, 'SD'),
      b(16, 'BD'),
      b(16, 'SD'),
    ]);
  });

  it('chord hits in any order are sorted; whitespace inside parens', () => {
    expect(ok(':4 (BD  SD{g}\nCR{hac})').events).toEqual([
      {
        hits: [h('CR', { accent: 'heavy' }), h('SD', { ghost: true }), h('BD')],
        ticks: 16,
      },
    ]);
  });

  it('a bare name mixes note and beat effects in any order', () => {
    expect(
      ok(':16 SD{tu 6 g} SD{tu 6} SD{tu 6} SD{tu 6} SD{tu 6} SD{tu 6}')
        .events[0],
    ).toEqual({
      hits: [h('SD', { ghost: true })],
      ticks: 4,
      tuplet: { n: 6, slot: 0 },
    });
    expect(ok(':8 SD{d ac}').events).toEqual([
      { hits: [h('SD', { accent: 'normal' })], ticks: 12 },
    ]);
  });

  it('.N is sticky across beats and bars, and may open the section', () => {
    expect(ok('SD.8 BD SD BD SD BD SD BD | SD').events).toEqual([
      ...Array.from({ length: 4 }, () => [b(8, 'SD'), b(8, 'BD')]).flat(),
      b(8, 'SD'),
    ]);
  });

  it('.N on a rest and on a chord, with beat effects after it', () => {
    expect(ok('r.4{d} (HH BD).8{d} HH.8').events).toEqual([
      r(24),
      b(12, 'HH', 'BD'),
      b(8, 'HH'),
    ]);
    expect(ok('SD.8{tu 3} SD{tu 3} SD{tu 3}').events[0]).toEqual({
      hits: [h('SD')],
      ticks: 8,
      tuplet: { n: 3, slot: 0 },
    });
  });

  it('{tu 13 8} (explicit denominator) reads fine', () => {
    const a = ok(`:32 ${Array(13).fill('SD{tu 13 8}').join(' ')}`).events;
    expect(a[12].tuplet).toEqual({ n: 13, slot: 12 });
  });

  it.each([9, 10, 11, 12])(
    '{tu %s} with no denominator reads fine (alphaTab has a default)',
    (n) => {
      const ev = ok(`:32 ${Array(n).fill(`SD{tu ${n}}`).join(' ')}`).events;
      expect(ev[n - 1].tuplet).toEqual({ n, slot: n - 1 });
    },
  );

  it('the same N twice in a row makes two groups', () => {
    const ev = ok(`:8 ${Array(6).fill('SD{tu 3}').join(' ')}`).events;
    expect(ev.map((e) => e.tuplet?.slot)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('other time signatures: bar length follows ts', () => {
    expect(ok(':4 SD SD SD | BD{d}', { num: 3, den: 4 }).events).toHaveLength(
      4,
    );
    expect(parseDrums(':4 SD SD SD SD |', { num: 3, den: 4 }).ok).toBe(false);
  });
});

describe('parseDrums: read-only (rejected) syntax', () => {
  it.each([
    ['unknown instrument', ':4 SN', '楽器「SN」'],
    ['numeric drum note', ':4 38', '楽器「38」'],
    ['uppercase rest R', ':4 R', '小文字の r'],
    ['lowercase kit name', ':4 sd', '大文字'],
    ['same instrument twice', ':4 (SD SD)', '2 回'],
    ['HH with HO', ':4 (HH HO)', 'HH と HO'],
    ['ghost with an accent', ':4 SD{g ac}', 'ゴーストとアクセント'],
    ['two accents', ':4 SD{ac hac}', 'アクセントは 1 つ'],
    ['tie', ':4 SD SD{t}', 'タイ'],
    ['lyrics effect', ':4 SD{lyrics "a"}', '引用符'],
    ['flam-like grace', ':4 SD{gr}', '効果「gr」'],
    ['tenuto', ':4 SD{ten}', '効果「ten」'],
    ['beat effect before .N', 'SD{tu 3}.8 SD{tu 3} SD{tu 3}', '.N の前'],
    ['note effect after .N', 'SD.8{g}', '.N の後'],
    ['note effect after a chord', ':4 (HH SD){g}', '（ ）の後'],
    ['beat effect inside parens', ':4 (HH SD{d})', '（ ）の中'],
    ['.N inside parens', '(HH.8 SD)', '.N'],
    ['note effect on a rest', ':4 r{g}', '休符'],
    ['rest inside parens', ':4 (r)', '休符'],
    ['empty parens', ':4 ()', '空の（ ）'],
    ['nested parens', ':4 ((SD))', '入れ子'],
    ['unclosed parens', ':4 (SD BD', '閉じていません'],
    ['empty braces', ':4 HH{}', '空の { }'],
    ['duplicate effect', ':4 SD{d d}', '重複'],
    ['dotted 32nd', ':32 SD{d}', '付点32分'],
    ['line comment', ':4 SD // x', 'コメント'],
    ['block comment', ':4 SD /* x */', 'コメント'],
    ['empty bar', ':4 SD SD SD SD | |', '空の小節'],
    ['leading barline', '| :4 SD', '空の小節'],
    ['no duration before first beat', 'SD', '音価が必要'],
    ['duration with nothing after', ':4 SD :8', '音価指定の後'],
    ['invalid :N', ':3 SD', '音価「:3」'],
    ['invalid .N', 'SD.3', '音価「.3」'],
    ['bar too long', ':4 SD SD SD SD SD |', '1 小節目が長すぎます'],
    ['bar too short (not last)', ':4 SD SD SD | SD', '1 小節目が短すぎます'],
    ['other \\tf feel', '\\tf dotted8th\n:4 SD', 'シャッフル'],
    ['\\tf numeric other feel', '\\tf 3\n:4 SD', 'シャッフル'],
    ['\\tf without value', '\\tf', '値がありません'],
    ['\\tf after a beat', ':4 SD \\tf t8 SD', '最初'],
    ['two \\tf', '\\tf t8\n\\tf t16\n:4 SD', '最初'],
    ['other \\ command', '\\ts 3 4\n:4 SD', '\\ で始まる'],
    ['tuplet cut short', ':8 SD{tu 3} SD{tu 3} SD', '3 連符の音が 2 個'],
    [
      'tuplet cut short at the end',
      ':8 SD{tu 3} SD{tu 3}',
      '3 連符の音が 2 個',
    ],
    ['mixed N', ':8 SD{tu 3} SD{tu 5} SD{tu 3}', '数が途中で変わって'],
    ['mixed values', ':8 SD{tu 3} SD{tu 3} :16 SD{tu 3}', '長さの違う'],
    ['dotted slot', ':8 SD{tu 3 d} SD{tu 3} SD{tu 3}', '付点'],
    ['whole-note tuplet', ':1 SD{tu 3} SD{tu 3} SD{tu 3}', '2分〜32分'],
    ['invalid N', ':8 SD{tu 4}', '4 連符は扱えません'],
    ['wrong denominator', ':8 SD{tu 3 4}', '分母'],
    ['13 with no denominator', ':8 SD{tu 13}', '分母を書いてください'],
    ['14 with no denominator', ':8 SD{tu 14}', '分母を書いてください'],
    ['15 with no denominator', ':8 SD{tu 15}', '分母を書いてください'],
    [
      'barline inside a tuplet',
      ':8 SD{tu 3} | SD{tu 3} SD{tu 3}',
      '小節線をまたいで',
    ],
    ['effect on a barline', ':4 SD |{d}', '小節線'],
    ['braces after whitespace', ':4 SD {g}', '直後'],
    ['two brace pairs', ':4 SD{g}{d}', '位置'],
    ['braces after r{} then .N', 'r{d}.8', '.N は書けません'],
  ])('%s: %s', (_, src, reason) => {
    const res = parseDrums(src, FOUR);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain(reason);
  });

  it('throws only for an unusable time signature', () => {
    expect(() => parseDrums(':4 SD', { num: 1, den: 128 })).toThrow(RangeError);
  });
});

describe('parseDrumsIgnoringBars', () => {
  it('accepts bars of any length and keeps the shuffle', () => {
    const src = '\\tf t8\n:4 SD SD SD SD SD | BD |';
    expect(parseDrums(src, FOUR).ok).toBe(false);
    expect(parseDrumsIgnoringBars(src)).toEqual({
      ok: true,
      events: [...Array(5).fill(b(16, 'SD')), b(16, 'BD')],
      shuffle: '8',
    });
  });

  it('still rejects everything else (empty bar, tuplet across |, bad names)', () => {
    expect(parseDrumsIgnoringBars(':4 SD | |').ok).toBe(false);
    expect(parseDrumsIgnoringBars(':8 SD{tu 3} | SD{tu 3} SD{tu 3}').ok).toBe(
      false,
    );
    expect(parseDrumsIgnoringBars(':4 XX').ok).toBe(false);
  });

  it('reads every fixture like parseDrums', () => {
    for (const f of drumFixtures) {
      expect(parseDrumsIgnoringBars(f.tex)).toEqual(parseDrums(f.tex, f.ts));
    }
  });
});
