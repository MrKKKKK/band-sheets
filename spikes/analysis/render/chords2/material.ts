// Spike 7 T5: what the synthetic chords2 material plays (docs/audio-spike7-plan.md section 3.1): the chord charts.
//
// Sets:
//   B      spike 6's bass songs (render/bass/progressions.ts generateSong: plain / inversion / cliche / clicheMin /
//          descending / pedal sections, slash chords), voiced by voicing.ts: material for B (plan section 2.1).
//   V1-V3  songs of 4 sections x 4 bars: 3 sections drawn from the stage's templates below (together holding every
//          quality the stage adds) + 1 plain section,
//          in one major key (minor templates are written in the relative minor). V3 voices its 9th chords in one of
//          three forms per section (voicing.ts NINE_FORMS; every song has all three).
//   pair   one short phrase per truth-table row of ts/chords2/identicalPairs.ts (TRUTH_ROWS, OTHER_ROWS): the row's
//          prev -> X -> next in the row's key, with the row's bass under X, plus a few chords that set up the key.
//          A phrase may carry several rows when the context is the same (A3 + B1, A6 + B5). `@ID` marks X.
// Templates are written in C major / A minor and transposed; a chart is one chord per bar or two (beats 0 and 2) or
// as written per bar. Consecutive equal chords (same name, same 9th form) are one segment.

import { generateSong } from '../bass/progressions';
import { STAGE_ADDS, type Stage } from '../../ts/chords2/vocab';
import { chordName, notePc, parseChord2, transposeChord, type Chord2 } from './chordName';
import { NINE_FORMS, isNine, type NineForm } from './voicing';

export type ChordSet = 'B' | 'V1' | 'V2' | 'V3' | 'pair';
export const CHORD_SETS: readonly ChordSet[] = ['B', 'V1', 'V2', 'V3', 'pair'];

export interface ChartChord {
  /** Beats from bar 0 beat 0 (4/4). */
  beat: number;
  beats: number;
  chord: Chord2;
  text: string;
  section: number;
  /** 9th chords only: how the piano voices it. */
  form?: NineForm;
  /** Truth-table row ids this segment is the X of (pair set). */
  rows?: string[];
}

export interface Chart {
  set: ChordSet;
  /** Vocabulary stage the material is for (B: V0; pair: the pair's stage). */
  stage: Stage;
  key: { tonic: number; minor: boolean };
  bars: number;
  sections: { label: string; startBar: number; bars: number; kind: string }[];
  chords: ChartChord[];
}

interface Template {
  kind: string;
  text: string;
}

/** V1 (mM7, m6, 6): inner-voice cliches (plan section 3.1) and the 6 / m6 chords in their usual places. */
export const V1_SECTIONS: readonly Template[] = [
  { kind: 'innerMin', text: 'Am | AmM7 | Am7 | Am6' },
  { kind: 'lineMin', text: 'Am | AmM7/G# | Am7/G | Am6/F#' },
  { kind: 'innerII', text: 'Dm DmM7 | Dm7 Dm6 | G7 | C' },
  { kind: 'innerMaj', text: 'C | Caug | C6 | C7' },
  { kind: 'minorIv', text: 'F | Fm6 | C | C6' },
  { kind: 'sixth', text: 'C6 | Am7 | Dm7 | G7' },
  { kind: 'minorIi', text: 'Bm7b5 | E7 | Am | Am6' },
];
/** V2 (sus2, 7sus4, add9, madd9): sus resolutions and pop progressions. */
export const V2_SECTIONS: readonly Template[] = [
  { kind: 'sus2', text: 'Csus2 | C | Fsus2 | F' },
  { kind: 'sus4dom', text: 'Dm7 | G7sus4 | G7 | C' },
  { kind: 'add9', text: 'Cadd9 | G/B | Am7 | Fadd9' },
  { kind: 'add9b', text: 'Fadd9 | G | Em7 | Am' },
  { kind: 'madd9', text: 'Amadd9 | Fmaj7 | C | G' },
  { kind: 'madd9Min', text: 'Am | Dmadd9 | Esus4 E7 | Am' },
  { kind: 'sus2b', text: 'C | Dsus2 D | G7sus4 | G7' },
];
/** V3 (9, m9, maj9). */
export const V3_SECTIONS: readonly Template[] = [
  { kind: 'ii9V9I', text: 'Dm9 | G9 | Cmaj9 | Cmaj9' },
  { kind: 'turn9', text: 'Cmaj9 | Am9 | Dm9 | G9' },
  { kind: 'desc9', text: 'Fmaj9 | Em9 | Dm9 | G9' },
  { kind: 'sec9', text: 'Em9 | A9 | Dm9 | G9' },
  { kind: 'dom9', text: 'Cmaj9 | C9 | Fmaj9 | G9' },
];
/** The plain section of a V-stage song (no new quality, no slash). */
export const PLAIN_SECTIONS: readonly Template[] = [
  { kind: 'plain', text: 'C | Am | F | G' },
  { kind: 'plain', text: 'C | F | G7 | C' },
  { kind: 'plain', text: 'Am | F | C | G' },
  { kind: 'plain', text: 'Dm7 | G7 | Cmaj7 | Am7' },
  { kind: 'plain', text: 'F | G | Em | Am' },
  { kind: 'plain', text: 'C | Em | F | G7' },
];
export const STAGE_SECTIONS: Record<'V1' | 'V2' | 'V3', readonly Template[]> = { V1: V1_SECTIONS, V2: V2_SECTIONS, V3: V3_SECTIONS };

/** The truth-table phrases (key = 'C' major or 'Am' minor style names; reasons per row in docs/audio-spike7-t2-truth.md). */
export interface Phrase {
  id: string;
  key: string;
  stage: Stage;
  text: string;
}
export const PHRASES: readonly Phrase[] = [
  { id: 'A1', key: 'C', stage: 'V1', text: 'C | F | G7 | C6@A1 | C6' },
  { id: 'A2', key: 'C', stage: 'V1', text: 'G7 | C | Caug | C6@A2 | C7 | F | G7 | C' },
  { id: 'A3B1', key: 'Am', stage: 'V1', text: 'Am | E7 | Am | AmM7 | Am7@A3 | Am6@B1 | Am6' },
  { id: 'A4', key: 'C', stage: 'V1', text: 'C | Em7 | Am7@A4 | Dm7 | G7 | C' },
  { id: 'A5', key: 'Am', stage: 'V1', text: 'Am | Dm7 | Am7@A5 | E7 | Am' },
  { id: 'A6B5', key: 'Am', stage: 'V1', text: 'Am | E7 | Am | AmM7/G# | Am7/G@A6 | Am6/F#@B5 | Fmaj7 | E7 | Am' },
  { id: 'A7', key: 'C', stage: 'V1', text: 'G7 | C | C6/E@A7 | F | G7 | C' },
  { id: 'A8', key: 'G', stage: 'V1', text: 'G | Am | C6@A8 | D7 | G' },
  { id: 'A9', key: 'C', stage: 'V1', text: 'C | G | Am | Am7/G@A9 | F | G | C' },
  { id: 'A10', key: 'C', stage: 'V1', text: 'C | F | C6/E@A10 | Dm7 | G7 | C' },
  { id: 'B2', key: 'G', stage: 'V1', text: 'G | C | G | Am6@B2 | D7 | G' },
  { id: 'B3', key: 'Em', stage: 'V1', text: 'Em | Am | Em | F#m7b5@B3 | B7 | Em' },
  { id: 'B4', key: 'C', stage: 'V1', text: 'C | F | C | F#m7b5@B4 | B7 | Em' },
  { id: 'B6', key: 'Em', stage: 'V1', text: 'Em | Am7 | Am6/C@B6 | B7 | Em' },
  { id: 'B7', key: 'Em', stage: 'V1', text: 'Em | B7 | Em | Am6@B7 | B7 | Em' },
  { id: 'B8', key: 'C', stage: 'V1', text: 'C | G | F#m7b5@B8 | F | C/E | Dm7 | G7 | C' },
  { id: 'B9', key: 'C', stage: 'V1', text: 'C | F/C | Fm6/C@B9 | C | G7 | C' },
  { id: 'C1', key: 'C', stage: 'V2', text: 'C | Am | Dm7 | Gsus4@C1 | G7 | C' },
  { id: 'C2', key: 'C', stage: 'V2', text: 'C | F | G7 | Csus2@C2 | C' },
  { id: 'C3', key: 'C', stage: 'V2', text: 'C | F | Csus2@C3 | F | G7 | C' },
  { id: 'C4', key: 'C', stage: 'V2', text: 'C | Am7 | Gsus4/D@C4 | G | C' },
  { id: 'C6', key: 'Am', stage: 'V2', text: 'Am | Dm | E7 | Asus2@C6 | Am' },
  { id: 'C7', key: 'C', stage: 'V2', text: 'G7 | C | Fsus2@C7 | F | G7 | C' },
  { id: 'P1', key: 'C', stage: 'V2', text: 'G7 | C | C/D@P1 | C/E | F | G7 | C' },
];

interface RawChord {
  beat: number;
  beats: number;
  name: string;
  rows: string[];
}

/** 'Dm DmM7 | Dm7 Dm6 | G7' -> chords (1, 2 or 4 per bar, evenly), `@ID[,ID]` row marks split off. */
export function parseBars(text: string, startBar = 0): RawChord[] {
  const out: RawChord[] = [];
  text.split('|').forEach((bar, b) => {
    const names = bar.trim().split(/\s+/);
    if (![1, 2, 4].includes(names.length)) throw new Error(`bar "${bar}": 1, 2 or 4 chords`);
    const beats = 4 / names.length;
    names.forEach((n, i) => {
      const [name, ids] = n.split('@');
      out.push({ beat: (startBar + b) * 4 + i * beats, beats, name, rows: ids ? ids.split(',') : [] });
    });
  });
  return out;
}

const pick = <X>(rnd: () => number, xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];

/** Adds the chords of one section; merges a chord equal to the previous one (name and form) into it. */
function pushChords(out: ChartChord[], raw: RawChord[], k: number, section: number, form?: NineForm) {
  for (const r of raw) {
    const chord = transposeChord(parseChord2(r.name), k);
    const f = isNine(chord.quality) ? (form ?? 'full') : undefined;
    const last = out[out.length - 1];
    const text = chordName(chord);
    if (last && last.text === text && last.form === f && r.rows.length === 0 && last.beat + last.beats === r.beat) {
      last.beats += r.beats;
      continue;
    }
    out.push({ beat: r.beat, beats: r.beats, chord, text, section, ...(f ? { form: f } : {}), ...(r.rows.length ? { rows: r.rows } : {}) });
  }
}

const LABELS = ['A', 'B', 'C', 'D'];

/** Spike 6's bass song, as a chart (set B). */
export function bChart(rnd: () => number): Chart {
  const song = generateSong(rnd);
  const t = song.timeline;
  const chords: ChartChord[] = [];
  t.chords.forEach((c, i) => {
    const beat = c.bar * 4 + c.beat;
    const next = t.chords[i + 1];
    const section = t.sections.findIndex((s) => c.bar >= s.startBar && c.bar < s.startBar + s.bars);
    pushChords(chords, [{ beat, beats: (next ? next.bar * 4 + next.beat : t.bars * 4) - beat, name: c.text, rows: [] }], 0, section);
  });
  return {
    set: 'B',
    stage: 'V0',
    key: { tonic: song.key, minor: false },
    bars: t.bars,
    sections: t.sections.map((s, i) => ({ ...s, kind: song.kinds[i] })),
    chords,
  };
}

/** A V1-V3 song: 3 stage sections (no repeats) + 1 plain section, shuffled; 9th forms rotate per V3 section. */
export function stageChart(stage: 'V1' | 'V2' | 'V3', rnd: () => number): Chart {
  const key = Math.floor(rnd() * 12);
  // 3 different stage sections that together hold every quality the stage adds (drawn again until they do), so every
  // seed (and so every split) has each new quality
  const covers = (ts: Template[]) => STAGE_ADDS[stage].every((q) => ts.some((t) => parseBars(t.text).some((r) => parseChord2(r.name).quality === q)));
  let chosen: Template[] = [];
  for (let tries = 0; tries === 0 || !covers(chosen); tries++) {
    if (tries === 100) throw new Error(`${stage}: no 3 sections cover the stage's qualities`);
    const pool = [...STAGE_SECTIONS[stage]];
    chosen = [];
    for (let i = 0; i < 3; i++) chosen.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  }
  chosen.push(pick(rnd, PLAIN_SECTIONS));
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }
  const formShift = Math.floor(rnd() * NINE_FORMS.length);
  const chords: ChartChord[] = [];
  const sections: Chart['sections'] = [];
  let nine = 0;
  chosen.forEach((tpl, s) => {
    const raw = parseBars(tpl.text, s * 4);
    const hasNine = raw.some((r) => isNine(parseChord2(r.name).quality));
    pushChords(chords, raw, key, s, hasNine ? NINE_FORMS[(nine++ + formShift) % NINE_FORMS.length] : undefined);
    sections.push({ label: LABELS[s], startBar: s * 4, bars: 4, kind: tpl.kind });
  });
  return { set: stage, stage, key: { tonic: key, minor: false }, bars: 16, sections, chords };
}

/** A truth-table phrase transposed by k semitones. */
export function phraseChart(p: Phrase, k: number): Chart {
  const minor = p.key.endsWith('m');
  const raw = parseBars(p.text);
  const chords: ChartChord[] = [];
  pushChords(chords, raw, k, 0);
  const bars = raw[raw.length - 1].beat / 4 + 1;
  return {
    set: 'pair',
    stage: p.stage,
    key: { tonic: (notePc(minor ? p.key.slice(0, -1) : p.key) + k) % 12, minor },
    bars,
    sections: [{ label: p.id, startBar: 0, bars, kind: 'pair' }],
    chords,
  };
}
