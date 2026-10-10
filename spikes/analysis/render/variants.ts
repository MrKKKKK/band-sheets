// The variants of docs/audio-spike0-plan.md, design decision 6, plus the
// spike 0 review additions (R5: etude full / shuffle, R6: lead-in silence).

import type { Mix, Variant } from './types';

export const ETUDE_SEED = 1;

const MIX_NAME: Record<Mix, string> = { piano: 'piano', 'piano+drums': 'drums', full: 'full' };
const MIXES: Mix[] = ['piano', 'piano+drums', 'full'];

function make(
  song: Variant['song'],
  mix: Mix,
  tempo: number,
  swing: Variant['swing'],
  click: boolean,
  leadInSec = 0,
): Variant {
  const prefix = song === 'etude' ? 'etude-' : '';
  const feel = swing === 'asWritten' ? 'shuffle' : 'straight';
  const lead = leadInSec > 0 ? `-lead${leadInSec}s` : '';
  const name = `${prefix}${MIX_NAME[mix]}-t${tempo}-${feel}${click ? '-click' : ''}${lead}`;
  const v: Variant = { song, mix, tempo, swing, click, name };
  if (leadInSec > 0) v.leadInSec = leadInSec;
  return v;
}

export function allVariants(): Variant[] {
  const out: Variant[] = [];
  for (const mix of MIXES) for (const t of [80, 116, 160]) out.push(make('saints', mix, t, 'none', false));
  out.push(make('saints', 'piano+drums', 116, 'asWritten', false));
  out.push(make('saints', 'full', 116, 'asWritten', false));
  out.push(make('saints', 'full', 116, 'none', true));
  // Etude: straight piano / drums / full at two tempi, plus a shuffle one.
  for (const t of [90, 140]) for (const mix of MIXES) out.push(make('etude', mix, t, 'none', false));
  out.push(make('etude', 'full', 90, 'asWritten', false));
  // Lead-in silence (R6): bar 0 does not start at 0 s.
  out.push(make('saints', 'full', 116, 'none', false, 1.37));
  out.push(make('etude', 'piano+drums', 90, 'none', false, 0.62));
  return out;
}
