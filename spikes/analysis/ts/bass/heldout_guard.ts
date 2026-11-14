/**
 * Spike 6 T5: "may the bass tools analyze this?" as pure functions (like ts/drum/heldout_guard.ts), so they are testable.
 *
 * Refused (docs/audio-spike6-plan.md 守ること, section 4):
 *  - synthetic variants with `heldOut` / split 'heldOut' in out/bass/manifest.json, and any name with timbre C (`-tC-`,
 *    the held-out timbre) even if the manifest says otherwise;
 *  - recordings flagged heldOut in recordings/bas-ids.local.json or out/rec/manifest.bass.json;
 *  - anything whose flag cannot be verified (manifest / ids unreadable, or a `syn-b*` / `bas-NN-x` name not listed).
 * The one held-out look (T13) has its own guarded entry: py/tools/bass_heldout_fit.py + ts/bass/heldout_eval.ts.
 * Dev looks: every evaluation of the dev split appends one line (kind 'look', input 'bass-synth-dev') to
 * out/results/heldout-log.jsonl, so dev looks are counted (spike 5's lesson).
 */
import { basename } from 'node:path';
import { parseJsonl } from './evalCommon';

export interface GuardVariant {
  name: string;
  wav?: string;
  heldOut?: boolean;
  split?: string;
  timbre?: string;
}
export interface GuardSources {
  /** out/bass/manifest.json variants (null = unreadable). */
  syn: GuardVariant[] | null;
  /** out/rec/manifest.bass.json variants (null = unreadable or absent). */
  rec: GuardVariant[] | null;
  /** recordings/bas-ids.local.json `recordings` (null = unreadable or absent). */
  ids: Record<string, { heldOut?: boolean }> | null;
}

export const HELD_OUT_TIMBRE = 'C';
export const isHeld = (v: GuardVariant): boolean => v.heldOut === true || v.split === 'heldOut' || v.timbre === HELD_OUT_TIMBRE;
const stemOf = (input: string): string => basename(input).replace(/\.(truth\.json|wav|json)$/i, '');

/** Refusal reason for an input path or name, else null. */
export function heldOutRefusal(input: string, src: GuardSources): string | null {
  const b = basename(input);
  const stem = stemOf(input);
  if (/-tC-/.test(stem)) return 'timbre C is held-out: refused';
  const matches = (v: GuardVariant) => v.name === stem || (v.wav !== undefined && basename(v.wav) === b);
  if (src.syn?.some((v) => matches(v) && isHeld(v))) return 'held-out synthetic variant: refused';
  if (src.rec?.some((v) => matches(v) && isHeld(v))) return 'held-out recording: refused';
  if (src.ids && Object.prototype.hasOwnProperty.call(src.ids, stem) && src.ids[stem].heldOut === true) return 'held-out recording: refused';
  if (/^syn-/.test(stem)) {
    if (src.syn === null) return 'cannot verify the held-out flag (out/bass/manifest.json unreadable): refused';
    if (!src.syn.some(matches)) return 'synthetic variant not in the manifest, flag unverifiable: refused';
    return null;
  }
  const listedRec = (src.ids !== null && stem in src.ids) || (src.rec?.some(matches) ?? false);
  if (!listedRec) return 'input is neither a listed synthetic variant nor a registered recording, flag unverifiable: refused';
  return null;
}

/** `*` / `?` glob over a whole variant name. */
export const globRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** Tuning / dev variants by split and name glob; held-out entries never pass (checked before and after matching). */
export function selectVariants<V extends GuardVariant>(all: readonly V[], splits: readonly string[], only?: string): V[] {
  if (splits.some((s) => !['tuning', 'dev'].includes(s))) throw new Error(`only tuning / dev splits are evaluated here, got ${splits.join(',')}`);
  const re = only ? globRegExp(only) : null;
  const sel = all.filter((v) => !isHeld(v) && splits.includes(v.split ?? '') && (!re || re.test(v.name)));
  if (sel.some(isHeld)) throw new Error('internal: held-out variant selected');
  return sel;
}

interface LogLine {
  kind?: string;
  input?: string;
}
export const DEV_LOOK_INPUT = 'bass-synth-dev';

/** Number of logged dev looks at the bass synthetic dev split. */
export function devLookCount(logText: string | null): number {
  return parseJsonl<LogLine>(logText).filter((d) => d.kind === 'look' && d.input === DEV_LOOK_INPUT).length;
}

export function devLookLine(o: { task: string; reason: string; configHash: string; commit: string; files: number; at: string }): string {
  return JSON.stringify({ kind: 'look', input: DEV_LOOK_INPUT, split: 'dev', heldOut: false, ...o });
}
