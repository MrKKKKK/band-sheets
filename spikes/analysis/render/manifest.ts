// Manifest / output-directory helpers for the render CLI (review R11).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Variant } from './types';

/** The alphaTab version the spike was validated with; warn on anything else. */
export const EXPECTED_ALPHATAB = '1.8.4';

export interface ManifestMeta {
  alphaTab: string;
  etudeSeed: number;
  soundFont: string;
  /** `git rev-parse HEAD`, or null when unavailable. */
  gitCommit: string | null;
  /** ISO 8601. */
  generatedAt: string;
  masterVolume: number;
  tailSec: number;
}

export interface Manifest extends ManifestMeta {
  variants: Record<string, unknown>[];
}

export function buildManifest(meta: ManifestMeta, variants: Record<string, unknown>[]): Manifest {
  return { ...meta, variants };
}

/** The spike 1 fields of a variant, for its manifest entry (`level`, `heldOut` always present). */
export function variantExtras(v: Variant): Record<string, unknown> {
  const out: Record<string, unknown> = { level: v.level ?? 0, heldOut: v.heldOut ?? false };
  out.comp = v.comp ?? 'block4';
  out.soundFont = v.soundFont ?? 'sonivox';
  out.pianoGainDb = v.pianoGainDb ?? 0;
  if (v.tempoCurve) out.tempoCurve = v.tempoCurve;
  if (v.etudeSeed !== undefined) out.etudeSeed = v.etudeSeed;
  if (v.seventhShare !== undefined) out.seventhShare = v.seventhShare;
  // spike 2 (T4): only when set, so the spike 1 entries stay as they were.
  if (v.lrGrade !== undefined) out.lrGrade = v.lrGrade;
  if (v.recSeed !== undefined) out.recSeed = v.recSeed;
  if (v.etudeForm !== undefined) out.etudeForm = v.etudeForm;
  if (v.pickupBeats !== undefined) out.pickupBeats = v.pickupBeats;
  if (v.vocabShare !== undefined) out.vocabShare = v.vocabShare;
  return out;
}

/** Current git commit of `cwd`, or null (no git, not a repo, ...). */
export function gitCommit(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

const GENERATED = /\.(wav|truth\.json|bandsheet)$/;

/**
 * Removes the files the CLI generates (wav, truth.json, bandsheet) from
 * `<out>/<dir>` for each of `dirs`, so renamed variants leave nothing stale.
 * Other files and missing directories are left alone. Returns the removed paths.
 */
export function cleanGenerated(out: string, dirs: string[]): string[] {
  const removed: string[] = [];
  for (const d of dirs) {
    const dir = join(out, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!GENERATED.test(f)) continue;
      rmSync(join(dir, f));
      removed.push(join(dir, f));
    }
  }
  return removed;
}

/** Largest |sample| and the count of samples at/over full scale. */
export function peakStats(samples: Float32Array): { peak: number; clipped: number } {
  let peak = 0;
  let clipped = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= 1) clipped++;
  }
  return { peak, clipped };
}

/**
 * The manifest variant list after rendering only some variants (`--only`):
 * every variant of `order` in that order, the fresh entry where there is one,
 * else the previous manifest's entry of that name; names in neither are left out.
 */
export function mergeManifestVariants(
  order: string[],
  fresh: Record<string, unknown>[],
  previous: Record<string, unknown>[],
): Record<string, unknown>[] {
  const byName = (xs: Record<string, unknown>[]) => new Map(xs.map((x) => [x.name as string, x]));
  const f = byName(fresh);
  const p = byName(previous);
  return order.flatMap((n) => {
    const e = f.get(n) ?? p.get(n);
    return e ? [e] : [];
  });
}
