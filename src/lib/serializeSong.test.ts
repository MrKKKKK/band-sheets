import { describe, expect, it } from 'vitest';
import { sampleSong, sampleSongText } from './fixtures/sampleSong';
import { newSongText, serializeSong } from './serializeSong';
import { parseSong } from './parseSong';
import type { Song } from './song';

const song = (partial: Partial<Song>): Song => ({
  meta: { title: '' },
  chart: [],
  parts: [],
  ...partial,
});

describe('serializeSong', () => {
  it('writes the sample song canonically', () => {
    expect(serializeSong(sampleSong)).toBe(sampleSongText);
  });

  it('writes an empty song as an empty string', () => {
    expect(serializeSong(song({}))).toBe('');
  });

  it('omits missing meta and an empty title', () => {
    expect(serializeSong(song({ meta: { title: '', tempo: 80 } }))).toBe(
      '{tempo: 80}\n',
    );
  });

  it('writes the palette at the end of the meta block', () => {
    expect(
      serializeSong(
        song({
          meta: {
            title: 'X',
            key: 'C',
            tempo: 90,
            time: '4/4',
            palette: ['C7(9,13)', 'Fmaj7'],
          },
        }),
      ),
    ).toBe(
      '{title: X}\n{key: C}\n{tempo: 90}\n{time: 4/4}\n{x_palette: C7(9,13) Fmaj7}\n',
    );
  });

  it('omits an empty palette', () => {
    expect(serializeSong(song({ meta: { title: 'X', palette: [] } }))).toBe(
      '{title: X}\n',
    );
  });

  it('writes sections without a label as bare start directives', () => {
    const text = serializeSong(
      song({
        chart: [{ kind: 'chorus', label: '', lines: [{ segments: [] }] }],
      }),
    );
    expect(text).toBe('{start_of_chorus}\n\n{end_of_chorus}\n');
  });

  it('writes implicit sections and raw lines without a wrapper', () => {
    const text = serializeSong(
      song({
        meta: { title: 'T' },
        chart: [
          {
            kind: '',
            label: '',
            lines: [
              { raw: '# memo' },
              { segments: [{ lyrics: 'ah ' }, { chord: 'C', lyrics: 'la' }] },
            ],
          },
        ],
      }),
    );
    expect(text).toBe('{title: T}\n\n# memo\nah [C]la\n');
  });

  it('writes parts with empty body/name', () => {
    expect(serializeSong(song({ parts: [{ name: '', body: '' }] }))).toBe(
      '{start_of_part}\n{end_of_part}\n',
    );
  });
});

describe('newSongText', () => {
  it('is a song with only the 無題の曲 title', () => {
    expect(newSongText()).toBe('{title: 無題の曲}\n');
    expect(parseSong(newSongText())).toEqual({
      meta: { title: '無題の曲' },
      chart: [],
      parts: [],
    });
  });
});
