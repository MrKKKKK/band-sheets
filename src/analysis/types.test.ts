import { describe, expect, it } from 'vitest';
import { STAGES } from '../lib/analysis/chords/analyze';
import { HUM_STAGES } from '../lib/analysis/hum/analyze';
import { ANALYSIS_STAGES, AnalysisError, isAnalysisError } from './types';

describe('ANALYSIS_STAGES', () => {
  it('chords = decode, resample, then the analyzer stages in order', () => {
    expect(ANALYSIS_STAGES.chords).toEqual(['decode', 'resample', ...STAGES]);
  });

  it('hum = decode, then the hum analyzer stages in order', () => {
    expect(ANALYSIS_STAGES.hum).toEqual(['decode', ...HUM_STAGES]);
  });
});

describe('AnalysisError', () => {
  it('keeps the code and the optional Japanese message', () => {
    const e = new AnalysisError('silent', '音声が無音です');
    expect(isAnalysisError(e)).toBe(true);
    expect(e.code).toBe('silent');
    expect(e.userMessage).toBe('音声が無音です');
    expect(new AnalysisError('cancelled').userMessage).toBeUndefined();
    expect(isAnalysisError(new Error('x'))).toBe(false);
  });
});
