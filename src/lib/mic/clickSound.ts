/**
 * The click's waveform (docs/mic-recording-plan.md §2.4); when the clicks sound is clickTrack.ts.
 */

const SOFT_HZ = 1000;
const SOFT_STRONG_HZ = 1500;
const SOFT_ATTACK_SEC = 0.0015;
const SOFT_DECAY_TAU_SEC = 0.015; // e^-(0.06/0.015) ~ 1.8% at the end
const SOFT_TOTAL_SEC = 0.06;

/**
 * The click of the count-in, the recording and the latency measurement: a sine (1 kHz, the downbeat
 * 1.5 kHz) with a 1.5 ms linear attack and an exponential decay, 60 ms long, peak 0.5. Gentle to the
 * ears; `detectClicks` finds its onset ~0.7 ms after the true start (latency.ts).
 */
export function softClickSamples(
  sampleRate: number,
  strong = false,
  amplitude = 0.5,
): Float32Array<ArrayBuffer> {
  const n = Math.max(8, Math.round(sampleRate * SOFT_TOTAL_SEC));
  const attack = Math.max(1, Math.round(sampleRate * SOFT_ATTACK_SEC));
  const hz = strong ? SOFT_STRONG_HZ : SOFT_HZ;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env =
      i < attack
        ? (i + 1) / attack
        : Math.exp(-(i - attack) / (sampleRate * SOFT_DECAY_TAU_SEC));
    // sin(0) = 0 would make the first sample silent; the attack ramp already starts near 0
    out[i] = amplitude * env * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}
