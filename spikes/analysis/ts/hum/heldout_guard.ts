/**
 * Spike 4 T15 (review S6/S10): the decision "may the single-file CLI analyze this file?" as a pure function, so it is
 * testable. Held-out data (synthetic `heldOut` / split 'heldOut' variants, recordings with the heldOut flag in
 * recordings/hum-ids.local.json, out/rec/manifest.hum.json or the truth JSON) is never analyzed outside the
 * look-point 3 driver. When a source needed to decide cannot be read, the file is refused instead of passed.
 */
import { basename, sep } from 'node:path';

export interface GuardVariant {
  name: string;
  wav?: string;
  heldOut?: boolean;
  split?: string;
}
export interface GuardSources {
  /** out/hum/manifest.json variants (null = unreadable). */
  syn: GuardVariant[] | null;
  /** out/rec/manifest.hum.json variants (null = unreadable). */
  rec: GuardVariant[] | null;
  /** recordings/hum-ids.local.json `recordings` map (null = unreadable). */
  ids: Record<string, { heldOut?: boolean }> | null;
}

const isHeld = (v: GuardVariant) => v.heldOut === true || v.split === 'heldOut';

/** Reason text when the input must be refused, else null. */
export function heldOutRefusal(input: string, src: GuardSources): string | null {
  const b = basename(input);
  const stem = b.replace(/\.(truth\.json|wav|json)$/i, '');
  const matches = (v: GuardVariant) => v.name === stem || (v.wav !== undefined && basename(v.wav) === b);
  if (src.syn?.some((v) => matches(v) && isHeld(v))) return 'held-out variants are never analyzed here';
  if (src.rec?.some((v) => matches(v) && isHeld(v))) return 'held-out recordings are never analyzed here';
  if (src.ids && Object.prototype.hasOwnProperty.call(src.ids, stem) && src.ids[stem].heldOut === true) return 'held-out recordings are never analyzed here';
  const looksRecording = /^hum-\d+-[a-z]/i.test(stem) || input.split(sep).includes('recordings') || input.split('/').includes('recordings');
  if (looksRecording && src.ids === null && src.rec === null) return 'cannot verify the held-out flag of a recording (hum-ids.local.json / manifest.hum.json unreadable): refusing';
  if (/^syn-/.test(stem) && src.syn === null) return 'cannot verify the held-out flag of a synthetic variant (manifest unreadable): refusing';
  return null;
}
