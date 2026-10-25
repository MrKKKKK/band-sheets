import { describe, expect, it } from 'vitest';
import { formatClock, formatDurationJa, formatFileSize } from './format';

describe('formatting', () => {
  it('formats clock times', () => {
    expect(formatClock(222.4)).toBe('3:42');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(-3)).toBe('0:00');
  });
  it('formats durations in Japanese', () => {
    expect(formatDurationJa(222.4)).toBe('3 分 42 秒');
    expect(formatDurationJa(42)).toBe('42 秒');
    expect(formatDurationJa(750)).toBe('12 分 30 秒');
  });
  it('formats file sizes', () => {
    expect(formatFileSize(38_200_000)).toBe('38.2 MB');
    expect(formatFileSize(512_000)).toBe('512 KB');
    expect(formatFileSize(10)).toBe('1 KB');
  });
});
