import type { ChartSection, Song } from '../song';

/**
 * Draft marks for a song made from a recording (docs/audio-integration-plan.md §3.3):
 * title suffix, a leading `{comment: …}` line, and `?` on low-confidence chords
 * (the `?` is the analyzer's text; see chordDraft.ts). The user may delete the
 * title suffix and the comment.
 */
export const DRAFT_TITLE_SUFFIX = '（下書き）';
const COMMENT_PREFIX = '自動解析の下書き';

/** Title + 「（下書き）」 (not added twice). */
export function draftTitle(title: string): string {
  return title.endsWith(DRAFT_TITLE_SUFFIX)
    ? title
    : title + DRAFT_TITLE_SUFFIX;
}

/** Local date as YYYY-MM-DD. */
export function formatDraftDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `{comment: 自動解析の下書き 2026-10-18 コード adec583eb3c6}` */
export function draftComment(date: string, configHash: string): string {
  return `{comment: ${COMMENT_PREFIX} ${date} コード ${configHash}}`;
}

export function isDraftComment(raw: string): boolean {
  return raw.startsWith(`{comment: ${COMMENT_PREFIX} `);
}

export interface DraftMarkInfo {
  /** YYYY-MM-DD (see `formatDraftDate`). */
  date: string;
  /** `result.analyzer.configHash`. */
  configHash: string;
}

/**
 * Returns the song with the title mark and, as the first chart section, an
 * implicit section holding the comment line. Replaces an earlier draft
 * comment instead of stacking a second one.
 */
export function markChordDraft(song: Song, info: DraftMarkInfo): Song {
  const comment: ChartSection = {
    kind: '',
    label: '',
    lines: [{ raw: draftComment(info.date, info.configHash) }],
  };
  const rest = song.chart.filter(
    (s) =>
      !(
        s.kind === '' &&
        s.lines.length === 1 &&
        'raw' in s.lines[0] &&
        isDraftComment(s.lines[0].raw)
      ),
  );
  return {
    ...song,
    meta: { ...song.meta, title: draftTitle(song.meta.title) },
    chart: [comment, ...rest],
  };
}
