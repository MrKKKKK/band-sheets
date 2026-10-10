import { alphaTexKeyName } from './keys';
import { isDrumPart, type Part, type Song } from './song';

/** App-default drum aliases (name, GM percussion note). */
export const DRUM_ARTICULATIONS: readonly (readonly [string, number])[] = [
  ['HH', 42],
  ['SD', 38],
  ['BD', 36],
  ['CR', 49],
  ['RD', 51],
  ['HO', 46],
  ['T1', 50],
  ['T2', 48],
  ['FT', 41],
];

const VALID_DENOMINATORS = new Set([1, 2, 4, 8, 16, 32, 64]);

/** Strict "N/D" check before the value reaches alphaTab. */
export function parseTimeSignature(
  time: string | undefined,
): [number, number] | undefined {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(time ?? '');
  if (!m) return undefined;
  const [num, den] = [Number(m[1]), Number(m[2])];
  if (num < 1 || !VALID_DENOMINATORS.has(den)) return undefined;
  return [num, den];
}

/** A quoted alphaTex string; `"` and `\` are stripped (alphaTex has no escaping we rely on). */
const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`;

/**
 * Builds a complete alphaTex document for rendering the selected parts
 * (all parts when `partNames` is omitted), in song order.
 */
export function partsToAlphaTex(song: Song, partNames?: string[]): string {
  const header: string[] = [];
  if (song.meta.title !== '') header.push(`\\title ${quote(song.meta.title)}`);
  if (song.meta.tempo !== undefined) header.push(`\\tempo ${song.meta.tempo}`);
  header.push('.');

  const ts = parseTimeSignature(song.meta.time);
  const tracks = song.parts
    .filter((p) => !partNames || partNames.includes(p.name))
    .map((p) => trackTex(p, ts, alphaTexKeyName(song.meta.key)));

  // One blank line between tracks for readability when debugging.
  return [header.join('\n'), tracks.join('\n\n')]
    .filter((s) => s !== '')
    .join('\n')
    .concat('\n');
}

function trackTex(
  part: Part,
  ts: [number, number] | undefined,
  ks: string | undefined,
): string {
  const body = part.body === '' ? [] : part.body.split('\n');
  const has = (re: RegExp) => re.test(part.body);
  const drum = isDrumPart(part);

  // Defaults go right after the line that sets up the staff (if the body
  // has one), so they apply to that staff; otherwise at the top.
  const anchor = drum ? /\\instrument\s+percussion\b/i : /\\staff\b/;
  const at = body.findIndex((l) => anchor.test(l)) + 1;

  const defaults: string[] = [];
  if (drum) {
    for (const [name, note] of DRUM_ARTICULATIONS) {
      if (!has(new RegExp(`\\\\articulation\\s+${name}\\b`))) {
        defaults.push(`\\articulation ${name} ${note}`);
      }
    }
    if (!has(/\\clef\b/)) defaults.push('\\clef neutral');
  } else if (!has(/\\staff\b/)) {
    defaults.push('\\staff {score}');
  }
  if (ts && !has(/\\ts\b/)) defaults.push(`\\ts ${ts[0]} ${ts[1]}`);

  // Key signature for pitched parts only (percussion has none).
  if (ks && !drum && !has(/\\ks\b/)) defaults.push(`\\ks ${ks}`);

  const lines = [
    `\\track ${quote(part.name)}`,
    ...body.slice(0, at),
    ...defaults,
    ...body.slice(at),
  ];
  return lines.join('\n');
}
