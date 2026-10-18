/**
 * Spike 4 T15 (review S10): the guard decisions of the held-out driver (ts/hum/heldout_eval.ts) as a pure function.
 * Returns the reason to refuse, or null when the run may go ahead. No I/O here.
 *
 *   final-heldout  look point 3: frozen config, clean tree, and no hum look-3 line yet in the log.
 *   rescore-m1     the one-time synthetic re-score under the M1 definition: frozen config, clean tree, the hum look-3
 *                  line must already exist, and no hum rescore-m1 line may exist yet.
 */
export type HeldOutRun = 'final-heldout' | 'rescore-m1';
export const RESCORE_KIND = 'rescore-m1';

export interface HeldOutGuardInput {
  run: HeldOutRun;
  configHash: string;
  frozenHash: string;
  /** Contents of out/results/heldout-log.jsonl, null when the file does not exist. */
  logText: string | null;
  /** `git status --porcelain`, null when git failed. */
  porcelain: string | null;
}

interface LogLine {
  kind?: string;
  input?: string;
  lookPoint?: number;
}
const parse = (text: string | null): LogLine[] =>
  (text ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogLine);

export const hasHumLook3 = (lines: LogLine[]) => lines.some((d) => d.input === 'hum' && d.lookPoint === 3 && d.kind === 'look');
export const hasHumRescore = (lines: LogLine[]) => lines.some((d) => d.input === 'hum' && d.kind === RESCORE_KIND);

export function heldOutRunBlock(g: HeldOutGuardInput): string | null {
  if (g.configHash !== g.frozenHash) return `not the frozen hum-v3 config: ${g.configHash}`;
  if (g.porcelain === null || g.porcelain !== '') return 'working tree must be clean (and git must work) for a held-out run';
  const lines = parse(g.logText);
  if (g.run === 'final-heldout') return hasHumLook3(lines) ? 'a hum look-3 line already exists in the heldout log: refusing to run again' : null;
  if (!hasHumLook3(lines)) return 'no hum look-3 line in the heldout log: the re-score needs the original look first';
  if (hasHumRescore(lines)) return 'a hum rescore-m1 line already exists in the heldout log: refusing to run again';
  return null;
}

/**
 * Command line -> mode. Exactly one of --selftest / --final-heldout; `--rescore-m1` is only valid together with
 * --final-heldout (it selects the one-time synthetic re-score instead of the look-3 run).
 */
export type HeldOutMode = 'selftest' | 'final-heldout' | 'rescore-m1';
export function parseHeldOutMode(argv: string[]): HeldOutMode {
  const final = argv.includes('--final-heldout');
  const selftest = argv.includes('--selftest');
  const rescore = argv.includes('--rescore-m1');
  if (final === selftest) throw new Error('give exactly one of --final-heldout / --selftest');
  if (rescore && !final) throw new Error('--rescore-m1 needs --final-heldout');
  return rescore ? 'rescore-m1' : final ? 'final-heldout' : 'selftest';
}
