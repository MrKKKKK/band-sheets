/**
 * Synthetic test audio for the analysis e2e tests: ONLY the golden fixtures in src/lib/analysis/fixtures/ (rendered
 * from band-sheets songs, see golden.test.ts), looped / resampled. Never user recordings.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { floatToInt16 } from '../../src/lib/mic/takeBuffer';
import { encodeWav16 } from '../../src/lib/mic/wav';

export const FIXTURES = join(
  import.meta.dirname,
  '../../src/lib/analysis/fixtures',
);
/** Generated files go under test-results/ (gitignored). */
export const GEN_DIR = join(
  import.meta.dirname,
  '../../test-results/analysis-audio',
);

/** 44-byte header, 16-bit LE mono PCM (what the fixtures are). */
export function readFixtureWav(name: string): { y: Float32Array; sr: number } {
  const b = readFileSync(join(FIXTURES, name));
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = (b.byteLength - 44) / 2;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = v.getInt16(44 + i * 2, true) / 32768;
  return { y, sr: v.getUint32(24, true) };
}

export function readFixtureJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

/**
 * Writes `x` as a 16-bit PCM wav with the app's own encoder (src/lib/mic/wav.ts, mono). With `channels` > 1 every
 * channel gets `x`: the samples are interleaved and the header's channel fields are patched (the encoder is mono-only).
 */
export async function writeWav16(
  name: string,
  x: Float32Array,
  sr: number,
  channels = 1,
): Promise<string> {
  mkdirSync(GEN_DIR, { recursive: true });
  const mono = floatToInt16(x);
  const pcm = new Int16Array(mono.length * channels);
  for (let i = 0; i < mono.length; i++)
    for (let c = 0; c < channels; c++) pcm[i * channels + c] = mono[i];
  const b = Buffer.from(await encodeWav16([pcm], sr).arrayBuffer());
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sr * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32);
  const path = join(GEN_DIR, name);
  writeFileSync(path, b);
  return path;
}

/** `y` looped to `sec` seconds and linearly resampled from `sr` to `outSr` (test input only, not for accuracy). */
export function loopTo(
  y: Float32Array,
  sr: number,
  sec: number,
  outSr = sr,
): Float32Array {
  const n = Math.round(sec * outSr);
  const out = new Float32Array(n);
  const step = sr / outSr;
  for (let i = 0; i < n; i++) {
    const t = (i * step) % y.length;
    const k = Math.floor(t);
    const f = t - k;
    out[i] = y[k] * (1 - f) + y[(k + 1) % y.length] * f;
  }
  return out;
}

/** Collects every request the page makes that does not go to `origin` (data: / blob: are local). */
export function offOriginRequests(
  page: { on(e: 'request', f: (r: { url(): string }) => void): void },
  origin: string,
): string[] {
  const out: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    if (new URL(u).origin !== origin) out.push(u);
  });
  return out;
}

/** Strings, booleans, lengths and keys equal; numbers within `tol`. Returns the differences (empty = equal). */
export function diffJson(
  actual: unknown,
  expected: unknown,
  tol = 1e-6,
  path = '$',
  out: string[] = [],
): string[] {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !(Math.abs(actual - expected) <= tol))
      out.push(`${path}: ${String(actual)} vs ${expected}`);
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      out.push(`${path}: length mismatch`);
    else
      expected.forEach((e, i) =>
        diffJson(actual[i], e, tol, `${path}[${i}]`, out),
      );
  } else if (expected !== null && typeof expected === 'object') {
    if (
      actual === null ||
      typeof actual !== 'object' ||
      Array.isArray(actual)
    ) {
      out.push(`${path}: not an object`);
    } else {
      const a = actual as Record<string, unknown>;
      const e = expected as Record<string, unknown>;
      const ka = Object.keys(a).sort().join();
      const ke = Object.keys(e).sort().join();
      if (ka !== ke) out.push(`${path}: keys ${ka} vs ${ke}`);
      else
        for (const k of Object.keys(e))
          diffJson(a[k], e[k], tol, `${path}.${k}`, out);
    }
  } else if (actual !== expected) {
    out.push(
      `${path}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
    );
  }
  return out;
}
