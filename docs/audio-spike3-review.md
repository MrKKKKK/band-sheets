# Audio spike 3 — T18 レビュー

対象: `spike/3-ts-port`（27d5296 時点。`research/audio-analysis...spike/3-ts-port`、読み取りのみ）／日付: 2026-10-17／レビュアー: Claude Opus（独立レビュー）

データは合成の変化形の名前と chart-NN の番号だけで書く（曲名・コード・調・歌詞は書かない）。CH は集計だけ。

## 総評

数値の一致は本物。報告された結果を、道具の出力ではなく結果の JSON どうしを直接比べて確かめた。

- **通しの一致（T15）**: 137 本すべてで、Python の `out/results/*.dsp-v1.json` と TS の `out/ts-results/*.json` を、`timingsSec` 以外の全部の項目で比べた。違いは次のとおり。
  - 構造・文字列・整数が違ったのは 1 本だけ（`etude-full-t90-straight-arp8__mid3` のセクションの数。そのためこの 1 本だけ `keys[].confidence` が .0285 ずれる）。
  - 拍・コード・セクションの時刻の差は最大 4.54e-5 s（22050 Hz の 1 サンプル。CH の中、変換が原因）。
  - コードの確信度・候補の確率の差は最大 9.4e-6。調の確信度は 9.7e-7、拍子の確信度は 3.6e-6。
  - コードの文字列（`?` を含む）、小節の頭、拍子、全体の調、小節ごとの調の並びは 137 本すべてで同じ。
- **原因の切り分け**: 上の 1 本は、Python の y を入れたとき（`out/ts-results-y`、15 本）には完全に一致する。だから原因は変換（リサンプル）で、報告どおり。
- **端の入力の追加の確かめ**（自作の合成音。scratchpad の中だけで作り、リポジトリには入れていない）: 22.05・32（float）・44.1・48（ステレオ）・8・96 kHz（24 bit）、ステレオ、クリップ、−80 dB の小さい音、頭の 1 秒の無音、1 秒・3 秒の短い音の 12 本。どれも Python とコード・セクション・調が同じで、拍の差は 4.5e-5 s 以下、確信度の差は 1.5e-7 以下。
- **テスト**: TS 45 ファイル・733 件と `tsc` が通る（devcontainer、`out/parity` があるので一致のテストも走った）。Python の新しい道具のテスト 12 件も通る。
- **プライバシー**: `privacy_check.py --history`（基準 `research/audio-analysis`）は OK。T15 の実行で `heldout-log.jsonl` に増えた行は `chart` の 2 行（started / finished、6fc6fbf、`adec583eb3c6`、`includeHeldOut: false`）だけ。held-out と rec の行は増えていない。`out/ts-results`（137 本）と `out/parity`（24 本）に、held-out・REC の変化形は 0 本。
- **AI を使わない**: 守られている。学習済みのモデル・コーパスは無い。表は既存の理論の表を JSON にしたもの。
- **凍結**: `py/dsp/` と `src/` の差分は 0 行。

穴は主に 3 つ。

1. 「0 本が許す差を超えた」は**点数**が同じという意味で、出力が同じという意味ではない。今回は直接の比べで結論が保たれたが、道具としては弱い。
2. メモリの 251 MB は、**読み込み（decode）を含まない**流れで、しかも MemTracker が約 100 MB を数え漏らしている。
3. 無音・NaN などの壊れた入力で、TS は Python と違う振る舞いをする。

## 必ず直す（must-fix、PR の前）

### 1. メモリの結論が実際の流れを測っていない

- **場所**:
  - `ts/browser/bench.ts:208-211`（`runMinutes` はすでにモノラルにした 44.1 kHz の配列をつないで渡す）
  - `ts/browser/bench.ts:96-103`（`decode`）
  - `ts/browser/bench.spec.ts`（`runFile` の道を一度も通らない）
- **何が起きるか**:
  - アプリで実際に起きるのは「ファイルの bytes → `decodeAudioData` → AudioBuffer → モノラル → Worker」で、これが同じ renderer のプロセスの中で起きる。
  - 5 分のステレオ 48 kHz なら、AudioBuffer だけで約 110 MB、モノラルの写しが約 58 MB、ファイルの bytes とその `slice(0)` の写しが加わる。
  - GC の時期によってはこれが解析の初めと重なり、今の +251 MB（目標 300 MB）を超えるおそれがある。
- **直し方**:
  - Playwright で `runFile` の道（`setInputFiles`）を使い、5 分のステレオ 48 kHz の合成 wav（と、できれば mp3）を通して RSS の増え方を測る。
  - 測れないなら、T20 の結論に「読み込みを含まない値」と明記する。
  - あわせて should-fix 3（`refine`）を先に直せば、余裕が約 100 MB 増える見込み。

### 2. ISC の表示が決まりの形でないファイルがある

- **場所**: `ts/dsp/beats.ts:1`
  - librosa の `feature.tempo`・`tempogram`・`beat_track` を行ごとに移したファイル。
  - 1 行目は `Ports librosa 0.11.0 ... (ISC, see ts/THIRD_PARTY.md)` で、`THIRD_PARTY.md` が決めた `(c) 2013--2023 librosa development team` の著作権の行が無い。
- **何が起きるか**: アプリに入れるときに表示を機械的に集めると、このファイルだけ漏れる。ISC は著作権の表示を残すことが条件。
- **直し方**: 1 行目を決まりの文に揃える。ほかの librosa をなぞったファイル（`audio.ts`・`chroma.ts`・`tempo.ts`・`core/cqt.ts`・`core/mel.ts`・`core/stft.ts`）は揃っている。
  - `core/resample.ts` の `toMono`（`librosa.to_mono` の平均）は自明なので、表示は不要と判断した。
  - `core/median.ts`・`*pairwiseSum` は scipy / numpy の挙動を合わせただけで、コードの写しではない。`THIRD_PARTY.md` の「NumPy・SciPy の処理の書き直しは可」に当たる。

## 直したほうがよい（should-fix、T19 へ）

### 1. `parity_report.py` が出力そのものを比べていない

- **場所**: `py/tools/parity_report.py:134-170`（`row_for`・`exceeded`）
- **何が起きるか**:
  - 比べているのは `score.py` の点数だけ。「両方が同じだけ間違う」「正解の無い項目」の違いは見えない。
  - たとえば調の正解は mod と CH にしか無い。L0〜M の 131 本では、小節ごとの調は一度も比べられていない（表の `key/bar` が `-`）。
  - セクションの名前が A,A と A,B,A,B のように違っても、F が偶然同じなら見えない。
  - 「足りない変化形」があっても終了コードが 0 なので、表を見落とすと気づかない。
- **直し方**:
  - 結果の JSON の直接の比べを足す: 構造・文字列・整数は完全一致、時刻と確信度は最大の差（このレビューで使った比べと同じ内容）。
  - 「超えた・足りない」があれば終了コードを 1 にする。
  - docstring の「numpy-free stdlib is enough」（3 行目）は誤り（`score.py` が numpy を読む）なので直す。

### 2. 壊れた入力で Python と違う振る舞い・わかりにくいエラー

- **場所**: `ts/dsp/analyze.ts:70`（入口で入力を確かめていない）、`ts/dsp/keyest.ts:102`、`ts/dsp/core/median.ts:47`
- **何が起きるか**（このレビューで再現）:
  - 10 秒の無音・長さ 0・0.1 秒・1e-40 の非正規化数だけの入力: Python は `zero-size array to reduction operation maximum` で落ちる。TS は拍 0・コード 0・セクション 0 の結果に、**全体の調「C major」（確信度 0）**を付けて、警告なしで返す。アプリでは無音のファイルに「ハ長調」と出る。
  - NaN を 1 つ含む float の WAV: Python は `Audio buffer is not finite everywhere` と分かるエラー。TS は `replaceSorted: value NaN not in window` という中の都合のエラーで落ちる。
- **直し方**:
  - `analyze()` の入口で、全部が有限かを確かめて分かるエラーにする。
  - 拍が 0 のときは、`key: null` と警告（例: `no-beats`）を返すか、Python と同じくエラーにする。どちらにするかはユーザーと決める（Python は凍結なので、TS 側の違いとして記録する）。

### 3. `refine` が 5 分で約 160 MB の float64 を数えずに作る

- **場所**: `ts/dsp/beats.ts:339-342`
  - `ax`・`convolveSame` の出力・`rise` は、どれも信号の長さの `Float64Array`。
  - 5 分なら 3 × 53 MB で、MemTracker を通っていない。
- **何が起きるか**:
  - T16 の段階ごとの `memPeak` は 152 MB で、RSS の増え方 251 MB との差の大半がこれと見られる。段階ごとのメモリの表が実際より小さく見える。
  - ピークは拍の段階（y・y_harm・y_perc の 3 本と重なる）にある。
- **直し方**:
  - `riseMax` は 1 回なめるだけで求まる。`rise` は拍の周り ±(half + w) の窓だけ要る。
  - 平滑化を流しながら計算すれば、配列を持たずに同じ値（同じ足し算の順）が出る。
  - あわせて、ほかに数えていない大きな配列（`core/cqt.ts` のカーネル、`posterior.ts` の alpha・beta、`resample.ts` の tap の表）を MemTracker に通すか、「数えていないもの」を `mem.ts` に書く。

### 4. 変わったサンプリング周波数で、変換の tap の表が数十〜百 MB になる

- **場所**: `ts/dsp/core/resample.ts:325-361`（`sincPlan`、`planCache`）
- **何が起きるか**:
  - `up = 22050 / gcd(from, 22050)` なので、周波数によって表が大きくなる。
  - 実測: 44056 Hz で 30.6 MB・0.7 s、44101 Hz で 61.6 MB・1.2 s。96001 Hz では見積もりで約 140 MB。
  - この表は `planCache` に一生残り、MemTracker にも入らない。
  - 一般的な周波数（8・16・22.05・32・44.1・48・96 kHz）は 0.6 MB 以下で問題ない。
- **直し方**:
  - `up` が大きい（例: > 1024）ときは、tap をその場で計算するか、大きな表をキャッシュしない。
  - または読み込みの側で、一般的でない周波数を 44.1 kHz に揃えてから渡す。

### 5. 使われていないコード・古い説明

- `ts/browser/slice.ts`（T8 の縦の一本）と `slice.test.ts`・`slice.parity.test.ts`・`browser/score.ts`（約 370 行）は `analyze.ts` に置き換わった。どこからも読まれていない（`StageStat` の型も二重）。消す。
- `ts/dsp/core/resample.ts` の `loadMono22050`・`designHalfBand`・`cqtHalfBand`・`decimate2`・`halfBandResponse` は、テストからしか呼ばれない。比べの参照として残すなら、そう書く。
- `ts/dsp/downbeat.ts:7-9` の「beat-level margin pass は移していない」は古い（T7b で `chords.ts` の `downbeatChords` に入り、`analyze.ts:111` が使っている）。

### 6. numpy の足し算をまねる関数が 5 つ・丸めが 2 つ

- **場所**:
  - pairwise の和: `posterior.ts:25`、`keyest.ts:34`、`beats.ts:52`、`core/cqt.ts:196`（`sections.ts:175` は `beats.ts` のを使う）
  - 偶数への丸め: `beats.ts:40`、`chroma.ts:55`
- **何が起きるか**: 今はどれも同じ動き（読んで確かめた）。でも直すときに 1 つだけ変わると、一致が気づかれずに崩れる。
- **直し方**: `core/np.ts` に 1 つにまとめ、テストを 1 か所にする。

### 7. 通信しないことのテストが全体の流れを覆っていない

- **場所**: `ts/parity/noNetwork.ts` の `stubNoNetwork` は `audio.test.ts`・`slice*.test.ts`・`parity.test.ts` だけが使う。全部の段階を通す `analyze.test.ts`・`analyze.parity.test.ts` では使われていない。
- 確かめたこと:
  - `ts/dsp/**` には `fetch` などの呼び出しも、遠くの URL の import も無い。外の依存は `fft.js` だけ。
  - Worker（`browser/worker.ts:19-31`）は通信の API を消している。
  - T16 の計測では、外の origin への通信 0 回・WebSocket 0 回（`out/t16/bench.json`）。
  - `bench.ts:109` の `fetch('./clip.wav')` は、同じ origin の開発用の合成音だけ。
- **直し方**: 全体のテストでも `stubNoNetwork()` を呼ぶ。`slice*.test.ts` を消すなら、なおさら必要。

### 8. 一致のテストが `out/` 無しでは全部飛ぶ

- **何が起きるか**:
  - `*.parity.test.ts` はどれも `out/parity` が無いと skip で、CI では一致を何も守らない。
  - `chords.parity.test.ts:75` は、段階が無いと `return` して成功扱いになる。
- **直し方**:
  - 設計判断 5 が許す「数秒の合成の中間値」を `ts/fixtures/` に 1 本コミットし、通しの 1 本だけでも CI で走らせる。
  - 環境変数（例: `REQUIRE_PARITY=1`）で、skip を失敗にできるようにする。

## あると良い（nice-to-have）

- **テンポの bin**:
  - `parity_report.py:78` の代わりの指標（拍の間隔の中央値が 0.5 % 以上違う、または拍の数が違う）は、結果に効く違いを捉えるには十分。今回は拍の数が全部同じで、時刻の差は 45 µs 以下。
  - ただし計画が記録すると決めた「bin が違った本数」そのものではない。TS の CLI に `--debug` で bin を出させ、Python 側は `dump_stages` の `tempo_top2_bin` と同じ計算を全部の dev 変化形で行えば、正確に数えられる。
- **許す差を実測に合わせて締める**:
  - `analyze.parity.test.ts:30` の `FLOAT_TOL = 1e-4` は、実測 9.4e-6 の 10 倍。2e-5 にできる。
  - `parity_report.py:35` の `?` の「説明できる」帯 ±0.02 は、実測の確信度の差の約 2000 倍。記録用に ±1e-4 の数も出す。
  - ほかの「緩めた」許す差は、どれも理由が正しいと確かめた: downbeat 1e-5（入力が float32 のダンプ）、keytrack 1e-7（実測 3.1e-8）、harmony・chords 1e-6（G1）、tuning ±0.02（計画どおり）。
- **表の digest の固定**: `config.ts:282` の `TABLE_DIGESTS` は手で固定している。テスト（`config.test.ts:53`）が守っているが、実行時に読んだ表とは結びついていない。`tables_to_json.py` が digest も JSON に書き出せば、固定が要らなくなる。
- **ビルドで表示が消える**: `out/t16/dist` の Worker の bundle（gzip で 33 KB。目標の 150 KB を十分下回る）には、ISC・MIT の表示が 0 件。今は配っていないので問題ないが、アプリに入れるときは `/*! */` か license の一覧を残す（`THIRD_PARTY.md` に書いてあるとおり）。
- **再現の手順**: T15 の駆動（全部の dev 変化形で `ts/cli.ts` を回すスクリプトと、REC を除いて `run_all` を回す包み）がコミットされていない。`py/tools/` か `CLAUDE.md` に置く。
  - なお T15 の `run_all` は `out/results/summary.*` を上書きした（git 管理外。スパイク 2 のホールドアウトの値は `out/t15/` と計画の実績に残っている）。次からは結果のディレクトリを分ける。
- `ts/browser/wav.ts` は 8 bit の PCM を読めない（CLI だけの話）。

## 持ち越し

- **mp3・m4a の読み込み**:
  - 一致はすべて WAV で測った。mp3 のエンコーダの遅れ（priming、約 1,000 サンプル）の扱いは、ブラウザの decoder と Python の読み込みで違いうる。違えば結果全体が数十 ms ずれる（拍 ±5 ms の基準に触れる）。
  - m4a（AAC）は `bench.ts:77-94` の `sniffRate` が周波数を読めず、44.1 kHz の context で decode する。48 kHz の m4a（スマートフォンの録音に多い）は、ブラウザ自身の変換を通ることになり、設計判断 2（自前の変換でブラウザごとの違いをなくす）に反する。
  - アプリに入れる設計（システムの設計）で決める。
- **長い曲**: HPSS の |STFT| などは長さに比例する（5 分で +251 MB）。10 分を超える入力の上限か分割を、アプリの設計で決める。
- **網羅の限界**:
  - 既定の設定は 4/4 だけ。`keytrack-not-converged` は合成の単体のケース（`keytrack.cases.json`）でしか通っていない（137 本の通しでは 0 回）。
  - 録音での一致は決定 5 のとおり見ていない。最後に開発用の録音で一致率だけを 1 回見るかは、ユーザーと決める。
- **速さ**: 5 分で 27〜32 秒（PC の当初の目標 20 秒、G1 の「約 15 秒で十分」より遅い）。ユーザーが当面受け入れたので T17 は飛ばした。
- **変換が原因の 1 本**（M のセクション）: 閾値の近くの出入り。セクション F は記録の指標で、全体の平均は ±.05 の中。soxr と同じにはしない（LGPL）ので、このまま記録する。

## 確かめて問題がなかったこと

- 段階ごとの差し込みが、段階のつなぎ（TS の出力を TS に入れる）の違いを隠していないか: T14（Python の y から）と T15（wav から）の通しが TS の出力を TS に入れる形で、上の直接の比べで一致した。差し込みのテストは、原因を切り分ける道具として正しく使われている。
- float32 のダンプが何かを隠していないか: 差し込みのテストは float32 に丸めた入力で比べるが、通しの比べは float64 の JSON どうしで、確信度 9.4e-6 以下。
- `exceeded()` の許す差の使い方（変化形ごと ±.02 / ±.01 / ±.03、全体の平均 ±.005 / ±.05、小節の頭の位相、拍 ±5 ms の 99 %、`?` の一致 95 %）は、計画 §4 の表と一致する。
- 既定でない設定はエラーになる。`resolveConfig` が、知らない key・型の違い・既定と違う値を拒む。`DEFAULT_CONFIG` は deepFreeze されている。各段階の既定の値は `config.test.ts:109-110` で揃っていることを確かめている。
- 依存: 本番の依存は `fft.js` 4.0.4 の 1 つだけ（MIT、依存なし、lock の integrity あり）。`tsx` は開発用。vitest・vite・Playwright はリポジトリ直下の開発用で、配る bundle には入らない。GPL・LGPL・AGPL は無い。CQT の間引き・読み込みの変換は自前の Kaiser 窓の FIR で、soxr のコードは使っていない（帯の端の値だけ合わせた）。
- `dump_stages.py` は、heldOut・REC・`recordings/` の下・rec-NN の名前を、音を読む前に拒む。テストもある。
- `keytrack.cases.json` は乱数の合成の進行（seed 12）で、録音・譜の値ではない。
