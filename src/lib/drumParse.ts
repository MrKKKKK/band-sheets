/**
 * parseDrums: strict reader of the drum alphaTex subset (M5 T12).
 * The accepted language is specified in the header comment of drum.ts
 * ("Reading"); anything else yields `{ ok: false, reason }` (a short
 * Japanese reason) and the editor keeps the section read-only (its text is
 * never rewritten).
 *
 * Normalization (what a read gives back, vs. the text):
 * - Hits are sorted into `DRUM_KIT` order (`sortHits`); `(SD)` is one hit.
 * - `.N` is read like a sticky `:N`; the writer emits `:N` instead.
 * - The `\tf` value is mapped to a `Shuffle` from any accepted alias; no
 *   `\tf` → 'none'. A body with a `\tf` but no beats keeps the read shuffle
 *   (the writer still writes '' for it).
 * - `{tu N D}` (explicit denominator) reads for any valid N; the
 *   one-argument `{tu N}` only reads for the N values alphaTab itself
 *   accepts without a denominator (3,5,6,7,9,10,11,12) — `{tu 13}` /
 *   `{tu 14}` / `{tu 15}` with no denominator make the section read-only,
 *   since alphaTab fails to import them at all (docs/m5-review.md R3).
 *   `{tu 13 8}` reads fine and is written back as `tupletTex(13)`.
 *
 * Result shape: `{ ok: true, events, shuffle }` is assignable to
 * melodyPart's `SectionParseResult<DrumEvent>` (the extra `shuffle` field is
 * simply ignored there), so both functions can back a `SectionCodec`.
 */
import { sortHits, type DrumEvent, type DrumHit, type Shuffle } from './drum';
import { DRUM_KIT, type DrumInstrument } from './drumKit';
import {
  DURATION_TICKS,
  barTicks,
  durationTicks,
  type Duration,
  type TimeSig,
} from './melody';
import { TUPLET_UNITS, parseTupletItem, tupletDen } from './tuplet';

export type ParseDrumsResult =
  | { ok: true; events: DrumEvent[]; shuffle: Shuffle }
  | { ok: false; reason: string };

class ReadOnly extends Error {}

const fail = (reason: string): never => {
  throw new ReadOnly(reason);
};

const KIT_IDS: ReadonlySet<string> = new Set(DRUM_KIT.map((e) => e.id));

/** Accepted `\tf` values (lowercased) → shuffle. */
const TF_VALUES: ReadonlyMap<string, Shuffle> = new Map<string, Shuffle>([
  ['none', 'none'],
  ['no', 'none'],
  ['notripletfeel', 'none'],
  ['0', 'none'],
  ['triplet8th', '8'],
  ['t8', '8'],
  ['triplet-8th', '8'],
  ['2', '8'],
  ['triplet16th', '16'],
  ['t16', '16'],
  ['triplet-16th', '16'],
  ['1', '16'],
]);

type NoteEffect = 'g' | 'ac' | 'hac';

interface Effects {
  note?: NoteEffect;
  dotted: boolean;
  /** `tu N` / `tu N D`: the tuplet's n (D already checked). */
  tuplet?: number;
}

interface Beat {
  kind: 'beat';
  hits: DrumHit[];
  dotted: boolean;
  tuplet?: number;
  explicitDur?: Duration;
}

type Token = { kind: 'bar' } | { kind: 'dur'; d: Duration } | Beat;

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** Parses the content between `{` and `}`. */
function parseEffects(content: string): Effects {
  const items = content.trim() === '' ? [] : content.trim().split(/\s+/);
  if (items.length === 0) fail('空の { } は使えません');
  const fx: Effects = { dotted: false };
  const seen = new Set<string>();
  const once = (name: string) => {
    if (seen.has(name)) fail(`効果「${name}」が重複しています`);
    seen.add(name);
  };
  for (let i = 0; i < items.length; i++) {
    const name = items[i];
    if (name === 'g' || name === 'ac' || name === 'hac') {
      once(name);
      if (fx.note !== undefined) {
        fail(
          fx.note === 'g' || name === 'g'
            ? '1 つの音にゴーストとアクセントは同時に付けられません'
            : '1 つの音にアクセントは 1 つだけ付けられます',
        );
      }
      fx.note = name;
      continue;
    }
    if (name === 'd') {
      once(name);
      fx.dotted = true;
      continue;
    }
    if (name === 'tu') {
      once(name);
      const args: string[] = [];
      while (args.length < 2 && /^\d+$/.test(items[i + 1] ?? '')) {
        args.push(items[++i]);
      }
      const res = parseTupletItem(args);
      if ('error' in res) fail(res.error);
      else fx.tuplet = res.n;
      continue;
    }
    if (name === 't') fail('ドラムではタイ {t} は使えません');
    fail(`効果「${name}」はアプリでは編集できません`);
  }
  return fx;
}

function checkName(name: string): DrumInstrument {
  if (KIT_IDS.has(name)) return name as DrumInstrument;
  if (name === 'R') fail('休符は小文字の r で書いてください');
  if (KIT_IDS.has(name.toUpperCase())) {
    fail(`楽器名は大文字で書いてください（「${name}」）`);
  }
  return fail(`楽器「${name}」はアプリでは編集できません`);
}

const hitOf = (inst: DrumInstrument, note?: NoteEffect): DrumHit => {
  if (note === 'g') return { inst, ghost: true };
  if (note === 'ac') return { inst, accent: 'normal' };
  if (note === 'hac') return { inst, accent: 'heavy' };
  return { inst };
};

const noteOnly = (fx: Effects, where: string): NoteEffect | undefined => {
  if (fx.dotted || fx.tuplet !== undefined) {
    fail(`${where}の { } には g・ac・hac だけ書けます`);
  }
  return fx.note;
};

const beatOnly = (fx: Effects, where: string): Effects => {
  if (fx.note !== undefined) fail(`${where}の { } には d と tu だけ書けます`);
  return fx;
};

/** Scanner over the beat part of a section (after any leading `\tf`). */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  /** Reads `{…}` at `i` (src[i] === '{'); returns its content. */
  const braces = (): string => {
    const close = src.indexOf('}', i + 1);
    if (close < 0) fail('{ が閉じていません');
    const content = src.slice(i + 1, close);
    if (content.includes('{')) fail('{ が入れ子になっています');
    i = close + 1;
    return content;
  };

  /** Reads `.N` at `i` (src[i] === '.'). */
  const dotDuration = (): Duration => {
    let j = i + 1;
    while (j < src.length && !isSpace(src[j]) && src[j] !== '{') j++;
    const d = src.slice(i + 1, j);
    if (!Object.hasOwn(DURATION_TICKS, d)) {
      fail(`音価「.${d}」は使えません`);
    }
    i = j;
    return d as Duration;
  };

  /** A name: up to whitespace or one of `{ } . ( )`. */
  const name = (): string => {
    let j = i;
    while (j < src.length && !isSpace(src[j]) && !'{}.()'.includes(src[j])) {
      j++;
    }
    const s = src.slice(i, j);
    i = j;
    return s;
  };

  const endOfToken = () => {
    if (i < src.length && !isSpace(src[i])) {
      fail(`「${src.slice(i, i + 8).split(/\s/)[0]}」の位置が正しくありません`);
    }
  };

  /** `.N` and `{beat effects}` after a chord or a rest / single name with `.N`. */
  const tail = (beat: Beat, where: string) => {
    if (src[i] === '.') beat.explicitDur = dotDuration();
    if (src[i] === '{') {
      const fx = beatOnly(parseEffects(braces()), where);
      beat.dotted = fx.dotted;
      beat.tuplet = fx.tuplet;
    }
    endOfToken();
  };

  const chord = (): Beat => {
    i++; // (
    const hits: DrumHit[] = [];
    for (;;) {
      while (isSpace(src[i])) i++;
      if (i >= src.length) fail('（ が閉じていません');
      if (src[i] === ')') {
        i++;
        break;
      }
      if (src[i] === '(') fail('（ ）が入れ子になっています');
      const s = name();
      if (s === '') {
        if (src[i] === '.') fail('（ ）の中の音に .N は付けられません');
        if (src[i] === '}') fail('} が対応していません');
        fail('{ } は楽器名の直後に空白なしで書いてください');
      }
      if (s === 'r') fail('休符は（ ）に入れられません');
      const inst = checkName(s);
      let note: NoteEffect | undefined;
      if (src[i] === '{') note = noteOnly(parseEffects(braces()), '（ ）の中');
      if (src[i] === '.') fail('（ ）の中の音に .N は付けられません');
      if (i < src.length && !isSpace(src[i]) && src[i] !== ')') {
        fail('（ ）の中の楽器は空白で区切ってください');
      }
      hits.push(hitOf(inst, note));
    }
    if (hits.length === 0) fail('空の（ ）は使えません');
    const beat: Beat = { kind: 'beat', hits, dotted: false };
    tail(beat, '（ ）の後');
    return beat;
  };

  const single = (): Beat => {
    const s = name();
    if (s === '') {
      const c = src[i];
      if (c === '{') fail('{ } は楽器名・休符の直後に空白なしで書いてください');
      if (c === ')') fail('） が対応していません');
      if (c === '}') fail('} が対応していません');
      fail(`「${src.slice(i).split(/\s/)[0]}」はアプリでは編集できません`);
    }
    if (s === 'r') {
      const beat: Beat = { kind: 'beat', hits: [], dotted: false };
      if (src[i] === '{') {
        const fx = beatOnly(parseEffects(braces()), '休符');
        beat.dotted = fx.dotted;
        beat.tuplet = fx.tuplet;
        if (src[i] === '.') fail('休符の { } の後に .N は書けません');
        endOfToken();
        return beat;
      }
      tail(beat, '.N の後');
      return beat;
    }
    const inst = checkName(s);
    const beat: Beat = { kind: 'beat', hits: [], dotted: false };
    let note: NoteEffect | undefined;
    if (src[i] === '{') {
      const fx = parseEffects(braces());
      if (src[i] === '.') {
        // `SD{g}.8{tu 3}`: the {} before .N holds note effects only.
        note = noteOnly(fx, '.N の前');
      } else {
        // `SD{g tu 6}`: one {} mixing note and beat effects.
        note = fx.note;
        beat.dotted = fx.dotted;
        beat.tuplet = fx.tuplet;
        beat.hits = [hitOf(inst, note)];
        endOfToken();
        return beat;
      }
    }
    beat.hits = [hitOf(inst, note)];
    tail(beat, '.N の後');
    return beat;
  };

  while (i < src.length) {
    const c = src[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === '|') {
      i++;
      if (src[i] === '{') fail('小節線 | に効果は付けられません');
      endOfToken();
      tokens.push({ kind: 'bar' });
      continue;
    }
    if (c === ':') {
      let j = i + 1;
      while (j < src.length && !isSpace(src[j])) j++;
      const word = src.slice(i, j);
      const d = word.slice(1);
      if (!Object.hasOwn(DURATION_TICKS, d)) {
        fail(`音価「${word}」は使えません`);
      }
      i = j;
      tokens.push({ kind: 'dur', d: d as Duration });
      continue;
    }
    tokens.push(c === '(' ? chord() : single());
  }
  return tokens;
}

/** Splits off an optional leading `\tf <v>`; rejects every other `\`. */
function preamble(src: string): { shuffle: Shuffle; rest: string } {
  if (src.includes('//') || src.includes('/*')) {
    fail('コメントはアプリでは編集できません');
  }
  if (src.includes('"'))
    fail('引用符 " を使う書き方はアプリでは編集できません');
  let shuffle: Shuffle = 'none';
  let rest = src;
  const m = /^\s*\\tf(?=\s)\s+(\S+)/i.exec(src);
  if (m) {
    const v = TF_VALUES.get(m[1].toLowerCase());
    if (v === undefined) {
      fail(`シャッフル「\\tf ${m[1]}」はアプリでは編集できません`);
    }
    shuffle = v!;
    rest = src.slice(m[0].length);
  } else if (/^\s*\\tf\s*$/i.test(src)) {
    fail('\\tf の後に値がありません');
  }
  if (/\\tf(?![A-Za-z])/i.test(rest)) {
    fail('\\tf はセクションの最初（拍の前）にだけ書けます');
  }
  if (rest.includes('\\')) {
    fail('セクション内の \\ で始まる指定はアプリでは編集できません');
  }
  return { shuffle, rest };
}

/**
 * Reads one drum section body. `ok: false` carries a short Japanese reason
 * for the read-only notice. Throws RangeError only for an unusable `ts`.
 */
export function parseDrums(body: string, ts: TimeSig): ParseDrumsResult {
  return run(body, barTicks(ts));
}

/**
 * Lenient variant: the same language as `parseDrums` with the bar-length
 * checks switched off — `|` only separates tokens, bars may be short or
 * overfull. Every other rule (no empty bars, no `|` inside a tuplet) is
 * unchanged, so when `parseDrums` fails but this succeeds, the ONLY problem
 * is bar lengths. Note that the events may then hold beats / tuplets that
 * cross the new barlines: re-bar with `normalizeDrums` and check
 * `groupsFitBars` before serializing.
 */
export function parseDrumsIgnoringBars(body: string): ParseDrumsResult {
  return run(body, null);
}

function run(body: string, size: number | null): ParseDrumsResult {
  try {
    const { shuffle, rest } = preamble(body);
    return { ok: true, events: build(tokenize(rest), size), shuffle };
  } catch (e) {
    if (e instanceof ReadOnly) return { ok: false, reason: e.message };
    throw e;
  }
}

function build(tokens: Token[], size: number | null): DrumEvent[] {
  const events: DrumEvent[] = [];
  const bars: number[] = []; // ticks of each closed bar
  let barPos = 0;
  let barBeats = 0;
  let dur: Duration | null = null;
  let durPending = false;
  // the tuplet being read: its n, written value and slots read so far
  let group: { n: number; d: Duration; count: number } | null = null;
  const groupShort = (g: { n: number; count: number }): never =>
    fail(`${g.n} 連符の音が ${g.count} 個しかありません`);

  for (const tok of tokens) {
    if (tok.kind === 'dur') {
      dur = tok.d;
      durPending = true;
      continue;
    }
    if (tok.kind === 'bar') {
      if (barBeats === 0) fail('空の小節があります');
      if (group) fail(`${group.n} 連符が小節線をまたいでいます`);
      bars.push(barPos);
      barPos = 0;
      barBeats = 0;
      continue;
    }
    if (tok.explicitDur !== undefined) {
      dur = tok.explicitDur;
    } else if (dur === null) {
      fail('セクションの最初の拍の前に :4 か .4 などの音価が必要です');
    }
    durPending = false;
    const d = dur!;
    const seen = new Set<DrumInstrument>();
    for (const h of tok.hits) {
      if (seen.has(h.inst)) {
        fail(`同じ楽器（${h.inst}）が 1 つの拍に 2 回あります`);
      }
      seen.add(h.inst);
    }
    if (seen.has('HH') && seen.has('HO')) {
      fail('ハイハットのクローズとオープン（HH と HO）は同時に書けません');
    }
    if (tok.dotted && d === '32') fail('付点32分音符は使えません');
    const ticks = durationTicks(d, tok.dotted);
    const ev: DrumEvent = { hits: sortHits(tok.hits), ticks };
    let realTicks = ticks;
    if (tok.tuplet !== undefined) {
      const n = tok.tuplet;
      if (tok.dotted) fail('連符の中に付点の拍は使えません');
      if (!TUPLET_UNITS.includes(d)) fail('連符の音価は 2分〜32分だけです');
      let slot: number;
      if (group) {
        if (group.n !== n) fail('連符の数が途中で変わっています');
        if (group.d !== d) {
          fail('長さの違う拍が混ざる連符はアプリでは編集できません');
        }
        slot = group.count++;
        realTicks = 0; // the group's span was counted at its first slot
      } else {
        group = { n, d, count: 1 };
        slot = 0;
        realTicks = tupletDen(n) * ticks;
      }
      ev.tuplet = { n, slot };
      if (group.count === n) group = null;
    } else if (group) {
      groupShort(group);
    }
    events.push(ev);
    barPos += realTicks;
    barBeats++;
  }
  if (durPending) fail('音価指定の後に拍がありません');
  if (group) groupShort(group);
  if (barBeats > 0) bars.push(barPos);
  if (size !== null) {
    bars.forEach((t, i) => {
      const last = i === bars.length - 1;
      if (t > size) fail(`${i + 1} 小節目が長すぎます`);
      if (!last && t < size) fail(`${i + 1} 小節目が短すぎます`);
    });
  }
  return events;
}
