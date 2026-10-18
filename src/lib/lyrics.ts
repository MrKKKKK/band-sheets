import { lineLyrics } from './chartEdit';
import { isDashLine } from './dashChart';
import { isRawLine } from './song';
import type { ChartLine, ChartSection, LyricLine, Song } from './song';

/**
 * Lyrics editing for editor A, step 1 (docs/m3-plan.md, decisions 5 and 6).
 *
 * A "lyric line" is a LyricLine with non-blank lyrics. Raw lines, blank
 * lines and chord-only lines are "non-lyric lines": they never appear in the
 * lyrics text and are kept in place by applyLyrics.
 */

function lyricOf(line: ChartLine): string | undefined {
  if (isRawLine(line) || isDashLine(line)) return undefined;
  const text = lineLyrics(line);
  return text.trim() === '' ? undefined : text;
}

/** Lyric lines per chart section, sections separated by one blank line. */
export function lyricsText(song: Song): string {
  return song.chart
    .map((section) =>
      section.lines
        .map(lyricOf)
        .filter((t) => t !== undefined)
        .join('\n'),
    )
    .filter((block) => block !== '')
    .join('\n\n');
}

/** First unused label of A…Z, then AA, AB, … */
export function nextSectionLabel(used: Iterable<string>): string {
  const taken = new Set(used);
  const letter = (n: number) => String.fromCharCode(65 + n);
  for (let n = 0; ; n++) {
    const label =
      n < 26 ? letter(n) : letter(Math.floor(n / 26) - 1) + letter(n % 26);
    if (!taken.has(label)) return label;
  }
}

interface OldLyric {
  sec: number;
  idx: number;
  /** Ordinal among the lyric lines of its section. */
  ord: number;
  text: string;
  line: LyricLine;
}

interface NewLine {
  block: number;
  pos: number;
  text: string;
}

interface Attachment {
  /** Insert before the block's line at `pos` (>= length = at the end). */
  pos: number;
  /** Old document order, for stable ordering at the same position. */
  order: number;
  line: ChartLine;
}

const END = Number.POSITIVE_INFINITY;

const isBlankLine = (line: ChartLine) =>
  !isRawLine(line) && line.segments.length === 0;

/**
 * Applies edited lyrics text (blocks separated by blank lines) to the song.
 *
 * - Old lyric lines (whole song, in order) and new lines are matched by LCS
 *   on exact strings (earliest match wins for repeated lines). Matched lines
 *   keep their old LyricLine with chords; others become chordless lines.
 * - Inheritance of kind/label (each section by at most one block, each block
 *   from at most one section): first by matched lines — the (section, block)
 *   pairs with the most matched lines win (ties: the earlier block, then the
 *   earlier section). Then by position, for blocks without any matched line
 *   (e.g. its only line was edited): blocks with matched lines are anchors
 *   (spanning the sections of their matched lines). Between two anchors the
 *   unmatched blocks pair in order with the still-free sections lying
 *   strictly between the anchors' sections, aligned from the end (the block
 *   just before an anchor takes the section just before it; extra blocks or
 *   sections are left over at the start of the gap). Before the first anchor
 *   likewise (end-aligned); after the last anchor, or with no anchor at all,
 *   aligned from the start. Finally, still-unpaired blocks take the
 *   still-free sections in order (e.g. swapped sections), so no label is lost
 *   while a block is available. Otherwise a block becomes `verse` with
 *   nextSectionLabel().
 * - Non-lyric lines of sections with lyric lines are never dropped (inherited
 *   or not). Each one goes, in this order of preference:
 *   1. just before the old lyric line that directly followed it in its
 *      section, if that line was kept (in whichever block it ended up);
 *   2. if that line was edited/deleted: right after the last kept earlier
 *      line of the section (its old slot, before inserted lines);
 *   3. if no lyric line of the section follows it (trailing lines): after the
 *      last kept line of the section, at the end of that block or before the
 *      next kept old lyric line if that one is in the same block;
 *   4. before the next kept line of the section;
 *   5. none of the section's lines kept: in the block inheriting the section
 *      (by position, at the old lyric ordinal; trailing lines at the end),
 *      else before the next kept old lyric line anywhere, else at the end of
 *      the last block, else (no lyrics left at all) non-blank ones into an
 *      implicit section at the end.
 *   Blank lines are not put into an implicit section (it cannot hold them).
 * - Sections without lyric lines (e.g. an instrumental intro, a top-level
 *   comment block) are kept as is: after the block holding the last
 *   surviving lyric line before them, else before the block holding the
 *   first surviving one after them.
 * - meta and parts are untouched.
 */
export function applyLyrics(song: Song, text: string): Song {
  const chart = song.chart;

  // Old lyric lines.
  const olds: OldLyric[] = [];
  const secOlds: number[][] = chart.map(() => []);
  chart.forEach((section, sec) =>
    section.lines.forEach((line, idx) => {
      const t = lyricOf(line);
      if (t === undefined || isRawLine(line)) return;
      secOlds[sec].push(olds.length);
      olds.push({ sec, idx, ord: secOlds[sec].length - 1, text: t, line });
    }),
  );
  const hasLyrics = secOlds.map((list) => list.length > 0);

  // New blocks.
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const t of text.split(/\r?\n/)) {
    if (t.trim() === '') current = undefined;
    else {
      if (!current) blocks.push((current = []));
      current.push(t);
    }
  }
  const news: NewLine[] = blocks.flatMap((lines, block) =>
    lines.map((t, pos) => ({ block, pos, text: t })),
  );
  const blockStart: number[] = [];
  blocks.reduce((start, lines, b) => {
    blockStart[b] = start;
    return start + lines.length;
  }, 0);

  // LCS, suffix table; walking forward takes the earliest match.
  const n = olds.length;
  const m = news.length;
  const dp = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        olds[i].text === news[j].text
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const oldToNew = new Array<number>(n).fill(-1);
  const newToOld = new Array<number>(m).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (olds[i].text === news[j].text && dp[i][j] === dp[i + 1][j + 1] + 1) {
      oldToNew[i] = j;
      newToOld[j] = i;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const kept = (o: number) => o >= 0 && o < n && oldToNew[o] >= 0;
  const newOf = (o: number) => news[oldToNew[o]];

  // Inheritance by matched lines.
  const pairs: { sec: number; block: number; count: number }[] = [];
  const blockHasMatch = blocks.map(() => false);
  blocks.forEach((lines, block) => {
    const counts = new Map<number, number>();
    for (let pos = 0; pos < lines.length; pos++) {
      const o = newToOld[blockStart[block] + pos];
      if (o >= 0) counts.set(olds[o].sec, (counts.get(olds[o].sec) ?? 0) + 1);
    }
    blockHasMatch[block] = counts.size > 0;
    for (const [sec, count] of counts) pairs.push({ sec, block, count });
  });
  pairs.sort((x, y) => y.count - x.count || x.block - y.block || x.sec - y.sec);
  const inheritedBy = new Map<number, number>(); // section → block
  const inherits: (number | undefined)[] = blocks.map(() => undefined);
  for (const { sec, block } of pairs) {
    if (inheritedBy.has(sec) || inherits[block] !== undefined) continue;
    inheritedBy.set(sec, block);
    inherits[block] = sec;
  }
  // Inheritance by position, anchored on the blocks with matched lines.
  const lyricSecs = chart.flatMap((_, sec) => (hasLyrics[sec] ? [sec] : []));
  const rank = new Map(lyricSecs.map((sec, i) => [sec, i]));
  const inherit = (sec: number, block: number) => {
    inheritedBy.set(sec, block);
    inherits[block] = sec;
  };
  const freeIn = (lo: number, hi: number) =>
    lyricSecs.slice(lo, hi).filter((sec) => !inheritedBy.has(sec));
  let gapBlocks: number[] = [];
  let lo = 0; // first section rank after the previous anchor
  const fillGap = (hi: number, fromEnd: boolean) => {
    const secs = freeIn(lo, hi);
    const count = Math.min(secs.length, gapBlocks.length);
    for (let i = 0; i < count; i++) {
      if (fromEnd)
        inherit(secs[secs.length - 1 - i], gapBlocks[gapBlocks.length - 1 - i]);
      else inherit(secs[i], gapBlocks[i]);
    }
    gapBlocks = [];
  };
  blocks.forEach((lines, block) => {
    if (!blockHasMatch[block]) {
      gapBlocks.push(block);
      return;
    }
    const ranks = lines.flatMap((_, pos) => {
      const o = newToOld[blockStart[block] + pos];
      return o >= 0 ? [rank.get(olds[o].sec)!] : [];
    });
    fillGap(Math.min(...ranks), true);
    lo = Math.max(lo, Math.max(...ranks) + 1);
  });
  fillGap(lyricSecs.length, false);
  // Leftovers (e.g. swapped sections): free sections in order.
  const leftSecs = freeIn(0, lyricSecs.length);
  blocks.forEach((_, block) => {
    if (blockHasMatch[block] || inherits[block] !== undefined) return;
    const sec = leftSecs.shift();
    if (sec !== undefined) inherit(sec, block);
  });

  // Non-lyric lines.
  const attachments: Attachment[][] = blocks.map(() => []);
  const orphans: ChartLine[] = [];
  const firstMatchedFrom = (k: number) => {
    for (let i = k; i < n; i++) if (oldToNew[i] >= 0) return i;
    return -1;
  };
  const lastMatchedBefore = (k: number) => {
    for (let i = k - 1; i >= 0; i--) if (oldToNew[i] >= 0) return i;
    return -1;
  };
  const before = (o: number) => ({ block: newOf(o).block, pos: newOf(o).pos });

  /** Target of a non-lyric line of `sec`; `k` = index of the next old lyric. */
  function target(
    sec: number,
    k: number,
    line: ChartLine,
  ): { block: number; pos: number } | undefined {
    const own = secOlds[sec];
    const nextInSec = k < n && olds[k].sec === sec;
    const prev = own.filter((o) => o < k && kept(o)).pop() ?? -1;
    const next = own.find((o) => o >= k && kept(o)) ?? -1;
    if (nextInSec && kept(k)) return before(k);
    if (prev >= 0) {
      const { block, pos } = newOf(prev);
      if (nextInSec) return { block, pos: pos + 1 };
      const g = firstMatchedFrom(k);
      return {
        block,
        pos: g >= 0 && newOf(g).block === block ? newOf(g).pos : END,
      };
    }
    if (next >= 0) return before(next);
    const b = inheritedBy.get(sec);
    if (b !== undefined)
      return { block: b, pos: nextInSec ? olds[k].ord : END };
    const g = firstMatchedFrom(k);
    if (g >= 0) return before(g);
    if (blocks.length > 0) return { block: blocks.length - 1, pos: END };
    if (!isBlankLine(line)) orphans.push(line);
    return undefined;
  }

  let order = 0;
  let k = 0; // index in `olds` of the next old lyric line
  chart.forEach((section, sec) => {
    if (!hasLyrics[sec]) {
      order += section.lines.length;
      return;
    }
    section.lines.forEach((line, idx) => {
      order++;
      if (k < n && olds[k].sec === sec && olds[k].idx === idx) {
        k++;
        return;
      }
      const t = target(sec, k, line);
      if (t) attachments[t.block].push({ pos: t.pos, order, line });
    });
  });

  // Sections without lyric lines: slot g = "before block g".
  const firstLyricSec = olds.length > 0 ? olds[0].sec : Infinity;
  const keptSecs: { slot: number; sec: number }[] = [];
  chart.forEach((_, sec) => {
    if (hasLyrics[sec]) return;
    const nBefore = olds.filter((o) => o.sec < sec).length;
    const p = lastMatchedBefore(nBefore);
    const f = firstMatchedFrom(nBefore);
    let slot: number;
    if (p >= 0) slot = newOf(p).block + 1;
    else if (f >= 0) slot = newOf(f).block;
    else slot = sec < firstLyricSec ? 0 : blocks.length;
    keptSecs.push({ slot, sec });
  });

  // Labels for new blocks.
  const used = new Set<string>();
  for (const sec of inheritedBy.keys()) used.add(chart[sec].label);
  for (const { sec } of keptSecs) used.add(chart[sec].label);
  const blockSections: ChartSection[] = blocks.map((lines, b) => {
    const atts = attachments[b].sort(
      (x, y) => x.pos - y.pos || x.order - y.order,
    );
    const out: ChartLine[] = [];
    let a = 0;
    lines.forEach((t, pos) => {
      while (a < atts.length && atts[a].pos <= pos) out.push(atts[a++].line);
      const o = newToOld[blockStart[b] + pos];
      out.push(o >= 0 ? olds[o].line : { segments: [{ lyrics: t }] });
    });
    while (a < atts.length) out.push(atts[a++].line);

    const sec = inherits[b];
    if (sec !== undefined) {
      const { kind, label } = chart[sec];
      // An implicit section cannot hold blank lines.
      const body = kind === '' ? out.filter((l) => !isBlankLine(l)) : out;
      return { kind, label, lines: body };
    }
    const label = nextSectionLabel(used);
    used.add(label);
    return { kind: 'verse', label, lines: out };
  });

  const result: ChartSection[] = [];
  for (let g = 0; g <= blocks.length; g++) {
    for (const { slot, sec } of keptSecs)
      if (slot === g) result.push(chart[sec]);
    if (g < blocks.length) result.push(blockSections[g]);
  }
  if (orphans.length > 0) result.push({ kind: '', label: '', lines: orphans });

  return { ...song, chart: result };
}
