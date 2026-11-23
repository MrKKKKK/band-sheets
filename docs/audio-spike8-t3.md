# スパイク 8 T3 記録: 合成の新しい素材（7th の弾き方の変化・L/LR の開発用）

想定読者: T5・T7・T9 を進めるエージェントと、結果を確かめるユーザー。目的: T3 で増やした合成素材の作り方、ホールドアウトが変わっていないことの確かめ方、本数を残す。

2026-11-23 作成。仕様は `docs/audio-spike8-plan.md` §3・§7 の T3。

## 1. 作ったもの

- **7th の弾き方の変化（`c2-t-*` / `c2-d-*` だけ）**: 名前は `c2-{t|d}-{b|v1|v2}-human-s{種}-v7{top|inner|no5|wide}`。曲（和音の並び・キー・テンポ・左手・ベース）は同じ集合・種の `human` と同じで、右手の弾き方だけ違う（乱数の列は弾き方ごとに別）。`render/chords2/voicing.ts` の `Voicing7`。
  - `top`: 7 度が右手の一番上。`inner`: 7 度が一番上でも一番下でもない。`no5`: 右手が 5 度を弾かない（`7`・`maj7`・`min7`・`mM7` だけ。`m7b5`・`dim7` は 5 度を抜くと別の和音に読めるので対象外。5 度が書かれたベースなら左手が弾く）。`wide`: 近い転回形の 1 つおきの音を 1 オクターブ上げた広い弾き方（右手 G3〜E6）。
  - 7th の和音（`7`・`maj7`・`min7`・`mM7`・`m7b5`・`dim7`・`7sus4`）だけが変わる。9th の和音と他の和音は今までどおり。その弾き方が取れない和音（ベースが 7 度のとき等）は今までの弾き方に戻る。
  - 対象の集合は B・V1・V2（V3 は 9th の曲）、変化は `human` だけ（YAGNI）。ホールドアウト（種 8〜9）には作らない（`synthParams` が断る）。
  - 正解 JSON の `chords2.segments[].pcs` は 5 度抜きを反映し、`--check` もそれで音名を確かめる。
- **開発用の L・LR**: スパイク 0・2 の旧い描画（`render/cli.ts`）の `etude4`・`etude5`（etude の種 4・5。調整用は種 1、ホールドアウトは種 2・3）。調整用の etude の L0〜L3 と LR（LR は難しい弾き方も）と同じ作り方で 1 曲 11 本、計 22 本。`render/variants.ts` の `allDevVariants()`、描画は `npx tsx render/cli.ts --dev`（出力 `out/levels-dev/`。調整用の `out/` の manifest とは別）。`saints` は曲が 1 つだけなので足していない。
- **`synthSplit`（guard.ts）**: `allDevVariants()` を `dev` で足した（その 1 行だけ）。`allC2Variants()` に 7th の変化も入っているので足し直しは要らない（試験で確認。一覧に無い `c2-t/d-*` は断る）。
- **ホールドアウトの確かめ**: `render/chords2/heldout-hashes.json` = 136 本の wav の SHA-256（spike7 の描画と一致を確認済み。中身は開いていない）。`render/chords2/heldout.test.ts`: (1) 一覧が記録と同じ、(2) `out/chords2/` の `c2-h-*.wav` のハッシュが記録と同じ（wav が無ければ skip と出る）、(3) 5 本の集合 × 種 8・9 の 10 本を描き直して記録と同じ、(4) `synthSplit` が新しい名前を分ける。同じ種で同じ wav は既存の `render.test.ts` の「同じ wav・ゴールデンハッシュ」「±1 ms」も通る。

## 2. 確かめた結果

- `npx vitest run ts/chords2 render/chords2 render/variants.test.ts render/modulate.test.ts`: 29 ファイル 295 件が通った。
- `render/chords2/cli.ts --only '*-v7*' --check`: 60 本、13,290 / 13,290 音が正解の ±1 ms 以内（最大 0.0005 ms）、1,148 / 1,148 区間が正解の音名どおり。
- `npx tsc --noEmit -p .`: エラー 0。
- `render/cli.ts --dev`: 22 本。クリップ警告なし。

## 3. 本数

合成の `c2-*`（manifest）:

| 分け | 前 | 7th の変化 | 今 |
| --- | ---: | ---: | ---: |
| 調整用 `c2-t` | 276 | +36 | 312 |
| 開発用 `c2-d` | 136 | +24 | 160 |
| ホールドアウト `c2-h` | 136 | 0 | 136 |
| 計 | 548 | +60 | 608 |

7th の変化の内訳（本数）:

| 弾き方 | 調整用 | 開発用 | B | V1 | V2 |
| --- | ---: | ---: | ---: | ---: | ---: |
| top | 9 | 6 | 5 | 5 | 5 |
| inner | 9 | 6 | 5 | 5 | 5 |
| no5 | 9 | 6 | 5 | 5 | 5 |
| wide | 9 | 6 | 5 | 5 | 5 |

7th の変化 60 本の和音の数（種類別。区間 = 同じ和音が続く間を 1 つ）:

| 種類 | 調整用 | 開発用 |
| --- | ---: | ---: |
| 7 | 92 | 32 |
| min7 | 56 | 24 |
| maj7 | 8 | 12 |
| mM7 | 16 | 8 |
| m7b5 | 8 | 0 |
| 7sus4 | 12 | 8 |
| maj / min | 268 / 144 | 212 / 88 |
| aug・sus2・sus4・6・m6・add9・madd9 | 4・12・12・12・28・16・12 | 8・8・0・16・12・12・8 |

開発用の L・LR（`out/levels-dev/`、`etude4`・`etude5`）:

| 集合 | 本数 | 和音の数（区間） |
| --- | ---: | --- |
| L0 | 2 | maj 48・min 48 |
| L1 | 8 | maj 192・min 192 |
| L2 | 2 | maj 48・min 48 |
| L3 | 2 | maj 48・min 48 |
| LR | 8 | maj 208・min 204・7 8 |
| 計 | 22 | |

## 4. 気づき・持ち越し

- 開発用の 7th の変化は `m7b5` が 0 区間、`maj7` が 12 区間と少ない（調整用 `m7b5` 8、`maj7` 8）。数が要る判断には使えない。
- 開発用の L・LR は、調整用の etude（種 1）と同じく 7th をほとんど含まない（LR に `7` が 8 区間）。後戻りの見張り用であって、7th の読みを測る集合ではない。
- 旧い描画は worktree に `node_modules` が無いと `sonivox.sf2` が見つからない（`ls .worktrees/spike8/node_modules` 無し）。描画の間だけ `.worktrees/spike8/node_modules` → `../../node_modules` の symlink を張り、終わったら消した。
- `out/` は git 管理外。描き直すには上の 2 つの CLI を使う。
