import { describe, expect, it } from 'vitest';
import { applyLyrics } from './lyrics';
import { clearStaleMetaLines } from './meta';
import { removeFromPalette } from './palette';
import { sampleSong, sampleSongText } from './fixtures/sampleSong';
import { parseSong } from './parseSong';
import { serializeSong } from './serializeSong';
import type { Song } from './song';
import { melodyTimeSignature } from './melody';
import { readSection, writeSection } from './melodyPart';

const messy = [
  '# hand-edited in Drive',
  '{artist: someone}',
  '{T:Messy}',
  '{tempo: fast}',
  '[C]outside',
  '',
  '',
  '{sov: A}',
  '[(C)] [(E)] [(G)]riff',
  '[C7(9,13)]tension [N.C.]',
  '{comment: 2回目は静かに}',
  '',
  '{key: E}',
  '{end_of_chorus}',
  '{eob}',
  '{start_of_part: Drums}',
  '\\instrument percussion',
  '',
  '  :8 HH HH |',
  '{start_of_part: Bass}',
  ':4 C2 |',
  '{end_of_part}',
  '[G]after parts',
  '{start_of_part: Unclosed}',
  'x |',
  '',
].join('\r\n');

const inputs: Record<string, string> = {
  sample: sampleSongText,
  messy,
  empty: '',
  unclosedSection: '{sov: A}\n[C]a',
  unclosedPart: '{start_of_part: P}\n\\section "A"\nC4 |',
  onlyBlank: '\n\n\n',
  unclosedBracket: '[C]a[b\n[',
  emptyDirective: '{}\n{ }\n{:}',
  palette:
    '{title: P}\n{x_palette: C7(9,13)  N.C. (C)}\n{sov: A}\n{x_palette: D}\n[C]a\n{eov}\n{X_PALETTE: E}',
  emptyPalette: '{x_palette:}\n{x_palette: G}',
  partWithTrailingBlank: '{start_of_part: P}\na\n\n{end_of_part}',
};

describe('round trip', () => {
  it('serialize(parse(canonical)) === canonical', () => {
    expect(serializeSong(parseSong(sampleSongText))).toBe(sampleSongText);
  });

  it('parse(serialize(song)) deep-equals the sample model', () => {
    expect(parseSong(serializeSong(sampleSong))).toEqual(sampleSong);
  });

  it('round-trips meta.palette', () => {
    const song = parseSong(inputs.palette);
    expect(song.meta.palette).toEqual(['C7(9,13)', 'N.C.', '(C)']);
    expect(parseSong(serializeSong(song))).toEqual(song);
    expect(serializeSong(song)).toContain('{x_palette: C7(9,13) N.C. (C)}');
  });

  for (const [name, text] of Object.entries(inputs)) {
    it(`is stable for ${name}`, () => {
      const first = parseSong(text);
      const canonical = serializeSong(first);
      expect(parseSong(canonical)).toEqual(first);
      expect(serializeSong(parseSong(canonical))).toBe(canonical);
    });
  }

  it('does not promote a later x_palette RawLine after the user empties the palette (R13 / N6 case a)', () => {
    // The second {x_palette: D} is kept as a RawLine (there's already a
    // consumed x_palette earlier). Once the user empties meta.palette, the
    // first x_palette line disappears from the output — re-parsing must not
    // let the stale second line take its place.
    const original = parseSong('{x_palette: C}\n[Am]a\n\n{x_palette: D}');
    expect(original.meta.palette).toEqual(['C']);

    const emptied = removeFromPalette(original, 'C');
    expect(emptied.meta.palette).toEqual([]);

    const text = serializeSong(emptied);
    const reparsed = parseSong(text);
    expect(reparsed.meta.palette ?? []).toEqual([]);

    // And it's stable from here on.
    expect(serializeSong(reparsed)).toBe(text);
  });

  // N5: the same promote-on-clear bug as R13, generalized from x_palette to
  // every meta field (key/tempo/time/title): a duplicate top-level
  // directive's second occurrence stays an unconsumed RawLine; clearing the
  // field — now via the explicit `clearStaleMetaLines` helper, called by
  // App's song-info handler for exactly the field(s) the user cleared, NOT
  // by serializeSong on its own (m3-review.md F1) — must not let that stale
  // RawLine get promoted into the field on the next parse.
  describe('does not promote a later duplicate meta directive after the field is explicitly cleared (N5)', () => {
    it('key', () => {
      const original = parseSong('{key: C}\n[Am]a\n\n{key: D}');
      expect(original.meta.key).toBe('C');

      const { key: _key, ...metaRest } = original.meta;
      const cleared: Song = {
        ...clearStaleMetaLines(original, ['key']),
        meta: metaRest,
      };
      const text = serializeSong(cleared);
      expect(text).not.toContain('key');
      const reparsed = parseSong(text);
      expect(reparsed.meta.key).toBeUndefined();
      expect(serializeSong(reparsed)).toBe(text);
    });

    it('tempo', () => {
      const original = parseSong('{tempo: 90}\n[Am]a\n\n{tempo: 120}');
      expect(original.meta.tempo).toBe(90);

      const { tempo: _tempo, ...metaRest } = original.meta;
      const cleared: Song = {
        ...clearStaleMetaLines(original, ['tempo']),
        meta: metaRest,
      };
      const text = serializeSong(cleared);
      expect(text).not.toContain('tempo');
      const reparsed = parseSong(text);
      expect(reparsed.meta.tempo).toBeUndefined();
      expect(serializeSong(reparsed)).toBe(text);
    });

    it('time', () => {
      const original = parseSong('{time: 3/4}\n[Am]a\n\n{time: 6/8}');
      expect(original.meta.time).toBe('3/4');

      const { time: _time, ...metaRest } = original.meta;
      const cleared: Song = {
        ...clearStaleMetaLines(original, ['time']),
        meta: metaRest,
      };
      const text = serializeSong(cleared);
      expect(text).not.toContain('time');
      const reparsed = parseSong(text);
      expect(reparsed.meta.time).toBeUndefined();
      expect(serializeSong(reparsed)).toBe(text);
    });

    it('title (cleared to the empty string, its only "unset" state)', () => {
      const original = parseSong('{title: A}\n[Am]a\n\n{title: B}');
      expect(original.meta.title).toBe('A');

      const cleared: Song = {
        ...clearStaleMetaLines(original, ['title']),
        meta: { ...original.meta, title: '' },
      };
      const text = serializeSong(cleared);
      expect(text).not.toContain('title');
      const reparsed = parseSong(text);
      expect(reparsed.meta.title).toBe('');
      expect(serializeSong(reparsed)).toBe(text);
    });
  });

  it('never drops a stale directive value that could never be promoted anyway (N5 guard)', () => {
    // {tempo: fast} fails parseSong's numeric check, so it is NEVER
    // promoted into meta.tempo regardless of whether another valid tempo
    // exists — clearStaleMetaLines must not drop it just because `tempo`
    // is one of the cleared fields, unlike the N5 duplicate-after-clear
    // case where the dropped value really would win the next reparse.
    const song: Song = {
      meta: { title: '' },
      chart: [{ kind: '', label: '', lines: [{ raw: '{tempo: fast}' }] }],
      parts: [],
    };
    expect(serializeSong(clearStaleMetaLines(song, ['tempo']))).toBe(
      '{tempo: fast}\n',
    );
  });

  // F1 (m3-review.md, medium, data loss): serializeSong on its own must
  // NEVER drop a top-level scalar meta directive just because the matching
  // meta field happens to be undefined — such a line can arrive at the top
  // level WITHOUT the user ever clearing anything in 曲情報. Reproduced via
  // applyLyrics (lyrics.ts): merging a section's lyric line into the
  // implicit section (because the section itself has no surviving lyric
  // line of its own) carries the section's non-lyric lines — including a
  // mid-song `{key: D}` / `{tempo: 140}` — along with it into the implicit
  // section, with meta.key / meta.tempo left untouched (still undefined,
  // since no top-level key/tempo directive was ever consumed).
  describe('keeps a top-level meta line that nothing explicitly cleared, after it is relocated by applyLyrics (F1)', () => {
    it('a key change relocated out of a merged verse section survives serialize', () => {
      const song = parseSong(
        'a1\n\n{start_of_verse: B}\n{key: D}\nb1\n{end_of_verse}',
      );
      expect(song.meta.key).toBeUndefined();

      const merged = applyLyrics(song, 'a1\nb1');
      const text = serializeSong(merged);
      expect(text).toContain('{key: D}');

      // The now-genuinely-top-level {key: D} legitimately gets promoted
      // into meta.key on the next parse (normal parseSong behavior, not a
      // bug — F1 only requires the line itself survive); from there on the
      // (now differently-shaped) output is stable.
      const reparsed = parseSong(text);
      expect(reparsed.meta.key).toBe('D');
      const text2 = serializeSong(reparsed);
      expect(serializeSong(parseSong(text2))).toBe(text2);
    });

    it('a tempo change relocated out of a merged chorus section survives serialize', () => {
      const song = parseSong(
        '{title: T}\n\na1\n\n{start_of_chorus}\n{tempo: 140}\nb1\n{end_of_chorus}',
      );
      expect(song.meta.tempo).toBeUndefined();

      const merged = applyLyrics(song, 'a1\nb1');
      const text = serializeSong(merged);
      expect(text).toContain('{tempo: 140}');

      const reparsed = parseSong(text);
      expect(reparsed.meta.tempo).toBe(140);
      const text2 = serializeSong(reparsed);
      expect(serializeSong(parseSong(text2))).toBe(text2);
    });
  });

  it('never drops a top-level directive the user never cleared (N6 case b)', () => {
    // Confirmed repro shape: an {x_palette: Z} that originally lived INSIDE
    // a section (so it was never promoted — meta.palette stays undefined,
    // not []) ends up relocated to the top-level/implicit section by some
    // unrelated transformation (e.g. a lyrics-editing bug). meta.palette
    // being undefined here means "never set", not "explicitly cleared", so
    // serializeSong must not treat it as stale and must not drop it.
    const song: Song = {
      meta: { title: '' },
      chart: [
        {
          kind: '',
          label: '',
          lines: [
            { segments: [{ lyrics: 'foo' }] },
            { raw: '{x_palette: Z}' },
            { segments: [{ lyrics: 'la' }] },
          ],
        },
      ],
      parts: [],
    };
    expect(song.meta.palette).toBeUndefined();

    const text = serializeSong(song);
    expect(text).toBe('foo\n{x_palette: Z}\nla\n');

    // Once it's genuinely at the top level (no longer inside a section),
    // the NEXT parse legitimately promotes it into meta.palette — that's
    // normal parseSong behavior for a real top-level directive, not a bug;
    // N6 only requires that the line itself was never silently deleted.
    // From that point on, the (now differently-shaped) output is stable.
    const reparsed = parseSong(text);
    expect(reparsed.meta.palette).toEqual(['Z']);
    const text2 = serializeSong(reparsed);
    expect(serializeSong(parseSong(text2))).toBe(text2);
  });

  describe('property: serialize(parse(x)) is stable even for an emptied field (R13)', () => {
    const trickyInputs = [
      '{title:}\n{title: Real}',
      '{key:}\n{key: C}',
      '{tempo:}\n{tempo: 100}',
      '{time:}\n{time: 4/4}',
      '{x_palette:}\n{x_palette: G}',
      '{title: A}\n{title:}\n{title: B}',
    ];

    it.each(trickyInputs)(
      'serialize(parse(serialize(parse(x)))) === serialize(parse(x)) for %j',
      (x) => {
        const once = serializeSong(parseSong(x));
        const twice = serializeSong(parseSong(once));
        expect(twice).toBe(once);
      },
    );
  });

  it('loses no comment, unknown directive or chord from messy input', () => {
    const out = serializeSong(parseSong(messy));
    for (const piece of [
      '# hand-edited in Drive',
      '{artist: someone}',
      '{tempo: fast}',
      '[(C)] [(E)] [(G)]riff',
      '[C7(9,13)]tension [N.C.]',
      '{comment: 2回目は静かに}',
      '{key: E}',
      '{eob}',
      '[G]after parts',
      '  :8 HH HH |',
    ]) {
      expect(out).toContain(piece);
    }
  });
});

describe('round trip: melody tuplets (M5)', () => {
  const tupletSong = [
    '{title: T}',
    '{time: 4/4}',
    '{start_of_part: Vocal}',
    '\\section "A"',
    ':8 C4{tu 3 lyrics "き" ch "C" slur "A-1"} D4{tu 3 slur "A-1"} r{tu 3} :4 E4{lyrics "ら" slur "A-2"} :16 F4{tu 5} G4{tu 5 slur "A-2"} r{tu 5} r{tu 5} A4{tu 5} :4 r |',
    ':32 ' + Array(13).fill('B4{tu 13 8}').join(' ') + ' :4 r :2 C5 |',
    '\\section "B"',
    'C4.8{tu 3} D4{tu 3} E4{tu 3} :4 F4 G4 A4 |',
    '{end_of_part}',
    '',
  ].join('\n');
  const ts = melodyTimeSignature('4/4');

  it('is stable through parseSong / serializeSong', () => {
    const first = parseSong(tupletSong);
    const canonical = serializeSong(first);
    expect(parseSong(canonical)).toEqual(first);
    expect(serializeSong(parseSong(canonical))).toBe(canonical);
  });

  it('canonical tuplet sections are editable and rewrite to identical text', () => {
    const body = parseSong(tupletSong).parts[0].body;
    const read = readSection(body, 'A', ts);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.events.filter((e) => e.tuplet)).toHaveLength(3 + 5 + 13);
    expect(writeSection(body, 'A', read.events, ts, ['A', 'B'])).toBe(body);
  });

  it('a hand-written .N{tu} section is normalized once, then stable', () => {
    const body = parseSong(tupletSong).parts[0].body;
    const read = readSection(body, 'B', ts);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    const once = writeSection(body, 'B', read.events, ts, ['A', 'B']);
    expect(once).toContain(':8 C4{tu 3} D4{tu 3} E4{tu 3} :4 F4 G4 A4 |');
    const again = readSection(once, 'B', ts);
    expect(again).toEqual(read);
    expect(writeSection(once, 'B', read.events, ts, ['A', 'B'])).toBe(once);
  });
});
