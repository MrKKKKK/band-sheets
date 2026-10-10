import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import type { MelodyEvent, TimeSig } from './melody';
import {
  convertPartLevelLyrics,
  ensureMelodyPart,
  hasPartLevelLyrics,
  melodyParts,
  partSections,
  preambleOverrides,
  readSection,
  readSectionWith,
  reflowSection,
  reflowSectionWith,
  renamePart,
  withoutCrossingTuplets,
  writeSection,
  writeSectionText,
  type SectionCodec,
} from './melodyPart';
import { layoutMelody } from './staffLayout';
import { serializeMelody } from './melodyTex';
import { parseMelody } from './melodyParse';
import { sampleSong } from './fixtures/sampleSong';
import type { Song } from './song';

const ts: TimeSig = { num: 4, den: 4 };
const q = (pitch: string, lyric?: string): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks: 16,
  ...(lyric ? { lyric } : {}),
});
// Lyric-less notes after a lyric would form a melisma, whose slur ids
// depend on the section label; these tests are about section ranges, so
// EVENTS has a melisma-free lyric layout (see 'slur ids' below).
const EVENTS: MelodyEvent[] = [q('C4'), q('D4'), q('E4', 'き'), q('F4', 'ら')];
const TEX = serializeMelody(EVENTS, ts);

const song = (parts: Song['parts']): Song => ({
  meta: { title: 't' },
  chart: [],
  parts,
});
const drums = { name: 'Drums', body: '\\instrument percussion\n:4 BD |' };

describe('melodyParts / ensureMelodyPart', () => {
  it('lists non-drum parts', () => {
    expect(melodyParts(sampleSong).map((p) => p.name)).toEqual(['Vocal']);
  });

  it('returns the first melody part unchanged', () => {
    const s = song([drums, { name: 'Gt', body: '' }, { name: 'Vo', body: '' }]);
    const r = ensureMelodyPart(s);
    expect(r.song).toBe(s);
    expect(r.partIndex).toBe(1);
  });

  it('appends an empty part when there is none', () => {
    const s = song([drums]);
    const r = ensureMelodyPart(s);
    expect(r.partIndex).toBe(1);
    expect(r.song.parts).toEqual([drums, { name: 'Vocal', body: '' }]);
    expect(s.parts).toHaveLength(1); // not mutated
    expect(ensureMelodyPart(s, 'Melody').song.parts[1].name).toBe('Melody');
  });

  it('avoids a name clash with an existing (drum) part', () => {
    const s = song([{ ...drums, name: 'Vocal' }]);
    expect(ensureMelodyPart(s).song.parts[1].name).toBe('Vocal 2');
  });
});

describe('renamePart', () => {
  const s = song([
    { name: 'Vocal', body: 'x' },
    { name: 'Gt', body: '' },
  ]);

  it('renames (trimmed) without mutating', () => {
    const r = renamePart(s, 0, '  Lead ');
    expect('error' in r).toBe(false);
    expect((r as Song).parts[0]).toEqual({ name: 'Lead', body: 'x' });
    expect(s.parts[0].name).toBe('Vocal');
  });

  it('allows keeping the same name', () => {
    expect('error' in renamePart(s, 0, 'Vocal')).toBe(false);
  });

  it.each([
    ['', '入力'],
    ['   ', '入力'],
    ['Gt', '同じ名前'],
    ['a{b', '{'],
    ['a}b', '{'],
    ['a\nb', '改行'],
    ['a\\b', '\\'],
    ['a"b', '"'],
  ])('rejects %j', (name, msg) => {
    const r = renamePart(s, 0, name);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain(msg);
  });

  it('throws on a bad index', () => {
    expect(() => renamePart(s, 5, 'x')).toThrow(RangeError);
  });
});

describe('partSections', () => {
  it('empty body', () => {
    expect(partSections('')).toEqual({ preamble: '', sections: [] });
  });

  it('splits preamble and sections with offsets', () => {
    const body =
      '\\staff\n\\section "A"\n:4 C4 |\n\\section "B" "Verse"\n:4 D4 |\n:4 E4 |';
    const r = partSections(body);
    expect(r.preamble).toBe('\\staff');
    expect(r.unlabeled).toBeUndefined();
    expect(r.sections.map((s) => [s.label, s.header, s.body])).toEqual([
      ['A', '\\section "A"', ':4 C4 |'],
      ['B', '\\section "B" "Verse"', ':4 D4 |\n:4 E4 |'],
    ]);
    for (const s of r.sections) expect(body.slice(s.start, s.end)).toBe(s.body);
  });

  it('label forms: quoted, single-quoted, bare', () => {
    const r = partSections('\\section \'x y\'\n\\section B\n  \\section "C"  ');
    expect(r.sections.map((s) => s.label)).toEqual(['x y', 'B', 'C']);
  });

  it('empty sections sit at the end of their header line', () => {
    const body = '\\section "A"\n\\section "B"';
    const [a, b] = partSections(body).sections;
    expect(a.body).toBe('');
    expect(a.start).toBe('\\section "A"'.length);
    expect(a.end).toBe(a.start);
    expect(b.start).toBe(body.length);
  });

  it('ignores \\section in // comment lines', () => {
    const r = partSections('// \\section "X"\n\\section "A"\n:4 C4 |');
    expect(r.preamble).toBe('// \\section "X"');
    expect(r.sections.map((s) => s.label)).toEqual(['A']);
  });

  it('exposes notes before the first section as unlabeled', () => {
    const r = partSections(
      '\\staff\n// c\n:4 C4 |\n\n\\lyrics "a"\n\\section "A"\n:4 D4 |',
    );
    expect(r.preamble).toBe('\\staff\n// c\n:4 C4 |\n\n\\lyrics "a"');
    expect(r.unlabeled).toBe(':4 C4 |');
  });

  it('a body without sections is all preamble', () => {
    const r = partSections(':4 C4 |');
    expect(r.preamble).toBe(':4 C4 |');
    expect(r.sections).toEqual([]);
    expect(r.unlabeled).toBe(':4 C4 |');
  });
});

describe('hasPartLevelLyrics', () => {
  it('detects \\lyrics in the preamble only', () => {
    expect(hasPartLevelLyrics(sampleSong.parts[0].body)).toBe(true);
    expect(hasPartLevelLyrics('\\section "A"\n\\lyrics "a"')).toBe(false);
    expect(hasPartLevelLyrics('// \\lyrics "a"\n\\section "A"')).toBe(false);
    expect(hasPartLevelLyrics('  \\lyrics 1 "a"')).toBe(true);
    expect(hasPartLevelLyrics('\\lyricsx')).toBe(false);
    expect(hasPartLevelLyrics('')).toBe(false);
  });
});

describe('readSection', () => {
  it('missing', () => {
    expect(readSection('\\section "A"\n' + TEX, 'B', ts)).toEqual({
      status: 'missing',
    });
    expect(readSection('', 'A', ts)).toEqual({ status: 'missing' });
  });

  it('ok, using the first section with that label', () => {
    const body = `\\section "A" "Verse"\n${TEX}\n\\section "A"\n:4 r |`;
    expect(readSection(body, 'A', ts)).toEqual({
      status: 'ok',
      events: EVENTS,
    });
  });

  it('an empty section reads as no events', () => {
    expect(readSection('\\section "A"', 'A', ts)).toEqual({
      status: 'ok',
      events: [],
    });
  });

  it('passes parse reasons through', () => {
    for (const src of [':4 C4 // x', ':4 (C4 E4) |', 'C4 |', ':4 C4{tu 3} |']) {
      const p = parseMelody(src, ts);
      expect(p.ok).toBe(false);
      expect(readSection(`\\section "A"\n${src}`, 'A', ts)).toEqual({
        status: 'readonly',
        reason: (p as { reason: string }).reason,
      });
    }
  });

  it('header line with extra content is read-only', () => {
    const r = readSection('\\section "A" :4 C4 |', 'A', ts);
    expect(r.status).toBe('readonly');
  });

  it('sample Vocal part: lyrics + sections found, both readable (M4 T-dot .N support)', () => {
    const body = sampleSong.parts[0].body;
    expect(partSections(body).sections.map((s) => s.label)).toEqual(['A', 'B']);
    // the sample uses alphaTab's `G4.2` idiom; now in the editor subset (see
    // melodyParse.ts / melody.ts spec comment).
    const h = (pitch: string): MelodyEvent => ({
      kind: 'note',
      pitch,
      ticks: 32,
    });
    const a = readSection(body, 'A', ts);
    expect(a).toEqual({
      status: 'ok',
      events: [
        q('C4'),
        q('C4'),
        q('G4'),
        q('G4'),
        q('A4'),
        q('A4'),
        h('G4'),
        q('F4'),
        q('F4'),
        q('E4'),
        q('E4'),
        q('D4'),
        q('D4'),
        h('C4'),
      ],
    });
    const b = readSection(body, 'B', ts);
    expect(b).toEqual({
      status: 'ok',
      events: [
        q('G4'),
        q('G4'),
        q('F4'),
        q('F4'),
        q('E4'),
        q('E4'),
        h('D4'),
        q('G4'),
        q('G4'),
        q('F4'),
        q('F4'),
        q('E4'),
        q('E4'),
        h('D4'),
      ],
    });
  });

  it('sample-like Vocal part in the subset is readable', () => {
    const body =
      '\\lyrics "き ら"\n\\section "A"\n' +
      TEX +
      '\n\\section "B"\n:4 G4 G4 F4 F4 |';
    expect(hasPartLevelLyrics(body)).toBe(true);
    expect(readSection(body, 'A', ts)).toEqual({
      status: 'ok',
      events: EVENTS,
    });
    expect(readSection(body, 'B', ts).status).toBe('ok');
  });
});

describe('writeSection', () => {
  const weird = [
    '\\staff {score} \\clef G2  ',
    '// comment',
    '\\lyrics "x y"',
    '\\section "A"   ',
    ':4 C4   D4 | //odd',
    '',
    '\\section "B" "Bridge"',
    ':4 r |',
    '\\section "C"',
    '\t:8 C4 C4 C4 C4 C4 C4 C4 C4 |  ',
  ].join('\n');

  it('replaces only B; everything else byte-identical', () => {
    const out = writeSection(weird, 'B', EVENTS, ts, ['A', 'B', 'C']);
    const b = partSections(weird).sections[1];
    expect(out).toBe(weird.slice(0, b.start) + TEX + weird.slice(b.end));
    expect(out.startsWith(weird.slice(0, b.start))).toBe(true);
    expect(out.endsWith(weird.slice(b.end))).toBe(true);
    expect(readSection(out, 'B', ts)).toEqual({ status: 'ok', events: EVENTS });
  });

  it('writes the first section of a duplicated label only', () => {
    const body = '\\section "A"\n:4 r |\n\\section "A"\n:4 r |';
    expect(writeSection(body, 'A', EVENTS, ts, [])).toBe(
      `\\section "A"\n${TEX}\n\\section "A"\n:4 r |`,
    );
  });

  it('fills an empty section (middle and last)', () => {
    expect(
      writeSection('\\section "A"\n\\section "B"', 'A', EVENTS, ts, []),
    ).toBe(`\\section "A"\n${TEX}\n\\section "B"`);
    expect(
      writeSection('\\section "A"\n\\section "B"', 'B', EVENTS, ts, []),
    ).toBe(`\\section "A"\n\\section "B"\n${TEX}`);
  });

  it('writing no events empties the section', () => {
    expect(
      writeSection('\\section "A"\n:4 C4 |\n\\section "B"', 'A', [], ts, []),
    ).toBe('\\section "A"\n\n\\section "B"');
    expect(writeSection('\\section "A"', 'A', [], ts, [])).toBe(
      '\\section "A"',
    );
  });

  it('throws on a read-only section and leaves nothing written', () => {
    expect(() => writeSection(weird, 'A', EVENTS, ts, [])).toThrow();
  });

  it('throws when the next header line has notes before \\section', () => {
    const body = '\\section "A"\n:4 C4 C4 C4 C4 |\n:4 D4 \\section "B"';
    expect(readSection(body, 'A', ts).status).toBe('readonly');
    expect(() => writeSection(body, 'A', EVENTS, ts, [])).toThrow();
  });

  describe('inserting a missing label', () => {
    const body = '\\staff\n\\section "A"\n:4 r |\n\\section "C"\n:4 r |';
    const block = `\\section "B"\n${TEX}`;

    it('after the latest preceding label in chart order', () => {
      expect(writeSection(body, 'B', EVENTS, ts, ['A', 'B', 'C'])).toBe(
        `\\staff\n\\section "A"\n:4 r |\n${block}\n\\section "C"\n:4 r |`,
      );
      expect(writeSection(body, 'B', EVENTS, ts, ['C', 'A', 'B'])).toBe(
        `\\staff\n\\section "A"\n:4 r |\n${block}\n\\section "C"\n:4 r |`,
      );
      expect(writeSection(body, 'B', EVENTS, ts, ['A', 'C', 'B'])).toBe(
        `${body}\n${block}`,
      );
    });

    it('picks the preceding label latest in chart order, not file order', () => {
      expect(writeSection(body, 'B', EVENTS, ts, ['C', 'A', 'X', 'B'])).toBe(
        `\\staff\n\\section "A"\n:4 r |\n${block}\n\\section "C"\n:4 r |`,
      );
      expect(writeSection(body, 'B', EVENTS, ts, ['A', 'C', 'X', 'B'])).toBe(
        `${body}\n${block}`,
      );
      const ca = '\\section "C"\n:4 r |\n\\section "A"\n:4 r |';
      expect(writeSection(ca, 'B', EVENTS, ts, ['A', 'B'])).toBe(
        `${ca}\n${block}`,
      );
      expect(writeSection(ca, 'B', EVENTS, ts, ['C', 'B'])).toBe(
        `\\section "C"\n:4 r |\n${block}\n\\section "A"\n:4 r |`,
      );
    });

    it('after the last occurrence of a duplicated preceding label', () => {
      const dup = '\\section "A"\n:4 r |\n\\section "C"\n\\section "A"';
      expect(writeSection(dup, 'B', EVENTS, ts, ['A', 'B'])).toBe(
        `${dup}\n${block}`,
      );
    });

    it('before the earliest following label when none precedes', () => {
      expect(writeSection(body, 'B', EVENTS, ts, ['B', 'A', 'C'])).toBe(
        `\\staff\n${block}\n\\section "A"\n:4 r |\n\\section "C"\n:4 r |`,
      );
      expect(writeSection(body, 'B', EVENTS, ts, ['X', 'B', 'C'])).toBe(
        `\\staff\n\\section "A"\n:4 r |\n${block}\n\\section "C"\n:4 r |`,
      );
    });

    it('at the end when unrelated / not in chart order', () => {
      expect(writeSection(body, 'B', EVENTS, ts, [])).toBe(`${body}\n${block}`);
      expect(writeSection(body, 'B', EVENTS, ts, ['X', 'B', 'Y'])).toBe(
        `${body}\n${block}`,
      );
    });

    it('into an empty body / a preamble-only body', () => {
      expect(writeSection('', 'A', EVENTS, ts, ['A'])).toBe(
        `\\section "A"\n${TEX}`,
      );
      expect(writeSection('\\staff', 'A', [], ts, ['A'])).toBe(
        '\\staff\n\\section "A"',
      );
      expect(writeSection('\\staff\n', 'A', [], ts, ['A'])).toBe(
        '\\staff\n\\section "A"',
      );
    });

    it('quotes labels safely and rejects line breaks', () => {
      expect(writeSection('', 'say "hi"', [], ts, [])).toBe(
        `\\section 'say "hi"'`,
      );
      expect(() => writeSection('', `a"b'c`, [], ts, [])).toThrow(/引用符/);
      expect(() => writeSection('', 'a\\b', [], ts, [])).toThrow(/\\/);
      expect(() => writeSection('', 'a\nb', [], ts, [])).toThrow();
      expect(
        partSections(writeSection('', 'サビ 1', [], ts, [])).sections[0].label,
      ).toBe('サビ 1');
    });

    it('the inserted section reads back', () => {
      const out = writeSection(body, 'B', EVENTS, ts, ['A', 'B', 'C']);
      expect(readSection(out, 'B', ts)).toEqual({
        status: 'ok',
        events: EVENTS,
      });
      expect(readSection(out, 'A', ts)).toEqual(readSection(body, 'A', ts));
    });
  });
});

/** Per-beat lyric of every beat in a part body, read via the REAL alphaTab
 * importer (ground truth for rendering-equivalence checks below). */
function beatLyrics(tex: string, timeSig: TimeSig): (string | undefined)[] {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.logErrors = false;
  importer.initFromString(
    `\\ts ${timeSig.num} ${timeSig.den}\n${tex}`,
    new alphaTab.Settings(),
  );
  const score = importer.readScore();
  const bars = score.tracks[0].staves[0].bars;
  return bars.flatMap((bar) => bar.voices[0].beats.map((b) => b.lyrics?.[0]));
}

describe('slur ids (melismas)', () => {
  const melisma = [q('C4', 'る'), q('D4'), q('E4')];

  it('writeSection prefixes slur ids with the section label; alphaTab pairs them per section', () => {
    let body = writeSection('', 'A', melisma, ts, ['A', 'B']);
    body = writeSection(body, 'B', melisma, ts, ['A', 'B']);
    expect(body).toBe(
      [
        '\\section "A"',
        ':4 C4{lyrics "る" slur "A-1"} D4 E4{slur "A-1"} |',
        '\\section "B"',
        ':4 C4{lyrics "る" slur "B-1"} D4 E4{slur "B-1"} |',
      ].join('\n'),
    );
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.logErrors = false;
    importer.initFromString(body, new alphaTab.Settings());
    const notes = importer
      .readScore()
      .tracks[0].staves[0].bars.map((b) => b.voices[0].beats[0].notes[0]);
    expect(notes[0].slurDestination?.realValue).toBe(64);
    expect(notes[1].slurDestination?.realValue).toBe(64);
    expect(notes[1].slurDestination?.beat.voice.bar.index).toBe(1);
  });

  it('convertPartLevelLyrics writes slurs with the section label', () => {
    const body = '\\lyrics "る"\n\\section "V"\n:4 C4 D4 E4 |';
    expect(convertPartLevelLyrics(body, ts)).toBe(
      '\\section "V"\n:4 C4{lyrics "る" slur "V-1"} D4 E4{slur "V-1"} |',
    );
  });
});

describe('convertPartLevelLyrics', () => {
  const KIRAKIRA = [
    'き',
    'ら',
    'き',
    'ら',
    'ひ',
    'か',
    'る',
    'お',
    'そ',
    'ら',
    'の',
    'ほ',
    'し',
    'よ',
  ];

  it('errors when there is no part-level \\lyrics line', () => {
    expect(convertPartLevelLyrics('\\section "A"\n:4 C4 |', ts)).toEqual({
      error: expect.any(String),
    });
  });

  it('rejects the start-bar form', () => {
    const body = '\\lyrics 2 "a b"\n\\section "A"\n:4 C4 D4 |';
    expect(convertPartLevelLyrics(body, ts)).toEqual({
      error: expect.any(String),
    });
  });

  it('errors when a section is read-only (nothing is written)', () => {
    const body = '\\lyrics "a b"\n\\section "A"\n:4 (C4 E4) D4 |';
    expect(convertPartLevelLyrics(body, ts)).toEqual({
      error: '読み取り専用のセクションがあるため変換できません',
    });
  });

  it('distributes syllables over notes in order, skipping rests', () => {
    const body =
      '\\lyrics "a b c"\n\\section "A"\n:4 C4 r D4 |\n\\section "B"\n:4 E4 |';
    const out = convertPartLevelLyrics(body, ts);
    expect(typeof out).toBe('string');
    const result = out as string;
    expect(result).not.toMatch(/\\lyrics/);
    expect(readSection(result, 'A', ts)).toEqual({
      status: 'ok',
      events: [
        { kind: 'note', pitch: 'C4', ticks: 16, lyric: 'a' },
        { kind: 'rest', ticks: 16 },
        { kind: 'note', pitch: 'D4', ticks: 16, lyric: 'b' },
      ],
    });
    expect(readSection(result, 'B', ts)).toEqual({
      status: 'ok',
      events: [{ kind: 'note', pitch: 'E4', ticks: 16, lyric: 'c' }],
    });
  });

  it('leaves later notes without a lyric once syllables run out', () => {
    const body = '\\lyrics "a"\n\\section "A"\n:4 C4 D4 |';
    const out = convertPartLevelLyrics(body, ts) as string;
    expect(readSection(out, 'A', ts)).toEqual({
      status: 'ok',
      events: [
        { kind: 'note', pitch: 'C4', ticks: 16, lyric: 'a' },
        { kind: 'note', pitch: 'D4', ticks: 16 },
      ],
    });
  });

  it('+ joins words on one beat, [...] comments are dropped', () => {
    const body = '\\lyrics "a+[x]+b c"\n\\section "A"\n:4 C4 D4 |';
    const out = convertPartLevelLyrics(body, ts) as string;
    expect(readSection(out, 'A', ts)).toEqual({
      status: 'ok',
      events: [
        { kind: 'note', pitch: 'C4', ticks: 16, lyric: 'a b' },
        { kind: 'note', pitch: 'D4', ticks: 16, lyric: 'c' },
      ],
    });
  });

  it('converts the sample song Vocal part: no \\lyrics line, A gets the syllables', () => {
    const body = sampleSong.parts[0].body;
    const out = convertPartLevelLyrics(body, ts);
    expect(typeof out).toBe('string');
    const result = out as string;
    expect(result).not.toMatch(/\\lyrics/);

    const a = readSection(result, 'A', ts);
    expect(a.status).toBe('ok');
    const aLyrics = (a as { events: MelodyEvent[] }).events.map((e) => e.lyric);
    expect(aLyrics).toEqual(KIRAKIRA);

    // B's notes get no lyric: all 14 syllables were used up by A.
    const b = readSection(result, 'B', ts);
    expect(b.status).toBe('ok');
    expect(
      (b as { events: MelodyEvent[] }).events.every(
        (e) => e.lyric === undefined,
      ),
    ).toBe(true);
  });

  it('rendering-equivalence: alphaTab reads the same per-beat lyrics before and after conversion', () => {
    const body = sampleSong.parts[0].body;
    const out = convertPartLevelLyrics(body, ts) as string;
    expect(beatLyrics(out, ts)).toEqual(beatLyrics(body, ts));
  });
});

describe('convertPartLevelLyrics: tied beats consume a syllable (M5)', () => {
  it('matches alphaTab: the tied continuation takes a syllable', () => {
    const body =
      '\\lyrics "a b c d"\n\\section "A"\n:4 C4 C4{t} D4 E4 | :1 F4 |';
    // ground truth: alphaTab gives the tied beat "b"
    expect(beatLyrics(body, ts)).toEqual(['a', 'b', 'c', 'd', undefined]);
    const out = convertPartLevelLyrics(body, ts) as string;
    expect(readSection(out, 'A', ts)).toEqual({
      status: 'ok',
      events: [
        { kind: 'note', pitch: 'C4', ticks: 32, lyric: 'a' },
        { kind: 'note', pitch: 'D4', ticks: 16, lyric: 'c' },
        { kind: 'note', pitch: 'E4', ticks: 16, lyric: 'd' },
        { kind: 'note', pitch: 'F4', ticks: 64 },
      ],
    });
  });

  it('ties across sections and barlines count per written beat', () => {
    const body =
      '\\lyrics "a b c d e"\n\\section "A"\n:2 C4 :4 D4 :4 E4 |\nE4{t} :2 F4{d} |\n\\section "B"\n:4 G4 |';
    const before = beatLyrics(body, ts);
    const out = convertPartLevelLyrics(body, ts) as string;
    // visible lyrics on the first beat of every note match alphaTab
    const a = readSection(out, 'A', ts) as { events: MelodyEvent[] };
    const b = readSection(out, 'B', ts) as { events: MelodyEvent[] };
    expect(a.events.map((e) => e.lyric)).toEqual([
      before[0],
      before[1],
      before[2],
      before[4],
    ]);
    expect(b.events.map((e) => e.lyric)).toEqual([before[5]]);
    expect(before).toEqual(['a', 'b', 'c', 'd', 'e', undefined]);
  });
});

describe('readSection: barMismatch / reflowSection (M3)', () => {
  const three: TimeSig = { num: 3, den: 4 };
  const body = '\\section "A"\n' + TEX + '\n\\section "B"\n:4 C4 |';

  it('4/4 content read in 3/4 → barMismatch with the lenient events', () => {
    expect(readSection(body, 'A', three)).toEqual({
      status: 'barMismatch',
      events: EVENTS,
      reason: '1 小節目が長すぎます',
    });
  });

  it('other errors stay readonly', () => {
    const bad = '\\section "A"\n:4 (C4 E4) D4 E4 F4 G4 |';
    expect(readSection(bad, 'A', three).status).toBe('readonly');
  });

  it('writeSection refuses a barMismatch section', () => {
    expect(() => writeSection(body, 'A', EVENTS, three, [])).toThrow();
  });

  it('reflowSection re-bars the section in the new time signature', () => {
    const out = reflowSection(body, 'A', three, ['A', 'B']);
    expect(out).toBe(
      '\\section "A"\n' +
        serializeMelody(EVENTS, three) +
        '\n\\section "B"\n:4 C4 |',
    );
    expect(readSection(out, 'A', three)).toEqual({
      status: 'ok',
      events: EVENTS,
    });
  });

  it('reflowSection throws on readonly / missing sections', () => {
    const bad = '\\section "A"\n:4 (C4 E4) D4 E4 F4 G4 |';
    expect(() => reflowSection(bad, 'A', three, [])).toThrow();
    expect(() => reflowSection(body, 'Z', three, [])).toThrow();
  });
});

/**
 * A tiny fake codec (M5 T4): a section's events are just its whitespace-
 * separated tokens. `BAD` makes a section unreadable either way; otherwise
 * the strict parser additionally rejects more tokens than `ts.num` (its
 * stand-in for a bar-length check), which the lenient one ignores.
 */
describe('readSectionWith / writeSectionText / reflowSectionWith (generic, fake codec)', () => {
  const fakeCodec: SectionCodec<string> = {
    parse(body, ts) {
      const tokens = body.split(/\s+/).filter(Boolean);
      if (tokens.includes('BAD'))
        return { ok: false, reason: 'こわれています' };
      if (tokens.length > ts.num) {
        return { ok: false, reason: '拍の数が多すぎます' };
      }
      return { ok: true, events: tokens };
    },
    parseIgnoringBars(body) {
      const tokens = body.split(/\s+/).filter(Boolean);
      if (tokens.includes('BAD'))
        return { ok: false, reason: 'こわれています' };
      return { ok: true, events: tokens };
    },
  };
  const fakeSerialize = (events: string[]) => events.join(' ');
  const fakeTs: TimeSig = { num: 2, den: 4 };

  describe('readSectionWith', () => {
    it('missing', () => {
      expect(readSectionWith('\\section "A"', 'B', fakeTs, fakeCodec)).toEqual({
        status: 'missing',
      });
    });

    it('ok', () => {
      expect(
        readSectionWith('\\section "A"\na b', 'A', fakeTs, fakeCodec),
      ).toEqual({ status: 'ok', events: ['a', 'b'] });
    });

    it('readonly (BAD, in either parser)', () => {
      expect(
        readSectionWith('\\section "A"\na BAD', 'A', fakeTs, fakeCodec),
      ).toEqual({ status: 'readonly', reason: 'こわれています' });
    });

    it('barMismatch: strict fails on count, lenient succeeds', () => {
      expect(
        readSectionWith('\\section "A"\na b c', 'A', fakeTs, fakeCodec),
      ).toEqual({
        status: 'barMismatch',
        events: ['a', 'b', 'c'],
        reason: '拍の数が多すぎます',
      });
    });
  });

  describe('writeSectionText', () => {
    it('replaces only the target section, byte-identical elsewhere', () => {
      const body = '\\section "A"\na b\n\\section "B"\nc d';
      const out = writeSectionText(body, 'A', 'x y z', []);
      expect(out).toBe('\\section "A"\nx y z\n\\section "B"\nc d');
    });

    it('inserts a new labelled section by chartOrder', () => {
      const body = '\\section "A"\na\n\\section "C"\nc';
      expect(writeSectionText(body, 'B', 'b', ['A', 'B', 'C'])).toBe(
        '\\section "A"\na\n\\section "B"\nb\n\\section "C"\nc',
      );
    });
  });

  describe('reflowSectionWith', () => {
    it('re-serializes a barMismatch section once ts fits', () => {
      const body = '\\section "A"\na b c\n\\section "B"\nd';
      expect(
        reflowSectionWith(
          body,
          'A',
          { num: 3, den: 4 },
          ['A', 'B'],
          fakeCodec,
          fakeSerialize,
        ),
      ).toBe('\\section "A"\na b c\n\\section "B"\nd');
    });

    it('throws on missing / readonly', () => {
      const body = '\\section "A"\na BAD';
      expect(() =>
        reflowSectionWith(body, 'A', fakeTs, [], fakeCodec, fakeSerialize),
      ).toThrow();
      expect(() =>
        reflowSectionWith(
          '\\section "A"',
          'Z',
          fakeTs,
          [],
          fakeCodec,
          fakeSerialize,
        ),
      ).toThrow();
    });
  });
});

describe('preambleOverrides (M11)', () => {
  it.each([
    ['\\section "A"\n:4 C4 |', {}],
    ['\\staff {score}\n\\ts 3 4\n\\section "A"', { ts: { num: 3, den: 4 } }],
    ['\\ts 6 8 \\ks G', { ts: { num: 6, den: 8 }, key: 'G' }],
    ['\\ks Aminor', { key: 'Am' }],
    ['\\ks f#minor', { key: 'F#m' }],
    ['\\ks Bb', { key: 'Bb' }],
    ['\\ks Ebmajor', { key: 'Eb' }],
    ['// \\ts 3 4\n\\lyrics "\\ks x"', {}],
  ])('%j', (body, expected) => {
    expect(preambleOverrides(body)).toEqual(expected);
  });

  it.each([
    '\\ts 3',
    '\\ts common',
    '\\ts 3 5',
    '\\ts 3 64',
    '\\ks H',
    '\\ks G#major',
    '\\ks "G"',
    '\\ts 3 4\n\\ts 4 4',
  ])('unsupported: %j', (body) => {
    expect(preambleOverrides(body)).toEqual({ unsupported: true });
  });

  it('ignores \\ts inside sections (those make the section read-only)', () => {
    expect(preambleOverrides('\\section "A"\n\\ts 3 4\n:4 C4 |')).toEqual({});
  });
});

describe('withoutCrossingTuplets (m5-review.md R1)', () => {
  const ts34: TimeSig = { num: 3, den: 4 };
  // The review's repro: fits 4/4, but the triplet crosses bar 1 in 3/4.
  const body =
    '\\section "A"\n:8 C4 :4 C4 C4 :8 C4{tu 3} C4{tu 3} C4{tu 3} :8 C4 |';

  it('the repro is a barMismatch whose raw events make layoutMelody throw', () => {
    const r = readSection(body, 'A', ts34);
    expect(r.status).toBe('barMismatch');
    if (r.status !== 'barMismatch') return;
    expect(() => layoutMelody(r.events, ts34, { width: 600 })).toThrow();
  });

  it('drops the marks of the crossing group only, so the layout succeeds', () => {
    const r = readSection(body, 'A', ts34);
    if (r.status !== 'barMismatch') throw new Error(r.status);
    const shown = withoutCrossingTuplets(r.events, ts34);
    expect(shown).toHaveLength(r.events.length);
    expect(shown.some((e) => e.tuplet)).toBe(false);
    expect(shown.map((e) => e.ticks)).toEqual(r.events.map((e) => e.ticks));
    expect(r.events.filter((e) => e.tuplet)).toHaveLength(3); // not mutated
    expect(() => layoutMelody(shown, ts34, { width: 600 })).not.toThrow();
  });

  it('keeps groups that still fit, and returns the input when nothing crosses', () => {
    const r = readSection(
      '\\section "A"\n:8 C4{tu 3} C4{tu 3} C4{tu 3} :4 C4 C4 C4 |\n:8 C4 :4 C4 :8 C4{tu 3} C4{tu 3} C4{tu 3} :4 C4 :8 C4 |',
      'A',
      ts34,
    );
    if (r.status !== 'barMismatch') throw new Error(r.status);
    const shown = withoutCrossingTuplets(r.events, ts34);
    expect(shown.slice(0, 3).every((e) => e.tuplet)).toBe(true);
    expect(shown.slice(8, 11).some((e) => e.tuplet)).toBe(false);
    const fits = withoutCrossingTuplets(shown, { num: 4, den: 4 });
    expect(fits).toBe(shown);
  });

  it('a part \\ts change gives the same barMismatch and a safe display', () => {
    const part = `\\ts 3 4\n${body}`;
    const o = preambleOverrides(part);
    if ('unsupported' in o || !o.ts) throw new Error('no ts');
    const r = readSection(part, 'A', o.ts);
    if (r.status !== 'barMismatch') throw new Error(r.status);
    expect(() =>
      layoutMelody(withoutCrossingTuplets(r.events, o.ts!), o.ts!, {
        width: 600,
      }),
    ).not.toThrow();
  });
});
