/**
 * Fallback test signal when the bundled dev synthetic clip is not served (e.g. a single-file build):
 * 60 s at 44.1 kHz, 120 BPM, C - G - Am - F one bar each (triads with a few harmonics + a bass note)
 * and a short noise burst on every beat. Deterministic. Not musically meaningful; for timing only.
 */
export function synthClip(sr = 44100, seconds = 60): Float32Array {
  const n = sr * seconds;
  const x = new Float32Array(n);
  const beat = 0.5;
  const prog = [
    [60, 64, 67, 36],
    [55, 59, 62, 43],
    [57, 60, 64, 45],
    [53, 57, 60, 41],
  ];
  const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const bar = Math.floor(t / (4 * beat)) % prog.length;
    const inBeat = t % beat;
    let s = 0;
    for (const m of prog[bar]) {
      const f = hz(m);
      for (let h = 1; h <= 3; h++) s += (0.06 / h) * Math.sin(2 * Math.PI * f * h * t);
    }
    s *= 0.6 + 0.4 * Math.exp(-inBeat * 4);
    s += 0.3 * rnd() * Math.exp(-inBeat * 60);
    x[i] = s;
  }
  return x;
}
