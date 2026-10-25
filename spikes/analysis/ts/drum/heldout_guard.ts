/**
 * Spike 5 T8: the decision "may the drum CLI analyze this?" as pure functions (like ts/hum/heldout_guard.ts), so they are
 * testable. Held-out data (synthetic `heldOut` / split 'heldOut' variants = kit C and the held-out room, recordings with the
 * heldOut flag in recordings/drm-ids.local.json, out/rec/manifest.drum.json or the truth JSON) is refused unless the caller
 * gives an explicit look point, and then only as look point 3 (the last, single look), on a clean working tree, once.
 * When a source needed to decide cannot be read, the input is refused instead of passed.
 */
import { basename, sep } from 'node:path';

export interface GuardVariant {
  name: string;
  wav?: string;
  heldOut?: boolean;
  split?: string;
}
export interface GuardSources {
  /** out/drum/manifest.json variants (null = unreadable). */
  syn: GuardVariant[] | null;
  /** out/rec/manifest.drum.json variants (null = unreadable). */
  rec: GuardVariant[] | null;
  /** recordings/drm-ids.local.json `recordings` map (null = unreadable). */
  ids: Record<string, { heldOut?: boolean }> | null;
}

const isHeld = (v: GuardVariant) => v.heldOut === true || v.split === 'heldOut';


export interface Refusal {
  reason: string;
  /** true: a look point may lift the refusal (the input is held-out); false: refused for good (cannot verify). */
  heldOut: boolean;
}

/** Refusal for an input path or take id (a wav, a truth json, a name), else null. */
export function heldOutRefusal(input: string, src: GuardSources): Refusal | null {
  const b = basename(input);
  const stem = b.replace(/\.(truth\.json|wav|json)$/i, '');
  const matches = (v: GuardVariant) => v.name === stem || (v.wav !== undefined && basename(v.wav) === b);
  if (src.syn?.some((v) => matches(v) && isHeld(v))) return { reason: 'held-out synthetic variants are not analyzed without a look point', heldOut: true };
  if (src.rec?.some((v) => matches(v) && isHeld(v))) return { reason: 'held-out recordings are not analyzed without a look point', heldOut: true };
  if (src.ids && Object.prototype.hasOwnProperty.call(src.ids, stem) && src.ids[stem].heldOut === true) return { reason: 'held-out recordings are not analyzed without a look point', heldOut: true };
  const looksRecording = /^drm-\d+-[a-z]/i.test(stem) || input.split(sep).includes('recordings') || input.split('/').includes('recordings');
  if (looksRecording && src.ids === null && src.rec === null) return { reason: 'cannot verify the held-out flag of a recording (drm-ids.local.json / manifest.drum.json unreadable): refusing', heldOut: false };
  if (/^syn-/.test(stem) && src.syn === null) return { reason: 'cannot verify the held-out flag of a synthetic variant (manifest unreadable): refusing', heldOut: false };
  return null;
}

interface LogLine {
  kind?: string;
  input?: string;
  lookPoint?: number;
  heldOut?: boolean;
}
export const parseLog = (text: string | null): LogLine[] =>
  (text ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogLine);

export const hasDrumLook3 = (lines: LogLine[]) => lines.some((d) => d.input === 'drum' && d.lookPoint === 3 && d.kind === 'look' && d.heldOut === true);

export interface LookPointInput {
  lookPoint: number | undefined;
  /** Contents of out/results/heldout-log.jsonl, null when the file does not exist. */
  logText: string | null;
  /** `git status --porcelain`, null when git failed. */
  porcelain: string | null;
}

/** Reason to refuse a HELD-OUT run given the look point flag, or null when it may go ahead. */
export function lookPointBlock(g: LookPointInput): string | null {
  if (g.lookPoint === undefined) return 'held-out input needs --look-point 3';
  if (g.lookPoint !== 3) return 'held-out data is looked at once, as look point 3 (--look-point 3)';
  if (g.porcelain === null || g.porcelain !== '') return 'working tree must be clean (and git must work) for a held-out run';
  return hasDrumLook3(parseLog(g.logText)) ? 'a drum look-3 line already exists in the heldout log: refusing to run again' : null;
}

/** The log line written BEFORE a look-point analysis (JSON; the caller appends it plus a newline). */
export function lookLogLine(o: { time: string; lookPoint: number; take: string; heldOut: boolean; configHash: string; commit?: string }): string {
  return JSON.stringify({ time: o.time, kind: 'look', input: 'drum', lookPoint: o.lookPoint, take: o.take, heldOut: o.heldOut, variants: [o.take], configHash: o.configHash, ...(o.commit ? { commit: o.commit } : {}) });
}
