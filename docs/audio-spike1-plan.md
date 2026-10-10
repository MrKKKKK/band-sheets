# スパイク 1 タスク計画: 音からコード・拍・セクション（機械的な方法）

2026-10-10 作成。方針は `audio-import-architecture.md`（以下「メモ」）の §4（方法）・§5.2（中間 JSON）・§8（評価）・§9（決定事項）に従う。土台はスパイク 0（`audio-spike0-plan.md`、レビュー `audio-spike0-review.md`）。ここでは**実装はまだしない**。

目的: wav を入れると、**拍（＋小節の頭）・テンポ・コード（拍ごと）・セクション**を、正解と同じ形の JSON で出す Python の CLI（解析器 `dsp-v1`）を作り、スパイク 0 の合成音源で採点する。結果は「下書き（入力の手助け）」なので、目指すのは完璧ではなく「役に立つ」水準。

決まっている条件（ユーザー決定）: AI・学習済みモデルは使わない（信号処理＋はっきり書ける規則。HMM / ビタビ法は人が決めた値なら可）。GPU なし。使うのはユーザー本人だけ（Python の CLI で可）。ライセンスは商用可・継承条件なしを優先（Chordino・aubio・Essentia は考え方だけ参考）。**本物のバンドの録音はまだ無い**（保留）ので、合成音源だけで測る。

作るものは 4 つ。

1. **解析器**（`py/analyze.py` ＋ `py/dsp/` の部品）: 各段階を別々にテストでき、差し替えられ、設定値は 1 か所にまとめる。
2. **難しい合成音源**（スパイク 0 レビュー R5 の重い部分）: 別の音色・伴奏の形・テンポの揺れ・雑音・残響・強弱。難しさを「レベル 0〜3」に分けて、レベルごとに点数を出す。
3. **誤りの分析**: どのコードと間違えたか（取り違えの表）、レベル別の表、拍・コードの時間軸の図（PNG）、日本語の報告（Markdown）。
4. **目標値**: スパイク 1 の合格ライン（下の「目標」。最初の通し実行の後にユーザーと確定する）。

## 事前に確かめたこと（2026-10-10、読み取りと使い捨ての試しのみ）

1. **今の合成音源は、素朴な方法でもほぼ満点になる（簡単すぎる）**。scratchpad の使い捨てスクリプト（HPSS → `beat_track` → 拍ごとのクロマ → 24 種の型 → ビタビ → 「4 通りの区切りのうちコードの変わり目と低音が多いもの」で小節の頭 → 小節ごとの自己類似行列と Foote の方法）を 11 本で採点した結果:
   - 拍 F 0.988〜0.992、小節の頭 F 0.985、コード / 拍 0.953〜1.000（聖者 0.969、練習曲 0.953〜1.000）、コード / 小節 1.000。テンポ 80・116・160、シャッフル、前の無音でも同じ。
   - 理由: ピアノの伴奏が「毎拍、同じ形の和音」なので、拍の位置もコードもはっきり音に出ている（レビュー R5 (c) の心配どおり）。→ **スパイク 1 の本当の評価は、難しいレベル（伴奏の形を変える・残響・雑音）でする**。
   - 雑音（白色雑音）SNR 10 dB でもほぼ同じ（拍 F 0.98、コード 0.97〜0.98）。SNR 0 dB で初めて崩れた（練習曲でテンポを 90 → 123 と誤り、拍 F 0.39）。
2. **セクションは素朴な方法では弱い**: 境目を出しすぎる（正解 2〜4 個に対して 6〜13 個）。セクション F 0.20〜0.46。いちばん工夫が要る所。なお聖者の行進は内側の境目が 1 つだけ（F は 0 か 1 に近い）、練習曲は 3 つ。数が少ないので、点数は荒い目安になる。
3. **7th**: 7th の型（属 7・メジャー 7・マイナー 7）を 3 和音と同じ重みで足すと、聖者の行進で再現率・適合率とも 0.57、練習曲で適合率 0.33（3 和音を 7th と誤る）。型の重みを 0.95 にすると 7th を一度も出さない。→ 重みと「確信が高いときだけ 7th」の規則は調整が要る。**練習曲の 7th は 128 拍中 4 拍だけ**なので、7th を測るには 7th の多い練習曲が要る。
4. **速さ**: 1 本（約 1 分）3〜4 秒。ただし Docker を起動するたびに最初の 1 本で約 25 秒かかる（numba の初回コンパイル。今の `NUMBA_CACHE_DIR=/tmp` はコンテナと一緒に消える）。→ キャッシュを `out/.numba-cache` に置けば 2 回目から速い。
5. **librosa の落とし穴**: `util.sync(C, beat_frames)` は「最初の拍より前」も 1 列目として返す（列が 1 つ多い）。拍 i の列 = [拍 i, 拍 i+1) になるよう、共通の形で決めておく。`beat_track` は `trim=False` にしないと最初と最後の拍を削る。
6. **テンポの揺れは alphaTab で作れる**: 読み込んだ楽譜の各小節（`masterBar.tempoAutomations`）に `Automation.buildTempoAutomation(false, 0, bpm, 0)` を足せる（1.8.4 に有り）。今の `truth.ts` は「テンポは 1 つ」を確かめて止めるので、MIDI のテンポ変更から秒を区間ごとに計算するように変える。
7. **2 つ目の音色**（どちらも継承条件なし）:
   - **MuseScore_General.sf3**: MIT ライセンス（FluidR3 由来）、40 MB。osuosl の公式ミラーから取得できる。alphaTab は SF3 を読める（同梱の `sonivox.sf3` が SF3）。
   - GeneralUser GS 2.0.3: 独自の許諾（「制限なく使ってよい、商用も可」。ただし一部の音の出どころは作者も 100% は分からないと明記）、32 MB。
   - → **MuseScore_General を推奨**（確認したい点 1）。リポジトリには入れず、git に入らない場所に取得する（SHA-256 を確かめる）。
8. **matplotlib**（図を描く道具）: ライセンスは PSF 由来の Matplotlib License（継承条件なし）。依存の pillow（HPND / MIT-CMU）・kiwisolver・contourpy・cycler（BSD）・fonttools・pyparsing（MIT）も同様。解析用イメージが約 50 MB 増える（今 865 MB）。手元のイメージだけで使い、アプリには入れない。→ 使う（設計判断 8）。
9. **採点の入口**: `run_all.py` の解析器は今「正解 JSON を受け取る関数」。`dsp-v1` は wav を読む必要があり、正解を見てはいけないので、呼び方を `(truth, wav_path)` に変える。

## 主な設計判断

1. **置き場所**: すべて `spikes/analysis/py/`。解析器の部品は `py/dsp/`（`audio.py`・`beats.py`・`chroma.py`・`chords.py`・`downbeat.py`・`sections.py`・`keyest.py`・`result.py`・`config.py`・`types.py`）、CLI は `py/analyze.py`。テストは `py/tests/test_dsp_*.py`（標準の `unittest`）。**テストの音は numpy でその場で作る**（サイン波の和音、クリックの列）。リポジトリに音のファイルは入れない。
2. **処理の流れ**（各段階は下の「共通の形」の関数 1 つ。設定 `Config` の値で方法を切り替える）:
   1. 読み込み（モノラル、22050 Hz）→ HPSS（伸びる音 / 叩く音に分ける）→ 音の立ち上がりの強さ。
   2. 拍: Ellis の動的計画法（`beat_track`、`trim=False`）。切り替えで PLP。テンポは拍の間隔の中央値。
   3. 拍ごとのクロマ（12 音の強さ）: 伸びる音から CQT クロマ（切り替えで CENS）、拍の区間ごとに中央値。低音域だけのクロマも作る（小節の頭の手がかり。分数コードは出さない）。
   4. コード: 24 種の 3 和音＋ 36 種の 7th の型と比べる（7th の型には重み < 1）→ HMM ＋ビタビ法（「同じコードが続く確率」は設定値）。切り替えでメディアンフィルタ / ならし無し。**確信度** = 1 位と 2 位の差。設定の閾値より低い拍は `text` に `?` を付ける（`Am?`、メモ §5.5）。7th は「7th の型が 3 和音の型より設定値以上強い」ときだけ。
   5. 小節の頭（規則）: 4 通りの区切りそれぞれで「コードの変わり目」「低音の強さ」「立ち上がりの強さ」を重み付きで足し、いちばん高い区切りを選ぶ。確信度 = 1 位と 2 位の差。拍子は 4/4 とみなす（3/4 の判定はスパイク 1 ではしない。合成音源に 3/4 が無いため）。
   6. セクション: 小節ごとの特徴（クロマ＋音量）→ 自己類似行列 → Foote の方法（チェッカーボード型のカーネル）で境目の候補 → 閾値と「最短のセクション長」で絞る → 4 小節の区切りに寄せる。名前は、区間どうしの似ている度合いが設定値以上なら同じ記号（A・B・A…）。
   7. キー（任意）: 曲全体のクロマを Krumhansl のキープロファイルと比べる。採点はしない（練習曲に正解のキーが無い）。
3. **出力**: 正解と同じ `AnalysisResult`（`render/types.ts`、メモ §5.2）。`source.kind: "recording"`（合成でも解析器は wav しか知らない）、`analyzer.methods` に段階ごとの方法名、拍に `bar`/`beat`、コードに `text` と `confidence`、`timeSignature.confidence`、`key`。正解の欄（`render`）は出さない。**解析器は正解の JSON を読まない**（テストで確かめる）。
4. **設定**: `py/dsp/config.py` の `Config`（入れ子の dataclass）に、すべての設定値と既定値を置く。`--config x.json` で一部だけ上書き。設定の要約とハッシュを結果の `analyzer` に記録する（どの設定で出した点数か分かるように）。
5. **難しさのレベル**（変化形は全部で約 67 本、`out/` は約 400 MB）:
   - **L0 きれい**: スパイク 0 の 21 本（そのまま）。
   - **L1 別の音**: 別の音色（MuseScore_General）、伴奏の形（8 分の分散和音 `arp8` ／ 1 小節に 1 回の白玉 `whole`）、ピアノを −9 dB にした音量のバランス、ゆっくりした強弱（±6 dB）、雑音 SNR 30 dB。
   - **L2 部屋**: 残響（RT60 0.6 秒）＋雑音 20 dB、テンポの揺れ（1 小節ごとに ±1 BPM ずつ、全体で ±6 % 程度の波）。
   - **L3 厳しい**: 雑音 10 dB ＋残響 1.2 秒、白玉の伴奏でドラム無し＋テンポの揺れ。目標は置かず記録だけ。
   - 合成で作るもの（TS）: 音色・伴奏の形・バランス・テンポの揺れ（約 13 本）。wav を加工して作るもの（Python `degrade.py`）: 雑音・残響・強弱（基の 6 本 × 5 条件 ＝ 30 本など）。雑音はピンクノイズ、残響は「指数で減る雑音」を自作の響き（インパルス応答）にした畳み込み、どれも乱数の種を固定。加工は時刻を変えないので、正解はそのまま写す（残響は直接音を 0 秒に置き、遅れを作らない）。
6. **調整に使わない曲（ホールドアウト）**: 練習曲の種 2（`etude2-…`、7th を多めにした進行。`chordEtude` に 7th の割合の引数を足す）を L0・L1・L2 で作り、**調整（T12）の間は見ない**。最後に 1 回だけ採点し、調整した曲との差が大きければ「合成音源に合わせすぎ」と判断する。
7. **採点の入口**（`run_all.py`）: 解析器は `(truth, wav_path)` を受け取る（`constant`・`oracle` は今までどおり truth だけを使う）。`--analyzers dsp-v1,constant`、`--only <名前の glob>`、`--dsp-config x.json --dsp-name dsp-v1-x`（設定を変えた比較）を足す。`manifest.json`（合成）と `manifest.derived.json`（加工）の両方を読む。比べる相手に「曲ごとに一番多いコードだけを答える」解析器 `mode-chord` を足す（R5 ④。正解から最頻のコードだけを使う参考値）。表は今の `summary.md` に加えて、**レベル × 曲 × 解析器の平均**（`summary-by-level.md`）。
8. **誤りの分析**（`report.py`）: 取り違えの種類（ルートは合っていてメジャー / マイナー違い、5 度違い、平行調・同主調、その他、コード無し）、取り違えの多い組の上位、確信度の高い拍と低い拍それぞれの正解率（`?` が意味を持つか）、小節の頭の位相のずれ（0〜3 拍）。図は matplotlib で、選んだ変化形ごとに「正解のコード帯／解析のコード帯／拍と小節の頭の印／セクション」を上下に並べた PNG（幅 1600 px 程度、1 枚 100〜200 KB、`out/results/plots/`、git に入れない）。報告は `out/results/report.md`（日本語）。
9. **ライセンス**: 新しく入れるのは matplotlib とその依存（すべて継承条件なし）と、音色 MuseScore_General（MIT、取得したものはリポジトリに入れない）。Chordino・aubio・Essentia のコードは写さない（考え方だけ）。LGPL の soxr / libsndfile は今までどおり手元のイメージの中だけ。

## タスク

各タスクは自分の「主なファイル」だけを変更する（同じ波の中でファイルが重ならない）。テストは対象だけを実行する（WSL が落ちやすいため）。自分が起動していないプロセスは止めない。

コマンド（以下 `BS` = `docker exec -u node -w /workspaces/band-sheets band-sheets`、`PY` = `docker run --rm -u 1000:1000 -e HOME=/tmp -e NUMBA_CACHE_DIR=/work/out/.numba-cache -v /home/mrk5/projects/band-sheets/spikes/analysis:/work -w /work band-sheets-analysis`）:

- TS のテスト: `BS npx vitest run --config spikes/analysis/vitest.config.ts <ファイル>`、型: `BS npx tsc -p spikes/analysis/tsconfig.json --noEmit`
- 合成: `docker exec -u node -w /workspaces/band-sheets/spikes/analysis band-sheets npx tsx render/cli.ts`
- Python のテスト（対象だけ）: `PY python -m unittest py.tests.test_dsp_beats` など
- 解析 1 本: `PY python py/analyze.py out/saints/full-t116-straight.wav -o /work/out/tmp.json`

| #   | 内容                                                                                                                                                                                                                                                                                                                                                                                                  | 主なファイル（所有）                                                                                                           | 依存        | テスト（対象だけ実行）                                                                                                                                                | モデル | 実績 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| T0  | 共通の形（下の「共通の形」をそのまま）: `py/dsp/types.py`、`config.py`（全設定値と既定値、JSON での上書き、ハッシュ）。`render/types.ts` の `Variant` に追加の欄（下）と manifest の `level`・`base`                                                                                                                                                                                                  | py/dsp/\_\_init\_\_.py, py/dsp/types.py, py/dsp/config.py, py/tests/test_dsp_config.py, render/types.ts                        | —           | `PY python -m unittest py.tests.test_dsp_config`、`tsc`                                                                                                               | sonnet |      |
| T1  | 環境: `requirements.txt` に matplotlib を足し、`requirements.lock.txt` を作り直してイメージを再構築。ライセンスの表示。`.gitignore` に `spikes/analysis/soundfonts/`。音色の取得スクリプト（URL と SHA-256 を固定、`soundfonts/` に置く。ユーザーの了承の後）                                                                                                                                         | py/requirements.txt, py/requirements.lock.txt, py/Dockerfile, .gitignore, spikes/analysis/fetch-soundfont.sh                   | —           | `docker build …` ＋ `PY python -c "import matplotlib, librosa"`、スクリプトを 1 回実行して SHA-256 一致                                                               | haiku  |      |
| T2  | 読み込み・HPSS・立ち上がり（`audio.py`）と拍（`beats.py`: Ellis / PLP の切り替え、`trim=False`、テンポ = 間隔の中央値、半分・倍のテンポは直さない）                                                                                                                                                                                                                                                   | py/dsp/audio.py, py/dsp/beats.py, py/tests/test_dsp_beats.py                                                                   | T0          | クリック列 120 BPM で拍 ±10 ms、前に 1 秒の無音、80 / 160 BPM、PLP でも同じ                                                                                           | sonnet |      |
| T3  | 拍ごとのクロマ（`chroma.py`: 列 i = [拍 i, 拍 i+1)、最後は曲の終わりまで、低音域のクロマも）とコード（`chords.py`: 型、7th の重み、ビタビ / メディアン / 無しの切り替え、確信度、`?`、区間への併合）                                                                                                                                                                                                  | py/dsp/chroma.py, py/dsp/chords.py, py/tests/test_dsp_chords.py                                                                | T0          | サイン波の和音の列（C–Am–F–G7）で全拍正解、1 拍だけのちらつきが消える、7th は条件を満たすときだけ、列の数 = 拍の数                                                    | sonnet |      |
| T4  | 小節の頭の規則（`downbeat.py`）: 4 通りの区切りの点数、重み、同点の扱い、確信度。入力は拍・コード・低音・立ち上がり（作り物でテストできる）                                                                                                                                                                                                                                                           | py/dsp/downbeat.py, py/tests/test_dsp_downbeat.py                                                                              | T0          | 作り物の入力で: 1 拍目にコードの変わり目と低音 → 位相 0、ずらすと位相も追従、手がかりが無いと確信度 0、弱起（拍が 3 つ余る）でも動く                                  | opus   |      |
| T5  | セクション（`sections.py`）: 小節ごとの特徴、自己類似行列、Foote の方法、絞り込み、4 小節への寄せ、名前付け（A・B・A…）                                                                                                                                                                                                                                                                               | py/dsp/sections.py, py/tests/test_dsp_sections.py                                                                              | T0          | 作り物の特徴（A8 B8 A8 B8 小節）で境目 3 つ・名前 A B A B、雑音を足しても境目を出しすぎない、短すぎる区間を作らない、1 セクションだけの曲                             | opus   |      |
| T6  | 難しい合成（TS 側）: 伴奏の形 `arp8`・`whole`（`pianoPart.ts`）、音色の選択と音量のバランス（`renderAudio.ts`）、練習曲の 7th の割合（`etude.ts`）、L1 と ホールドアウトの変化形・`level`（`variants.ts`・`manifest.ts`・`cli.ts`）                                                                                                                                                                   | render/pianoPart.ts, render/etude.ts, render/renderAudio.ts, render/variants.ts, render/manifest.ts, render/cli.ts（各 +test） | T0, T1      | `render/pianoPart.test.ts render/etude.test.ts render/variants.test.ts render/renderAudio.test.ts`（音色を変えて 2 小節の長さが計算どおり、`whole` は 1 小節に 1 回） | sonnet |      |
| T7  | テンポの揺れ（`truth.ts`）: `Variant.tempoCurve` を小節ごとの `tempoAutomations` にして、正解の秒を MIDI のテンポ変更から区間ごとに計算。「テンポは 1 つ」の確認は「`tempoCurve` どおり」に変える                                                                                                                                                                                                     | render/truth.ts（+test）                                                                                                       | T0          | `render/truth.test.ts`（手で計算した値: 116 → 117 BPM の 2 小節目の頭 = 4 × 60/116 秒、3 小節目 = それ + 4 × 60/117 秒。シャッフルと前の無音との組み合わせ）          | opus   |      |
| T8  | wav の加工（`degrade.py`）: ピンクノイズ（SNR 指定）、自作の残響、ゆっくりした強弱、全体の音量。基の変化形と条件の表から `out/derived/` に wav と正解の写しと `manifest.derived.json`                                                                                                                                                                                                                 | py/degrade.py, py/tests/test_degrade.py                                                                                        | T0          | 作った雑音の SNR が指定 ±0.5 dB、残響のピークが 0 サンプル目、正解の時刻が変わらない、同じ種で同じ結果                                                                | sonnet |      |
| T9  | 結果の組み立て（`result.py`: `AnalysisResult` の形、`?`、`methods`、設定の要約）、キー（`keyest.py`）、CLI（`analyze.py`: `--config`、`-o`、段階ごとの時間の表示）                                                                                                                                                                                                                                    | py/dsp/result.py, py/dsp/keyest.py, py/analyze.py, py/tests/test_analyze.py                                                    | T2〜T5      | 合成した 10 秒の音で最後まで通り、`score.py` の検査を通る形、正解を読まない（truth のパスを渡さない）、C メジャーの音階でキー C                                       | sonnet |      |
| T10 | 採点の入口（設計判断 7）: `(truth, wav_path)`、`--analyzers`・`--only`・`--dsp-config`、2 つの manifest、`mode-chord`、レベル別の表                                                                                                                                                                                                                                                                   | py/run_all.py, py/baseline.py, py/tests/test_baseline.py                                                                       | T0          | `PY python -m unittest py.tests.test_baseline`（小さな手作りの manifest で、レベル別の平均、加工の manifest が無くても動く）                                          | sonnet |      |
| T11 | 誤りの分析（設計判断 8）: 取り違えの種類と上位、確信度ごとの正解率、小節の頭の位相のずれ、時間軸の PNG、`report.md`                                                                                                                                                                                                                                                                                   | py/report.py, py/tests/test_report.py                                                                                          | T0, T1, T10 | 手作りの正解と結果で種類の分け方（5 度・平行調など）、PNG が書けること（中身は目視）                                                                                  | sonnet |      |
| T12 | 通し実行と調整: 合成 → 加工 → `check_alignment` → `run_all`（ホールドアウトを除く）→ `report`。誤りを見て `config.py` の既定値だけを直す（1 回ごとに何を変えて何点になったかを記録、最大 5 回）。目標の案を数字で見直す                                                                                                                                                                               | py/dsp/config.py（既定値のみ）, 本書の実績                                                                                     | T6〜T11     | 上の通し実行。実行は haiku に任せてよい                                                                                                                               | opus   |      |
| T13 | ホールドアウトの採点と、要約の報告（ユーザー向け、日本語）: レベル別の表、目標との比較、代表の図 2〜3 枚                                                                                                                                                                                                                                                                                              | out/ のみ（書くのは報告）                                                                                                      | T12         | `PY python py/run_all.py --only 'etude2-*'`                                                                                                                           | haiku  |      |
| T14 | 独立レビュー: 解析器が正解を見ていないか、調整のしすぎ、採点の変更が公平か、加工の正しさ（SNR・残響の遅れ）、テンポの揺れの正解、ライセンス → `docs/audio-spike1-review.md`                                                                                                                                                                                                                           | docs/audio-spike1-review.md                                                                                                    | T13         | 必要に応じて対象だけ                                                                                                                                                  | opus   |      |
| T15 | レビューの指摘の修正（指摘ごとに担当ファイルの所有者のやり方で）                                                                                                                                                                                                                                                                                                                                      | 指摘による                                                                                                                     | T14         | 直したファイルのテスト＋通し実行をもう一度                                                                                                                            | sonnet |      |
| T16 | ユーザーの確認（下）と記録: 本書の実績、`CLAUDE.md` に解析器・加工・報告のコマンドと注意、メモ §8.2 にスパイク 1 の結果                                                                                                                                                                                                                                                                               | docs/audio-spike1-plan.md, CLAUDE.md, docs/audio-import-architecture.md                                                        | T15         | `npx prettier --check` を変えた docs に                                                                                                                               | sonnet |      |
| TR  | 本物の録音（2026-10-10 追加）: `recordings/*.chords.json`（小節ごとのコードと 8 分音符の長さ、テンポ、最初の音の秒）から正解 JSON を作る `py/rec_truth.py`。クリックに合わせた演奏なので、拍 = 最初の音から等間隔（等間隔のずれを `librosa` の立ち上がりで確かめて報告）。`recordings/manifest.json`（level `REC`）を作り、T10 の `run_all` がこれも読めるようにする（T10 と相談: 3 つ目の manifest） | py/rec_truth.py, py/tests/test_rec_truth.py                                                                                    | T0          | 小さな手作りの注記で、拍・小節の頭・コードの秒が手計算と一致、`Bbadd9` などの書き方の扱い                                                                             | sonnet |      |

**ユーザーの確認（T16 の前）**: `out/results/report.md`（日本語の要約）と、`out/results/plots/` の図 2〜3 枚（例: `full-t116-straight`・L2 の残響つき・ホールドアウトの練習曲）を見る。見るところ: 図の「正解」と「解析」のコード帯がどれくらい合っているか、誤りが「直すのが楽な種類」（ルートは合っていて 7th だけ違う、など）か。気になれば、同じ wav を聴きながら図を見る（コード名を音に重ねる仕組みは作らない）。

### 共通の形（T0 で先に固定する）

```python
# spikes/analysis/py/dsp/types.py
@dataclass(frozen=True)
class Features:          # audio.load_features(path, cfg)
    sr: int; hop: int; duration: float
    y: np.ndarray; y_harm: np.ndarray; y_perc: np.ndarray
    onset_env: np.ndarray            # フレームごと
@dataclass(frozen=True)
class BeatGrid:          # beats.track_beats(feat, cfg)
    times: np.ndarray                # 秒、昇順
    tempo: float; method: str
# chroma.beat_chroma(feat, grid, cfg) -> (chroma, bass): どちらも shape (12, len(times))、列 i = [times[i], times[i+1])
@dataclass(frozen=True)
class BeatChord:         # chords.estimate_chords(chroma, cfg) -> list[BeatChord]（拍ごと）
    root: int | None                 # 0〜11、None = コード無し
    quality: str                     # 'maj' | 'min' | '7' | 'maj7' | 'min7'
    confidence: float                # 0〜1（1 位と 2 位の差から）
@dataclass(frozen=True)
class Downbeats:         # downbeat.choose_downbeats(feat, grid, chords, bass, cfg)
    phase: int                       # 小節の頭になる最初の拍の番号（0〜3）
    beats_per_bar: int; confidence: float; scores: list[float]
@dataclass(frozen=True)
class Section:           # sections.find_sections(chroma, grid, downbeats, feat, cfg) -> list[Section]
    start_bar: int; end_bar: int     # end は含まない。小節の番号は phase から数える
    label: str
# keyest.estimate_key(chroma, cfg) -> (tonic: str, mode: 'major'|'minor', confidence: float)
# result.build_result(feat, grid, chords, downbeats, sections, key, cfg) -> dict（AnalysisResult）
# analyze.analyze(wav_path: str, cfg: Config) -> dict
```

```ts
// render/types.ts の Variant に足す欄（すべて任意。無ければ今までと同じ音）
comp?: 'block4' | 'arp8' | 'whole';     // 伴奏の形（既定 block4 = 今の毎拍の和音）
soundFont?: 'sonivox' | 'musescore';
pianoGainDb?: number;                   // 音量のバランス
tempoCurve?: number[];                  // 小節ごとのテンポ（長さ = 小節数）
etudeSeed?: number; seventhShare?: number;
level?: 0 | 1 | 2 | 3; heldOut?: boolean;
```

`manifest.derived.json` の 1 件: `{ name, song, base, level, heldOut, degrade: { noiseSnrDb?, reverbRt60?, gainEnvDb?, gainDb? }, wav, truth }`（パスは `out/` から）。

## 波

0. T0, T1（T1 の音色の取得は、確認したい点 1 の了承の後）
1. T2, T3, T4, T5, T8（5 つ。どれも T0 の形だけに依存。T4・T5 は作り物の入力でテストする）
2. T6, T7, T9, T10, TR（5 つ。TR は本物の録音の正解。T6 と T7 は `types.ts` を変えない。T6 は T1 の音色が要る）
3. T11 → T12 → T13
4. T14 → T15 → ユーザーの確認 → T16

ファイルの重なりの確認: `types.ts`・`py/dsp/types.py`・`config.py` は T0 だけ（`config.py` の既定値は T12 だけが後で変える）。`truth.ts` は T7 だけ、そのほかの `render/` は T6 だけ。`run_all.py`・`baseline.py` は T10 だけ。`CLAUDE.md`・メモは T16 だけ。アプリの `src/` は誰も変えない。

## 検証の進め方

- 各タスクは「テスト」列のコマンドだけを実行し、結果（変更ファイル・テスト件数・未解決の点）を短く報告する。全部の Python のテストや TS のテストを流すのは T15 の後だけ。
- 合成・加工・全部の解析の通し実行は T12・T13・T15 だけ（全部で 5 分ほどの見込み）。調整中は `--only` で一部だけ流す。
- 解析器が正解を読まないことは、テスト（T9）と構造（`analyze` は wav のパスと設定しか受け取らない）の両方で守る。
- 調整（T12）はホールドアウト（`etude2-…`）を見ずに行い、変えた設定と点数を毎回記録する。

### 目標（案。T12 の後、数字を見てユーザーと確定する）

| 指標                                                             | L0     | L1       | L2       | L3       |
| ---------------------------------------------------------------- | ------ | -------- | -------- | -------- |
| 拍 F（±70 ms）                                                   | ≥ 0.95 | ≥ 0.90   | ≥ 0.85   | 記録のみ |
| 小節の頭 F                                                       | ≥ 0.90 | ≥ 0.80   | ≥ 0.70   | 記録のみ |
| コード / 拍（ルート＋メジャー / マイナー、聖者と練習曲を別々に） | ≥ 0.85 | ≥ 0.75   | ≥ 0.70   | 記録のみ |
| セクション F（練習曲。聖者は境目が 1 つなので参考）              | ≥ 0.6  | ≥ 0.5    | 記録のみ | 記録のみ |
| 7th の適合率（7th と出した拍のうち正しい割合。再現率は記録のみ） | ≥ 0.6  | 記録のみ | 記録のみ | 記録のみ |

- どのレベルでも `constant`・`mode-chord` より上。ホールドアウトの練習曲は、同じレベルの調整した練習曲との差が 0.1 以内。速さは CPU で 1 分の音あたり 10 秒以内。
- メモ §4.2 の目安（ポップスの本物の録音でメジャー / マイナーまで 6〜7 割）より高めなのは、合成音源が本物より「きれい」なため。L0 は素朴な方法でもほぼ届く（事前確認 1）ので、**判断の中心は L1・L2 とセクション**。

### 確定した目標（2026-10-10 ユーザー確認。上の案を置き換える）

| 指標 | 目標 |
| --- | --- |
| 拍 F | L0・L1 ≥ 0.95、L2 ≥ 0.85 |
| 小節の頭 F | L0 ≥ 0.95、L1・L2 ≥ 0.80 |
| 合成のコード / 拍 | L0 ≥ 0.95、L1・L2 ≥ 0.90 |
| REC のコード | ≥ 0.6（願望。記録のみで合否に使わない） |
| 練習曲のセクション F | ≥ 0.5 |
| 7th の適合率 | L0 で ≥ 0.8 |
| 速さ | 1 分の音あたり 10 秒以内 |

## 確認したいこと（ユーザーへの質問）

**2026-10-10 決定**: 1・2 とも推奨どおり（MuseScore_General を取得してよい、目標は仮で T12 の後に確定）。

**本物の録音（2026-10-10 ユーザー提供）**: ユーザーがピアノで弾いた 1 本（市販曲のコード進行、4/4、124 BPM、メトロノームに合わせて演奏、38.5 秒、17 小節＋最後の和音の余韻、アドリブとミスタッチあり）。`spikes/analysis/recordings/`（git に入れない）に wav とコード進行の注記（`<名前>.chords.json`）を置いた。**市販曲なので、音・コード進行・歌詞はリポジトリに入れない**。正解は「弾こうとしたコード進行」。各小節は「1 つ目のコードが 8 分音符 3 つ、2 つ目が 2 拍目の裏から 5 つ」の形が多い（先取り）。sus4・aug のコードは採点の対象外、add9 はメジャー扱い。採点では合成のレベルとは別の欄（`REC`）として出す。調整（T12）でこの録音を見るのはよいが、録音に合わせた調整のしすぎに注意し、何を変えたかを記録する。

1. **2 つ目の音色をダウンロードしてよいか**: MuseScore_General.sf3（MIT、40 MB）を、git に入らない `spikes/analysis/soundfonts/` に取得する（SHA-256 を記録して確かめる）。加えて `out/` が今の 132 MB から約 400 MB に増える（作り直せるので消してもよい）。別の案は GeneralUser GS（独自の許諾、商用可だが一部の音の出どころが不明確）か、音色は増やさず伴奏の形と加工だけにする。→ **推奨: MuseScore_General を取得**（音色の違いはバンドの録音との差の大きな部分で、許諾も一番はっきりしている）。
2. **目標の決め方**: 上の表を仮の目標として進め、T12 の通し実行の数字を見てから確定する、でよいか。→ **推奨: はい**（合成音源で素朴な方法がほぼ満点だったので、L1・L2 の実際の難しさを見てから決める方が意味のある目標になる）。

## 実績

### T12（通し実行と調整）

- 変えた既定値（`config.py`、コミット 8f93202）: `self_transition` 0.9 → 0.6、7th の重み 0.98・余裕 0、セクションの `loudness_weight` 0.5 → 0.25。1 回ごとの「変えた値と点数」の記録は当時残さなかった（レビュー R10）。残っている数字: ホールドアウト `etude2` L0 のコード / 拍 0.930 → 0.992、L1 0.930 → 0.992、L2 0.906 → 0.969（レビュー R11）。`loudness_weight` 0.25 の見かけの上がり（聖者のセクション F .873 → .941）は、T15 で 0.5 に戻すと消えた。

### T15（レビューの修正、2026-10-10 完了）

R1・R2・R5・R6・R8・R9・R10 を修正（コミット dca6bd4..24420be）。R1: `loudness_weight` を 0.5 に戻し、ちらつきのテストを直し、CI に Python テストの job（`spike-analysis-py`）を追加。R2: 途中の小節から始まる変化形（レベル M、`py/midbar.py`）と位相 0 固定の `dsp-phase0` を追加。R5: 拍 F の採点で解析の拍を正解の範囲に切る。R6: コードを 1 拍あたり 2 点（1/4・3/4）で採点（旧値は `perBeatMidpoint`）。R8: 最後の拍の幅を 1 拍に切る。R9: `piano` 以外の `check_alignment` は WARN のみ。R10: ホールドアウトは既定で除外（`--include-held-out`）、報告で別の表。Python のテスト 158 件成功。

通し実行（`--include-held-out`、既定の設定、475 本。調整用の変化形の平均、dsp-v1、修正前 → 修正後）:

| レベル | n | 拍 F | 小節の頭 F | コード / 拍 | コード / 小節 | セクション F |
| --- | --- | --- | --- | --- | --- | --- |
| L0 | 22 | .999 → 1.000 | .999 → 1.000 | .992 → .999 | 1.000 → 1.000 | .780 → .765 |
| L1 | 18 | .999 → .999 | .999 → .999 | .990 → .998 | 1.000 → 1.000 | .685 → .656 |
| L2 | 12 | .972 → .972 | .972 → .972 | .995 → 1.000 | 1.000 → 1.000 | .792 → .722 |
| L3 | 7 | .925 → .929 | .933 → .939 | .993 → .999 | 1.000 → 1.000 | .667 → .595 |
| REC | 1 | .919 → 1.000 | .919 → 1.000 | .436 → .439 | .562 → .562 | 0 → 0 |
| M（新規、dsp-v1） | 27 | .999 | 1.000 | .998 | .997 | 0.000 |
| M（新規、dsp-phase0） | 27 | .999 | 0.000 | .998 | .997 | 0.000 |

- セクション F の低下は `loudness_weight` を 0.5 に戻したため（聖者 .941 → .873、練習曲 .467 → .472）。T12 の見かけの上がりは消えた。**練習曲のセクション F .472 は目標 0.5 に届かない。**
- `dsp-phase0` の小節の頭 F（L0〜L3）= 1.000 / .944 / .972 / .801、`dsp-v1` = 1.000 / .999 / .972 / .939。位相の規則は L1・L3 で効いている。
- ホールドアウト（別の表、dsp-v1）の小節の頭 F: L0 1.000、L1 .750（n=4）、L2 .889（n=3）、修正前と同じ。L1 の .750 は `etude2` の `arp8` で位相を外したため（`dsp-phase0` は 1.000）。
- REC の拍 F .919 → 1.000 は R5 の採点の修正だけで、解析器の改善ではない。

### 目標との比較（T15 後）

| 目標 | 結果 | 判定 |
| --- | --- | --- |
| 拍 F L0・L1 ≥ .95、L2 ≥ .85 | 1.000 / .999 / .972 | 達成 |
| 小節の頭 F L0 ≥ .95、L1・L2 ≥ .80 | 1.000 / .999 / .972（`dsp-phase0` は L1 .944・L2 .972。ホールドアウト L1 .750） | 調整用は達成。ホールドアウト L1 は未達 |
| 合成のコード / 拍 L0 ≥ .95、L1・L2 ≥ .90 | .999 / .998 / 1.000 | 達成 |
| REC のコード ≥ .6（願望） | .439 | 未達（記録のみ） |
| 練習曲のセクション F ≥ .5 | .472 | **未達** |
| 7th の適合率 L0 ≥ .8 | 1.000（ただし 7th と出した拍は 1 本平均 2.2 拍、再現率 .133） | 数字の上では達成。件数が少なく弱い根拠。L1 は 7th を一度も出さず、L3 .631、REC .588 |
| 速さ ≤ 10 秒 / 分 | T14 の計測で平均 3.3 秒 / 分（最大 4.3） | 達成。T15 後の再計測は未 |

- 小節の頭の高い点は「最初の音 = 小節の頭」の前提に支えられている（レビュー R2）。途中の小節から始まる変化形（レベル M）は、`dsp-v1` では 1.000 だが、セクション F は 0.000（下の持ち越し）。

## スパイク 2 へ持ち越し

レビューの指摘（詳細は `audio-spike1-review.md`）:

- R4: REC の弱さの原因（5 度・平行調の取り違え、先取り、メロディ）の比較をやり直す。半拍・低音・音域・倍音の 4 案を、正解の区切りを使った上限と解析の区切りの 2 つで並べる。
- R7: テンポの揺れで倍・半分のテンポに取り違える（揺れの 3 本で拍 F 0.67）。`--tempo` と T・2T・T/2 から選ぶ規則。
- R12: コードの確信度と `?` が役に立っていない。事後確率にして、`?` に誤りが集まるかを測る。
- R13: 7th の判定が残響と音色で揺れる（L1 は 0 拍、L3 は適合率 .63）。区間が決まった後に区間全体で決める。
- R14: 練習曲のセクションの境目を分けられない（F .472）。打撃（クラッシュ・フィル）の手がかりを足す。

新しく分かったこと:

- 途中の小節から始まる変化形（レベル M）はセクション F が 0.000。原因の疑い: セクションの格子が最初の（途中の）小節を 0 小節目に固定している（未検証）。弱起の曲は 1 小節ずれる。

スパイク 2 で試す案（合意済み）:

- 低音のルートを左手の分散和音から取る（最も低い音・最初の音・オクターブ重ねの音を使い、5 度は取らない）。
- 倍音を考えたコードの型、録音ごとの倍音の形（ユーザーの案）。
- 高音の短いメロディの音を割り引く。
- 8 分音符ごとのコードの区切り（2 拍目の裏の先取り）。
- 合成の伴奏の形「左手 1-5-8 の分散和音 ＋ 右手の和音の一部 ＋ メロディ」を足す。
- テンポの倍・半分の規則。
- コードの事後確率の確信度。
- 曲の作りが違うホールドアウトの追加（R10 の残り）。
