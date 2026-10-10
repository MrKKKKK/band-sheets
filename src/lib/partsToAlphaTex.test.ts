import { importer, Settings } from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { sampleSong } from './fixtures/sampleSong';
import { DRUM_ARTICULATIONS, partsToAlphaTex } from './partsToAlphaTex';
import type { Song } from './song';

const song = (partial: Partial<Song>): Song => ({
  meta: { title: '' },
  chart: [],
  parts: [],
  ...partial,
});

describe('partsToAlphaTex', () => {
  it('builds a document for all parts of the sample', () => {
    const tex = partsToAlphaTex(sampleSong);
    expect(tex).toBe(
      [
        '\\title "きらきら星"',
        '\\tempo 100',
        '.',
        '\\track "Vocal"',
        '\\staff {score}',
        '\\ts 4 4',
        '\\ks c',
        sampleSong.parts[0].body,
        '',
        '\\track "Drums"',
        '\\instrument percussion',
        '\\articulation HH 42',
        '\\articulation SD 38',
        '\\articulation BD 36',
        '\\articulation CR 49',
        '\\articulation RD 51',
        '\\articulation HO 46',
        '\\articulation T1 50',
        '\\articulation T2 48',
        '\\articulation FT 41',
        '\\clef neutral',
        '\\ts 4 4',
        sampleSong.parts[1].body.split('\n').slice(1).join('\n'),
      ].join('\n') + '\n',
    );
  });

  it('exports the default articulations', () => {
    expect(DRUM_ARTICULATIONS).toEqual([
      ['HH', 42],
      ['SD', 38],
      ['BD', 36],
      ['CR', 49],
      ['RD', 51],
      ['HO', 46],
      ['T1', 50],
      ['T2', 48],
      ['FT', 41],
    ]);
  });

  it('selects parts by name, keeping song order', () => {
    const tex = partsToAlphaTex(sampleSong, ['Drums']);
    expect(tex).toContain('\\track "Drums"');
    expect(tex).not.toContain('\\track "Vocal"');
  });

  it('does not override aliases, clef, staff or ts the body defines', () => {
    const tex = partsToAlphaTex(
      song({
        meta: { title: '', time: '4/4' },
        parts: [
          {
            name: 'D',
            body: '\\instrument percussion\n\\articulation HH 44\n\\clef neutral\n\\ts 3 4\nHH |',
          },
          { name: 'M', body: '\\staff {score tabs}\nC4 |' },
        ],
      }),
    );
    expect(tex.match(/\\articulation HH/g)).toHaveLength(1);
    expect(tex).toContain('\\articulation HH 44');
    expect(tex).toContain('\\articulation SD 38');
    expect(tex.match(/\\clef/g)).toHaveLength(1);
    expect(tex.match(/\\ts/g)).toHaveLength(2); // body's 3/4 + M's 4/4
    expect(tex.match(/\\staff/g)).toHaveLength(1);
  });

  it('skips missing meta and invalid time signatures', () => {
    const tex = partsToAlphaTex(
      song({
        meta: { title: '', time: '4/' },
        parts: [{ name: 'M', body: 'C4' }],
      }),
    );
    expect(tex).toBe('.\n\\track "M"\n\\staff {score}\nC4\n');
  });

  it('accepts time signatures with spaces', () => {
    const tex = partsToAlphaTex(
      song({
        meta: { title: '', time: ' 6 / 8 ' },
        parts: [{ name: 'M', body: '' }],
      }),
    );
    expect(tex).toContain('\\ts 6 8');
  });

  it('strips double quotes from names and title', () => {
    const tex = partsToAlphaTex(
      song({ meta: { title: 'a"b' }, parts: [{ name: 'x"y', body: '' }] }),
    );
    expect(tex).toContain('\\title "ab"');
    expect(tex).toContain('\\track "xy"');
  });
});

describe('partsToAlphaTex: quoting (M10)', () => {
  it('strips \\ and " from track names and the title', () => {
    const tex = partsToAlphaTex(
      song({
        meta: { title: 'a\\"b' },
        parts: [{ name: 'Vo\\"x', body: '' }],
      }),
    );
    expect(tex).toContain('\\title "ab"');
    expect(tex).toContain('\\track "Vox"');
  });
});

describe('partsToAlphaTex key signature', () => {
  const withKey = (key: string | undefined, body = ':4 C4 D4 F4 F#4 |') =>
    song({
      meta: { title: '', key },
      parts: [
        { name: 'Vocal', body },
        { name: 'Drums', body: '\\instrument percussion\nHH.8 |' },
      ],
    });
  const ksOf = (tex: string) => {
    const imp = new importer.AlphaTexImporter();
    imp.logErrors = false;
    imp.initFromString(tex, new Settings());
    const score = imp.readScore();
    return score.tracks.map((t) => t.staves[0].bars[0].keySignature);
  };

  it('adds \\ks to melody parts only', () => {
    const tex = partsToAlphaTex(withKey('G'));
    const [melody, drums] = tex.split('\\track "Drums"');
    expect(melody).toContain('\\ks g');
    expect(drums).not.toContain('\\ks');
    expect(ksOf(tex)[0]).toBe(1);
  });

  it.each([
    ['D', 2, 0],
    ['Am', 0, 1],
    ['F#m', 3, 1],
    ['Bb', -2, 0],
    ['Eb', -3, 0],
    ['Ebm', -6, 1],
  ])('key %s -> keySignature %i (minor=%i)', (key, sig, minor) => {
    const imp = new importer.AlphaTexImporter();
    imp.logErrors = false;
    imp.initFromString(partsToAlphaTex(withKey(key)), new Settings());
    const bar = imp.readScore().tracks[0].staves[0].bars[0];
    expect(bar.keySignature).toBe(sig);
    expect(bar.keySignatureType).toBe(minor);
  });

  it("lets the part's own \\ks win", () => {
    const tex = partsToAlphaTex(withKey('G', '\\ks D\n:4 C4 |'));
    expect(tex.match(/\\ks/g)).toHaveLength(1);
    expect(ksOf(tex)[0]).toBe(2);
  });

  it.each([undefined, '', 'H', 'G#', 'g'])('no \\ks for key %j', (key) => {
    expect(partsToAlphaTex(withKey(key))).not.toContain('\\ks');
  });

  it('does not change note pitches', () => {
    const pitches = (tex: string) => {
      const imp = new importer.AlphaTexImporter();
      imp.logErrors = false;
      imp.initFromString(tex, new Settings());
      return imp
        .readScore()
        .tracks[0].staves[0].bars[0].voices[0].beats.map(
          (b) => b.notes[0].realValue,
        );
    };
    expect(pitches(partsToAlphaTex(withKey('D')))).toEqual(
      pitches(partsToAlphaTex(withKey(undefined))),
    );
  });
});
