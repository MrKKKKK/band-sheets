/**
 * parseMelody: strict reader of the melody alphaTex subset (M4 T3).
 * The accepted language is specified in the header comment of melody.ts
 * ("Reading"); anything else yields `{ ok: false, reason }` and the editor
 * keeps the section read-only (its text is never rewritten).
 *
 * Normalization (what a read gives back for serializer output):
 * - Tied pieces (`{t}`, same pitch string) merge into one note with the
 *   summed ticks, also across barlines; lyric / chord come from the first
 *   piece. So `C4 C4{t}` inside one bar reads as one 32-tick note.
 * - A rest directly after a rest merges into it unless it carries its own
 *   `ch` (`mergeRests`, also used by the editor's `applyCommand`). Rests are split at barlines / decomposed without ties when
 *   written, so this is how they come back as one event. Consequence:
 *   two separate adjacent rests (the second without chord) read back as
 *   one rest (accepted normalization, like adjacent tied notes).
 * - Slurs carry no data of their own: they must match the melismas
 *   (`checkSlurs`, else read-only) and are dropped; a melisma without a
 *   written slur, or with a non-canonical id, is accepted and gets the
 *   canonical slur on the next write.
 * - Tuplets (M5): `{tu N}` / `{tu N D}` beats are grouped n at a time into
 *   events with `tuplet: { n, slot }` (rules in melody.ts "Reading"); rests
 *   inside a tuplet never merge. `{tu N D}` (explicit denominator) reads for
 *   any valid N; the one-argument `{tu N}` only reads for the N values
 *   alphaTab itself accepts without a denominator (3,5,6,7,9,10,11,12) —
 *   `{tu 13}` / `{tu 14}` / `{tu 15}` with no denominator make the section
 *   read-only, since alphaTab fails to import them at all (docs/m5-review.md
 *   R3). `{tu 13 8}` reads fine and is written back as `tupletTex(13)`.
 */
import {
  DURATION_TICKS,
  barTicks,
  durationTicks,
  isValidPitch,
  melismas,
  type Duration,
  type MelodyEvent,
  type TimeSig,
} from './melody';
import { TUPLET_UNITS, parseTupletItem, tupletDen } from './tuplet';

export type ParseMelodyResult =
  { ok: true; events: MelodyEvent[] } | { ok: false; reason: string };

/** `parseMelodyBeats`: like ParseMelodyResult, plus written beats per event. */
export type ParseMelodyBeatsResult =
  | { ok: true; events: MelodyEvent[]; beats: number[] }
  | { ok: false; reason: string };

/**
 * The parser's rest normalization, shared with the editor (`applyCommand`)
 * so that edited events already equal what a round trip through the text
 * gives back: a rest directly following a rest and carrying no chord of its
 * own is merged into it (ticks summed; the merged rest's lyric, if any, is
 * dropped — rests never carry lyrics in the text). Also drops a `lyric` on
 * any rest, as the serializer does. Rests inside a tuplet (`tuplet` set)
 * are never merged, neither with each other nor with a neighbouring rest.
 *
 * `map[i]` = index in `events` (output) of input event `i`; a merged rest
 * maps to the rest it was merged into. Returns the input array itself (and
 * the identity map) when nothing changes. Never mutates the input.
 */
export function mergeRests(input: readonly MelodyEvent[]): {
  events: MelodyEvent[];
  map: number[];
} {
  const mergesIntoPrev = (e: MelodyEvent, i: number) =>
    e.kind === 'rest' &&
    i > 0 &&
    input[i - 1].kind === 'rest' &&
    e.chord === undefined &&
    e.tuplet === undefined &&
    input[i - 1].tuplet === undefined;
  const needed = input.some(
    (e, i) =>
      (e.kind === 'rest' && e.lyric !== undefined) || mergesIntoPrev(e, i),
  );
  if (!needed) {
    return { events: input as MelodyEvent[], map: input.map((_, i) => i) };
  }
  const events: MelodyEvent[] = [];
  const map: number[] = [];
  input.forEach((e, i) => {
    const last = events[events.length - 1];
    if (mergesIntoPrev(e, i)) {
      events[events.length - 1] = { ...last, ticks: last.ticks + e.ticks };
    } else if (e.kind === 'rest' && e.lyric !== undefined) {
      const { lyric: _drop, ...rest } = e;
      events.push(rest);
    } else {
      events.push(e);
    }
    map.push(events.length - 1);
  });
  return { events, map };
}

class ReadOnly extends Error {}

const fail = (reason: string): never => {
  throw new ReadOnly(reason);
};

interface Effects {
  dotted: boolean;
  tie: boolean;
  lyric?: string;
  chord?: string;
  /** Slur id (`slur "<id>"` or `slur <ident>`), checked against the melismas in `build`. */
  slur?: string;
  /** `tu N` / `tu N D`: the tuplet's n (D already checked). */
  tuplet?: number;
}

type Token =
  | { kind: 'bar' }
  | { kind: 'dur'; d: Duration }
  | { kind: 'beat'; word: string; effects: Effects; explicitDur?: Duration };

const isSpace = (c: string) => /\s/.test(c);

/** Parses the content between `{` and `}` (quotes already balanced). */
function parseEffects(body: string): Effects {
  const fx: Effects = { dotted: false, tie: false };
  const seen = new Set<string>();
  let i = 0;
  const once = (name: string) => {
    if (seen.has(name)) fail(`効果「${name}」が重複しています`);
    seen.add(name);
  };
  if (body.trim() === '') fail('空の { } は使えません');
  while (i < body.length) {
    if (body[i] === ' ') {
      i++;
      continue;
    }
    let j = i;
    while (j < body.length && body[j] !== ' ' && body[j] !== '"') j++;
    const name = body.slice(i, j);
    i = j;
    if (name === 'd' || name === 't') {
      once(name);
      if (name === 'd') fx.dotted = true;
      else fx.tie = true;
      continue;
    }
    if (name === 'lyrics' || name === 'ch') {
      once(name);
      while (body[i] === ' ') i++;
      if (body[i] !== '"') fail(`「${name}」の後には "…" が必要です`);
      const end = body.indexOf('"', i + 1);
      if (end < 0) fail('引用符 " が閉じていません');
      const s = body.slice(i + 1, end);
      if (/[\r\n]/.test(s)) fail('歌詞・コードの中で改行はできません');
      if (/[{}]/.test(s)) fail('歌詞・コードに { } は使えません');
      if (s.trim() === '') fail('空の歌詞・コードは使えません');
      if (name === 'lyrics') fx.lyric = s;
      else fx.chord = s;
      i = end + 1;
      if (i < body.length && body[i] !== ' ') {
        fail('効果は空白で区切ってください');
      }
      continue;
    }
    if (name === 'slur') {
      once(name);
      while (body[i] === ' ') i++;
      if (body[i] === '"') {
        const end = body.indexOf('"', i + 1);
        if (end < 0) fail('引用符 " が閉じていません');
        const s = body.slice(i + 1, end);
        if (/[\r\n{}]/.test(s) || s.trim() === '') {
          fail('スラーの名前が正しくありません');
        }
        fx.slur = s;
        i = end + 1;
      } else {
        let j = i;
        while (j < body.length && body[j] !== ' ') j++;
        const id = body.slice(i, j);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
          fail('スラーの名前が正しくありません');
        }
        fx.slur = id;
        i = j;
      }
      if (i < body.length && body[i] !== ' ') {
        fail('効果は空白で区切ってください');
      }
      continue;
    }
    if (name === 'tu') {
      once(name);
      const args: string[] = [];
      const word = () => {
        while (body[i] === ' ') i++;
        let j = i;
        while (j < body.length && body[j] !== ' ') j++;
        return [body.slice(i, j), j] as const;
      };
      const [first, afterFirst] = word();
      if (first !== '') {
        args.push(first);
        i = afterFirst;
        const [second, afterSecond] = word();
        if (/^\d+$/.test(second)) {
          args.push(second);
          i = afterSecond;
        }
      }
      const res = parseTupletItem(args);
      if ('error' in res) fail(res.error);
      else fx.tuplet = res.n;
      continue;
    }
    if (name === '') fail('引用符 " の位置が正しくありません');
    fail(`効果「${name}」はアプリでは編集できません`);
  }
  return fx;
}

function tokenize(src: string): Token[] {
  if (src.includes('\\')) {
    fail('セクション内の \\ で始まる指定はアプリでは編集できません');
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    if (isSpace(src[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < src.length && !isSpace(src[j]) && src[j] !== '{') j++;
    const word = src.slice(i, j);
    if (word.startsWith('//') || word.startsWith('/*')) {
      fail('コメントはアプリでは編集できません');
    }
    let effects: Effects = { dotted: false, tie: false };
    let braces = false;
    if (src[j] === '{') {
      braces = true;
      let k = j + 1;
      let inQuote = false;
      while (k < src.length && (inQuote || src[k] !== '}')) {
        if (src[k] === '"') inQuote = !inQuote;
        else if (!inQuote && src[k] === '{') fail('{ が入れ子になっています');
        k++;
      }
      if (k >= src.length) {
        fail(inQuote ? '引用符 " が閉じていません' : '{ が閉じていません');
      }
      if (word === '') fail('{ } は音符・休符の直後に空白なしで書いてください');
      effects = parseEffects(src.slice(j + 1, k));
      j = k + 1;
      if (j < src.length && !isSpace(src[j])) {
        fail('} の後には空白か改行が必要です');
      }
    }
    i = j;
    tokens.push(classify(word, effects, braces));
  }
  return tokens;
}

const PITCH_LIKE = /^[A-Ga-g][^\s]*$/;

function classify(word: string, effects: Effects, braces: boolean): Token {
  if (word.includes('}')) fail('} が対応していません');
  if (word.includes('"')) fail('引用符 " の位置が正しくありません');
  if (word.startsWith('(') || word.includes(')')) {
    fail('和音（ ）はアプリでは編集できません');
  }
  if (word === '|') {
    if (braces) fail('小節線 | に効果は付けられません');
    return { kind: 'bar' };
  }
  if (word.startsWith(':')) {
    if (braces) fail('音価指定に効果は付けられません');
    const d = word.slice(1);
    if (!(d in DURATION_TICKS)) fail(`音価「${word}」は使えません`);
    return { kind: 'dur', d: d as Duration };
  }
  if (word.includes('.')) {
    const dot = word.indexOf('.');
    const base = word.slice(0, dot);
    const suffix = word.slice(dot + 1);
    const validBase = base === 'r' || isValidPitch(base);
    const validSuffix =
      suffix.indexOf('.') < 0 && Object.hasOwn(DURATION_TICKS, suffix);
    if (validBase && validSuffix) {
      // alphaTab reads a {} after `.N` as beat effects: only d / tu.
      const beatOnly =
        !effects.tie &&
        effects.lyric === undefined &&
        effects.chord === undefined &&
        effects.slur === undefined;
      if (braces && !beatOnly) {
        fail(`「.」で音価を指定した音符の {} には d と tu だけ書けます`);
      }
      return {
        kind: 'beat',
        word: base,
        effects,
        explicitDur: suffix as Duration,
      };
    }
    fail(`「${word}」の書き方（. を使う指定）はアプリでは編集できません`);
  }
  if (word === 'r' || isValidPitch(word)) {
    return { kind: 'beat', word, effects };
  }
  if (PITCH_LIKE.test(word) && /^[a-g]/.test(word)) {
    fail(`音名は大文字で書いてください（「${word}」）`);
  }
  return fail(`「${word}」はアプリでは編集できません`);
}

/**
 * Reads one section body. `ok: false` carries a short Japanese reason for
 * the read-only notice. Throws RangeError only for an unusable `ts`.
 */
export function parseMelody(src: string, ts: TimeSig): ParseMelodyResult {
  const res = parseMelodyBeats(src, ts);
  return res.ok ? { ok: true, events: res.events } : res;
}

/**
 * Like `parseMelody`, plus `beats[i]` = how many written beats were merged
 * into `events[i]` (1 + its tie continuations for a note; the number of
 * merged rest beats for a rest). Used where alphaTab's per-beat behaviour
 * matters, e.g. part-level `\lyrics` (alphaTab gives tied beats a syllable).
 */
export function parseMelodyBeats(
  src: string,
  ts: TimeSig,
): ParseMelodyBeatsResult {
  return run(src, barTicks(ts));
}

/**
 * Lenient variant (M3): the same language as `parseMelody` with the
 * bar-length checks switched off — `|` only separates tokens, bars may be
 * short or overfull, ties still merge (also across `|`). Every other rule
 * (including "no empty bars") is unchanged, so when `parseMelody` fails but
 * this succeeds, the ONLY problem is bar lengths (e.g. the song's time
 * signature changed after the notes were written). The events can then be
 * re-barred with `serializeMelody(events, newTs)`.
 */
export function parseMelodyIgnoringBars(src: string): ParseMelodyResult {
  const res = run(src, null);
  return res.ok ? { ok: true, events: res.events } : res;
}

function run(src: string, size: number | null): ParseMelodyBeatsResult {
  try {
    return { ok: true, ...build(tokenize(src), size) };
  } catch (e) {
    if (e instanceof ReadOnly) return { ok: false, reason: e.message };
    throw e;
  }
}

function build(
  tokens: Token[],
  size: number | null,
): { events: MelodyEvent[]; beats: number[] } {
  const raw: MelodyEvent[] = [];
  const rawBeats: number[] = [];
  const bars: number[] = []; // ticks of each closed bar
  let barPos = 0;
  let barBeats = 0;
  let dur: Duration | null = null;
  let durPending = false;
  // the previous beat's event (null at the start)
  let prev: MelodyEvent | null = null;
  // written beat numbers (section-wide) of each raw event's first / last beat
  const firstBeat: number[] = [];
  const lastBeat: number[] = [];
  let beatNo = 0;
  // slur ids → the beat numbers they were written on
  const slurBeats = new Map<string, number[]>();
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
      fail('セクションの最初の音の前に :4 か .4 などの音価が必要です');
    }
    durPending = false;
    const fx = tok.effects;
    const rest = tok.word === 'r';
    if (fx.dotted && dur === '32') fail('付点32分音符は使えません');
    const ticks = durationTicks(dur!, fx.dotted);
    if (rest && fx.lyric !== undefined) fail('休符に歌詞は付けられません');
    if (rest && fx.slur !== undefined) fail('休符にスラーは付けられません');
    let slot: number | undefined;
    let realTicks = ticks;
    if (fx.tuplet !== undefined) {
      const n = fx.tuplet;
      if (fx.dotted) fail('連符の中に付点の音は使えません');
      if (fx.tie) fail('連符の中でタイ {t} は使えません');
      if (!TUPLET_UNITS.includes(dur!)) {
        fail('連符の音価は 2分〜32分だけです');
      }
      if (group) {
        if (group.n !== n) fail('連符の数が途中で変わっています');
        if (group.d !== dur) {
          fail('長さの違う音が混ざる連符はアプリでは編集できません');
        }
        slot = group.count++;
        realTicks = 0; // the group's span was counted at its first slot
      } else {
        group = { n, d: dur!, count: 1 };
        slot = 0;
        realTicks = tupletDen(n) * ticks;
      }
      if (group.count === n) group = null;
    } else {
      if (group) groupShort(group);
      if (fx.tie && prev?.tuplet) {
        fail('連符の音からタイ {t} はつなげられません');
      }
    }
    if (fx.slur !== undefined) {
      const at = slurBeats.get(fx.slur) ?? [];
      if (at.length >= 2) fail(`スラー「${fx.slur}」が 3 回以上使われています`);
      slurBeats.set(fx.slur, [...at, beatNo]);
    }
    if (fx.tie) {
      if (rest) fail('休符にタイ {t} は付けられません');
      if (prev === null)
        fail('セクションの最初の音にタイ {t} は付けられません');
      if (prev!.kind === 'rest')
        fail('休符の後の音にタイ {t} は付けられません');
      if (prev!.pitch !== tok.word) {
        fail(`違う音へのタイはできません（${prev!.pitch} → ${tok.word}）`);
      }
      if (fx.lyric !== undefined || fx.chord !== undefined) {
        fail('タイでつながる音に歌詞・コードは付けられません');
      }
      prev!.ticks += ticks;
      rawBeats[rawBeats.length - 1]++;
      lastBeat[lastBeat.length - 1] = beatNo;
    } else {
      const ev: MelodyEvent = rest
        ? { kind: 'rest', ticks }
        : { kind: 'note', pitch: tok.word, ticks };
      if (fx.lyric !== undefined) ev.lyric = fx.lyric;
      if (fx.chord !== undefined) ev.chord = fx.chord;
      if (slot !== undefined) ev.tuplet = { n: fx.tuplet!, slot };
      raw.push(ev);
      rawBeats.push(1);
      firstBeat.push(beatNo);
      lastBeat.push(beatNo);
      prev = ev;
    }
    barPos += realTicks;
    barBeats++;
    beatNo++;
  }
  if (durPending) fail('音価指定の後に音がありません');
  if (group) groupShort(group);
  if (barBeats > 0) bars.push(barPos);
  if (size !== null) {
    bars.forEach((t, i) => {
      const last = i === bars.length - 1;
      if (t > size) fail(`${i + 1} 小節目が長すぎます`);
      if (!last && t < size) fail(`${i + 1} 小節目が短すぎます`);
    });
  }
  checkSlurs(raw, firstBeat, lastBeat, slurBeats);
  // Events are fresh objects owned here, so merging may reuse them.
  const { events, map } = mergeRests(raw);
  const beats = events.map(() => 0);
  map.forEach((to, from) => (beats[to] += rawBeats[from]));
  return { events, beats };
}

/**
 * Slurs are derived from melismas (spec in melody.ts): every written slur
 * must run from the first beat of a melisma's start note to the last beat
 * of its end note. Anything else (an unpaired slur, one over notes that
 * all have lyrics, one ending early…) is outside the subset → read-only.
 * A melisma WITHOUT a written slur is fine (the writer adds it).
 */
function checkSlurs(
  raw: MelodyEvent[],
  firstBeat: number[],
  lastBeat: number[],
  slurBeats: Map<string, number[]>,
): void {
  const spans = new Set(
    melismas(raw).map((m) => `${firstBeat[m.start]}-${lastBeat[m.end]}`),
  );
  for (const [id, at] of slurBeats) {
    if (at.length < 2) fail(`スラー「${id}」の終わりがありません`);
    if (!spans.has(`${at[0]}-${at[1]}`)) {
      fail(
        'スラーは、歌詞のある音から続く歌詞のない音（のばす音）にだけ付けられます',
      );
    }
  }
}
