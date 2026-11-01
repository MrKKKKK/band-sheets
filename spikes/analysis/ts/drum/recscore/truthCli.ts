/**
 * Spike 5 T4: writes recordings/drum-scores/<x>.ticks.json (tick truth) for every <x>.song.txt found.
 *   npx tsx ts/drum/recscore/truthCli.ts [scores-dir]      (default: recordings/drum-scores, from spikes/analysis)
 * Local files only; prints take names, never score content.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TAKE_ROLE, type TakeLetter } from './builder';
import { tickTruth } from './truth';

export function writeAll(dir: string): string[] {
  const done: string[] = [];
  for (const letter of Object.keys(TAKE_ROLE) as TakeLetter[]) {
    const src = join(dir, `${letter}.song.txt`);
    if (!existsSync(src)) continue;
    writeFileSync(join(dir, `${letter}.ticks.json`), JSON.stringify(tickTruth(readFileSync(src, 'utf8'), letter)));
    done.push(TAKE_ROLE[letter].name);
  }
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.argv[2] ?? 'recordings/drum-scores';
  const done = writeAll(dir);
  process.stdout.write(`ticks.json written: ${done.join(' ') || '(none)'}\n`);
}
