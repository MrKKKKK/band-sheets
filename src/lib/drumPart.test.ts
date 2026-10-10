import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import type { TimeSig } from './melody';
import type { DrumEvent } from './drum';
import type { Song } from './song';
import { sampleSong } from './fixtures/sampleSong';
import { eightBeat } from './fixtures/drumFixtures';
import { parseDrums } from './drumParse';
import { serializeDrums } from './drumTex';
import { partSections } from './melodyPart';
import { DRUM_ARTICULATIONS } from './partsToAlphaTex';
import {
  drumParts,
  ensureDrumPart,
  readDrumSection,
  writeDrumSection,
  reflowDrumSection,
  drumBarMismatchDisplay,
} from './drumPart';
import { layoutDrums } from './drumLayout';

const ts: TimeSig = { num: 4, den: 4 };
const song = (parts: Song['parts']): Song => ({
  meta: { title: 't' },
  chart: [],
  parts,
});

describe('drumParts / ensureDrumPart', () => {
  const melodyPart = { name: 'Vocal', body: '' };

  it('lists drum parts only, in song order', () => {
    expect(drumParts(sampleSong).map((p) => p.name)).toEqual(['Drums']);
  });

  it('returns the first drum part unchanged', () => {
    const s = song([
      melodyPart,
      { name: 'Dr', body: '\\instrument percussion' },
    ]);
    const r = ensureDrumPart(s);
    expect(r.song).toBe(s);
    expect(r.partIndex).toBe(1);
  });

  it('appends a minimal drum part when there is none', () => {
    const s = song([melodyPart]);
    const r = ensureDrumPart(s);
    expect(r.partIndex).toBe(1);
    expect(r.song.parts).toEqual([
      melodyPart,
      { name: 'Drums', body: '\\instrument percussion' },
    ]);
    expect(s.parts).toHaveLength(1); // not mutated
    expect(ensureDrumPart(s, 'Perc').song.parts[1].name).toBe('Perc');
  });

  it('avoids a name clash with an existing (non-drum) part named "Drums"', () => {
    const s = song([{ ...melodyPart, name: 'Drums' }]);
    expect(ensureDrumPart(s).song.parts[1].name).toBe('Drums 2');
  });
});

describe('readDrumSection', () => {
  it('missing', () => {
    expect(readDrumSection('\\section "A"', 'B', ts)).toEqual({
      status: 'missing',
    });
    expect(readDrumSection('', 'A', ts)).toEqual({ status: 'missing' });
  });

  it('sample song: Drums section A reads as-is', () => {
    const body = sampleSong.parts[1].body;
    expect(partSections(body).sections.map((s) => s.label)).toEqual(['A']);
    expect(readDrumSection(body, 'A', ts)).toEqual({
      status: 'ok',
      events: eightBeat.events,
      shuffle: 'none',
    });
  });

  it('an empty section reads as no events, shuffle none', () => {
    expect(readDrumSection('\\section "A"', 'A', ts)).toEqual({
      status: 'ok',
      events: [],
      shuffle: 'none',
    });
  });

  it('a \\tf with no beats keeps its shuffle on read (write still empties it)', () => {
    const body = '\\section "A"\n\\tf triplet8th';
    expect(readDrumSection(body, 'A', ts)).toEqual({
      status: 'ok',
      events: [],
      shuffle: '8',
    });
  });

  it('passes parseDrums reasons through', () => {
    for (const src of [':4 XX |', ':4 (HH HO) |', ':4 R |', ':4 (SD SD) |']) {
      const p = parseDrums(src, ts);
      expect(p.ok).toBe(false);
      expect(readDrumSection(`\\section "A"\n${src}`, 'A', ts)).toEqual({
        status: 'readonly',
        reason: (p as { reason: string }).reason,
      });
    }
  });

  it('header line with extra content is read-only', () => {
    expect(readDrumSection('\\section "A" :4 BD |', 'A', ts).status).toBe(
      'readonly',
    );
  });

  describe('barMismatch / reflow', () => {
    const three: TimeSig = { num: 3, den: 4 };
    const drumsBody = sampleSong.parts[1].body;

    it('reading the sample song drums in 3/4 is a barMismatch', () => {
      const r = readDrumSection(drumsBody, 'A', three);
      expect(r.status).toBe('barMismatch');
      if (r.status === 'barMismatch') {
        expect(r.events).toEqual(eightBeat.events);
        expect(r.shuffle).toBe('none');
        expect(r.reason).toContain('小節目');
      }
    });

    it('writeDrumSection refuses a barMismatch section', () => {
      expect(() =>
        writeDrumSection(drumsBody, 'A', eightBeat.events, 'none', three, []),
      ).toThrow();
    });

    it('reflowDrumSection re-bars the section in the new time signature', () => {
      const out = reflowDrumSection(drumsBody, 'A', three, ['A']);
      expect(readDrumSection(out, 'A', three)).toEqual({
        status: 'ok',
        events: eightBeat.events,
        shuffle: 'none',
      });
    });

    it('reflowDrumSection throws on missing / readonly sections', () => {
      expect(() => reflowDrumSection(drumsBody, 'Z', three, [])).toThrow();
      const bad = '\\section "A"\n:4 (HH HO) |';
      expect(() => reflowDrumSection(bad, 'A', three, [])).toThrow();
    });
  });

  describe('reflowDrumSection rejects a tuplet crossing the new barline', () => {
    // one 4/4 bar: dotted quarter rest, then an 8th-note triplet (span = one
    // quarter) starting at tick 24 — fits in a 64-tick bar, but straddles
    // the barline of a 32-tick (2/4) bar.
    const bodyText = '\\section "A"\n:4 r{d} :8 SD{tu 3} SD{tu 3} SD{tu 3} |';
    const fourFour: TimeSig = { num: 4, den: 4 };
    const twoFour: TimeSig = { num: 2, den: 4 };

    it('reads ok under 4/4 but barMismatch under 2/4', () => {
      expect(readDrumSection(bodyText, 'A', fourFour).status).toBe('ok');
      expect(readDrumSection(bodyText, 'A', twoFour).status).toBe(
        'barMismatch',
      );
    });

    it('reflowDrumSection throws a Japanese error naming the tuplet', () => {
      expect(() => reflowDrumSection(bodyText, 'A', twoFour, ['A'])).toThrow(
        /小節線をまたぎます/,
      );
    });
  });

  describe('\\articulation override makes the whole part read-only', () => {
    const overridden = [
      '\\instrument percussion',
      '\\articulation HH 50',
      '\\section "A"',
      ':4 BD |',
    ].join('\n');

    it('a section with an otherwise valid body is readonly', () => {
      expect(readDrumSection(overridden, 'A', ts).status).toBe('readonly');
    });

    it('is readonly even for a label that does not exist (whole part blocked)', () => {
      expect(readDrumSection(overridden, 'Z', ts).status).toBe('readonly');
    });

    it('writeDrumSection / reflowDrumSection throw too', () => {
      expect(() =>
        writeDrumSection(overridden, 'A', [], 'none', ts, []),
      ).toThrow();
      expect(() => reflowDrumSection(overridden, 'A', ts, [])).toThrow();
    });

    it('the same number as the app default is NOT an override', () => {
      const same = [
        '\\instrument percussion',
        '\\articulation HH 42',
        '\\section "A"',
        ':4 BD |',
      ].join('\n');
      expect(readDrumSection(same, 'A', ts).status).toBe('ok');
    });

    it('an articulation for a name outside the 9-piece kit is ignored', () => {
      const other = [
        '\\instrument percussion',
        '\\articulation XX 99',
        '\\section "A"',
        ':4 BD |',
      ].join('\n');
      expect(readDrumSection(other, 'A', ts).status).toBe('ok');
    });
  });
});

describe('writeDrumSection', () => {
  const eventsB: DrumEvent[] = [
    { hits: [{ inst: 'HH' }, { inst: 'BD' }], ticks: 16 },
    { hits: [{ inst: 'HH' }], ticks: 16 },
    { hits: [{ inst: 'HH' }, { inst: 'SD' }], ticks: 16 },
    { hits: [{ inst: 'HH' }], ticks: 16 },
  ];

  it('replaces only the target section; everything else byte-identical', () => {
    const weird = [
      '\\instrument percussion',
      '// a comment in the preamble',
      '\\section "A"   ',
      ':4 BD SD BD SD |',
      '',
      '\\section "B" "Bridge"',
      ':8 (HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |',
      '\\section "C"',
      '\t:16 SD SD SD SD SD SD SD SD |',
    ].join('\n');
    const out = writeDrumSection(weird, 'B', eventsB, 'none', ts, [
      'A',
      'B',
      'C',
    ]);
    const b = partSections(weird).sections[1];
    const tex = serializeDrums(eventsB, 'none', ts);
    expect(out).toBe(weird.slice(0, b.start) + tex + weird.slice(b.end));
    expect(out.startsWith(weird.slice(0, b.start))).toBe(true);
    expect(out.endsWith(weird.slice(b.end))).toBe(true);
    expect(readDrumSection(out, 'B', ts)).toEqual({
      status: 'ok',
      events: eventsB,
      shuffle: 'none',
    });
  });

  it('shuffle round-trips independently per section', () => {
    let body = '\\section "A"\n\\section "B"';
    body = writeDrumSection(body, 'A', eventsB, '8', ts, ['A', 'B']);
    body = writeDrumSection(body, 'B', eventsB, '16', ts, ['A', 'B']);
    expect(readDrumSection(body, 'A', ts)).toEqual({
      status: 'ok',
      events: eventsB,
      shuffle: '8',
    });
    expect(readDrumSection(body, 'B', ts)).toEqual({
      status: 'ok',
      events: eventsB,
      shuffle: '16',
    });
  });

  it('writing no events empties the section and discards the requested shuffle', () => {
    expect(
      writeDrumSection('\\section "A"\n:4 BD |', 'A', [], '8', ts, []),
    ).toBe('\\section "A"\n');
    expect(readDrumSection('\\section "A"\n', 'A', ts)).toEqual({
      status: 'ok',
      events: [],
      shuffle: 'none',
    });
  });

  it('throws on a read-only section and writes nothing', () => {
    const body = '\\section "A"\n:4 XX |';
    expect(() => writeDrumSection(body, 'A', eventsB, 'none', ts, [])).toThrow(
      /読み取り専用/,
    );
  });

  it('inserts a missing label by chartOrder and reads back', () => {
    const body = '\\section "A"\n:4 r |\n\\section "C"\n:4 r |';
    const out = writeDrumSection(body, 'B', eventsB, 'none', ts, [
      'A',
      'B',
      'C',
    ]);
    expect(out).toBe(
      `\\section "A"\n:4 r |\n\\section "B"\n${serializeDrums(
        eventsB,
        'none',
        ts,
      )}\n\\section "C"\n:4 r |`,
    );
    expect(readDrumSection(out, 'B', ts)).toEqual({
      status: 'ok',
      events: eventsB,
      shuffle: 'none',
    });
  });
});

describe('inherited shuffle (m5-review.md R2)', () => {
  const eight = ':8 SD SD SD SD SD SD SD SD |';
  const eventsOf = (body: string, label: string) => {
    const r = readDrumSection(body, label, ts);
    if (r.status !== 'ok') throw new Error(r.status);
    return r.events;
  };

  it("a section without \\tf reads the previous section's value", () => {
    const body = `\\section "A"\n\\tf triplet8th\n${eight}\n\\section "B"\n${eight}`;
    expect(readDrumSection(body, 'B', ts)).toMatchObject({
      status: 'ok',
      shuffle: '8',
    });
  });

  it('carries over through several sections without \\tf', () => {
    const body = `\\section "A"\n\\tf t16\n${eight}\n\\section "B"\n${eight}\n\\section "C"\n${eight}`;
    expect(readDrumSection(body, 'C', ts)).toMatchObject({ shuffle: '16' });
  });

  it('reads a part-preamble \\tf', () => {
    const body = `\\instrument percussion\n\\tf triplet8th\n\\section "A"\n${eight}`;
    expect(readDrumSection(body, 'A', ts)).toMatchObject({ shuffle: '8' });
  });

  it('an own \\tf wins over the inherited one', () => {
    const body = `\\tf triplet8th\n\\section "A"\n\\tf none\n${eight}`;
    expect(readDrumSection(body, 'A', ts)).toMatchObject({ shuffle: 'none' });
  });

  it('a \\tf inside a read-only section still carries over', () => {
    const body = `\\section "A"\n\\tf t8\n:4 XX |\n\\section "B"\n${eight}`;
    expect(readDrumSection(body, 'A', ts).status).toBe('readonly');
    expect(readDrumSection(body, 'B', ts)).toMatchObject({ shuffle: '8' });
  });

  it('an inherited value the app cannot read makes the section read-only', () => {
    const body = `\\tf weird\n\\section "A"\n${eight}`;
    expect(readDrumSection(body, 'A', ts)).toEqual({
      status: 'readonly',
      reason: '前から引き継ぐシャッフル（\\tf weird）をアプリでは読めません',
    });
  });

  it('the first edit writes the inherited value explicitly', () => {
    const body = `\\section "A"\n\\tf triplet8th\n${eight}\n\\section "B"\n${eight}`;
    const r = readDrumSection(body, 'B', ts);
    if (r.status !== 'ok') throw new Error(r.status);
    const out = writeDrumSection(
      body,
      'B',
      [...r.events, { hits: [{ inst: 'BD' }], ticks: 8 }],
      r.shuffle,
      ts,
      ['A', 'B'],
    );
    expect(partSections(out).sections[1].body).toMatch(/^\\tf triplet8th\n/);
  });

  it('a missing section reads the value at its would-be position (with chartOrder)', () => {
    const body = `\\section "A"\n\\tf t8\n${eight}\n\\section "C"\n\\tf none\n${eight}`;
    expect(readDrumSection(body, 'B', ts, ['A', 'B', 'C'])).toEqual({
      status: 'missing',
      shuffle: '8',
    });
    expect(readDrumSection(body, 'X', ts, ['X', 'A', 'C'])).toEqual({
      status: 'missing',
      shuffle: 'none',
    });
    expect(readDrumSection('', 'A', ts, ['A'])).toEqual({
      status: 'missing',
      shuffle: 'none',
    });
  });

  describe('a write keeps later sections without \\tf rendering the same', () => {
    it("changing an earlier section's shuffle pins the next section's old value", () => {
      const body = `\\section "A"\n\\tf none\n${eight}\n\\section "B"\n${eight}\n\\section "C"\n${eight}`;
      const out = writeDrumSection(body, 'A', eventsOf(body, 'A'), '8', ts, [
        'A',
        'B',
        'C',
      ]);
      expect(out).toBe(
        `\\section "A"\n\\tf triplet8th\n${eight}\n\\section "B"\n\\tf none\n${eight}\n\\section "C"\n${eight}`,
      );
      expect(readDrumSection(out, 'B', ts)).toMatchObject({ shuffle: 'none' });
      expect(readDrumSection(out, 'C', ts)).toMatchObject({ shuffle: 'none' });
    });

    it('keeps the raw token, even one the app cannot read', () => {
      const body = `\\tf weird\n\\section "A"\n\\tf t8\n${eight}\n\\section "B"\n:4 XX |`;
      const out = writeDrumSection(body, 'A', [], 'none', ts, ['A', 'B']);
      expect(out).toBe(
        `\\tf weird\n\\section "A"\n\n\\section "B"\n\\tf t8\n:4 XX |`,
      );
    });

    it('a new section inserted before a hand-written one does not change it', () => {
      const body = `\\section "A"\n\\tf t8\n${eight}\n\\section "C"\n${eight}`;
      const out = writeDrumSection(body, 'B', eventsOf(body, 'A'), 'none', ts, [
        'A',
        'B',
        'C',
      ]);
      expect(partSections(out).sections.map((s) => s.label)).toEqual([
        'A',
        'B',
        'C',
      ]);
      expect(readDrumSection(out, 'C', ts)).toMatchObject({ shuffle: '8' });
      expect(partSections(out).sections[2].body).toBe(`\\tf t8\n${eight}`);
    });

    it('an empty following section gets the line under its header', () => {
      const body = `\\section "A"\n${eight}\n\\section "B"`;
      const out = writeDrumSection(body, 'A', eventsOf(body, 'A'), '16', ts, [
        'A',
        'B',
      ]);
      expect(out).toBe(
        `\\section "A"\n\\tf triplet16th\n${eight}\n\\section "B"\n\\tf none`,
      );
    });

    it('does not touch a section whose own \\tf already decides it', () => {
      const body = `\\section "A"\n${eight}\n\\section "B"\n\\tf none\n${eight}`;
      const out = writeDrumSection(body, 'A', eventsOf(body, 'A'), '8', ts, [
        'A',
        'B',
      ]);
      expect(out.endsWith(`\\section "B"\n\\tf none\n${eight}`)).toBe(true);
      expect(out.match(/\\tf/g)).toHaveLength(2);
    });

    it('leaves a read-only section starting with a bare beat alone', () => {
      const body = `\\section "A"\n${eight}\n\\section "B"\nSD SD |`;
      const out = writeDrumSection(body, 'A', eventsOf(body, 'A'), '8', ts, [
        'A',
        'B',
      ]);
      expect(out.endsWith('\\section "B"\nSD SD |')).toBe(true);
    });

    // m5-review.md R9: a `//` comment line before the first beat (making
    // the section read-only on its own) must not be mistaken for a
    // duration-less bare beat — the `\tf` line still needs to go in ahead
    // of it, or alphaTab's rendering of that section silently changes too.
    it('still pins a following section whose first content line is a comment', () => {
      const body = `\\section "A"\n\\tf none\n${eight}\n\\section "B"\n// hand\n${eight}`;
      const out = writeDrumSection(body, 'A', eventsOf(body, 'A'), '8', ts, [
        'A',
        'B',
      ]);
      expect(out).toBe(
        `\\section "A"\n\\tf triplet8th\n${eight}\n\\section "B"\n\\tf none\n// hand\n${eight}`,
      );

      // Confirm against alphaTab itself: A's shuffle changed (triplet8th),
      // B (read-only in this app, comment inside) keeps rendering with the
      // feel it had before the edit (none), not A's new one.
      const head = [
        `\\ts ${ts.num} ${ts.den}`,
        '\\instrument percussion',
        ...DRUM_ARTICULATIONS.map(([n, m]) => `\\articulation ${n} ${m}`),
        '\\clef neutral',
      ];
      const importer = new alphaTab.importer.AlphaTexImporter();
      importer.logErrors = false;
      importer.initFromString(
        [...head, out].join('\n'),
        new alphaTab.Settings(),
      );
      const score = importer.readScore();
      expect(score.masterBars).toHaveLength(2);
      expect(score.masterBars[0].tripletFeel).toBe(2); // triplet8th
      expect(score.masterBars[1].tripletFeel).toBe(0); // none, unchanged
    });

    it('reflowDrumSection keeps the following sections too', () => {
      const body = `\\section "A"\n\\tf t8\n:2 SD SD |\n\\section "B"\n${eight}`;
      const out = reflowDrumSection(body, 'A', { num: 3, den: 4 }, ['A', 'B']);
      expect(readDrumSection(out, 'B', { num: 3, den: 4 }).status).not.toBe(
        'readonly',
      );
      expect(partSections(out).sections[1].body).toBe(eight);
    });
  });
});

describe('drumBarMismatchDisplay (m5-review.md R1)', () => {
  const layout = (events: DrumEvent[], t: TimeSig) =>
    layoutDrums(events, t, { width: 600 });

  for (const [name, body, t] of [
    ['3/4: a half note crossing the barline', ':2 SD SD |', { num: 3, den: 4 }],
    ['4/4: hand-typed :4 SD :2 SD SD', ':4 SD :2 SD SD |', ts],
    [
      '3/4: a triplet crossing the new barline',
      ':8 SD :4 SD SD :8 SD{tu 3} SD{tu 3} SD{tu 3} :8 SD |',
      { num: 3, den: 4 },
    ],
  ] as const) {
    it(name, () => {
      const r = readDrumSection(`\\section "A"\n${body}`, 'A', t);
      expect(r.status).toBe('barMismatch');
      if (r.status !== 'barMismatch') return;
      expect(() => layout(r.events, t)).toThrow();
      const shown = drumBarMismatchDisplay(r.events, t);
      expect(() => layout(shown, t)).not.toThrow();
      const total = (es: DrumEvent[]) => es.reduce((n, e) => n + e.ticks, 0);
      if (!r.events.some((e) => e.tuplet)) {
        expect(total(shown)).toBe(total(r.events));
      }
    });
  }
});
