/**
 * Spike 3 T14: Node CLI for the TS analyzer (the counterpart of `python py/analyze.py`).
 *
 *   npx tsx ts/cli.ts <input.wav | y.f32> [-o out.json] [--config x.json] [--sr HZ]
 *
 * Input: a WAV (PCM 16/24/32-bit, float 32/64; read by ts/browser/wav.ts, mixed to mono like librosa.to_mono,
 * resampled to 22050 Hz with our windowed sinc, plan decision 2), or a raw little-endian float32 mono file
 * `.f32` (e.g. out/parity/<variant>/y.f32 = Python's librosa.load output; `--sr` gives its rate, default 22050,
 * other rates are resampled). `--config`: a JSON of overrides like py --config; anything but the default
 * values is an error (the TS port has the default path only). There is no `--tempo` (beats.tempo_hint is
 * not ported).
 * Output: the result JSON (stdout, or -o FILE); per-stage timings and MemTracker peak go to stderr.
 * Reads local files only; no network.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeWav } from './browser/wav';
import { analyze } from './dsp/analyze';
import { resolveConfig } from './dsp/config';
import { resampleSinc, toMono } from './dsp/core/resample';

const SR = 22050;

interface Args {
  input: string;
  out?: string;
  config?: string;
  sr: number;
}

function usage(msg?: string): never {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write('usage: npx tsx ts/cli.ts <input.wav | y.f32> [-o out.json] [--config x.json] [--sr HZ]\n');
  process.exit(2);
}

export function parseArgs(argv: string[]): Args {
  let input: string | undefined;
  let out: string | undefined;
  let config: string | undefined;
  let sr = SR;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === '-o' || a === '--out') out = val();
    else if (a === '--config') config = val();
    else if (a === '--sr') {
      sr = Number(val());
      if (!Number.isInteger(sr) || sr <= 0) usage('--sr must be a positive integer');
    } else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('-')) usage(`unknown option ${a}`);
    else if (input === undefined) input = a;
    else usage(`unexpected argument ${a}`);
  }
  if (input === undefined) usage('no input file');
  return { input, out, config, sr };
}

/** Raw LE float32 (independent of alignment / host endianness). */
function readF32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4) throw new Error(`.f32 file length ${bytes.byteLength} is not a multiple of 4`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = v.getFloat32(i * 4, true);
  return out;
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const cfg = resolveConfig(args.config ? (JSON.parse(readFileSync(args.config, 'utf8')) as unknown) : {});
  const pre: Record<string, number> = {};
  let t = performance.now();
  const bytes = new Uint8Array(readFileSync(args.input));
  let y: Float32Array;
  let sr: number;
  if (args.input.toLowerCase().endsWith('.f32')) {
    y = readF32(bytes);
    sr = args.sr;
  } else {
    const wav = decodeWav(bytes);
    y = toMono(wav.channels);
    sr = wav.sampleRate;
  }
  pre.read = (performance.now() - t) / 1000;
  if (sr !== SR) {
    t = performance.now();
    y = resampleSinc(y, sr, SR);
    pre.resample = (performance.now() - t) / 1000;
  }
  const { result, stats, mem } = analyze(y, { cfg, preTimings: pre });
  for (const [k, v] of Object.entries(result.analyzer.timingsSec ?? {})) {
    process.stderr.write(`${k.padStart(9)}: ${v.toFixed(2)} s\n`);
  }
  const peak = Math.max(...stats.map((s) => s.memPeak), mem.peak);
  process.stderr.write(`  memPeak: ${(peak / 2 ** 20).toFixed(1)} MB (MemTracker, typed arrays after decode)\n`);
  process.stderr.write(`   maxRSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MB (Node process, whole run)\n`);
  const text = JSON.stringify(result, null, 2);
  if (args.out) writeFileSync(args.out, text + '\n', 'utf8');
  else process.stdout.write(text + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
