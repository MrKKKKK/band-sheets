/**
 * The latency measurement's plan and verdict (docs/mic-recording-plan.md §2.6), pure: when the clicks sound, which
 * frames to capture, and what the captured samples say. useMicRecorder only schedules, waits and reports.
 */
import {
  detectClicks,
  judgeLatency,
  MEASURE_CLICKS,
  type LatencyVerdict,
  type ReportedLatency,
} from './latency';

/** The first click is this far after 遅れを測る, then one click every MEASURE_GAP_SEC. */
export const MEASURE_LEAD_SEC = 0.3;
export const MEASURE_GAP_SEC = 0.5;
/** The capture starts this long before the first click … */
const CAPTURE_PRE_SEC = 0.1;
/** … and ends this long after the last one. */
const CAPTURE_POST_SEC = 0.45;

export interface MeasurementPlan {
  sampleRate: number;
  /** AudioContext time of the first click */
  first: number;
  /** the clicks on the context clock (all weak) */
  clicks: { time: number; strong: boolean }[];
  /** the capture range on the context's frame axis */
  fromFrame: number;
  endFrame: number;
  /** the capture's end on the context clock (s) */
  endSec: number;
}

/** `now` = the context clock (s) when 遅れを測る was pressed. */
export function measurementPlan(
  now: number,
  sampleRate: number,
): MeasurementPlan {
  const first = now + MEASURE_LEAD_SEC;
  const clicks = Array.from({ length: MEASURE_CLICKS }, (_, i) => ({
    time: first + i * MEASURE_GAP_SEC,
    strong: false,
  }));
  const endSec = clicks[clicks.length - 1].time + CAPTURE_POST_SEC;
  return {
    sampleRate,
    first,
    clicks,
    fromFrame: Math.round((first - CAPTURE_PRE_SEC) * sampleRate),
    endFrame: Math.round(endSec * sampleRate),
    endSec,
  };
}

/** `samples` = the plan's capture range (`fromFrame` … `endFrame`). */
export function evaluateMeasurement(
  samples: Float32Array,
  plan: MeasurementPlan,
  reported: ReportedLatency,
): LatencyVerdict {
  const { sampleRate: rate, fromFrame, clicks } = plan;
  return judgeLatency(
    detectClicks(
      samples,
      rate,
      clicks.map((c) => c.time * rate - fromFrame),
    ),
    reported,
  );
}
