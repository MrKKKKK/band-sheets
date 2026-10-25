/**
 * Spike 5 T4b: builds the paste-ready song texts and `.txt` templates for the
 * six drum recordings a-f. The score CONTENT (bars) is NOT in git: it lives in
 * `recordings/drum-scores/defs.ts` (gitignored) so the held-out scores (e, f)
 * stay hidden from tuning agents. This file only holds the builder, the
 * dev/held-out mapping and the checks.
 */
import { drumBars } from '../../../../../src/lib/drum';
import { parseDrums } from '../../../../../src/lib/drumParse';
import { serializeDrums } from '../../../../../src/lib/drumTex';
import { barTicks, melodyTimeSignature } from '../../../../../src/lib/melody';

export type TakeLetter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';

/** Dev/held-out decision (user, 2026-10-25; plan section 4). */
export const TAKE_ROLE: Record<TakeLetter, { heldOut: boolean; name: string }> = {
  a: { heldOut: false, name: 'drm-01-a' },
  b: { heldOut: false, name: 'drm-02-b' },
  c: { heldOut: false, name: 'drm-03-c' },
  d: { heldOut: false, name: 'drm-04-d' },
  e: { heldOut: true, name: 'drm-05-e' },
  f: { heldOut: true, name: 'drm-06-f' },
};

export interface ScoreSection {
  label: string;
  /** shuffle feel of the section: written as `\tf`. */
  shuffle: 'none' | '8' | '16';
  /** one alphaTex bar per element (beats separated by spaces, no `|`). */
  bars: string[];
}

export interface TakeDef {
  letter: TakeLetter;
  title: string;
  bpm: number;
  time: string; // '4/4'
  sections: ScoreSection[];
  /** short description for the .txt memo */
  style: string;
  /** extra playing marks the notation cannot hold: "bar instrument technique" */
  extraMarks?: string[];
}

/**
 * Grid helper: one string per instrument, one char per slot
 * ('x' hit, 'g' ghost, 'a' accent, '.' none). Returns one bar of alphaTex
 * (starting with `:N`), `slots` = 8 or 16 (or 4).
 */
export function grid(slots: 4 | 8 | 16, rows: Record<string, string>): string {
  const toks: string[] = [];
  for (let i = 0; i < slots; i++) {
    const hits: string[] = [];
    for (const [inst, pat] of Object.entries(rows)) {
      const p = pat.replace(/ /g, '');
      if (p.length !== slots) throw new Error(`grid row ${inst} has ${p.length} slots, want ${slots}`);
      const c = p[i];
      if (c === '.') continue;
      const eff = c === 'g' ? '{g}' : c === 'a' ? '{ac}' : c === 'x' ? '' : null;
      if (eff === null) throw new Error(`bad grid char ${c}`);
      hits.push(inst + eff);
    }
    toks.push(hits.length === 0 ? 'r' : hits.length === 1 ? hits[0] : `(${hits.join(' ')})`);
  }
  return `:${slots} ${toks.join(' ')}`;
}

/** Drum section body in the app's canonical form (parse then serialize). */
export function sectionBody(sec: ScoreSection, time: string): string {
  const ts = melodyTimeSignature(time);
  const tf = { none: 'none', '8': 'triplet8th', '16': 'triplet16th' }[sec.shuffle];
  const raw = `\\tf ${tf}\n${sec.bars.map((b) => `${b} |`).join('\n')}`;
  const r = parseDrums(raw, ts);
  if (!r.ok) throw new Error(`${sec.label}: ${r.reason}`);
  return serializeDrums(r.events, r.shuffle, ts);
}

/** Full ChordPro container to paste into 新しい曲 → テキスト入力. */
export function songText(def: TakeDef): string {
  const lines = [
    `{title: ${def.title}}`,
    `{tempo: ${def.bpm}}`,
    `{time: ${def.time}}`,
    '',
  ];
  let from = 1;
  for (const s of def.sections) {
    lines.push(`{start_of_verse: ${s.label}}`, `${from}〜${from + s.bars.length - 1} 小節`, '{end_of_verse}', '');
    from += s.bars.length;
  }
  lines.push('{start_of_part: Drums}', '\\instrument percussion');
  for (const s of def.sections) {
    lines.push(`\\section "${s.label}"`, sectionBody(s, def.time));
  }
  lines.push('{end_of_part}', '');
  return lines.join('\n');
}

export function totalBars(def: TakeDef): number {
  return def.sections.reduce((n, s) => n + s.bars.length, 0);
}

/** Seconds of the scored part (excluding the 1-bar count-in). */
export function durationSec(def: TakeDef): number {
  const ts = melodyTimeSignature(def.time);
  return (totalBars(def) * ts.num * 4) / ts.den / def.bpm * 60;
}

export function txtTemplate(def: TakeDef): string {
  const role = TAKE_ROLE[def.letter];
  const lines = [
    `# ${role.name} (${def.style})`,
    `bpm: ${def.bpm}`,
    `拍子: ${def.time}`,
    `叩き方: ${def.letter}`,
    `ホールドアウト: ${role.heldOut ? 'はい' : 'いいえ'}`,
    `開始: ${((60 / def.bpm) * 4).toFixed(2)}秒   # 楽譜 1 小節目の頭の秒。カウント 1 小節を含めて書き出したときの値。1 小節目の頭から書き出したなら 0秒 に直す`,
    `キット: `,
    `マイク/接続: aD5 ライン出力`,
    `クリック: 録音に入れない（カウント 1 小節）`,
    `楽譜と違って叩いた小節: `,
  ];
  for (const m of def.extraMarks ?? []) lines.push(`特殊奏法: ${m}`);
  lines.push('');
  return lines.join('\n');
}

export { drumBars, barTicks };
