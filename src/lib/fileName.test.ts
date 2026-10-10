import { describe, expect, it } from 'vitest';
import {
  SONG_FILE_EXT,
  copyTitle,
  fileNameForTitle,
  localCopyTitle,
} from './fileName';

describe('fileNameForTitle', () => {
  it('uses the .bandsheet extension', () => {
    expect(SONG_FILE_EXT).toBe('.bandsheet');
    expect(fileNameForTitle('Song')).toBe('Song.bandsheet');
  });
  it('trims and collapses whitespace', () => {
    expect(fileNameForTitle('  A   B　C ')).toBe('A B C.bandsheet');
    expect(fileNameForTitle('a\tb\nc')).toBe('a b c.bandsheet');
  });
  it('replaces forbidden characters with _', () => {
    expect(fileNameForTitle('a/b\\c:d*e?f"g<h>i|j')).toBe(
      'a_b_c_d_e_f_g_h_i_j.bandsheet',
    );
  });
  it('replaces control characters with _', () => {
    expect(fileNameForTitle('a\u0000b\u001fc\u007fd')).toBe(
      'a_b_c_d.bandsheet',
    );
  });
  it('falls back for empty titles', () => {
    expect(fileNameForTitle('')).toBe('無題の曲.bandsheet');
    expect(fileNameForTitle('  \t ')).toBe('無題の曲.bandsheet');
  });
  it('keeps names of exactly 80 characters, cuts longer ones', () => {
    expect(fileNameForTitle('a'.repeat(80))).toBe(
      'a'.repeat(80) + '.bandsheet',
    );
    expect(fileNameForTitle('a'.repeat(81))).toBe(
      'a'.repeat(80) + '.bandsheet',
    );
  });
  it('does not split surrogate pairs', () => {
    const name = fileNameForTitle('😀'.repeat(100));
    expect(name).toBe('😀'.repeat(80) + '.bandsheet');
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  it('trims a trailing space left by the cut', () => {
    expect(fileNameForTitle('a'.repeat(79) + ' b')).toBe(
      'a'.repeat(79) + '.bandsheet',
    );
  });
});

describe('copyTitle / localCopyTitle', () => {
  it('copyTitle', () => {
    expect(copyTitle('Song')).toBe('Song のコピー');
  });
  it('localCopyTitle formats local time without zero-padding month/day', () => {
    expect(localCopyTitle('Song', new Date(2026, 9, 6, 15, 12))).toBe(
      'Song（手元の版 10/6 15:12）',
    );
    expect(localCopyTitle('S', new Date(2026, 0, 12, 3, 4))).toBe(
      'S（手元の版 1/12 03:04）',
    );
  });
});
