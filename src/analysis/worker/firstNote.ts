/**
 * S2's 「歌い始めの場所」 (plan §9 Q7 (a)): the user gives only the bar position of the first sung note (bar +
 * beat → `firstNoteTick`), never a second. The analyzer needs an approximate second for it (`firstNoteSec`), so
 * the hum Worker first analyses with a placeholder and then re-runs ONLY the quantization with the start of the
 * first detected note. The seconds-domain notes (`melody.notes`) do not depend on the start, so this equals an
 * analysis that was given that second. Runs in the Worker (analyzer code).
 */
import { resolveStart } from '../../lib/analysis/hum/analyze';
import { resolveHumConfig } from '../../lib/analysis/hum/config';
import { beatGrid, quantize } from '../../lib/analysis/hum/quantize';
import type {
  GridPhaseMeta,
  HumAnalysisResult,
} from '../../lib/analysis/hum/types';

/** The result quantized with the first detected note at `firstNoteTick`. No notes: returned unchanged. */
export function requantizeAtFirstNote(
  result: HumAnalysisResult,
  firstNoteTick: number,
): HumAnalysisResult {
  const first = result.melody.notes[0];
  if (!first) return result;
  const cfg = resolveHumConfig({}); // what analyzeHum uses without a config
  const { startSec: _given, ...rest } = result.hum.meta.info;
  const info = { ...rest, firstNoteSec: first.start, firstNoteTick };
  const st = resolveStart(info);
  const quantized = quantize(
    result.melody.notes,
    {
      bpm: info.bpm,
      ts: info.ts,
      startSec: st.startSec,
      firstNoteSec: st.firstNoteSec,
      firstNoteTick: st.firstNoteTick,
    },
    cfg.grid,
  );
  const stepSec =
    (64 / cfg.grid.subdivision) *
    beatGrid({ bpm: info.bpm, ts: info.ts, startSec: 0 }).tickSec;
  const grid: GridPhaseMeta = {
    startMode: st.startMode,
    givenStartSec: st.startSec,
    startSec: quantized.startSec,
    phaseOffsetSec: quantized.phaseOffsetSec ?? 0,
    phaseSteps: Math.round((quantized.phaseOffsetSec ?? 0) / stepSec),
    onsetBiasSec: quantized.onsetBiasSec,
    barPositionKnown: true,
  };
  return {
    ...result,
    melody: { ...result.melody, quantized },
    hum: { ...result.hum, meta: { ...result.hum.meta, info, grid } },
  };
}
