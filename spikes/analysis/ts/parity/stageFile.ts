/**
 * Reader for the intermediate-value files that py/tools/dump_stages.py (T1) writes
 * under out/parity/<variant>/.
 *
 * FORMAT (T1 must write exactly this):
 *   - `<stage>.f32`: raw little-endian float32, row-major (C order), no header.
 *     Byte length must be 4 * product(shape). Integers (frame indexes etc.) are
 *     stored as float32 too (exact below 2^24). Scalars have shape [].
 *   - `meta.json` (one per variant directory):
 *       {
 *         "commit": "f087ca3",            // git short hash of the Python analyzer
 *         "configHash": "adec583eb3c6",   // hash of the default config
 *         "stages": {
 *           "<stage>": { "file": "<stage>.f32", "dtype": "float32", "shape": [rows, cols] }
 *         }
 *       }
 *     `file` defaults to `<stage>.f32` when omitted. `dtype` must be "float32" when present.
 *     Extra keys (e.g. "sr", "hop", "note") are kept in `info` and ignored by the reader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StageMeta {
  file?: string;
  dtype?: string;
  shape: number[];
  [key: string]: unknown;
}

export interface ParityMeta {
  commit?: string;
  configHash?: string;
  stages: Record<string, StageMeta>;
  [key: string]: unknown;
}

export interface Stage {
  data: Float32Array;
  shape: number[];
  info: StageMeta;
}

export function shapeSize(shape: readonly number[]): number {
  return shape.reduce((p, n) => p * n, 1);
}

/** Decode raw LE float32 bytes (independent of host endianness and buffer alignment). */
export function decodeF32(bytes: Uint8Array, shape: readonly number[]): Float32Array {
  const expected = shapeSize(shape) * 4;
  if (bytes.byteLength !== expected) {
    throw new Error(
      `f32 size mismatch: ${bytes.byteLength} bytes, shape [${shape.join(',')}] needs ${expected}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(shapeSize(shape));
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Encode to raw LE float32 (for tests / hand-made fixtures). */
export function encodeF32(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
  return out;
}

export function readF32(path: string, shape: readonly number[]): Float32Array {
  return decodeF32(readFileSync(path), shape);
}

export function parseMeta(json: string): ParityMeta {
  const m = JSON.parse(json) as ParityMeta;
  if (typeof m !== 'object' || m === null || typeof m.stages !== 'object' || m.stages === null) {
    throw new Error('meta.json: missing "stages"');
  }
  for (const [name, s] of Object.entries(m.stages)) {
    if (!Array.isArray(s.shape) || s.shape.some((n) => !Number.isInteger(n) || n < 0)) {
      throw new Error(`meta.json: stage "${name}" has an invalid shape`);
    }
    if (s.dtype !== undefined && s.dtype !== 'float32') {
      throw new Error(`meta.json: stage "${name}" dtype must be float32, got ${String(s.dtype)}`);
    }
  }
  return m;
}

export function readMeta(dir: string): ParityMeta {
  return parseMeta(readFileSync(join(dir, 'meta.json'), 'utf8'));
}

export function readStage(dir: string, stage: string, meta: ParityMeta = readMeta(dir)): Stage {
  const info = meta.stages[stage];
  if (!info) throw new Error(`stage "${stage}" not in ${dir}/meta.json`);
  const data = readF32(join(dir, info.file ?? `${stage}.f32`), info.shape);
  return { data, shape: info.shape, info };
}
