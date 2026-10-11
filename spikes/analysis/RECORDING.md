# 録音の渡し方（スパイク 2）

録音（音声）とコードの書いた .txt を、受け入れフォルダに入れるだけです。あとは 1 コマンドで取り込みます。

## 1. 受け入れフォルダ

WSL: `/home/mrk5/projects/band-sheets/spikes/analysis/recordings/inbox/`
Windows のエクスプローラー: `\\wsl.localhost\Ubuntu\home\mrk5\projects\band-sheets\spikes\analysis\recordings\inbox`

（このフォルダは git に入りません。曲名がファイル名でも大丈夫です。取り込み後は匿名の名前 `rec-01` … に変わります。）

## 2. DAW（Cakewalk Sonar）からの書き出し

- **おすすめ**: 書き出す範囲を「1 小節目の頭ちょうど」から始めて WAV で書き出す。`.txt` に `開始: 0秒` と書く。
  - 弱起（1 小節目の前に数拍ある）の曲は、弱起の最初の拍から書き出し、`弱起: 1拍` と `開始: 0.484秒`（= 弱起の拍数 × 60 ÷ bpm）を書く。
- 位置を揃えられないとき: `開始:` を書かなければ、音の最初の立ち上がりを 1 小節目の頭（弱起ありなら弱起の最初の拍）とみなします。取り込みのとき検出した位置が表示されるので確かめてください。
- bpm は DAW のプロジェクトのテンポ。
- WAV は 16/24 ビット整数・32 ビット浮動小数、モノ/ステレオ、44.1/48/96 kHz どれでも可（自動で モノ・44.1 kHz に変換）。m4a / aac は読めません（WAV か mp3 / flac にしてください）。
- マキシマイザーを掛けるときは、**掛ける前と後の両方**を書き出すのがおすすめ（最低限は掛けた後だけ）。

## 3. ファイルの名前

同じ名前でそろえます（名前は何でも可）。

| ファイル | 意味 |
| --- | --- |
| `名前.wav` | 音声（マキシマイザー前。1 本だけならこれ） |
| `名前.max.wav` | 同じ録音のマキシマイザー後（あれば） |
| `名前.txt` | コードの書いたファイル（必須。2 本の音声で共通） |
| `名前.mid` | 弾いた MIDI（任意。保存するだけ） |

2 本あるときも同じ曲として扱われ、ホールドアウトかどうかは同じです（1 つの録音を開発用とホールドアウトに分けません）。

## 4. .txt の書き方

```
bpm: 124
拍子: 4/4
キー: C          （任意）
弾き方: a        （a〜e。下の表）
弱起: 1拍        （任意）
開始: 0秒        （任意。1 小節目の頭の秒数）
クリック: あり   （任意。既定はあり）
マキシマイザー: あり   （任意。音声が 1 本のときだけ使う）
| C | Am7 | F | G7 |
| C . Em . | F G |
```

- `|` で小節を区切る。1 小節に書いたコードは小節を等分する（2 つなら半分ずつ、4 つなら 1 拍ずつ）。`.` は「前のコードのまま」。
- `N.C.`（または `N`）はコード無し。`#` で始まる行はメモ。英語の項目名（bpm / time / key / style / pickup / start / click / maximizer）でも可。
- コード名は `C` `Dm7` `G7(#9)` `Bm7b5` `C/E` のように書く。読めないコードは「何行目の何が読めないか」が表示されます。

弾き方（a〜e）。**この記号で、開発用かホールドアウトかが解析の前に自動で決まります**。

| 記号 | 弾き方 | 区分 |
| --- | --- | --- |
| a | 今と同じ（左手 1-5-8 の分散和音） | 開発用 |
| b | 毎拍の和音 | ホールドアウト |
| c | ゆっくり（70〜90 BPM） | 開発用 |
| d | 弱起の曲 | ホールドアウト |
| e | 離れた部屋の録音 / ギターのストローク | 開発用 |

## 5. 取り込み

`inbox` に入れたら、次を実行します（`spikes/analysis` で）。

```
docker run --rm -u 1000:1000 -e HOME=/tmp -e NUMBA_CACHE_DIR=/work/out/.numba-cache \
  -v /home/mrk5/projects/band-sheets/spikes/analysis:/work -w /work band-sheets-analysis python py/intake.py
```

- 元のファイルは `recordings/originals/` に移り、`inbox` は空になります（エラーのものだけ残る）。
- 最後に `privacy_check`（曲名・コード進行が git に入っていないか）が自動で走ります。ホスト側でも `python3 spikes/analysis/py/privacy_check.py` で全体を確かめられます。
- 解析（`run_all`）はこの取り込みでは走りません。

## 6. コード進行だけを渡す（録音なし）

録音が無くても、よく知っている曲の **コード進行だけ** を書いてもらえれば、それをピアノで鳴らした合成音（調つき・転調つき）を作って、キー追跡やコード理論の評価に使います。

**置き場所**: WSL `/home/mrk5/projects/band-sheets/spikes/analysis/recordings/charts/`
Windows のエクスプローラー: `\\wsl.localhost\Ubuntu\home\mrk5\projects\band-sheets\spikes\analysis\recordings\charts`（`wslpath -w /home/mrk5/projects/band-sheets/spikes/analysis/recordings/charts` でも出ます）

1 曲 1 ファイルで `名前.txt`（名前は何でも可）を置きます。書き方は 4 章の .txt と同じです。違いは次のとおり。

```
bpm: 124
拍子: 4/4
キー: C          （任意。書くと調の評価ができる）
弱起: 1拍        （任意。4/4 だけ）
| C | Am7 | F | G7 |
| C . Em . | F G |
キー: D          （小節の行と行の間に書くと、次の小節から D に転調）
| D | Bm7 | Em7 A7 | D |
```

- `弾き方:` と `開始:` は要りません。録音も要りません。
- 曲の途中の `キー:` は「その次の小節から」その調、という意味です（何回でも可）。
- 1 小節に書いたコードは小節を等分します（`.` は前のコードのまま）。`N.C.` の小節は、鳴らす側では前のコードが続きます（正解も同じ）。
- 9th・13th・add9・6 などは鳴らせないので自動で簡単な形にします（`Dm9`→`Dm7`、`G7(#9)`→`G7`、`C6`→`C`。正解もその形）。簡略化した個数は実行時に表示されます。
- メロディは要りません（コードだけ）。曲名やアーティスト名も書かなくて大丈夫です。メモを書くときは `#` の行に。

**取り込みと作成**（`spikes/analysis` で。2 段階です）:

```
# 1) 読み込み・匿名の名前 chart-01 … を付ける・ホールドアウトの判定（Python 側）
docker run --rm -u 1000:1000 -e HOME=/tmp -e NUMBA_CACHE_DIR=/work/out/.numba-cache \
  -v /home/mrk5/projects/band-sheets/spikes/analysis:/work -w /work band-sheets-analysis python py/charts.py
# 2) 音の作成（devcontainer 側）→ out/charts/ に chart-NN-{block,rec,rechard}.wav と正解
docker exec -u node -w /workspaces/band-sheets/spikes/analysis band-sheets npx tsx render/chartsCli.ts
```

- 1 曲から 3 種類を作ります: `block`（毎拍の和音、L0 相当）、`rec`（録音に近い弾き方）、`rechard`（録音に近い難しい弾き方）。拍子が 4/4 以外のときは `block` だけです。
- ホールドアウトは **id の番号で自動** に決まります（chart-04, chart-08 … が最後の確認用）。解析の前に `out/results/heldout-log.jsonl` に記録されます。書き直して再実行しても同じ曲は同じ id のままです。
- 評価では、レポートに「CH」として出ます。コード名も曲名も出ません（図もコード名なし）。
- ファイルを直したら、1) と 2) をもう一度実行してください。

**プライバシー**: **手元だけ** で使います。`recordings/` も `out/` も git に入らない設定で、**git にも Google Drive にも上げません**。実行のたびに `privacy_check` が走り、曲名（ファイル名・`#` のメモ）やコード進行が git で管理されるファイルやコミットメッセージに紛れていないか確かめます（ホストでも `python3 spikes/analysis/py/privacy_check.py`）。
