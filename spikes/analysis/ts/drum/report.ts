/**
 * Spike 5 T3: report helpers for the drum scores (docs/audio-spike5-plan.md section 5), like hum/report.ts.
 * Aggregate tables per level x instrument x metric, scalar metrics per level, confusion tables summed per level.
 * Recordings: aggregates only (n, mean, min, max), never a per-take line or an id. Numbers only.
 */
import { LEVEL_INSTRUMENTS, type DrumLevel } from './types';
import type { Scores, TakeScore } from './score';

export interface DrumReportRow {
  /** Printed for synthetic takes only. */
  id: string;
  kind: 'synthetic' | 'recording';
  /** 'D0'..'D3' or any grouping label. */
  level: string;
  /** Analysis level, picks the instrument columns. */
  drumLevel: DrumLevel;
  heldOut?: boolean;
  take: Pick<TakeScore, 'scores' | 'confusion'>;
}

/** Metrics shown per instrument: [title, key prefix]. */
export const INST_METRICS: [string, string][] = [
  ['onset F +-50ms', 'onset.f'],
  ['onset P +-50ms', 'onset.p'],
  ['onset R +-50ms', 'onset.r'],
  ['onset F +-25ms', 'onset25.f'],
];

/** Scalar metrics: [header, key, format]. */
export const SCALAR_COLUMNS: [string, string, 'f' | 'n'][] = [
  ['grid F', 'grid.f'],
  ['swing acc', 'swing.acc'],
  ['strength agree', 'strength.agree'],
  ['ghost R', 'strength.ghostR'],
  ['accent R', 'strength.accentR'],
  ['edits', 'edit.count'],
  ['edits/kbd', 'edit.ratioToKeyboard'],
  ['edits/kbd (copy)', 'edit.ratioToKeyboardCopy'],
  ['bar head F', 'barHead.f'],
  ['tempo err', 'tempo.relErr'],
  ['offset ms', 'align.offsetMs'],
].map(([h, k]) => [h, k, k === 'edit.count' || k === 'align.offsetMs' ? 'n' : 'f'] as [string, string, 'f' | 'n']);

const fmt = (x: number | undefined, kind: 'f' | 'n' = 'f') => (x === undefined || !Number.isFinite(x) ? '-' : kind === 'f' ? x.toFixed(3) : x.toFixed(1));

export function stats(rows: { scores: Scores }[], key: string) {
  const v = rows.map((r) => r.scores[key]).filter((x) => x !== undefined && Number.isFinite(x));
  if (v.length === 0) return undefined;
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) };
}
function table(header: string[], body: string[][]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}
const sortLevels = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

function groups(rows: DrumReportRow[]): Map<string, DrumReportRow[]> {
  const m = new Map<string, DrumReportRow[]>();
  for (const r of rows) {
    const k = `${r.level}${r.heldOut ? ' (held-out)' : ''}`;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

/** Sum of the confusion tables of the rows. */
export function sumConfusion(rows: { confusion: Record<string, Record<string, number>> }[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) for (const [t, row] of Object.entries(r.confusion)) for (const [e, n] of Object.entries(row)) (out[t] ??= {})[e] = (out[t][e] ?? 0) + n;
  return out;
}

export function confusionTable(c: Record<string, Record<string, number>>): string {
  const names = [...new Set([...Object.keys(c), ...Object.values(c).flatMap((r) => Object.keys(r))])].filter((x) => x !== 'none').sort();
  const cols = [...names, 'none'];
  const rows = [...names, 'none'];
  return table(['truth \\ est', ...cols], rows.map((t) => [t, ...cols.map((e) => String(c[t]?.[e] ?? 0))]));
}

function instColumns(rows: DrumReportRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) for (const i of LEVEL_INSTRUMENTS[r.drumLevel]) set.add(i);
  const order = [...new Set(rows.flatMap((r) => LEVEL_INSTRUMENTS[r.drumLevel] as readonly string[]))];
  return order.filter((i) => set.has(i));
}

/**
 * Markdown. For each stat (synthetic: mean per level; recordings: mean / min / max per level) one table per instrument
 * metric (rows = level, columns = instruments + all), one scalar table, one confusion table per level.
 */
export function renderDrumReport(rows: DrumReportRow[]): string {
  const out: string[] = [];
  for (const [title, kind] of [['Synthetic', 'synthetic'], ['Recordings (aggregates only, no per-take lines)', 'recording']] as const) {
    const sel = rows.filter((r) => r.kind === kind);
    if (!sel.length) continue;
    const g = groups(sel);
    const keys = [...g.keys()].sort(sortLevels);
    const statNames = kind === 'synthetic' ? (['mean'] as const) : (['mean', 'min', 'max'] as const);
    const insts = instColumns(sel);
    for (const [mt, prefix] of INST_METRICS) {
      const body: string[][] = [];
      for (const k of keys) {
        const rs = g.get(k)!.map((r) => r.take);
        for (const st of statNames) body.push([statNames.length > 1 ? `${k} ${st}` : k, String(rs.length), ...[...insts, 'all'].map((i) => fmt(stats(rs, `${prefix}.${i}`)?.[st]))]);
      }
      out.push(`## ${title}: ${mt}`, '', table(['group', 'n', ...insts, 'all'], body), '');
    }
    const body: string[][] = [];
    for (const k of keys) {
      const rs = g.get(k)!.map((r) => r.take);
      for (const st of statNames) body.push([statNames.length > 1 ? `${k} ${st}` : k, String(rs.length), ...SCALAR_COLUMNS.map(([, key, f]) => fmt(stats(rs, key)?.[st], f))]);
    }
    out.push(`## ${title}: grid, swing, strength, edits`, '', table(['group', 'n', ...SCALAR_COLUMNS.map((c) => c[0])], body), '');
    for (const k of keys) out.push(`### ${title}: confusion (truth x est, +-50 ms) ${k}`, '', confusionTable(sumConfusion(g.get(k)!.map((r) => r.take))), '');
    if (kind === 'synthetic') {
      const sorted = [...sel].sort((a, b) => sortLevels(a.level, b.level) || a.id.localeCompare(b.id));
      out.push(
        `## ${title}: per take`,
        '',
        table(['take', 'level', 'onset F all', 'grid F', 'swing acc', 'edits/kbd'], sorted.map((r) => [r.id, r.level + (r.heldOut ? ' (held-out)' : ''), ...['onset.f.all', 'grid.f', 'swing.acc', 'edit.ratioToKeyboard'].map((k) => fmt(r.take.scores[k]))])),
        '',
      );
    }
  }
  return out.join('\n');
}
