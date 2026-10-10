// Chord timeline of a song (docs/audio-spike0-plan.md, T3; design
// decisions 4 and 5): where each chart chord starts, in bars and beats.
//
// Rules
// - Melody part = the FIRST non-drum part (`melodyParts(song)[0]`), the same
//   part the app's melody editor picks (`ensureMelodyPart`).
// - Each `[Chord]` belongs to the chart syllable it is written on
//   (`splitSyllables`, the same split as `chartSyllables`). A chord written
//   in the middle of a syllable (`sa[G]ints`, `き[G]ょう`) belongs to that
//   syllable; a chord between syllables (incl. after a hyphen,
//   `march-[G7]ing`) belongs to the next one.
// - The n-th chart syllable of a section = the n-th syllable of that
//   section's melody notes (`syllableStream`): notes without a lyric
//   (melisma continuations) and rests take none, so a chord lands on the
//   FIRST note of its syllable. A note carrying several syllables gives all
//   of them its own start time. The chart and note syllables must be equal,
//   text included.
// - The chord starts at that note's bar and beat; a note starting mid-beat
//   (or inside a tuplet) is rounded DOWN to its beat. Two chords on the same
//   beat: the later one wins. Repeated identical chords are kept as written.
// - Bars/beats are 0-based over the whole song, sections in chart order;
//   a section's bar count = its melody notes' length rounded UP to whole
//   bars (a short last bar still lasts a full bar in alphaTab).
// - The first chord is moved back to bar 0 beat 0 (decision 4).
//
// Restrictions (decision 5) — anything else throws a Japanese Error:
// x/4 time only (song `{time}` or the part's own `\ts`), no `\tempo` in any
// part (one tempo, from `{tempo}`), labelled chart sections in the same order
// as the melody part's `\section`s with no repeats, every section readable
// by `readSection` (status 'ok'), no chord on a line without lyrics or after
// the last syllable of a line, no lyric lines with chords outside a
// labelled section, at least one chord.

import { lineLyrics } from '../../../src/lib/chartEdit';
import { barTicks, WHOLE_TICKS, type MelodyEvent } from '../../../src/lib/melody';
import { syllableStream } from '../../../src/lib/melodyLyrics';
import {
  melodyParts,
  partSections,
  preambleOverrides,
  readSection,
} from '../../../src/lib/melodyPart';
import { parseTimeSignature } from '../../../src/lib/partsToAlphaTex';
import { isRawLine, type ChartSection, type Song } from '../../../src/lib/song';
import { splitSyllables } from '../../../src/lib/syllables';
import { tupletGroups } from '../../../src/lib/tuplet';
import type { ChordTimeline, TimelineChord } from './types';

/** A chart chord placed on a syllable index of its section. */
interface ChartChord {
  syllable: number;
  text: string;
}

const sameStart = (a: readonly string[], b: readonly string[]) =>
  a.every((s, i) => s === b[i]);

/**
 * Chords of one chart section with the index of the syllable each one sits
 * on, and the section's syllables. Lyric text = non-raw lines with
 * non-blank lyrics joined by '\n' (as in `chartSyllables`).
 */
export function chartChords(section: ChartSection): {
  syllables: string[];
  chords: ChartChord[];
} {
  const name = sectionName(section.label);
  const lines: { lyrics: string; chords: { offset: number; text: string }[] }[] =
    [];
  for (const line of section.lines) {
    if (isRawLine(line)) continue;
    const lyrics = lineLyrics(line);
    const chords: { offset: number; text: string }[] = [];
    let offset = 0;
    for (const seg of line.segments) {
      if (seg.chord !== undefined) chords.push({ offset, text: seg.chord });
      offset += seg.lyrics.length;
    }
    if (lyrics.trim() === '') {
      if (chords.length > 0) {
        throw new Error(
          `${name}: 歌詞の無い行にコード（${chords.map((c) => c.text).join(' ')}）があります。コードは歌詞の上に書いてください`,
        );
      }
      continue;
    }
    lines.push({ lyrics, chords });
  }
  const fullText = lines.map((l) => l.lyrics).join('\n');
  const syllables = splitSyllables(fullText);
  const out: ChartChord[] = [];
  let before = ''; // text of the previous lines, with their '\n'
  for (const line of lines) {
    for (const c of line.chords) {
      const rest = line.lyrics.slice(c.offset);
      if (splitSyllables(rest).length === 0) {
        throw new Error(
          `${name}: 行の最後のコード ${c.text} の後ろに歌詞がありません（「${line.lyrics}」）`,
        );
      }
      const pre = splitSyllables(before + line.lyrics.slice(0, c.offset));
      // At a syllable boundary the syllables before the chord are unchanged
      // by what follows; otherwise the chord cuts into the last of them.
      const index = sameStart(pre, syllables) ? pre.length : pre.length - 1;
      out.push({ syllable: Math.max(0, index), text: c.text });
    }
    before += line.lyrics + '\n';
  }
  return { syllables, chords: out };
}

function sectionName(label: string): string {
  return label === '' ? 'ラベルの無いセクション' : `セクション「${label}」`;
}

/** Start tick (within the section) of every event, tuplets at real positions. */
function onsets(events: readonly MelodyEvent[]): number[] {
  const groups = tupletGroups(events);
  if ('error' in groups) throw new Error(groups.error);
  const out: number[] = [];
  let pos = 0;
  let i = 0;
  for (const g of groups) {
    for (; i < g.start; i++) {
      out.push(pos);
      pos += events[i].ticks;
    }
    for (let k = 0; k < g.n; k++, i++) out.push(pos + (k * g.span) / g.n);
    pos += g.span;
  }
  for (; i < events.length; i++) {
    out.push(pos);
    pos += events[i].ticks;
  }
  out.push(pos); // total
  return out;
}

function timeSignature(song: Song, body: string): [number, number] {
  const over = preambleOverrides(body);
  if ('unsupported' in over) {
    throw new Error('メロディのパートの \\ts / \\ks が読めません');
  }
  let ts: [number, number];
  if (over.ts) ts = [over.ts.num, over.ts.den];
  else if (song.meta.time === undefined) ts = [4, 4];
  else {
    const parsed = parseTimeSignature(song.meta.time);
    if (!parsed) throw new Error(`拍子「${song.meta.time}」が読めません`);
    ts = parsed;
  }
  if (ts[1] !== 4) {
    throw new Error(
      `拍子 ${ts[0]}/${ts[1]} は扱えません（スパイク 0 は x/4 の曲だけ）`,
    );
  }
  return ts;
}

export function chordTimeline(song: Song): ChordTimeline {
  const part = melodyParts(song)[0];
  if (!part) {
    throw new Error('メロディのパート（ドラム以外のパート）がありません');
  }
  for (const p of song.parts) {
    if (/\\tempo\b/i.test(p.body)) {
      throw new Error(
        `パート「${p.name}」に \\tempo があります（スパイク 0 はテンポ 1 つの曲だけ。{tempo} で指定してください）`,
      );
    }
  }
  const ts = timeSignature(song, part.body);
  const time = { num: ts[0], den: ts[1] };
  const perBar = barTicks(time);
  const perBeat = WHOLE_TICKS / ts[1];

  for (const s of song.chart) {
    if (s.label !== '') continue;
    const chorded = s.lines.some(
      (l) => !isRawLine(l) && l.segments.some((g) => g.chord !== undefined),
    );
    if (chorded) {
      throw new Error(
        'ラベルの無いセクション（{start_of_…} の外）にコードがあります',
      );
    }
  }
  const chart = song.chart.filter((s) => s.label !== '');
  const chartOrder = chart.map((s) => s.label);
  const partOrder = partSections(part.body).sections.map((s) => s.label);
  if (
    chartOrder.length !== partOrder.length ||
    chartOrder.some((l, i) => l !== partOrder[i])
  ) {
    throw new Error(
      `コード譜のセクションの順（${chartOrder.join(' ')}）とパート「${part.name}」の \\section の順（${partOrder.join(' ')}）が違います（スパイク 0 は同じ順で繰り返し無しの曲だけ）`,
    );
  }
  if (new Set(chartOrder).size !== chartOrder.length) {
    throw new Error(
      `セクションが繰り返されています（${chartOrder.join(' ')}）。スパイク 0 は繰り返し無しの曲だけです`,
    );
  }

  const sections: ChordTimeline['sections'] = [];
  const placed: TimelineChord[] = [];
  let startBar = 0;
  for (const section of chart) {
    const name = sectionName(section.label);
    const read = readSection(part.body, section.label, time);
    if (read.status !== 'ok') {
      const why = 'reason' in read ? read.reason : 'ありません';
      throw new Error(`パート「${part.name}」の${name}が読めません: ${why}`);
    }
    const events = read.events;
    const { syllables, chords } = chartChords(section);
    const sung = syllableStream(events);
    if (sung.length !== syllables.length) {
      throw new Error(
        `${name}: コード譜の音節（${syllables.length} 個）とメロディの歌詞の音節（${sung.length} 個）の数が合いません`,
      );
    }
    const diff = sung.findIndex((s, i) => s !== syllables[i]);
    if (diff >= 0) {
      throw new Error(
        `${name}: ${diff + 1} 番目の音節がコード譜（「${syllables[diff]}」）とメロディ（「${sung[diff]}」）で違います`,
      );
    }
    // Start tick of each syllable = the start of the note carrying it.
    const at = onsets(events);
    const syllableTick: number[] = [];
    events.forEach((e, i) => {
      const n = e.kind === 'note' ? splitSyllables(e.lyric ?? '').length : 0;
      for (let k = 0; k < n; k++) syllableTick.push(at[i]);
    });
    for (const c of chords) {
      const tick = syllableTick[c.syllable];
      const bar = startBar + Math.floor(tick / perBar);
      const beat = Math.floor((tick % perBar) / perBeat);
      const last = placed.at(-1);
      if (last && last.bar === bar && last.beat === beat) placed.pop();
      placed.push({ bar, beat, text: c.text });
    }
    const bars = Math.ceil(at[at.length - 1] / perBar);
    sections.push({ label: section.label, startBar, bars });
    startBar += bars;
  }
  if (placed.length === 0) throw new Error('コード譜にコードがありません');
  placed[0] = { ...placed[0], bar: 0, beat: 0 };
  return { ts, bars: startBar, sections, chords: placed };
}

/**
 * The chord sounding on each beat, per bar (`null` before the first chord,
 * which cannot happen after `chordTimeline`). For tests and debugging.
 */
export function chordsPerBeat(t: ChordTimeline): (string | null)[][] {
  const out: (string | null)[][] = [];
  let k = -1;
  for (let bar = 0; bar < t.bars; bar++) {
    const row: (string | null)[] = [];
    for (let beat = 0; beat < t.ts[0]; beat++) {
      while (
        k + 1 < t.chords.length &&
        (t.chords[k + 1].bar < bar ||
          (t.chords[k + 1].bar === bar && t.chords[k + 1].beat <= beat))
      ) {
        k++;
      }
      row.push(k >= 0 ? t.chords[k].text : null);
    }
    out.push(row);
  }
  return out;
}
