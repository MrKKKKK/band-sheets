/**
 * The chords / beats / sections / key run inside the chords Worker: validate at the file's rate (positions in the
 * error message are in the file's own time) -> resample to 22050 Hz (our sinc, as the research branch) -> drop the
 * file-rate signal -> analyze(). `analyzer.timingsSec` is not written (stage times go out as progress messages).
 */
import { analyze, validateInput } from '../../lib/analysis/chords/analyze';
import type { TsAnalysisResult } from '../../lib/analysis/chords/result';
import { MemTracker } from '../../lib/analysis/core/mem';
import { resampleSinc } from '../../lib/analysis/core/resample';
import type { RunMessage } from '../protocol';
import type { PostStage } from './serve';

export const CHORDS_SR = 22050;

export function runChords(
  msg: Extract<RunMessage, { kind: 'chords' }>,
  onStage: PostStage,
): TsAnalysisResult {
  const mem = new MemTracker();
  let samples: Float32Array | null = msg.samples;
  // the message holds the only other reference: drop it so the file-rate signal can be collected after resampling
  (msg as { samples: Float32Array | null }).samples = null;
  const t0 = performance.now();
  validateInput(samples, msg.sampleRate);
  const box: { y: Float32Array | null } = {
    y: resampleSinc(samples, msg.sampleRate, CHORDS_SR, {}, mem),
  };
  samples = null;
  onStage('resample', performance.now() - t0);
  return analyze(box, {
    mem,
    timings: false,
    onStage: (s) => onStage(s.name, s.ms),
  }).result;
}
