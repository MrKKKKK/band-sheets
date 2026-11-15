# スパイク 7 T4: 採点・「元の種類」・入力の音量そろえ

想定読者: T5〜T14 で採点・基準線・関門の表を作るエージェントと、結果を確かめるユーザー。
目的: T4 で何を作ったか（指標、「落」の対応表、そろえの入口）と、再現の確認で何を確かめたかを残す。

## 指標（`spikes/analysis/ts/chords2/eval/score.ts`）

`scoreChords(truth, result, beats, vocab)`、`vocab` は `'full'`（全）か `'down'`（落）。点の取り方はスパイク 6（1 拍 2 点、拍の 25 % と 75 %、重み 0.5、正解の `X/X` は `/X` なし、結果の `/X` は根音と同じでも `/X`）。

- コード名の当たり（`name`）: ルート・種類・`/X` が全部合う。点の割合と、区間単位（正解の区間が 1 単位、その区間の点の半分以上が当たりなら当たり）の割合と Wilson 区間（z = 1.96）。
- `root`（ルートだけ）、`slashRoot`（正解に `/X` がある点でルートが合う割合。区間単位の Wilson つき）。
- `slash`: 再現率・適合率・F（スパイク 6 と同じ）。`wrongSlash`: 正解に `/X` が無い点のうち結果が `/X` を出した割合。和音のある点だけの割合は `onChordPoints`。
- `byQuality`: 種類ごとの再現率（正解側）と適合率（結果側）。ルートと種類が合ったものを当たりとする。
- `editCounts` / `editDiff`: 直す手数（スパイク 6 の数え方、100 拍あたりは `savedPer100Beats`）。結果の区間に `candidates` があれば、候補から選べば直せる数 `nameFixableByCandidate`（`name` の内数）も数える。
- 音が同じ組（`pairs.ts`）: `scorePairs` は食い違う例（`conflict`）を主、全体と食い違わない例を併記し、Wilson 区間つき。比べる読みは「音だけ」（今の語彙の読み）と「ベースだけ」（ベースがルートの読み、無ければ音だけ）。`pairReadings` で組のもう一方の読みを出す。

全: 正解の種類は `originalQuality`（なければ `quality`）。全語彙（V3 までの 20 種類と `5`）に無い正解（`13`・`aug7` など）は数えない（`droppedPoints`）。
落: 正解も結果も下の表で今の語彙に落とす。落とし先が無い正解は数えず、結果は何にも合わない。

`ts/bass/` は計画 §4.1 のとおり変えていない。`scoreBass` / `editCounts` は中で `mapVocab` を使い「全」の種類を落としてしまうので、同じ規則を `score.ts` に書き、`score.test.ts` が「落」でスパイク 6 の数と完全に同じになること（ランダムな 200 組、`mM7` を除く）を確かめる。

## 「落」の対応表（`mapDown.ts`。ノート §4.2・提案 N7）

| 全の種類                                     | 落                       |
| -------------------------------------------- | ------------------------ |
| maj・min・7・maj7・min7・dim・aug・sus4・m7b5・dim7 | そのまま                 |
| `mM7`                                        | min（スパイク 6 は落として数えなかった） |
| `m6`・`madd9`                                | min                      |
| `6`・`add9`                                  | maj                      |
| `9`                                          | 7                        |
| `m9`                                         | min7                     |
| `maj9`                                       | maj7                     |
| `7sus4`                                      | sus4                     |
| `sus2`                                       | 数えない（5 にはしない。v1a は 5 を出さず、基準が必ず負けるため） |
| `13`・`7(#9)` など（書いたままの形）         | スパイク 6 の `mapVocab`（`mM7(9)` などの mM 系は min、`aug7`・`7(b5)` は数えない） |

スパイク 6 との違いは `mM7`（→ min）の 1 行だけ（`madd9`・`m6` などは `mapVocab` がもともと同じ）。

## 「元の種類」（`py/rec_truth.py`）

`build_truth(..., original_quality=True)`、CLI は `--original-quality`。各和音に `originalQuality` を足す（`Am6` → `m6`、`C6` → `6`、`Cadd2` → `add9`、`G9` → `9`、`Dm7` → `min7`、`Caug7` → `aug7`、`Cdim7` → `dim7`。`C2` は sus2 か add9 か分からないので `2` のまま）。表に無い書き方は今までどおり書いたまま。**既定ではこの欄を出さない**（スパイク 2〜6 の出力は変わらない）。先に特性テスト（`TestOriginalQuality`、欄が無いことと `quality` が今のままであることの固定。`Cdim7` の `quality` は今も `dim`）を書いて通し、そのあとで足した。

## 入力の音量そろえの入口（`input.ts`）

`prepareInput(samples, sampleRate, normalize)`（モノ）または `prepareChannels`。順は `src/analysis/worker/runChords.ts` と同じ: 22,050 Hz に再標本化（`ts/dsp` の `resampleSinc`）→ `normalize` が真なら `src/lib/analysis/inputLevel.ts` の `normalizeLevel`（import。写していない。RMS −22 dBFS、ピーク −1 dBFS 以下）→ `analyze`。入力は変えない（同じ標本化周波数で `resampleSinc` が入力をそのまま返す場合も写す）。そろえ無しはスパイク 6 の `rec_eval.ts`（`--normalize-rms` なし）と同じ入力、そろえ有りは R3 と同じ入力。スパイクの tsconfig はもともと `src/` を import できる（render が使っている）。

## 再現の確認（`ts/chords2/eval/repro_t4.ts`。調整用の合成 72 本だけ。見る時点は使わない）

開発用の録音（a〜d）は開かないと再現できないので **やっていない**（新しい見る時点になる）。代わりにスパイク 6 の調整用の合成（`out/bass`、`split` が `tuning`）で確かめた。

- A. 採点: スパイク 6 が保存した v1a の結果（`out/bass-results/t8-tuning`）と正解を、スパイク 6 の `scoreBass`・`editCounts`・名前の当たり（`t9_sweep.ts` の規則）と、「落」の `scoreChords`・`editCounts` で採点し、同じ数になった: 採点の点 4608（重みつき）、`/X` の正解の点 1088、誤った `/X` 0 / 3520、直す手数 1494 / 4608 拍（100 拍あたり 32.42）、名前の当たり .5854（2697.5 / 4608）。
- B. 入力: そろえ無しは、72 本の WAV がスパイク 6 の `loadMono` と標本まで同じ（72 / 72）。72 本の RMS の中央値は −22.010 dBFS（スパイク 6 R3 の −22.0 と、アプリの `TARGET_RMS_DB` −22 に合う）。そろえ有りは、1 本ずつの増幅がスパイク 6 の `normalizeGainDb(rms, peak, −22)` と同じ（72 / 72。ピーク上限に当たった本は無し。中央値そのもの −22.010 を目標にした場合との差は最大 0.010 dB）。

確かめられていないもの（見る時点が要る）: 録音 a〜d の R3・T13 の数との一致。T7 の基準線（1 回目の見る時点）で、そろえ有りの a〜d がスパイク 6 R3 の数（名前 .740 など、計画 §5）に合うかを一緒に見る。

## 試験

`ts/chords2/eval/{score,mapDown,pairs,input}.test.ts`（手計算の例、Wilson の既知の値、スパイク 6 との一致、正解表 25 行での音だけ 10/25・食い違う例 3/8 など）、`py/tests/test_rec_truth.py` の `TestOriginalQuality`。
