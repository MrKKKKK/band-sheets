import { describe, expect, it } from 'vitest';
import { newAgg, type Agg } from './baselineAgg';
import { g1Lines, type Tally as T8Tally } from './t8';
import { g1LinesV1, type Tally as T10Tally } from './t10';

interface Spec {
  files?: number;
  name?: [number, number]; // point hit / n
  slashRoot?: [number, number];
  wrong?: [number, number]; // falseSlash / noSlash
  edits?: [number, number, number]; // total / fixable by candidate / nBeats
}
/** A synthetic Agg with only the fields the G1 lines read. */
const agg = (s: Spec): Agg => {
  const a = newAgg();
  a.files = s.files ?? 1;
  if (s.name) [a.nameP.hit, a.nameP.n] = s.name;
  if (s.slashRoot) [a.slashRootP.hit, a.slashRootP.n] = s.slashRoot;
  if (s.wrong) [a.wrong.falseSlash, a.wrong.noSlash] = s.wrong;
  if (s.edits) [a.edits.total, a.edits.nameFixableByCandidate, a.edits.nBeats] = s.edits;
  return a;
};
const t8Tally = (m: Record<string, Spec>): T8Tally => ({ agg: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, agg(v)])), conf: {}, fb: {}, ms: {} });
const t10Tally = (m: Record<string, Spec>): T10Tally => ({ agg: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, agg(v)])), fb: {}, sev: {}, nq: {}, pairs: {} });
const show = (ls: { line: string; value: string; target: string; pass: boolean | null; user?: boolean }[]) => ls.map((l) => `${l.pass === null ? '-' : l.pass ? 'o' : 'x'}${l.user ? '!' : ''} ${l.line}: ${l.value} | ${l.target}`);

describe('g1Lines (T8 rows against bassT8 / bassG2)', () => {
  const full = t8Tally({
    'down|cand|REC': { name: [70, 100], slashRoot: [60, 100], wrong: [1, 100], edits: [10, 2, 100] },
    'down|bassT8|REC': { name: [60, 100], slashRoot: [30, 100], edits: [20, 5, 100] },
    'down|bassG2|REC': { name: [65, 100], slashRoot: [50, 100] },
    'down|cand|B2': { name: [50, 100] },
    'down|bassT8|B2': { name: [40, 100] },
    'down|cand|B1': { slashRoot: [50, 100] },
    'down|bassT8|B1': { slashRoot: [20, 100] },
    'down|cand|LR': { name: [50, 100], wrong: [3, 100] },
    'down|bassG2|LR': { name: [60, 100] },
    'down|cand|Lpool': { name: [59, 100] },
    'down|bassG2|Lpool': { name: [60, 100] },
    'down|cand|SYN': { edits: [30, 0, 100] },
    'down|bassT8|SYN': { edits: [40, 0, 100] },
  });
  it('lists every line in order with pass / fail', () => {
    expect(show(g1Lines(full, 'cand'))).toMatchInlineSnapshot(`
      [
        "o 1 名前 落 録音 ALL（基準 +.05）: .700 | ≥ .650",
        "o 1 名前 落 合成 B2（基準 +.05）: .500 | ≥ .450",
        "o 2 /X の点のルート 録音（基準 +.20、かつ G2 既定以上）: .600 | ≥ .500",
        "o 2 /X の点のルート 合成 B1（基準 +.20）: .500 | ≥ .400",
        "o 3 誤った /X 録音 ALL: .010 | ≤ .020",
        "o 3 誤った /X 合成 LR: .030 | ≤ .050",
        "x 4 後戻り LR 名前（G2 既定 −.01）: .500 | ≥ .590",
        "o 4 後戻り L0〜L3・LV 名前（G2 既定 −.01）: .590 | ≥ .590",
        "o 4 後戻り 録音 ALL 名前（G2 既定 −.02）: .700 | ≥ .630",
        "o 5 手で直す数 / 100 拍 落 録音 ALL（基準 −1.5）: 8.0 | ≤ 13.5",
        "o 5 手で直す数 / 100 拍 落 合成（開発用 B・V・pair・B0〜B3）（基準 −1.5）: 30.0 | ≤ 38.5",
      ]
    `);
  });
  it('lists nothing for a row without data; null when a base is missing', () => {
    expect(g1Lines(t8Tally({}), 'cand')).toEqual([]);
    expect(show(g1Lines(t8Tally({ 'down|cand|REC': { name: [70, 100], slashRoot: [1, 2], wrong: [0, 10], edits: [10, 0, 100] } }), 'cand'))).toMatchInlineSnapshot(`
      [
        "- 1 名前 落 録音 ALL（基準 +.05）: .700 | ≥ -",
        "o 2 /X の点のルート 録音（基準 +.20、かつ G2 既定以上）: .500 | ≥ .000",
        "o 3 誤った /X 録音 ALL: .000 | ≤ .020",
        "- 4 後戻り 録音 ALL 名前（G2 既定 −.02）: .700 | ≥ -",
        "- 5 手で直す数 / 100 拍 落 録音 ALL（基準 −1.5）: 10.0 | ≤ -",
      ]
    `);
  });
});

describe('g1LinesV1 (V1 rows against bassG2)', () => {
  const full = t10Tally({
    'down|cand|REC': { name: [64, 100], wrong: [1, 100] },
    'down|bassG2|REC': { name: [65, 100] },
    'full|cand|REC': { edits: [10, 0, 100] },
    'full|bassG2|REC': { edits: [20, 0, 100] },
    'down|cand|LR': { name: [58, 100], wrong: [10, 100] },
    'down|bassG2|LR': { name: [60, 100] },
    'down|cand|Lpool': { name: [50, 100] },
    'down|bassG2|Lpool': { name: [60, 100] },
    'down|cand|SYN': {},
    'full|cand|SYN': { edits: [30, 0, 100] },
    'full|bassG2|SYN': { edits: [40, 0, 100] },
  });
  it('lists every line in order with pass / fail / user-decides', () => {
    expect(show(g1LinesV1(full, 'cand', null))).toMatchInlineSnapshot(`
      [
        "x! 4 後戻り LR 名前 落（採った設定 −.01）: .580（差 -0.020） | ≥ .590",
        "x 4 後戻り L0〜L3・LV 名前 落（採った設定 −.01）: .500（差 -0.100） | ≥ .590",
        "o 4 後戻り 録音 ALL 名前 落（採った設定 −.02）: .640（差 -0.010） | ≥ .630",
        "o 3 誤った /X 録音 ALL: .010 | ≤ .020",
        "x 3 誤った /X 合成 LR: .100 | ≤ .050",
        "o 5 手で直す数 / 100 拍 全 録音 ALL（採った設定 −1.5）: 10.0 | ≤ 18.5",
        "o 5 手で直す数 / 100 拍 全 合成 SYN（採った設定 −1.5）: 30.0 | ≤ 38.5",
        "- 6 新しい種類の再現率 合成 SYN（mM7・m6・6 をまとめて）: - | ≥ .600",
        "x 6 新しい種類の適合率 合成 SYN（G3 の決め手）: -（出した点 0） | ≥ .800",
      ]
    `);
  });
  it('lists nothing for a row without data', () => {
    expect(g1LinesV1(t10Tally({}), 'cand', null)).toEqual([]);
  });
});
