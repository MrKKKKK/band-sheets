import { describe, expect, it } from 'vitest';
import { parseSong } from '../../../src/lib/parseSong';
import { saintsSampleText } from '../../../src/lib/saintsSample';
import { chordsPerBeat, chordTimeline } from './chordTimeline';

/** A song with one chart section per entry and a Vocal part with the same labels. */
function song(
  sections: { label: string; chart: string; melody: string }[],
  opts: { time?: string; extraParts?: string; preamble?: string } = {},
): string {
  const head = `{title: t}\n${opts.time ? `{time: ${opts.time}}\n` : ''}`;
  const chart = sections
    .map((s) => `{start_of_verse: ${s.label}}\n${s.chart}\n{end_of_verse}`)
    .join('\n\n');
  const body = sections
    .map((s) => `\\section "${s.label}"\n${s.melody}`)
    .join('\n');
  const pre = opts.preamble ? `${opts.preamble}\n` : '';
  return `${head}\n${chart}\n\n{start_of_part: Vocal}\n${pre}${body}\n{end_of_part}\n${opts.extraParts ?? ''}`;
}

const timeline = (text: string) => chordTimeline(parseSong(text));

describe('chordTimeline: 聖者の行進', () => {
  const t = timeline(saintsSampleText);

  it('has 32 bars of 4/4 in two sections of 16', () => {
    expect(t.ts).toEqual([4, 4]);
    expect(t.bars).toBe(32);
    expect(t.sections).toEqual([
      { label: 'A', startBar: 0, bars: 16 },
      { label: 'B', startBar: 16, bars: 16 },
    ]);
  });

  it('places every chart chord (hand-derived from the sample text)', () => {
    // A: C on "saints" (bar 1), G7 on the 2nd "in" (bar 7), C "want" (9),
    // C7 "be" (10), F "num-" (11), C "saints" (13), G7 "ing" (14 beat 2),
    // C "in" (15). B is the same 16 bars later. The first C is moved back
    // to bar 0 beat 0 (pickup bar).
    const a = (o: number) => [
      { bar: o + 7, beat: 0, text: 'G7' },
      { bar: o + 9, beat: 0, text: 'C' },
      { bar: o + 10, beat: 0, text: 'C7' },
      { bar: o + 11, beat: 0, text: 'F' },
      { bar: o + 13, beat: 0, text: 'C' },
      { bar: o + 14, beat: 2, text: 'G7' },
      { bar: o + 15, beat: 0, text: 'C' },
    ];
    expect(t.chords).toEqual([
      { bar: 0, beat: 0, text: 'C' },
      ...a(0),
      { bar: 17, beat: 0, text: 'C' },
      ...a(16),
    ]);
  });

  it('matches the hand-written per-bar chord table', () => {
    const all = (c: string) => [c, c, c, c];
    const half = ['C', 'C', 'G7', 'G7'];
    const section = [
      all('C'), // 0 pickup (first chord extended back)
      all('C'), // 1 saints
      all('C'),
      all('C'),
      all('C'),
      all('C'),
      all('C'), // 6
      all('G7'), // 7 in
      all('G7'), // 8 pickup
      all('C'), // 9 want
      all('C7'), // 10 be
      all('F'), // 11 num-ber
      all('F'), // 12 pickup
      all('C'), // 13 saints
      half, // 14 march-[G7]ing
      all('C'), // 15 in
    ];
    expect(chordsPerBeat(t)).toEqual([...section, ...section]);
  });
});

describe('chordTimeline: placement rules', () => {
  it('puts a chord after a melisma on the next syllable, skipping lyric-less notes', () => {
    const t = timeline(
      song([
        {
          label: 'A',
          chart: '[C]a [G]b',
          melody: ':4 C4{lyrics "a"} D4 E4 F4{lyrics "b"} |',
        },
      ]),
    );
    expect(t.chords).toEqual([
      { bar: 0, beat: 0, text: 'C' },
      { bar: 0, beat: 3, text: 'G' },
    ]);
  });

  it('a melisma syllable carries its chord on its FIRST note', () => {
    const t = timeline(
      song([
        {
          label: 'A',
          chart: '[C]x [F]a [G]b',
          // a = D4 (beat 1) sung on D4 E4 | F4 G4 |, then b in bar 2.
          melody:
            ':4 C4{lyrics "x"} :2 D4{lyrics "a"} :4 E4 | :2 F4 G4 | :1 G4{lyrics "b"} |',
        },
      ]),
    );
    expect(t.chords).toEqual([
      { bar: 0, beat: 0, text: 'C' },
      { bar: 0, beat: 1, text: 'F' },
      { bar: 2, beat: 0, text: 'G' },
    ]);
    expect(t.bars).toBe(3);
  });

  it('rounds a note starting mid-beat down to its beat', () => {
    const t = timeline(
      song([
        {
          label: 'A',
          chart: 'a [C]b c [G]d',
          // a: 0, b: 8 (beat 0.5), c: 16, d: 40 (beat 2.5)
          melody:
            ':8 C4{lyrics "a"} D4{lyrics "b"} :4 E4{lyrics "c"} :8 r F4{lyrics "d"} :4 G4 |',
        },
      ]),
    );
    expect(t.chords).toEqual([
      { bar: 0, beat: 0, text: 'C' },
      { bar: 0, beat: 2, text: 'G' },
    ]);
  });

  it('places a chord inside a tuplet at the real position', () => {
    // Triplet eighths on beats 0–1: slots at 0, 5.33, 10.67; then beat 1 = 16.
    const t = timeline(
      song([
        {
          label: 'A',
          chart: '[C]a b [G]c [F]d',
          melody:
            ':8 C4{tu 3 lyrics "a"} D4{tu 3 lyrics "b"} E4{tu 3 lyrics "c"} :4 F4{lyrics "d"} :2 r |',
        },
      ]),
    );
    expect(t.chords).toEqual([
      { bar: 0, beat: 0, text: 'G' }, // C and G share beat 0: the later wins
      { bar: 0, beat: 1, text: 'F' },
    ]);
  });

  it('attaches a chord written mid-word / mid-syllable to that syllable', () => {
    const t = timeline(
      song([
        {
          label: 'A',
          chart: 'Oh sa[G]ints き[C]ょう',
          melody: ':4 C4{lyrics "Oh"} D4{lyrics "saints"} :2 E4{lyrics "きょう"} |',
        },
      ]),
    );
    expect(t.chords).toEqual([
      { bar: 0, beat: 0, text: 'G' }, // moved back from beat 1
      { bar: 0, beat: 2, text: 'C' },
    ]);
  });

  it('a chord after a hyphen goes on the next syllable; chords across lines', () => {
    const t = timeline(
      song([
        {
          label: 'A',
          chart: '[C]march-[G]ing\n[F]in',
          melody: ':4 C4{lyrics "march-"} D4{lyrics "ing"} :2 E4{lyrics "in"} |',
        },
      ]),
    );
    expect(t.chords.map((c) => [c.beat, c.text])).toEqual([
      [0, 'C'],
      [1, 'G'],
      [2, 'F'],
    ]);
  });

  it('keeps sections in order and counts a short last bar as a full bar', () => {
    const t = timeline(
      song(
        [
          { label: 'A', chart: '[C]a b c', melody: ':2 C4{lyrics "a"} :4 D4{lyrics "b"} | E4{lyrics "c"} |' },
          { label: 'B', chart: 'x [G]y z', melody: ':4 C4{lyrics "x"} D4{lyrics "y"} E4{lyrics "z"} |' },
        ],
        { time: '3/4' },
      ),
    );
    expect(t.ts).toEqual([3, 4]);
    expect(t.sections).toEqual([
      { label: 'A', startBar: 0, bars: 2 },
      { label: 'B', startBar: 2, bars: 1 },
    ]);
    expect(t.chords).toEqual([
      { bar: 0, beat: 0, text: 'C' },
      { bar: 2, beat: 1, text: 'G' },
    ]);
  });

  it('uses the first non-drum part as the melody (drums and later parts ignored)', () => {
    const text = [
      '{title: t}',
      '{start_of_verse: A}',
      'a [G]b',
      '{end_of_verse}',
      '{start_of_part: Drums}',
      '\\instrument percussion',
      '\\section "A"',
      ':4 HH HH HH HH |',
      '{end_of_part}',
      '{start_of_part: Lead}',
      '\\section "A"',
      ':2 C4{lyrics "a"} D4{lyrics "b"} |',
      '{end_of_part}',
      '{start_of_part: Second}',
      '\\section "A"',
      ':4 C4{lyrics "a"} D4{lyrics "b"} :2 r |',
      '{end_of_part}',
    ].join('\n');
    expect(timeline(text).chords).toEqual([{ bar: 0, beat: 0, text: 'G' }]);
  });

  it('honours the part preamble \\ts over {time}', () => {
    const t = timeline(
      song([{ label: 'A', chart: '[C]a [G]b', melody: ':4 C4{lyrics "a"} D4{lyrics "b"} |' }], {
        time: '4/4',
        preamble: '\\ts 2 4',
      }),
    );
    expect(t.ts).toEqual([2, 4]);
    expect(t.chords[1]).toEqual({ bar: 0, beat: 1, text: 'G' });
  });
});

describe('chordTimeline: errors (Japanese)', () => {
  const ok = { label: 'A', chart: '[C]a b', melody: ':2 C4{lyrics "a"} D4{lyrics "b"} |' };

  it('syllable count mismatch', () => {
    expect(() =>
      timeline(song([{ ...ok, chart: '[C]a b c' }])),
    ).toThrow(/音節（3 個）.*音節（2 個）の数が合いません/);
  });

  it('syllable text mismatch', () => {
    expect(() => timeline(song([{ ...ok, chart: '[C]a z' }]))).toThrow(
      /2 番目の音節がコード譜（「z」）とメロディ（「b」）で違います/,
    );
  });

  it('no melody part (no parts / drums only)', () => {
    expect(() => timeline('{title: t}\n[C]a\n')).toThrow(/メロディのパート.*ありません/);
    expect(() =>
      timeline(
        '{title: t}\n{start_of_verse: A}\n[C]a\n{end_of_verse}\n{start_of_part: Drums}\n\\instrument percussion\n\\section "A"\n:1 BD |\n{end_of_part}\n',
      ),
    ).toThrow(/メロディのパート/);
  });

  it('section order differs between chart and part', () => {
    const b = { ...ok, label: 'B' };
    const text = song([ok, b]).replace(
      '\\section "A"\n:2 C4{lyrics "a"} D4{lyrics "b"} |\n\\section "B"',
      '\\section "B"\n:2 C4{lyrics "a"} D4{lyrics "b"} |\n\\section "A"',
    );
    expect(() => timeline(text)).toThrow(/セクションの順（A B）.*\\section の順（B A）が違います/);
  });

  it('repeated chart section (A B A)', () => {
    const b = { ...ok, label: 'B' };
    const text = song([ok, b, ok]);
    expect(() => timeline(text)).toThrow(/繰り返されています/);
  });

  it('section missing in the part', () => {
    const text = song([ok]).replace('\\section "A"\n', '\\section "Z"\n');
    expect(() => timeline(text)).toThrow(/が違います/);
  });

  it('non-x/4 time ({time: 6/8} and part \\ts 6 8)', () => {
    expect(() => timeline(song([ok], { time: '6/8' }))).toThrow(
      /拍子 6\/8 は扱えません/,
    );
    expect(() =>
      timeline(song([ok], { preamble: '\\ts 3 8' })),
    ).toThrow(/拍子 3\/8 は扱えません/);
  });

  it('unreadable {time}', () => {
    expect(() => timeline(song([ok], { time: 'four' }))).toThrow(/拍子「four」が読めません/);
  });

  it('chord on a line without lyrics', () => {
    expect(() =>
      timeline(song([{ ...ok, chart: '[C] [G]\na b' }])),
    ).toThrow(/歌詞の無い行にコード（C G）があります/);
  });

  it('chord after the last syllable of a line', () => {
    expect(() => timeline(song([{ ...ok, chart: '[C]a b [G]' }]))).toThrow(
      /行の最後のコード G の後ろに歌詞がありません/,
    );
  });

  it('chords outside a labelled section', () => {
    const text = song([ok]).replace('{title: t}\n', '{title: t}\n[D]x\n');
    expect(() => timeline(text)).toThrow(/ラベルの無いセクション/);
  });

  it('a \\tempo in a part', () => {
    expect(() => timeline(song([ok], { preamble: '\\tempo 90' }))).toThrow(
      /\\tempo があります/,
    );
  });

  it('a section the parser cannot read', () => {
    expect(() =>
      timeline(song([{ ...ok, melody: ':2 C4{lyrics "a"} D4{lyrics "b"} E4 |' }])),
    ).toThrow(/セクション「A」が読めません/);
  });

  it('no chords at all', () => {
    expect(() => timeline(song([{ ...ok, chart: 'a b' }]))).toThrow(
      /コードがありません/,
    );
  });
});
