/**
 * Spike 8 T2 (docs/audio-spike8-plan.md decision 5, §3, §4-4): counts the truth segments per split x chord kind,
 * before the hold-out is opened, so the plan knows which kinds reach 20 segments per split. NUMBERS ONLY: no chord
 * name, progression, key, tempo or title is printed or written (count.test.ts fixes that).
 *
 * Reads (after ONE 'count' line in out/results/heldout-log.jsonl: guard.ts beginCount, task / commit / folders):
 *  - recordings: the scores, read as the truth is read (recScores.ts readScore: the app's own dash-chart parser; one
 *    segment per chord per bar, which recScores.test.ts checks against the intake templates). Dev a-f
 *    (bass-scores/) and g-j (chord-scores/); hold-out k-n (recordings/chd-heldout-scores/, gitignored): the `jp` and
 *    `cp` takes share one score, so each letter counts once.
 *  - synthetic: the recipe before rendering (render/chords2 allC2Variants + chartOf, what `--list` lists); no wav and
 *    no truth JSON is opened. Every file of a split counts (the variations of a seed repeat its chart).
 * A chord whose quality-making note is only in the bass (score.ts ベースにだけある音) is counted in its own row, as
 * the scorer leaves it out of the per-quality numbers. Excluded bars of a take (intake, if any) are not subtracted.
 *
 * CLI (from spikes/analysis; committed, clean code; once):
 *   npx tsx ts/chords2/eval/count.ts --task T2 --commit <HEAD>
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chartOf } from '../../../render/chords2/render';
import { allC2Variants, type C2Split } from '../../../render/chords2/variants';
import { argOf } from '../../bass/evalCommon';
import { DEV, DEV_DIR, HELDOUT, HELDOUT_DIR, parseChordText, scoreOf, type Score } from '../recScores';
import { stageQualities } from '../vocab';
import { beginCount, commitArg, ROOT, type CountRequest } from './guard';
import { bassOnlyAlternative } from './score';

/** The chord kinds of the full vocabulary (V0-V3), in vocab order. */
export const KINDS: readonly string[] = stageQualities('V3');
/** The stage sums the plan asks for (E1 = the 7th family, E2; plan §2.3). */
export const GROUPS: Readonly<Record<string, readonly string[]>> = {
  'E1 7 度の仲間（7・min7・maj7・m7b5）': ['7', 'min7', 'maj7', 'm7b5'],
  'E2（6・m6・mM7）': ['6', 'm6', 'mM7'],
};
export const BASS_SCORES = join(ROOT, 'bass-scores');
export const BASS_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

/** A truth segment as the count sees it: nothing but its kind and where its bass sits. */
export interface KindChord {
  root: number;
  quality: string;
  /** the written `/X` as a pitch class, null = the root */
  bass: number | null;
}

export interface Counts {
  files: number;
  segments: number;
  /** segments under the ベースにだけある音 rule (not in byKind) */
  bassOnly: number;
  byKind: Record<string, number>;
}

export const emptyCounts = (): Counts => ({ files: 0, segments: 0, bassOnly: 0, byKind: Object.fromEntries(KINDS.map((k) => [k, 0])) });

/** Adds one file's segments (pure). Throws on a kind outside the vocabulary (the scorer would drop it). */
export function addFile(c: Counts, chords: readonly KindChord[]): Counts {
  c.files++;
  for (const ch of chords) {
    if (!(ch.quality in c.byKind)) throw new Error('a chord kind outside the chords2 vocabulary');
    c.segments++;
    if (ch.bass !== null && bassOnlyAlternative(ch.quality, (ch.bass - ch.root + 12) % 12) !== null) c.bassOnly++;
    else c.byKind[ch.quality]++;
  }
  return c;
}

/** The segments of a recording score: one per chord per bar (pure). An unreadable chord throws without naming it. */
export const scoreSegments = (s: Score): KindChord[] =>
  s.bars.flatMap((bar) =>
    bar.map((c) => {
      try {
        return parseChordText(c.text);
      } catch {
        throw new Error('a score chord outside the chords2 vocabulary');
      }
    }),
  );

/** The segments of a synthetic file from its recipe (pure; nothing rendered or read). */
export const recipeChords = (v: Parameters<typeof chartOf>[0]): KindChord[] => chartOf(v).chords.map((c) => c.chord);

/** The count table: one row per kind, the stage sums, the bass-only row, totals; one column per split (pure). */
export function countTable(cols: readonly (readonly [string, Counts])[]): string {
  const row = (label: string, f: (c: Counts) => number) => `| ${label} | ${cols.map(([, c]) => String(f(c))).join(' | ')} |`;
  return [
    `| 種類 | ${cols.map(([l]) => l).join(' | ')} |`,
    `| --- | ${cols.map(() => '---:').join(' | ')} |`,
    ...KINDS.map((k) => row(`\`${k}\``, (c) => c.byKind[k])),
    ...Object.entries(GROUPS).map(([label, ks]) => row(`**${label}**`, (c) => ks.reduce((a, k) => a + c.byKind[k], 0))),
    row('ベースにだけある音', (c) => c.bassOnly),
    row('区間の合計', (c) => c.segments),
    row('ファイル（録音は楽譜）', (c) => c.files),
  ].join('\n');
}

export const SYNTH_SPLITS: readonly C2Split[] = ['tuning', 'dev', 'heldOut'];
const SPLIT_LABEL: Record<C2Split, string> = { tuning: '合成 調整用', dev: '合成 開発用', heldOut: '合成 ホールドアウト' };

export interface CountReaders {
  devScores: () => Score[];
  heldOutScores: () => Score[];
  synthetic: (split: C2Split) => KindChord[][];
}
const rel = (p: string) => `spikes/analysis/${p.slice(ROOT.length + 1)}`;
export const COUNT_FOLDERS = [rel(BASS_SCORES), rel(DEV_DIR), rel(HELDOUT_DIR), 'render/chords2 recipe (allC2Variants + chartOf; no wav, no truth JSON)'];

export const DEFAULT_READERS: CountReaders = {
  devScores: () => [...BASS_LETTERS.map((l) => scoreOf(BASS_SCORES, l)), ...DEV.map((l) => scoreOf(DEV_DIR, l))],
  heldOutScores: () => HELDOUT.map((l) => scoreOf(HELDOUT_DIR, l)),
  synthetic: (split) => allC2Variants().filter((v) => v.split === split).map(recipeChords),
};

/**
 * The count run: `begin` (logs the count line, throws on refusal) BEFORE any reader is called; then the table.
 * Returns only the table text.
 */
export function countRun(begin: () => void, r: CountReaders): string {
  begin();
  const cols: [string, Counts][] = [
    ['録音 開発用 a〜j', r.devScores().reduce((c, s) => addFile(c, scoreSegments(s)), emptyCounts())],
    ['録音 ホールドアウト k〜n（jp・cp で 1 組）', r.heldOutScores().reduce((c, s) => addFile(c, scoreSegments(s)), emptyCounts())],
    ...SYNTH_SPLITS.map((sp) => [SPLIT_LABEL[sp], r.synthetic(sp).reduce((c, chords) => addFile(c, chords), emptyCounts())] as [string, Counts]),
  ];
  return countTable(cols);
}

function main(argv: string[]): void {
  const task = argOf(argv, '--task') ?? '';
  const req: CountRequest = { task, reason: 'spike 8 decision 5: segments per split x chord kind (numbers only) before the hold-out is opened', folders: COUNT_FOLDERS };
  const text = countRun(() => {
    const line = beginCount(req, commitArg(argv));
    console.log(`count line logged: task ${line.task} commit ${line.commit?.slice(0, 7)}`);
  }, DEFAULT_READERS);
  console.log(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
