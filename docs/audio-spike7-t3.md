# スパイク 7 T3: コード解析器 v2 の土台

想定読者: T4〜T12 を実装するエージェントと、スパイク 7 の結果を確かめるユーザー。
目的: T3 で何を作ったか、v1a と同じ出力になる固定のテストの中身、仮の設定のハッシュ、Viterbi の時間を残す。

## できたもの（`spikes/analysis/ts/chords2/`）

- `vocab.ts`: 段階 V0〜V3（状態 120 / 156 / 204 / 240）、新しい種類の音程の型、名前（`suffix`）、仲間の写し `FAMILY_OF`（`6`・`add9` → maj、`maj9` → maj7、`mM7`・`m6`・`madd9` → min、`m9` → min7、`9` → 7、`7sus4` → sus4、`sus2` → maj と min の強い方）。T2 の `identicalPairs.ts` にあった段階と型の定数をここへ移し、`identicalPairs.ts` は再エクスポートする（1 か所）。
- `config.ts`: 仮の値と `chords2ConfigHash`。切り替えは `stage`（V0 既定）、`bass.method`（`off`・M1〜M3）、`pairRule`（`off`・`context`・`bassRoot`）、`newQualityMargin`（0.05、v1a の `vocab_margin` と同じ仮の値）だけ。v1a の chords の値も設定に入れてあるのでハッシュに入る。
- `prior.ts`: v1a の `TheoryPrior`（変更なし）に、新しい種類を仲間の名前で渡す。`sus2` だけは maj 読みと min 読みの 2 つの事前分布の要素ごとの最大。
- `analyze.ts`: `analyze(input, cfg)`。v1a の拍・列ごとのクロマ・小節の調（`barKeys`・`barOfBeat`）を受け取り、段階の状態で Viterbi を解き直して区間と候補を作る（U1）。v1a から import で使うもの: `gateScores`（V0 の状態）、`chordPosterior`、`mergeChords`、`segmentCandidates`、`TheoryPrior`。新しく書いたもの: 複数の型を持つ状態の点、新しい種類の「はっきり勝ったときだけ」の守り、拡張した状態の Viterbi（v1a のは非公開で凍結なので写し。`BETA`・`EIGHTH_EMIS` も同じ理由で写し）、名前。
- `bass.method` が `off` でない、`pairRule` が `off` でないときは T8・T9 まで例外にする（型だけ用意）。

## 設定ハッシュ

既定（V0・全部オフ）: `607593f71c46`（`chords2.golden.test.ts` で固定。値を変えたら必ず変わる）。

## v1a と同じ出力の固定のテスト（`chords2.golden.test.ts`）

全部オフのとき、`analyze` の列（root・quality・confidence・事後確率）と区間（候補つき）が、v1a の `estimateChordsPass2` + `mergeSegments` と `toEqual` で一致する。入力は v1a の `harmony.test.ts`・`chords.test.ts` と同じ種類（種つき乱数のクロマと調、per_beat 1・2、出だしの余り拍、調なし・確信度 0、手作りのブロックコードと無音）。全部通った。このテストは音声からではなくクロマからの比較（v1a の `analyze()` は列ごとのクロマと調を外に出さないため）。

## 内声のクリシェ（`chords2.cliche.test.ts`）

Am の 3 音に動く 1 音（G# → G → F#、各 8 拍）を重ねた合成クロマ。V1 で区間が 4 つできる: `Am`・`AmM7`・`Am7`・4 つ目。V0 では 4 つにならず、`mM7`・`m6` の名前は出ない。
注意: 4 つ目は `Am6` と `F#m7b5` が同じ音で点が同じになるため、`pairRule: 'off'` では同点の規則（今の語彙の読み）で `F#m7b5` と出て、`Am6` は候補に残る（計画 §2.3 のとおり。`Am6` に決めるのは T9）。

## Viterbi の時間（合成のランダムなクロマ 480 拍 × per_beat 2、事前分布つき。列ごとの状態の数が増える分）

チョード段全体（点・事前分布・Viterbi・事後確率）の平均 3 回: V0 102 ms、V1 128 ms、V2 308 ms、V3 389 ms。V3 / V0 ≈ 3.8 倍（計画の最大 4 倍の内）。V2 で `sus2` の事前分布が 2 つになる分も含む。1 つの合成で測っただけで、T7 で本測定する。
