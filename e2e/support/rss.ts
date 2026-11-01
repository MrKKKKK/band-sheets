import { readFileSync, readdirSync } from 'node:fs';

/** The largest VmRSS (MB) among the Chromium renderer processes, from /proc (Linux only). */
export function rendererRssMb(): number {
  let max = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (
        !readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(
          '--type=renderer',
        )
      )
        continue;
      const m = /VmRSS:\s+(\d+) kB/.exec(
        readFileSync(`/proc/${pid}/status`, 'utf8'),
      );
      if (m) max = Math.max(max, Number(m[1]) / 1024);
    } catch {
      /* process gone */
    }
  }
  return max;
}
