// Spike 5 T2: rooms and the phone-like mic of the synthetic drums. All linear, causal and deterministic, and the dry
// path is kept, so a hit's first arrival (its truth onset) is not moved:
//   - tuning / dev rooms of kit A: render/hum/degrade.ts addReverb (Schroeder: 4 combs + 2 allpasses);
//   - the HELD-OUT room (kit C; plan section 4: never used for tuning / dev): fdnRoom, a different structure
//     (8-line feedback delay network with a Hadamard mix, per-line one-pole damping and a sparse early-reflection
//     tap pattern), so an analyzer tuned on the Schroeder room meets an unseen reverb;
//   - phoneMic: one distant mic, band-limited (2nd-order high-pass 200 Hz, low-pass 6 kHz, RBJ biquads).

export { addReverb } from '../hum/degrade';

const FDN_MS = [31.3, 37.9, 41.9, 47.3, 53.1, 59.9, 67.7, 73.3];
const EARLY: [number, number][] = [
  [7.1, 0.42],
  [11.3, -0.33],
  [16.9, 0.28],
  [23.7, -0.21],
];
/** Damping one-pole coefficient (higher = darker tail). */
const DAMP = 0.35;

/** Held-out room: output = (1 - wet) * dry + wet * (early reflections + FDN tail), in place. */
export function fdnRoom(x: Float64Array, rt60: number, sr: number, wet: number): void {
  const n = x.length;
  const L = FDN_MS.length;
  const d = FDN_MS.map((ms) => Math.round((ms / 1000) * sr));
  const g = d.map((di) => 10 ** ((-3 * di) / sr / rt60));
  const bufs = d.map((di) => new Float64Array(di));
  const lp = new Float64Array(L);
  const idx = new Int32Array(L);
  const outs = new Float64Array(L);
  const m = new Float64Array(L);
  const rev = new Float64Array(n);
  const h = 1 / Math.sqrt(L);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < L; k++) outs[k] = bufs[k][idx[k]];
    let y = 0;
    for (let k = 0; k < L; k++) y += outs[k];
    rev[i] = y / L;
    // Hadamard 8x8 (fast Walsh-Hadamard in place on a copy)
    m.set(outs);
    for (let len = 1; len < L; len <<= 1)
      for (let a = 0; a < L; a += len << 1)
        for (let b = a; b < a + len; b++) {
          const u = m[b];
          const v = m[b + len];
          m[b] = u + v;
          m[b + len] = u - v;
        }
    for (let k = 0; k < L; k++) {
      lp[k] = (1 - DAMP) * m[k] * h * g[k] + DAMP * lp[k];
      bufs[k][idx[k]] = x[i] + lp[k];
      idx[k] = (idx[k] + 1) % d[k];
    }
  }
  const early = EARLY.map(([ms, a]) => [Math.round((ms / 1000) * sr), a] as const);
  for (let i = n - 1; i >= 0; i--) {
    let e = 0;
    for (const [dd, a] of early) if (i >= dd) e += a * x[i - dd];
    x[i] = (1 - wet) * x[i] + wet * (e + rev[i]);
  }
}

function biquad(x: Float64Array, b0: number, b1: number, b2: number, a1: number, a2: number): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

/** RBJ cookbook 2nd-order filter (Q = 1/sqrt 2), in place. */
export function rbj(x: Float64Array, type: 'lp' | 'hp', f0: number, sr: number): void {
  const w = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  const b = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  biquad(x, b[0] / a0, b[1] / a0, b[2] / a0, (-2 * c) / a0, (1 - alpha) / a0);
}

export const PHONE_HP_HZ = 200;
export const PHONE_LP_HZ = 6000;

export function phoneMic(x: Float64Array, sr: number): void {
  rbj(x, 'hp', PHONE_HP_HZ, sr);
  rbj(x, 'lp', PHONE_LP_HZ, sr);
}
