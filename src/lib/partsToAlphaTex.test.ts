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
