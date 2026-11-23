/**
 * Self-made test chords for the live tool's timing (timing.ts) and tests (core.test.ts): piano-ish notes, deterministic,
 * no recording and no tuning material. Moved here from LT0's timing.ts unchanged.
 */

/** A piano-ish note: 8 partials (1/h), partial h decays faster, 5 ms attack. Deterministic. */
export function addNote(y: Float32Array, sr: number, hz: number, amp: number): void {
  for (let h = 1; h <= 8; h++) {
    const f = hz * h * Math.sqrt(1 + 0.0004 * h * h); // slight inharmonicity
    if (f > sr / 2 - 100) break;
    const a = amp / h;
    const k = 0.4 + 0.15 * h;
    for (let i = 0; i < y.length; i++) {
      const t = i / sr;
      y[i] += a * Math.min(1, t / 0.005) * Math.exp(-k * t) * Math.sin(2 * Math.PI * f * t);
    }
  }
}

export const midiHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/** The notes `midis` (equal amplitude) for `seconds`, scaled to RMS `rmsDb` dBFS (-22: the spike's level). */
export function chordSignal(midis: readonly number[], sr: number, seconds: number, rmsDb = -22): Float32Array {
  const y = new Float32Array(Math.round(sr * seconds));
  for (const m of midis) addNote(y, sr, midiHz(m), 1.0);
  let e = 0;
  for (const v of y) e += v * v;
  const g = 10 ** (rmsDb / 20) / Math.sqrt(e / y.length);
  for (let i = 0; i < y.length; i++) y[i] *= g;
  return y;
}

/** C major triad (C4 E4 G4) + bass C2, LT0's signal. */
export const C_CHORD = [36, 60, 64, 67];
