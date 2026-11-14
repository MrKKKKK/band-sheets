/**
 * Node-side helpers of the browser perf specs (bassPerf, drumPerf, humPerf, bench): write a 16-bit mono wav, and
 * read the Chromium renderer processes' VmRSS from /proc (Linux, devcontainer). No network.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

export function writeWav16(path: string, x: Float32Array, sr: number): void {
  const data = x.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768))), 44 + i * 2);
  writeFileSync(path, b);
}

/** VmRSS of every Chromium renderer process in MB: the largest one (the page and its Workers) and the sum. */
export function rendererRssMb(): { max: number; sum: number } {
  let max = 0;
  let sum = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')) continue;
      const mm = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (mm) {
        const mb = Number(mm[1]) / 1024;
        max = Math.max(max, mb);
        sum += mb;
      }
    } catch {
      /* gone */
    }
  }
  return { max, sum };
}
