# スパイク 6 T7: 通し・CLI・Worker・計測ページ

読む人: ユーザー（G1 の前に、ベースの解析がどこまでつながったかを確かめる人）と、T8（基準線）・T9〜T12 の担当。
目的: B-1・B-2 を v1a の解析の後ろにつないだ形、結果の JSON の欄、CLI とホールドアウトのガード、Worker と計測ページ、測った数、後のタスクへの申し送りを 1 か所にまとめる。

## つないだ形（`ts/bass/analyze.ts`）

`analyzeWithBass(y, { bass, commit, ...analyze の選択肢 })`:

1. ベースが切（`enabled: false`、既定）なら、凍結の `ts/dsp/analyze` をそのまま呼んで返すだけ（同じ呼び出し・同じ出力）。
2. 入なら、入力の確かめ（v1a と同じ `validateInput`）→ 低い CQT（`bassLowCqt` の段階。v1a が `y` を手放す前に計算）→ v1a の `analyze` → `bass` の段階（`applyBass`: v1a の区間と拍で `segmentBass` → `slashMarks` → `withSlash`）。
3. 段階の時間は `stats` と `analyzer.timingsSec`（`bassLowCqt`・`bass`、`total` に足す）に入る。メモリは同じ `MemTracker` で数える（低い CQT を `adopt`、終わったら `release`）。
4. 正解は読まない。`analyze.ts` の import に採点・正解・render・ファイルのコードが無いことをテストで見る。
5. B-3・B-4 はまだ無いので、`cliche.split`・`cliche.redecideRoot`・`notes.enabled` が入なら例外。

## 結果の JSON（`render/types.ts`、任意の欄だけ）

印（`/X`）のある和音だけに書く。印の無い和音は v1a のオブジェクトそのまま。

```ts
// chords[] の 1 つ（印のあるとき）
{ ...v1a の和音, bass: 'E', text: 'C/E',            // text の末尾の ? は残す（'C/E?'）
  bassConfidence: 0.42,                             // 1 位の確信度（(1 位 − 2 位) / 1 位）
  bassKind: 'inversion' | 'passing' | 'pedal',
  bassCandidates: [{ bass: 'C', confidence: 0.58 }] } // 2 位の読み（ユーザーの決定 2026-11-14）。confidence = 1 位に対する 2 位の点の比 0〜1
// 結果の一番上（ベースが入のときだけ）
bassAnalyzer: { config: 'bass-v0', configHash: '9b8d16cf12cb', commit?: '479c695' }
```

- `bassCandidates` は配列（ハミングの `candidates`、ドラムの `alts` と同じ形）。今は 2 位の 1 つだけ。2 位がルートの印（正しい `/X` の 28 %、T6）では、ここからルートに戻せる。画面は作っていない（YAGNI）。
- ベースが入の設定は `enabled: true` で、ハッシュは既定（`dfed4fc0704f`、切）と違う `9b8d16cf12cb` になる（値は T6 のまま: `slash.minConfidence` 0.1、`minBeats` 1）。
- 既定の出力は v1a と同じ: 切の `analyzeWithBass` の JSON が `analyze()` と文字列で一致するテスト（固定の fixture）、既存の `config.test.ts` の固定のテストもそのまま通る。ゴールデン・ハッシュの更新は無し。

## CLI（`ts/bass/cli.ts`、`spikes/analysis` で `npx tsx`）

- `--all [--split tuning|dev|tuning,dev] [--only GLOB] [--results DIR] [--config x.json] [--commit SHA] [--dev-look "<理由>"]`: manifest の合成を通し、`<name>.json`（結果）と `run.json`（設定・コミット・数・時間）を `out/bass-results/analyze`（または DIR）に書く。採点はしない（T8）。既定の split は調整用だけ。
- `<wav> [-o out.json]`: 1 本（manifest にある合成か、登録された録音）。標準出力・エラーには数と時間だけ（和音・音名は出さない）。
- コミットは `--commit`、`BAND_SHEETS_COMMIT`、git の順。devcontainer のワークツリーでは git が読めないので `-e BAND_SHEETS_COMMIT=<sha>` を渡す。

### ホールドアウトのガード

wav を開く前に断る（`heldout_guard.ts` を使う。glob の関数 `globRegExp` だけ切り出した）:

| 要求                                                       | 結果                                      |
| ---------------------------------------------------------- | ----------------------------------------- |
| `--split heldOut`（`tuning,heldOut` も）                   | 断る                                      |
| `--only` の glob がホールドアウトに当たる                  | 断る（調整用だけに当たる glob で可）      |
| 1 本: 音色 C・ホールドアウトの録音・確かめられない名前     | 断る                                      |
| 開発用（`--split dev`、開発用の 1 本）に `--dev-look` 無し | 断る                                      |
| 開発用に `--dev-look` あり                                 | ログに 1 行（`task: 'T7'`）書いてから通す |

確かめ方: 単体テスト（`cli.test.ts`、作り物の manifest）と、本物の `out/bass/manifest.json` で上の 6 通りを実際に打って全部が断られ、ログの行が増えないこと（1 行のまま）を見た。音色 C の wav は開いていない。

## Worker と計測ページ

- `ts/browser/worker.ts`（スパイク 3 のコードの Worker）: `RunRequest.bass`（設定の上書き、`{}` で既定値）があればベースの段階も走らせる。無ければ今までどおり（`analyzeWithBass` が `analyze` をそのまま呼ぶ）。要約に `bass: { configHash, marked }`（印の数だけ。名前は出さない）。通信の API を消す守りは今までどおり。
- 計測ページ `ts/browser/bassBench.html` / `bassBench.ts`（ポート 5186・5187）: ファイルを選ぶと、同じ音をベースなし → ありの順に解析し、段階ごとの時間・メモリ最大・コード数・`/X` の数・JSON の大きさを表に出す。
- Playwright（devcontainer）: `npx playwright test --config spikes/analysis/ts/browser/bassBench.playwright.config.ts`。調整用の `syn-b1-walking-tA-s1` で、なしは要約にベースが無くベースの段階も無い、ありはコード数が同じでベースの 2 段階が走り `/X` が 1 つ以上、無音は `[silent]`、通信は自分の origin だけ: **通る**。

## 測った数

Node（1 スレッド、CLI の `run.json`、コミット `479c695`）:

| split                 | 本数 | 音の長さ | 失敗 | v1a ms / 音 1 分 | ベースの段階 ms / 音 1 分 | 和音 | `/X` |
| --------------------- | ---- | -------- | ---- | ---------------- | ------------------------- | ---- | ---- |
| 調整用                | 72   | 51.1 分  | 0    | 2782             | 560                       | 1765 | 92   |
| 開発用（ログ 2 行目） | 96   | 67.2 分  | 0    | 2613             | 514                       | –    | –    |

- 調整用の `/X` の数（レベル別、和音数 / `/X`）: B0 470 / 6、B1 430 / 23、B2 436 / 40、B3 429 / 23。当たりかどうかは見ていない（採点は T8）。
- 開発用は `/X` の数も出していない（通せることだけを見た）。

ブラウザ（devcontainer の Chromium、計測ページ、調整用 1 本を 5 回つないだ 259 秒）:

| 項目                     | ベースなし | ベースあり | 差                                                    |
| ------------------------ | ---------- | ---------- | ----------------------------------------------------- |
| Worker の計の時間        | 17.56 s    | 20.44 s    | +2.88 s（ベースの段階 2.57 s = 音 1 分あたり 0.60 s） |
| メモリ最大（MemTracker） | 131.2 MB   | 134.1 MB   | +2.9 MB                                               |
| 結果の JSON              | 109,820 B  | 112,277 B  | +2.5 KB                                               |

5 分に直すとベースの段階は約 +3.0 秒で、§5 の「+3 秒以内」のちょうど境目（T5 の Node の見込みと同じ）。Worker の heap は Worker の中で `performance.memory` が取れず「–」。大きさ（gzip）・1・3・5 分の正式な数は T12。

## 開発用の確認（ログ 2 行目）

`heldout-log.jsonl` の 2 行目（`bass-synth-dev`、`task: 'T7'`、コミット `479c695`、設定 `9b8d16cf12cb`、96 本）。計画 T7 の終わりの条件「開発用の合成を全部通せる」のためだけに通し、点・`/X` の数は見ていない。スパイク 6 で開発用の合成を見たのは T5 の 1 回とこの 1 回。

## 終わりの条件

- 調整用・開発用の合成を全部通せる: **満たす**（失敗 0）。
- 既定の出力が v1a と同じ: **満たす**（上の固定のテスト）。
- 通信しないテスト: **満たす**（計測ページの Playwright で外への要求 0、Worker の通信 API を消す守りはそのまま）。
- テスト: `ts/bass` 全部と spikes の全体（vitest 1002 通る）、`tsc --noEmit -p spikes/analysis/tsconfig.json` 通る。

## T8 への申し送り

- 基準線の v1a の区間の結果は `out/bass-results/analyze/<name>.json`（調整用）と `out/bass-results/dev/`（開発用）にある。採点は `score.ts` の `scoreBass` を結果の `chords` と正解で呼ぶだけ（`segment_eval.ts` の `--slash` と同じ数になるはず。確かめてから使う）。開発用を採点すると見た回が増えるので、ログの行を足す。
- 正解の `G/G`（ベース = ルート）はどの結果でも当たらない（T6 の申し送り）。採点か合成かを T8 で決める。
- ベースが入の設定のハッシュは `9b8d16cf12cb`（既定の `dfed4fc0704f` は切）。基準線を固定するときはこちらを書く。
- `bassCandidates` は印のある和音だけ。印の無い和音の 2 位（`/X` の候補）を出すかは、画面を作るときに決める。
- 片付けの候補: `segment_eval.ts` の開発用ログの書き込みと `cli.ts` の `logDevLook` が重なっている（T7 では `segment_eval.ts` を変えていない）。`config.ts` の `segment.method` の型と `stayProb`（T6 から持ち越し）。
- Worker（`worker.ts`）はベースのコードを常に取り込むので、大きさの差は T12 でベースの import ありとなしの build を比べて測る。
