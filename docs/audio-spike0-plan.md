# スパイク 0 タスク計画: 評価の土台（合成音源・正解データ・採点）

2026-10-10 作成。方針は `audio-import-architecture.md`（以下「メモ」）の §8.1（評価の考え方）・§8.2（スパイク 0）・§9（決定事項）に従う。ここでは**実装はまだしない**。タスクの分け方と、事前に確かめた「できるかどうか」の結果をまとめる。

目的: 後のスパイク（1: Python ＋ librosa でコード・拍・セクション、2: ブラウザで鼻歌 → メロディ）の結果を、**答えがはっきり分かる音源**で採点できるようにする。作るものは 3 つ。

1. **合成音源**: band-sheets の曲（最初は内蔵の「聖者の行進」）を alphaTab で wav にする。コード譜からピアノの伴奏パートを自動で作り、テンポ・楽器の組み合わせ・シャッフル・クリック音を変えて何通りも作る。
2. **正解データ**: wav ごとに、拍の時刻・小節の頭・拍ごとのコード・セクションの境目・メロディの音符（始まり・高さ・長さ）を、メモ §5.2 の中間 JSON の形で書き出す（時刻は秒。wav と完全に一致させる）。
3. **採点スクリプト**: 解析結果の JSON を正解と比べ、§8.1 の「ゆるい」基準で点数を出す（Python ＋ mir_eval）。何もしない「仮の解析器」で、最初から最後まで通ることを確かめる。

## 事前に確かめたこと（2026-10-10、読み取りと小さな試しのみ）

1. **音にする処理は、ブラウザなしで Node だけで動く**（いちばん単純で確実な方法として採用）。
   - alphaTab 1.8.4 の `synth.AlphaSynth` に「何もしない出力」（`ISynthOutput` の空の実装）を渡し、`exportAudio(options, midiFile, [], transpositionPitches)` を呼ぶと、**同期的に**音の配列（`Float32Array`、ステレオ交互）が返る。画面用の `AlphaTabApi.exportAudio` はブラウザが要るが、こちらは要らない。
   - 流れ: `parseSong` → `partsToAlphaTex`（アプリの関数をそのまま使える）→ `importer.AlphaTexImporter` → `midi.MidiFileGenerator` ＋ `AlphaSynthMidiFileHandler` → `AlphaSynth.exportAudio`。音色は `node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2` を `AudioExportOptions.soundFonts` に渡す。
   - 聖者の行進（32 小節、116 BPM）で **66.2 秒の音が 0.4 秒で**できた（= 32 × 4 拍 × 60/116 秒ちょうど）。最初の音は楽譜の時刻から **1 ms 以内**に鳴る（ずれの補正は不要）。`metronomeVolume = 1` でクリック音も入る。
   - TypeScript の実行は、アプリの `src/lib` が拡張子なしの import（`./song`）を使うので Node だけでは読めない。`spikes/analysis/` に専用の `package.json` を作り **tsx**（TypeScript をそのまま実行する道具、MIT）を入れる。alphaTab はアプリの `node_modules` のもの（1.8.4）を使い、二重に入れない。
2. **シャッフル（`\tf triplet8th`）の注意**（実際の MIDI で確認）。
   - alphaTab は再生のときシャッフルを反映する。ただし対象は「拍の頭から始まる同じ長さの 8 分音符 2 つ」だけで、裏の 8 分が 1/2 → 2/3 拍の位置にずれる。拍の頭の時刻は変わらない。
   - `\tf` は**小節ごと（全パート共通）**の設定。しかも**最初のトラックがドラムでないと、`\tf` を書いた小節にしか効かない**（Vocal → Drums の順だと 0 小節目と 16 小節目だけ、Drums が先なら全小節）。→ 合成のときは**ドラムを先頭のトラックにする**。
   - 正解のメロディ・ドラムの時刻は、楽譜から自分で計算せず、**alphaTab が作った MIDI の音の始まり（ノートオン）から取る**。これで、シャッフルなどの細かい規則があっても音と正解が必ず一致する。聖者の行進のメロディには 8 分音符が無いので、シャッフルで動くのはハイハットの裏だけ。
3. **Python の環境**: PC（WSL）は Python 3.14 だが pip も venv の部品（ensurepip）も無い。band-sheets のコンテナ（Node 用）も Python 3.11 で pip が無い。sudo は使えない。→ **Docker の公式イメージ `python:3.12-slim-bookworm` で、解析用の小さなイメージを作る**のを提案（確認したい点 1）。PC にもアプリのコンテナにも何も入れずに済み、メモ §8.2 の「band-sheets とは別の環境」とも合う。3.12 にするのは、librosa が使う numba の対応が確実なため。
4. **コードの時刻**: コード譜の `[C]` は「歌詞のどの文字か」しか持っていない。そこで、コード譜の音節（`chartSyllables`）と、メロディの音符の歌詞を順番に対応させて、コードが始まる小節・拍を決める（M4 の自動割り当てと同じ考え方）。聖者の行進はコード譜とメロディの歌詞がきれいに対応する。
5. **聖者の行進にはマイナーのコードが無い**（C・F・G7・C7 だけ）。メジャー / マイナーの区別を測れないので、**コードだけの練習曲を自動で作る**（24 種の長調・短調のコード＋ 7th、乱数の種を固定）。

## 主な設計判断

1. **置き場所**（すべて `spikes/analysis/`。oxlint・prettier・`tsc -b` の対象外。アプリの `npm test` にも入らない）:
   - `render/`（TypeScript）: 曲 → 音源＋正解。`src/lib` の関数（`parseSong`・`partsToAlphaTex`・`chartSyllables`・`melodyPart.ts` の読み取り）を import して使う。テストは `spikes/analysis/vitest.config.ts`（Node 環境、`render/**/*.test.ts`）。
   - `py/`（Python）: `Dockerfile`・`requirements.txt`（バージョン固定）・採点・仮の解析器・テスト（標準の `unittest`）。
   - `out/`（**git に入れない**）: `out/<曲>/<変化形>.wav` と `.truth.json`、`out/manifest.json`、`out/results/`。どれも数秒で作り直せるので、リポジトリには音源を 1 つも入れない（小さな試験用の音も入れない）。全部で 16 本・約 100 MB の見込み。
2. **wav の形式**: モノラル（左右の平均）、44.1 kHz、16 bit。音量の正規化はしない（はみ出しだけ止める）。
3. **楽器**: ピアノ = 0（アコースティックピアノ）、メロディ = 65（アルトサックス、歌の代わり）、ドラム = チャンネル 10。楽器の番号は読み込んだ後の `track.playbackInfo.program` で変える（曲のテキストは変えない）。
4. **ピアノの伴奏**（`pianoPart.ts`）: 1 拍ごとに 4 分音符の和音。左手は根音（分数コードならその音）を C2〜B2、右手は C4 付近の密集した形（3 和音か 7th）。コードの無い最初の部分（弱起の小節など）は**最初のコードを前に伸ばす**（伴奏が無いと拍の正解が音に無くなるため）。正解のコードも同じ規則で付ける。
5. **曲の構成の制限**（スパイク 0）: 拍子は x/4 だけ、テンポは 1 つ、コード譜のセクションの順 = パートの `\section` の順（繰り返し無し）。alphaTab はパートの本文を上から順に鳴らすので、コード譜の順で繰り返す曲は正解がずれる。外れる曲は日本語のエラーで止める。
6. **変化形（16 本）**: 聖者の行進 = テンポ 80・116・160 × 組み合わせ（ピアノだけ／＋ドラム／＋ドラム＋メロディ）を全部まっすぐ（`\tf none` に置き換え）で 9 本、シャッフルあり（書かれたまま）を 116 の「＋ドラム」「全部」で 2 本、クリックあり（116・全部）1 本。練習曲 = テンポ 90・140 × （ピアノだけ／＋ドラム）で 4 本。名前は `full-t116-shuffle` のように。
7. **正解の取り方**（`truth.ts`）: 拍・小節の頭 = alphaTab の小節の開始 tick と拍子から。秒 = tick ÷ 960 × 60 ÷ テンポ（テンポの変化が無いことを確かめる）。セクション = 小節の `section`（コード譜の順と一致することを確かめる）。メロディ・ドラム = MIDI のノートオン／オフ。コード = 4 のコードの時刻表から、拍ごとに。
8. **採点の基準**（`score.py`、メモ §8.1 の 2 を具体化）:
   - 拍: `mir_eval.beat.f_measure`（±70 ms）。`mir_eval.beat.evaluate` は**最初の 5 秒を捨てる**ので使わない。小節の頭も同じ F 値で別に出す。
   - コード（拍ごと）: 正解の各拍について、その拍の**真ん中の時刻**で解析結果のコードを見る。ルート（音の高さの種類 0〜11、`C#` と `Db` は同じ）とメジャー / マイナー（maj・7・maj7 → メジャー、min・min7 → マイナー、それ以外は数えない）が合えば当たり。正解が「コード無し」の拍は数えない。小節ごとの値（小節の中で一番長いコード同士）と、7th の有無の正解率（ルートとメジャー / マイナーが当たった拍の中で）も出す。参考に `mir_eval.chord.majmin`（時間の長さで重み付け）も出す。
   - メロディ: 16 分音符より短い音は正解・解析の両方から除く。`mir_eval.transcription.precision_recall_f1_overlap`（始まり ±50 ms、高さは半音まで一致、終わりは見ない）。
   - セクション: `mir_eval.segment.detection`（幅 = 1 小節の秒数、曲の最初と最後の境目は除く）。名前（A・B）は採点しない。
   - 解析結果に無い項目は「未評価」（null）にする。結果は変化形 × 解析器ごとの JSON と、一覧の表（Markdown と CSV）。
9. **仮の解析器**（`baseline.py`）: ①「定数」= 0 秒から 120 BPM の拍、4 拍ごとに小節の頭、曲全体が C メジャー、セクション 1 つ、メロディ無し。②「答えの写し」= 正解をそのまま返す（全部 1.0 になるはず）。採点のテストでは②の拍を 60 ms ずらすと当たり、80 ms ずらすと外れることも確かめる。
10. **音と正解のずれの確認**（`check_alignment.py`）: ピアノだけの wav で librosa の音の始まりの検出をし、正解の拍との差の中央値が 20 ms 未満であることを確かめる（「秒が音と一致している」ことの機械的な確認。スパイク 1 の環境の確認も兼ねる）。

## タスク

各タスクは自分の「主なファイル」だけを変更する（同じ波の中でファイルが重ならない）。テストは対象だけを実行する（WSL が落ちやすいため。全体の `npm test` は流さない。アプリのコードは変えないので不要）。自分が起動していないプロセスは止めない。

コマンド（以下 `BS` = `docker exec -u node -w /workspaces/band-sheets band-sheets`、`PY` = `docker run --rm -u 1000:1000 -e HOME=/tmp -e NUMBA_CACHE_DIR=/tmp -v /home/mrk5/projects/band-sheets/spikes/analysis:/work -w /work band-sheets-analysis`）:

- TS のテスト: `BS npx vitest run --config spikes/analysis/vitest.config.ts <ファイル>`、型: `BS npx tsc -p spikes/analysis/tsconfig.json --noEmit`
- 合成: `docker exec -u node -w /workspaces/band-sheets/spikes/analysis band-sheets npx tsx render/cli.ts`
- Python のテスト: `PY python -m unittest discover -s py/tests`

| #   | 内容                                                                                                                                                                                                                                                                                    | 主なファイル（所有）                                                                            | 依存       | テスト（対象だけ実行）                                                                                                       | モデル | 実績 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| T0  | 共通の型（下の「共通の形」をそのまま）と、正解 JSON の例 1 件                                                                                                                                                                                                                           | spikes/analysis/render/types.ts, spikes/analysis/truth.example.json                             | —          | `tsc`（T2 の設定ができるまでは目視）                                                                                         | sonnet |      |
| T1  | Python の環境: `python:3.12-slim-bookworm` から `band-sheets-analysis` イメージ（numpy・scipy・librosa・mir_eval・soundfile、バージョン固定）。各ライブラリのバージョンとライセンスを表示する確認。ルートの `.gitignore` に `spikes/analysis/out/`                                      | spikes/analysis/py/Dockerfile, py/requirements.txt, .gitignore                                  | —          | `docker build -t band-sheets-analysis spikes/analysis/py` ＋ `PY python -c "import librosa, mir_eval; ..."`                  | sonnet |      |
| T2  | TS の土台（`package.json` に tsx、`tsconfig.json`、`vitest.config.ts`）＋ `parseChordSymbol(text)`: 厳密に読む（C, C#, Db, Am, G7, Cmaj7, Am7, Bdim, Caug, Csus4, C/E。読めなければエラー）、ルートは 0〜11                                                                             | spikes/analysis/package.json, tsconfig.json, vitest.config.ts, render/chordSymbol.ts（+test）   | T0         | `render/chordSymbol.test.ts`（異名同音、分数コード、空・`H`・`Cm7b5` などの拒否）                                            | sonnet |      |
| T3  | `chordTimeline(song)`: コード譜の `[コード]` → 音節の番号 → 歌詞の付いた何番目の音符 → 小節・拍。拍の途中の音は、その拍の頭に丸める。セクションごとの小節数はパートから。設計判断 4・5 の規則とエラー（歌詞の数が合わない、メロディが無い、順番が違う、x/4 でない、歌詞の無いコード行） | spikes/analysis/render/chordTimeline.ts（+test）                                                | T0         | `render/chordTimeline.test.ts`（聖者の行進の小節ごとのコードを手で書いた表と比較、メリスマ、エラー 6 種以上）                | opus   |      |
| T7  | 採点 `score.py`: 設計判断 8 のとおり。入力は正解と解析結果の JSON 2 つ、出力は点数の JSON。コード名の変換（maj/min への寄せ方）を 1 か所の関数に                                                                                                                                        | spikes/analysis/py/score.py, py/tests/test_score.py                                             | T0, T1     | `PY python -m unittest py.tests.test_score`（答えの写し = 全部 1.0、拍 ±60/80 ms、異名同音、コード無しの拍、短い音、未評価） | sonnet |      |
| T4  | `pianoPartBody(timeline)`（設計判断 4。`\section` 付きの alphaTex、AlphaTexImporter で小節数と音が合うこと）と `chordEtude(seed)`（練習曲: A・B・A・B の 4 セクション各 8 小節、1 小節に 1〜2 コード、24 種＋ 7th、簡単な 8 ビートのドラム）                                            | spikes/analysis/render/pianoPart.ts, render/etude.ts（各 +test）                                | T2, T3     | `render/pianoPart.test.ts render/etude.test.ts`                                                                              | sonnet |      |
| T5  | `buildTruth(...)`: 設計判断 7。トラックの並び（ドラムが先頭）、テンポが 1 つ、セクションの一致の確認。ドラムの音番号 → `BD`・`SD` などの名前（`DRUM_ARTICULATIONS` の逆引き）                                                                                                           | spikes/analysis/render/truth.ts（+test）                                                        | T2, T3     | `render/truth.test.ts`（聖者の行進: 拍 128 個、最初のメロディの音 = 1 拍目の後、シャッフルでハイハットの裏が 2/3 拍の位置）  | opus   |      |
| T8  | `baseline.py`（設計判断 9 の 2 つ）、`run_all.py`（`out/manifest.json` の全部 × 解析器を採点 → `out/results/summary.md`・`.csv`）、`check_alignment.py`（設計判断 10）                                                                                                                  | spikes/analysis/py/baseline.py, py/run_all.py, py/check_alignment.py, py/tests/test_baseline.py | T0, T1, T7 | `PY python -m unittest py.tests.test_baseline`（小さな手作りの正解 JSON で）                                                 | sonnet |      |
| T6  | `wav.ts`（モノラル 16 bit の書き出し）、`renderAudio.ts`（事前確認 1 の方法、トラックの並び・楽器・`\tf none` への置き換え・クリック）、`variants.ts`（設計判断 6 の 16 本）、`cli.ts`（全部を作って `out/` と `manifest.json` に書く）                                                 | spikes/analysis/render/wav.ts, renderAudio.ts, variants.ts, cli.ts（+test）                     | T4, T5     | `render/wav.test.ts render/renderAudio.test.ts`（2 小節だけ合成して長さ = 計算どおり ±64 サンプル、最初の音の位置）          | sonnet |      |
| T9  | 通しで実行: 合成 16 本 → `check_alignment.py` → `run_all.py`。表を要約して報告（答えの写しが全部 1.0、定数の解析器の値、合成と採点の時間）                                                                                                                                              | （書かない。`out/` のみ）                                                                       | T6, T8     | 上の「合成」と `PY python py/check_alignment.py`、`PY python py/run_all.py`                                                  | haiku  |      |
| T10 | 独立レビュー: 正解と音の一致（特にシャッフル・弱起・最後の小節）、採点の基準がメモ §8.1 と合っているか、mir_eval の使い方（5 秒の切り捨て、幅）、変化形の偏り、ライセンス → `docs/audio-spike0-review.md`                                                                               | docs/audio-spike0-review.md                                                                     | T9         | 必要に応じて対象だけ                                                                                                         | opus   |      |
| T11 | レビューの指摘の修正（指摘ごとに担当ファイルの所有者のやり方で）                                                                                                                                                                                                                        | 指摘による                                                                                      | T10        | 直したファイルのテスト＋ T9 の通し実行をもう一度                                                                             | sonnet |      |
| T12 | ユーザーの確認（下）と記録: 本書の実績、`CLAUDE.md` に `spikes/analysis` の使い方と `\tf` のトラック順の注意、メモ §8.2 にスパイク 0 の結果                                                                                                                                             | docs/audio-spike0-plan.md, CLAUDE.md, docs/audio-import-architecture.md                         | T11        | `npx prettier --check` を変えた docs に                                                                                      | sonnet |      |

**ユーザーの確認（T12 の前）**: エクスプローラーで `\\wsl.localhost\Ubuntu\home\mrk5\projects\band-sheets\spikes\analysis\out\saints\` を開き、`full-t116-straight.wav`・`full-t116-shuffle.wav`・`piano-t80-straight.wav` と練習曲 1 本を聴く。見るところ: 伴奏のコードが歌と合っているか、シャッフルが自然か、音割れや無音が無いか。`summary.md` の表もざっと見る。

### 共通の形（T0 で先に固定する）

```ts
// spikes/analysis/render/types.ts
export type ChordQuality =
  'maj' | 'min' | '7' | 'maj7' | 'min7' | 'dim' | 'aug' | 'sus4';
export interface ChordSymbol {
  text: string;
  root: number;
  rootName: string;
  quality: ChordQuality;
  bass: number | null;
} // root・bass は 0〜11
export interface TimelineChord {
  bar: number;
  beat: number;
  text: string;
} // 曲全体で 0 始まり。次のコードまで続く
export interface ChordTimeline {
  ts: [number, number];
  bars: number;
  sections: { label: string; startBar: number; bars: number }[];
  chords: TimelineChord[]; // 時刻順。先頭は bar 0 beat 0（最初のコードを前に伸ばした後）
}
export type Mix = 'piano' | 'piano+drums' | 'full';
export interface Variant {
  song: 'saints' | 'etude';
  mix: Mix;
  tempo: number;
  swing: 'none' | 'asWritten';
  click: boolean;
  name: string;
}
```

正解 JSON（解析結果も同じ形。メモ §5.2 に `source.kind: "synthetic"`、`render`、拍の `bar`/`beat`、コードの `text` を足しただけ。時刻はすべて秒）:

```jsonc
{
  "format": "band-sheets-analysis",
  "version": 1,
  "source": { "kind": "synthetic", "durationSec": 66.207, "click": false },
  "analyzer": { "name": "ground-truth", "version": "0.1.0", "methods": [] },
  "render": {
    "song": "saints",
    "variant": "full-t116-shuffle",
    "tempo": 116,
    "tracks": ["Drums", "Piano", "Vocal"],
    "programs": { "Piano": 0, "Vocal": 65 },
    "sampleRate": 44100,
    "alphaTab": "1.8.4",
    "soundFont": "sonivox.sf2",
  },
  "beats": [{ "t": 0.0, "downbeat": true, "bar": 0, "beat": 0 }],
  "timeSignature": { "num": 4, "den": 4, "confidence": 1 },
  "key": { "tonic": "C", "mode": "major", "confidence": 1 },
  "sections": [{ "start": 0.0, "end": 33.103, "label": "A" }],
  "chords": [
    {
      "start": 0.0,
      "end": 14.483,
      "root": "C",
      "quality": "maj",
      "bass": null,
      "text": "C",
      "confidence": 1,
    },
  ],
  "melody": {
    "notes": [{ "start": 0.517, "end": 1.034, "midi": 60, "confidence": 1 }],
  },
  "drums": [{ "t": 0.0, "inst": "HH", "strength": 1, "confidence": 1 }],
  "swing": { "kind": "8", "confidence": 1 }, // シャッフルの変化形だけ
}
```

## 波

0. T0（すぐ終わる。以降の前提）
1. T1, T2, T3, T7（T7 のテストの実行は T1 のイメージができてから）
2. T4, T5, T8
3. T6
4. T9 → T10 → T11 → ユーザーの確認 → T12

ファイルの重なりの確認: `.gitignore` は T1 だけ、`package.json`・設定ファイルは T2 だけ、`types.ts` は T0 だけ（後で変えるときは T10/T11 で）。アプリの `src/` は誰も変えない（import するだけ）。`CLAUDE.md`・メモは T12 だけ。

## 検証の進め方

- 各タスクは「テスト」列のコマンドと、TS なら `tsc -p spikes/analysis/tsconfig.json` だけを実行し、結果（変更ファイル・テスト件数・未解決の点）を短く報告する。
- 合成と採点の通し実行は T9 と T11 の後だけ。音を聴く確認はユーザー（Playwright もブラウザも不要）。
- 正解の時刻は、テストで少なくとも 1 か所、**手で計算した値**とも比べる（例: 116 BPM の 2 小節目の頭 = 4 × 60/116 = 2.069 秒）。

## 確認したい点（ユーザーへの質問）

1. **Python の環境を Docker のイメージで作ってよいか**（`python:3.12-slim-bookworm` を取得し、numpy・librosa・mir_eval などを入れたイメージを作る。合計 1 GB 弱のディスクと、最初に数百 MB のダウンロード）。別の案は、PC に **uv**（Python とライブラリを管理する道具）を `~/.local/bin` に入れる方法だが、外部の道具なので、入れる前にインストールの仕組みとコードを読んで確かめる手間がかかる → **推奨: Docker のイメージ**（PC にもアプリのコンテナにも何も入れない、消すのも簡単）。
2. **採点に使う曲**: 聖者の行進（マイナーのコードが無い）＋自動で作るコードの練習曲、の 2 つで始める。ユーザーの手元に「コード譜とメロディ（歌詞付き）がそろった `.bandsheet`」があれば 3 曲目に加えられる → **推奨: スパイク 0 はこの 2 曲だけ**（仕組みができてから、スパイク 1 で増やす）。

## 実績

（各タスクの完了時に追記する）
