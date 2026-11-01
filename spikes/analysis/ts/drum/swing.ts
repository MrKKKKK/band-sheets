/**
 * Spike 5 T7: per-bar shuffle decision (docs/audio-spike5-plan.md section 2: "シャッフルは小節ごとの裏の 8 分・16 分の
 * 位置の比から判定").
 *
 * Input: hit positions in REAL ticks from bar-1 beat 1 (whole = 64; after the onset bias is removed).
 * A beat pair ("span") is a quarter (16 ticks) for an 8th shuffle and an 8th (8 ticks) for a 16th shuffle.
 *  - Sample: a span whose onsets at relative position r in [innerMin, innerMax) form exactly ONE cluster (onsets closer
 *    than clusterFrac of the span are one cluster, e.g. BD + HH) gives r (cluster mean). Spans with 2+ inner clusters
 *    (straight 16ths inside a quarter) give nothing, so a straight 16th groove never looks like an 8th shuffle.
 *  - A bar's own decision, with >= minPairs samples at a level: '16' if the 8th-span median >= ratioMin, else '8' if the
 *    quarter-span median >= ratioMin, else 'none'. With fewer samples at both levels the bar is undecided.
 *  - Take level: among decided bars, the swing kind with the most bars (tie -> '8') if it has at least as many bars as
 *    'none'; confidence = its share of the decided bars. Absent = no shuffle.
 *  - Undecided bars take the take-level kind (ratio = median of that kind's decided ratios), else 'none' / 0.5: a
 *    shuffle bar with only two off-beats must not snap them to straight 16ths.
 * Only x/4 meters can swing (other meters: every bar 'none').
 */
import { DEFAULT_DRUM_CONFIG, type DrumConfig } from './config';
import type { DrumSwingBar } from './types';

export type SwingKind = DrumSwingBar['kind'];
/** Span (ticks) of a beat pair per shuffle kind. */
export const SWING_SPAN: Readonly<Record<'8' | '16', number>> = { '8': 16, '16': 8 };

export interface SwingBarDetail extends DrumSwingBar {
  /** Samples at the quarter span ('8') and at the 8th span ('16'). */
  pairs8: number;
  pairs16: number;
  decided: boolean;
}

export interface SwingResult {
  bars: DrumSwingBar[];
  detail: SwingBarDetail[];
  swing?: { kind: '8' | '16'; confidence: number };
}

export function median(a: readonly number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Off-beat samples per bar for one span length. */
export function swingSamples(pos: readonly number[], span: number, barTicks: number, nBars: number, cfg: DrumConfig['swing'] = DEFAULT_DRUM_CONFIG.swing): number[][] {
  const bySpan = new Map<number, number[]>();
  for (const p of pos) {
    const k = Math.floor(p / span);
    const r = p / span - k;
    if (r >= cfg.innerMin && r < cfg.innerMax) bySpan.set(k, [...(bySpan.get(k) ?? []), r]);
  }
  const out: number[][] = Array.from({ length: nBars }, () => []);
  for (const [k, rs] of [...bySpan.entries()].sort((a, b) => a[0] - b[0])) {
    rs.sort((a, b) => a - b);
    if (rs.some((r, i) => i > 0 && r - rs[i - 1] >= cfg.clusterFrac)) continue;
    const bar = Math.floor((k * span) / barTicks);
    if (bar >= 0 && bar < nBars) out[bar].push(rs.reduce((s, r) => s + r, 0) / rs.length);
  }
  return out;
}

export function detectSwing(pos: readonly number[], barTicks: number, nBars: number, den: number, cfg: DrumConfig['swing'] = DEFAULT_DRUM_CONFIG.swing): SwingResult {
  const can = den === 4;
  const empty = () => Array.from({ length: nBars }, () => [] as number[]);
  const s8 = can ? swingSamples(pos, SWING_SPAN['8'], barTicks, nBars, cfg) : empty();
  const s16 = can ? swingSamples(pos, SWING_SPAN['16'], barTicks, nBars, cfg) : empty();
  const detail: SwingBarDetail[] = [];
  for (let bar = 0; bar < nBars; bar++) {
    const a = s8[bar];
    const b = s16[bar];
    const m8 = median(a);
    const m16 = median(b);
    const ok8 = a.length >= cfg.minPairs;
    const ok16 = b.length >= cfg.minPairs;
    let kind: SwingKind = 'none';
    let ratio = 0.5;
    if (ok16 && m16 >= cfg.ratioMin) [kind, ratio] = ['16', m16];
    else if (ok8 && m8 >= cfg.ratioMin) [kind, ratio] = ['8', m8];
    else if (ok8 || ok16) ratio = a.length >= b.length ? m8 : m16;
    detail.push({ bar, kind, ratio, pairs8: a.length, pairs16: b.length, decided: ok8 || ok16 });
  }
  const decided = detail.filter((d) => d.decided);
  const count = (k: SwingKind) => decided.filter((d) => d.kind === k).length;
  const best: '8' | '16' = count('16') > count('8') ? '16' : '8';
  const swing = count(best) > 0 && count(best) >= count('none') ? { kind: best, confidence: count(best) / decided.length } : undefined;
  const fillRatio = swing ? median(decided.filter((d) => d.kind === swing.kind).map((d) => d.ratio)) : 0.5;
  for (const d of detail) {
    if (!d.decided) {
      d.kind = swing?.kind ?? 'none';
      d.ratio = fillRatio;
    }
  }
  return { bars: detail.map(({ bar, kind, ratio }) => ({ bar, kind, ratio })), detail, ...(swing ? { swing } : {}) };
}
