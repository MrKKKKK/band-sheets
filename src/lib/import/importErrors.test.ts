import { describe, expect, it } from 'vitest';
import type { AnalysisErrorCode } from '../../analysis/types';
import { IMPORT_ERROR_MESSAGES, importErrorInfo } from './importErrors';

const CODES: AnalysisErrorCode[] = [
  'decode-failed',
  'too-long',
  'empty',
  'too-short',
  'non-finite',
  'silent',
  'no-beats',
  'invalid-info',
  'out-of-memory',
  'worker-crashed',
  'unsupported',
  'cancelled',
  'internal',
];

describe('importErrors', () => {
  it('has a short Japanese message for every code and nothing else', () => {
    expect(Object.keys(IMPORT_ERROR_MESSAGES).sort()).toEqual(
      [...CODES].sort(),
    );
    for (const code of CODES) {
      const m = IMPORT_ERROR_MESSAGES[code];
      expect(m).toMatch(/[぀-ヿ]/);
      expect(m.endsWith('。')).toBe(true);
      expect(m.length).toBeLessThanOrEqual(80);
    }
  });
  it('treats only cancelled as a notice', () => {
    for (const code of CODES)
      expect(importErrorInfo(code).severity).toBe(
        code === 'cancelled' ? 'notice' : 'error',
      );
    expect(importErrorInfo('cancelled').message).toBe('中止しました。');
  });
});
