import { parseKey } from './keys';
import { META_ALIASES, parseDirective } from './parseSong';
import type { ChartLine, Song, SongMeta } from './song';

/** Raw form values of the song-info form. */
export interface MetaInput {
  title: string;
  key: string;
  tempo: string;
  time: string;
}

export type MetaField = keyof MetaInput;

/** Validated fields; empty optional fields are omitted (= removed). */
export type ValidMeta = Pick<SongMeta, 'title' | 'key' | 'tempo' | 'time'>;

export type MetaValidation =
  | { ok: true; meta: ValidMeta }
  | { ok: false; errors: Partial<Record<MetaField, string>> };

export const TEMPO_MIN = 1;
export const TEMPO_MAX = 400;
const TIME_DENOMINATORS = new Set([1, 2, 4, 8, 16, 32]);

/**
 * Strict check of the song-info form. All fields are trimmed. Title is
 * required; key / tempo / time may be empty (→ omitted from `meta`).
 *
 * `original`, when given, is the same four fields as loaded from the file
 * (e.g. via `toInput(meta)` in SongInfoPopover) *before* this edit. A field
 * the user left untouched (trimmed input === trimmed original) skips its
 * format/range check and is passed through as-is (N8): a hand-edited or
 * otherwise out-of-range file value — e.g. `{tempo: 0}` or `{tempo: 500}`,
 * both outside TEMPO_MIN..TEMPO_MAX — must not block saving every OTHER
 * field in the form just because the user never touched that one. Only a
 * field the user actually changed gets the strict check.
 */
export function validateMeta(
  input: MetaInput,
  original?: MetaInput,
): MetaValidation {
  const errors: Partial<Record<MetaField, string>> = {};
  const meta: ValidMeta = { title: input.title.trim() };
  const unchanged = (field: MetaField, value: string) =>
    original !== undefined && value === original[field].trim();

  if (meta.title === '') errors.title = '曲名を入力してください';

  const key = input.key.trim();
  if (key !== '') {
    if (unchanged('key', key) || parseKey(key)) meta.key = key;
    else errors.key = 'キーは C、F#m、Bb のように入力してください';
  }

  const tempo = input.tempo.trim();
  if (tempo !== '') {
    if (unchanged('tempo', tempo)) {
      meta.tempo = Number(tempo);
    } else {
      // Accepts decimals (not just integers): a file loaded from disk can
      // have e.g. {tempo: 120.5}, and rejecting it here used to block
      // saving every other field in the form too (R15).
      const n = /^\d+(\.\d+)?$/.test(tempo) ? Number(tempo) : NaN;
      if (n >= TEMPO_MIN && n <= TEMPO_MAX) meta.tempo = n;
      else
        errors.tempo = `テンポは ${TEMPO_MIN}〜${TEMPO_MAX} の数値で入力してください`;
    }
  }

  const time = input.time.trim();
  if (time !== '') {
    const m = /^(\d+)\/(\d+)$/.exec(time);
    if (
      unchanged('time', time) ||
      (m && Number(m[1]) > 0 && TIME_DENOMINATORS.has(Number(m[2])))
    )
      meta.time = time;
    else
      errors.time =
        '拍子は 4/4、6/8 のように入力してください（分母は 1, 2, 4, 8, 16, 32）';
  }

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, meta };
}

/**
 * Would parseSong's `applyMeta` actually promote this value into `field`
 * (ignoring the "already seen" check)? Only `tempo` has an extra format
 * check at parse time (the others accept any non-empty value verbatim).
 * Needed so e.g. `{tempo: fast}` (never promotable — always kept as a raw
 * line, with or without a valid tempo elsewhere) is never treated as a
 * stale duplicate and dropped by `clearStaleMetaLines`; only a value that
 * could actually win the next reparse is worth dropping.
 */
function isPromotableMetaValue(field: keyof SongMeta, value: string): boolean {
  return field === 'tempo' ? /^\d+(\.\d+)?$/.test(value) : true;
}

/**
 * A RawLine that would re-parse as a (non-empty, promotable) top-level
 * directive for one of `fields`.
 */
function isStaleMetaLine(
  line: ChartLine,
  fields: Set<keyof SongMeta>,
): boolean {
  if (!('raw' in line)) return false;
  const d = parseDirective(line.raw);
  if (!d || !d.value) return false;
  const field = META_ALIASES[d.name];
  if (!field || field === 'palette' || !fields.has(field)) return false;
  return isPromotableMetaValue(field, d.value);
}

/**
 * Removes top-level (implicit section) RawLines that would re-parse as a
 * directive for one of `fields` (title/key/tempo/time).
 *
 * This is the one place a scalar meta field's stale duplicate directive
 * gets dropped — and it must only run as part of the explicit user action
 * of clearing that field in 曲情報 (App's song-info change handler calls it
 * for exactly the fields that went from set to empty). serializeSong itself
 * must NOT infer "the user cleared this" merely from the field being
 * `undefined`: a top-level directive for a field can arrive there WITHOUT
 * any clearing action, e.g. applyLyrics (lyrics.ts) moving a section's
 * mid-song `{key: D}` into the implicit section when blocks merge — dropping
 * it then silently lost real data (m3-review.md F1).
 */
export function clearStaleMetaLines(song: Song, fields: MetaField[]): Song {
  if (fields.length === 0) return song;
  const fieldSet = new Set<keyof SongMeta>(fields);
  let changed = false;
  const chart = song.chart.map((section) => {
    if (section.kind !== '') return section;
    const lines = section.lines.filter(
      (line) => !isStaleMetaLine(line, fieldSet),
    );
    if (lines.length === section.lines.length) return section;
    changed = true;
    return { ...section, lines };
  });
  return changed ? { ...song, chart } : song;
}

/** "キー C · ♩=100 · 4/4" (missing parts omitted). */
export function metaSummary(meta: SongMeta): string {
  const parts: string[] = [];
  if (meta.key) parts.push(`キー ${meta.key}`);
  if (meta.tempo !== undefined) parts.push(`♩=${meta.tempo}`);
  if (meta.time) parts.push(meta.time);
  return parts.length > 0 ? parts.join(' · ') : '曲情報を設定';
}
