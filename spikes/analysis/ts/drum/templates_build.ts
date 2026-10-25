/**
 * Spike 5 T6: builds the fixed NMF templates of classify.ts from the TUNING kit's one-shots (kit A, MuseScore_General,
 * program 0 Standard; render/drum/kits.ts). Node only (alphaTab render): classify.ts never imports this file, it uses
 * the generated table in templates.ts (make_templates.ts writes it).
 * Per (instrument, velocity): the one-shot after 1 s of silence -> classify.ts melSpectrogram -> observation at its
 * onset (the same window as for a take) -> normalised to sum 1. No take audio is read.
 */
import { getKit, layerOf, SAMPLE_RATE, A_VELOCITY_STEPS } from '../../render/drum/kits';
import { melSpectrogram, observation, type SpecParams, type TemplateColumn, type TemplateGroup, type TemplateTable } from './classify';
import type { DrumInst } from './types';

export const TEMPLATE_INSTS: [DrumInst, TemplateGroup][] = [
  ['BD', 'BD'],
  ['SD', 'SD'],
  ['HH', 'HH'],
  ['HO', 'HH'],
  ['RD', 'other'],
  ['CR', 'other'],
  ['T1', 'other'],
  ['T2', 'other'],
  ['FT', 'other'],
  ['SD.xs', 'ext'],
  ['RD.bell', 'extCym'],
  ['CB', 'ext'],
  ['SP', 'extCym'],
  ['CN', 'extCym'],
];
export const TEMPLATE_VELOCITIES = [50, 110];

const round = (v: number) => Number(v.toPrecision(4));

export function buildTemplates(p: SpecParams): TemplateTable {
  if (p.sr !== SAMPLE_RATE) throw new Error(`templates: kit A renders at ${SAMPLE_RATE}, config sr ${p.sr}`);
  const kit = getKit('A');
  const columns: TemplateColumn[] = [];
  const lead = SAMPLE_RATE;
  for (const [inst, group] of TEMPLATE_INSTS) {
    for (const velocity of TEMPLATE_VELOCITIES) {
      const v = kit.voice({ inst, layer: layerOf(velocity, A_VELOCITY_STEPS), rr: 0, mics: { dry: 1 }, cents: 0, program: 0 });
      const y = new Float32Array(lead + v.x.length + SAMPLE_RATE / 2);
      y.set(v.x, lead);
      const x = observation(melSpectrogram(y, p), (lead + v.onset) / SAMPLE_RATE, p);
      const s = x.reduce((a, b) => a + b, 0);
      if (!(s > 0)) throw new Error(`templates: empty observation for ${inst} v${velocity}`);
      columns.push({ inst, group, velocity, w: Array.from(x, (e) => round(e / s)) });
    }
  }
  return { source: 'kit A (MuseScore_General, program 0), render/drum/kits.ts', params: { ...p }, columns };
}
