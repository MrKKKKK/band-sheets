/**
 * The humming run inside the hum Worker: analyzeHum() does validate -> resample -> f0 -> level -> notes -> quantize
 * itself. The user's info is checked first: a bad bpm / time signature / start is `invalid-info` (with the
 * analyzer's Japanese message, which never contains the values themselves). `firstNoteAuto`: see firstNote.ts.
 */
import { analyzeHum, validateHumInfo } from '../../lib/analysis/hum/analyze';
import type { HumAnalysisResult } from '../../lib/analysis/hum/types';
import type { RunMessage } from '../protocol';
import { requantizeAtFirstNote } from './firstNote';
import { RunnerError, type PostStage } from './serve';

export function runHum(
  msg: Extract<RunMessage, { kind: 'hum' }>,
  onStage: PostStage,
): HumAnalysisResult {
  try {
    validateHumInfo(msg.info);
  } catch (e) {
    throw new RunnerError(
      'invalid-info',
      e instanceof Error ? e.message : undefined,
    );
  }
  // analyzeHum drops its own reference after resampling; take the samples out of the message (no local variable)
  // so nothing else keeps the file-rate signal alive while f0 / notes run
  const result = analyzeHum(takeSamples(msg), msg.sampleRate, msg.info, {
    f0Track: msg.f0Track,
    onStage,
  });
  return msg.firstNoteAuto
    ? requantizeAtFirstNote(result, msg.info.firstNoteTick ?? 0)
    : result;
}

function takeSamples(msg: { samples: Float32Array | null }): Float32Array {
  const s = msg.samples as Float32Array;
  msg.samples = null;
  return s;
}
