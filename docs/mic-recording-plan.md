# マイク録音の組み込み計画（鼻歌から下書き・S2）

想定読者: このリポジトリで作業するユーザーとエージェント（文脈を持たないサブエージェントを含む）。
目的: 「鼻歌から下書き」の S2 に「マイクで録る」を足すための設計・決定・タスクを 1 か所にまとめ、各タスクをこの文書だけで始められるようにする。

2026-10-31 作成、同日に独立レビューとユーザーの決定（Q1・Q2・タブの切り替え）を反映。[roadmap.md](roadmap.md) §2 の 3 番。土台は [audio-integration-plan.md](audio-integration-plan.md)（§9 Q6 (b)、§10 ①）と、研究ブランチの遅れの計測（`research/audio-analysis` の `docs/audio-spike4-plan.md` T13 の結果）。

## 1. 決まったこと

ユーザーの決定（変えない）:

- **補正 = 録る時の `baseLatency` ＋ `outputLatency` ＋ この端末に覚えた「入力側の残り」**。T13（ZOOM L-12・Chromium）で往復 94〜106 ms、1 回の中のばらつき 0、申告値 50〜58 ms、残り 44〜53 ms。エコー除去・ノイズ除去・自動音量は切る。
- 画面は Claude Design のキャンバス https://claude.ai/artifact/N3nRtuzeSSPQ2iPWNDZay9 のとおり（文言・数はキャンバスを見る）:
  - S2 の 1 枚目のカード: 「ファイルを選ぶ」（今のまま）/「マイクで録る」の切り替え。許可は「マイクで録る」を選んだ時にだけ求める。
  - M2: 許可されない / マイクが無い（「ファイルを選ぶ」への近道）。
  - M3: 録る前（マイクの選択、メーター、このマイクの入力の遅れと［遅れを測る］、控えめな案内、ヘッドホンの注意、● 録音）。
  - M4: 遅れを測る小さなダイアログ。
  - M5: 1 小節の数え（「やめて戻る」は使えない。「やめる」で M3 に戻り何も残さない）。
  - M6: 録音中（経過時間、今の小節・拍、メーター、■ 止める。クリックは鳴り続ける）。
  - M7: 録れた録音のカード（波形、クリックあり / なしで聞く、録り直す、録音を保存（wav）、下書きを作る）。
  - M8: 録り直しの前の確認。
  - 「歌い始めの場所」は今のまま（数えの次の拍 = 1 小節目の 1 拍目）。
- 遅れはマイクごとに、この端末に覚える。録り直しの前に確認する。長さの上限は 10 分（ファイルと同じ）。
- 録音はアプリが持ち続けない（画面を離れると消える）。M7 と S4 の「録音を保存（wav）」で保存し、後で「ファイルを選ぶ」から使い直せる。
- **保存する wav に数えの 1 小節を残す**（Q1 (a)）。ファイルの 0 秒 = 聞こえた数えの頭。
- **録音中の割り込み**（マイクが抜けた・許可の取り消し・AudioContext の失敗）では、録れた分を残して M7 に出し、止まった理由を知らせる（Q2 (a)）。
- **タブやアプリを切り替えても録音は止めない**。クリックは数えの始めに全部まとめて予約する（§2.4）。G1 で、ユーザーの PC でタブを隠しても録音とクリックが続くことを確かめる。
- PC だけ（鼻歌の入口がすでに PC だけ）。音はどこにも送らない。

この計画で決めたこと（理由つき。変えたければユーザーが言う）:

- 録音は **wav の `File`** にして、今の解析 → S4 の流れ（`useAudioPlayer`、聞き比べ、保存）にそのまま渡す（§2.1）。
- 1 小節目の時刻は**秒で解析に渡す**（`info.startSec`。§2.2）。
- 自分の声をヘッドホンに返す（モニター）はしない。ブラウザ経由では約 100 ms 遅れて歌いにくい。必要な人は機材の直接モニターを使う（M3 の注意に一言）。
- 録音の音の形: マイクの 1 チャンネル（それ以上なら worklet で平均）、マイクのトラックの標本化周波数、16 bit の PCM。

## 2. 設計

### 2.1 全体の形

```
S2（HumSetup）── 切り替え ─┬─ ファイル: AudioFileField（今のまま）
                            └─ マイク: MicRecorder（M2〜M8）
                                  └ useMicRecorder（状態: lib/mic/recorderState.ts）
                                       └ MicSession（src/audio/。getUserMedia・AudioContext・worklet・クリック）
録れた録音 → wav の File ─→ useAnalysisRun.startFile(file, 長さ, 要求) → 解析（startSec）→ S4（HumReview。今のまま＋保存ボタン）
```

- wav の `File` なら `decodeFile`（wav を少しずつ読む）、`useAudioPlayer`・`useHumPlayback`、Worker への受け渡しが何も変わらない（`{ audio: DecodedAudio }` は、S4 の再生と保存に結局ファイルが要るので使わない）。
- **ファイルの 0 秒 = 聞こえた数えの 1 拍目**、1 小節目 = 0 秒 ＋ 1 小節の長さ（`bar1Sec`）。補正はファイルを作る時に済ませる（切り出しの始まり = 数えの 1 拍目を予約した context のフレーム ＋ 補正のフレーム数）。M7 の小節線とクリックの再生、保存した wav も同じ並び。
- 切り出しの終わり = ■ 止めた時刻 ＋ 補正。止めた後も補正の分（＋ worklet の送り残り）ためてから閉じ、最後の声を切らない。

### 2.2 1 小節目の時刻の渡し方

- マイクでは 1 小節目の時刻が時計から分かる。解析には **`{bpm, ts, key?, startSec: bar1Sec}` だけ**を送り、`firstNoteSec`・`firstNoteTick`・`firstNoteAuto` は付けない。`validateHumInfo`（`src/lib/analysis/hum/analyze.ts`）は `startSec` と `firstNoteSec` の両方、または `firstNoteSec` なしの `firstNoteTick` を拒むため、`humImport.ts` にマイク用の関数（例 `humRunInfoAtBar1`）を別に足す。解析の結果の `grid.startMode` は `'barStart'` になる。
- 理由: `firstNoteAuto` は「最初に見つかった音 = 歌い始めの拍」と決めつけ、息の音や早めの入りで全体がずれる。`startSec` は測った 4 回で ±5 ms。位相の探索は `phaseBarPriorBeats` 0.05 拍で「小節頭はほぼ正しい」として動き、歌い手の一定の早め・遅めは `onsetBias` が取る。ただし `onsetBias` の上限は `min(0.08 s, 0.45 × 16 分音符)` なので、遅れを測っていないマイクで残る 45〜50 ms は 160 bpm 以上（上限 約 42 ms）では吸収しきれない。
- 「歌い始めの場所」は今のまま見せる。`startSec` のときは解析に使わないが、音符は 1 小節目から数えるので、3 小節目から歌えば 3 小節目に入り食い違わない。
- 保存した wav を後で「ファイルを選ぶ」で使うと、今どおり `firstNoteAuto` で動く。

### 2.3 `useAnalysisRun` への入口の追加（T3b）

今の `pick` → `start` は録音に合わない: `start` はその描画の時の `phase` を読むので、同じ処理の中で `await pick(); start()` とすると古い `phase` で何もしない。`pick` は「〜を選びました」と読み上げ、長すぎると `phase.file` を消し、ファイルを 1 つしか持てない。

そこで **`startFile(file, durationSec, request)`** を足す（長さが分かっているファイルで、長さの確かめと選んだ読み上げを飛ばして解析を始める）。失敗・中止の時は、その前の `pick` の状態（選んであったファイル）に戻して notice を出す。これで「ファイル」と「マイク」を切り替えても、選んだファイルは `useAnalysisRun` に、録音は画面（`take: {file, durationSec, bar1Sec}`）に、両方残る。動作が増えるので refactor ではなく小さな feature の PR にする。

### 2.4 純粋な部分（`src/lib/mic/`、テスト駆動）

| ファイル           | 中身                                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clickTrack.ts`    | 拍の時刻と強弱（拍は `beatTicksOf(ts)`、♩ = `{tempo}`）。数えの始めに、数えの 1 小節 ＋ ファイルが 10 分になるまでの全部の拍を一度に出す（120 bpm で約 1200 個）。M6 の「今の小節・拍」、M7 の小節線。クリックの音 `clickSamples`（強拍は高く）。M7 のクリックありの再生用の `SoundingNote[]`                               |
| `latency.ts`       | T13 の `highPass`・`detectClicks`・`stats` を写す（spike から import しない。テストも写す）。遅れの測定の判定（4 回中 3 回以上拾えて、ばらつき 5 ms 以内、**往復**が 0〜300 ms → `remainderMs` = 往復の中央値 −（base＋output）。残りは負もありうる: `outputLatency` を多めに申告する機器、Bluetooth など）、補正の秒の計算 |
| `takeBuffer.ts`    | worklet のかたまり（`{frame, data}`）を context のフレームの軸の上に **Int16 のかたまりのまま**ためる（隙間は 0 で埋めて数える）。切り出し（§2.1 の始まりと終わり）。メーターと波形のための 10 ms ごとの最大値。ファイルの長さ（切り出しの始まりから）が `MAX_DURATION_SEC`（600 秒）に達するフレーム                       |
| `wav.ts`           | Int16 のかたまり → wav（44 バイトの見出し ＋ かたまりの配列を `Blob` へ）。往復のテストは `src/analysis/audioFile.ts` の読み手で。`e2e/support/analysisAudio.ts` の `writeWav16` は T2 の後にこれを使う形へ置きかえる（T6b）                                                                                                |
| `recorderState.ts` | M2〜M8 の状態と移り変わり（reducer）。§2.6 の表、10 分の自動停止、残り 1 分の案内を 1 回だけ                                                                                                                                                                                                                                |
| `micTexts.ts`      | 日本語の文言（エラー、案内、ライブ領域の文）。`importErrors.ts` の形にならう                                                                                                                                                                                                                                                |

- **10 分の数え方**: 上限はファイルの長さ（= 数えの頭から）で 600 秒。数えを含むので、歌える長さは 600 秒 − 1 小節。M6 の経過時間は 1 小節目の頭から数え（数えの間は出さない）、残り時間は「ファイルが 600 秒になるまで」を、残り 1 分から出す。600 秒を超えると `useAnalysisRun` が too-long で断るので、ちょうどで止める。
- `storage.ts` に `MIC_LATENCY_KEY`（`band-sheets:mic-latency`、JSON `{v:1, devices: {[deviceId]: remainderMs}}`）と `loadMicRemainder` / `saveMicRemainder` を足す。他と同じく全部 try/catch、壊れた値は「まだ測っていない」。
- メモリ: 10 分・48 kHz のモノ Float32 は約 115 MB。worklet のかたまりはすぐ Int16 にして（約 58 MB）、wav は見出し ＋ かたまりの配列のまま `new Blob([...])` に渡し、ためた配列はすぐ捨てる。全部をつないだ大きな配列は作らない。

### 2.5 ブラウザの部分（`src/audio/`）

`src/analysis/` と同じく、画面から差し替えられる入口を 1 つ置く。対象は PC の Chromium（解析と同じ）。

- `micSession.ts`: `MicSession` のインターフェースと本物。
  - `listDevices()`: `enumerateDevices` の audioinput。Windows の Chromium の `default` / `communications` は仮の機器なので、同じ `groupId` の実際の機器に読みかえて一覧にする。
  - `open(deviceId)`: `getUserMedia({audio: {deviceId: {exact}, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1}})`。遅れを覚える鍵はこの実際の `deviceId`。その後で `new AudioContext({sampleRate: トラックの sampleRate})`（Firefox は周波数が違うと `createMediaStreamSource` で失敗する。Chromium でも害はない）と `resume()`。`await` の後なのでユーザーの操作の扱いが切れて止まったままのことがあり、● 録音・遅れを測るの押下でも `resume()` する。
  - `startCapture(fromFrame, endFrame)`: worklet に始めと終わりのフレームを渡す。終わり（10 分）は worklet が自分で止める（タブが隠れて主スレッドのタイマーが遅れても正確）。`stopCapture()` は ■ のとき。
  - `scheduleClicks(times)`: 全部の拍の `AudioBufferSourceNode` を一度に予約し、参照を持つ（■・やめる・割り込みで全部 `stop()`）。先読みのスケジューラは作らない。
  - `latencyNow()`: `baseLatency` ＋ `outputLatency`。Chromium は音が出る前に 0 や仮の値を返すことがあるので、**クリックが鳴っている間に読む**: 遅れの測定では測った直後、録音では数えの間。補正は ■ の時に決める。
  - `onLevel`、`onInterrupted(reason)`（トラックの `ended`（抜けた・許可の取り消しもこれで来る）、`ctx.onstatechange` の closed / interrupted）、`close()`。タブが隠れたことは割り込みにしない。
- `captureWorklet.ts`: T13 の worklet と同じく `currentFrame` を付けて送る。約 4096 フレームにまとめ、モノにまとめる。
- `fakeMicSession.ts`: 単体テスト・Storybook 用。許可されない / マイクが無い / 合成の声 / 割り込み / 測定の成功と失敗。**進められる時計**を持ち、10 分・残り 1 分を一瞬で試せる（`fakeAnalysisClient` と同じ考え）。
- `saveFile.ts`（T3c）: `<a download>` ＋ object URL（すぐ revoke）。ファイル名は `鼻歌_<曲名>_<セクション>_<YYYYMMDD-HHmm>.wav`（禁止文字は `fileName.ts` と同じ規則）。
- worklet の読み込み: T13 は blob: URL だったが、CSP の `script-src` に blob: を足したくない（Google のトークンが localStorage にあるため）。Vite の `?worker&url` で同じ origin の chunk にし、`audioWorklet.addModule(url)` に渡す（`script-src 'self'` で足りる見込み）。確かめること:
  - `vite.config.ts` の `worker.plugins` は全部の Worker のビルドに `analysisLicenseBanner` を足す。解析の Worker だけに絞る。
  - dev / Storybook では `?worker_file&type=module` で配られ、Vite が足す import が `AudioWorkletGlobalScope` で動かないことがある。dev（story）とビルド（`e2e:csp`）の両方で `addModule` を確かめる。だめなら worklet を `public/` の素の JS にするなど、blob: 以外の道を選ぶ。どうしても blob: が要るなら先にユーザーに聞く。
- Permissions-Policy: GitHub Pages は送らず、`microphone` の既定は自分の origin で許される。何もしない。

### 2.6 割り込みと端の場合

| 起きたこと                                                                                                       | ふるまい                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 許可されない（`NotAllowedError`）/ マイクが無い（`NotFoundError`）/ 他のアプリが使用中（`NotReadableError`）     | M2。それぞれの文言、「ファイルを選ぶ」への近道                                                     |
| 録音の前に `devicechange`                                                                                        | 一覧を読み直す。選んでいたマイクが消えたら既定に戻して知らせる。遅れの表示も選んだマイクのものに   |
| 数え（M5）の途中で割り込み                                                                                       | M3 に戻り、何も残さない                                                                            |
| 録音中（M6）にマイクが抜けた・許可が取り消された・context が閉じた / 止まった・かたまりの途切れが 0.5 秒を超えた | そこで止め、録れた分を M7 に出して理由を知らせる（決定）                                           |
| タブ・アプリの切り替え                                                                                           | 何もしない（録音もクリックも続く。決定）                                                           |
| ファイルが 600 秒                                                                                                | 自動で止めて M7、1 回だけ知らせる（残り 1 分も 1 回）                                              |
| 1 小節目より前に止めた                                                                                           | M7 に出さず M3 に戻し「短すぎます」                                                                |
| 録音中に「やめて戻る」・ブラウザの戻る                                                                           | 「やめて戻る」は M5・M6 で使えない（決定）。ブラウザの戻るは録音を止めて捨て、今と同じく画面を出る |
| `outputLatency` が取れない                                                                                       | 0 として扱う                                                                                       |

### 2.7 フックと部品

- `useMicRecorder({session, storage, tempo, ts, onTake})`: `recorderState` を `MicSession` につなぐ。M7 に入ったらマイクを閉じる（ブラウザの録音中の印を消す。録り直す時に開き直す。許可は 2 回目から聞かれない）。画面を離れる・「ファイルを選ぶ」に切り替える時も閉じる。
- M7 の再生は **`useHumPlayback(file, clickNotes)` をそのまま使う**（録音が時計、「クリックあり」= 両方、「なし」= 録音だけ）。
- 部品（CSS Modules ＋ stories）: `MicRecorder`（M2・M3・M5・M6・M7）、`LevelMeter`、`TakeWaveform`（小節線つき）、`LatencyDialog`（M4、`Dialog` の上）。M8 は既存の `ConfirmDialog`、切り替えは既存の `SegmentedControl`。
- 「下書きを作る」= `startFile(take.file, take.durationSec, {kind: 'hum', source: {file}, info: humRunInfoAtBar1(...)})`。
- S4 の「録音を保存（wav）」は、マイクで録った録音のときだけ出す（選んだファイルは元から手元にある）。

### 2.8 アクセシビリティ

- ライブ領域は S2 の 1 つだけ（`import-live`、`useAnalysisRun` の `say`）。`MicRecorder`・`LatencyDialog` は文を `say` に渡すだけ。
- 読み上げるのは状態が変わった時だけ: 許可された、数えを始めた、録音を始めた、残り 1 分、止めた・自動で止めた・割り込み（理由つき）、録れた（長さ。`pick` の「〜を選びました」の代わり。`startFile` は読み上げない）、遅れを覚えた / 拾えなかった。拍ごと・秒ごとには読まない。数えの表示は `aria-hidden`。
- フォーカス: M3 → ● 録音、M5 → 「やめる」、M6 → ■ 止める、M7 → 録音のカードの見出し、M2 → エラーの枠（今の `notice` と同じ）。ダイアログは `Dialog` の決まり（閉じたら開いたボタンへ）。
- エラーの文は `role="alert"` にしない（CLAUDE.md の決まり）。メーターは `role="meter"`（ライブにしない）。

## 3. テスト

| 種類           | 何を                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 単体           | `src/lib/mic/` の全部（拍の時刻と 6/8・3/4、検出の写しのテスト、遅れの判定の境目と負の残り、かたまりの順序の乱れ・隙間・重なり、切り出しの始まりと終わり、600 秒、wav の往復、状態の移り変わり全部）。`storage.ts` の新しい鍵。`humRunInfoAtBar1` の結果が `validateHumInfo` を通ること。`useAnalysisRun.startFile`（読み上げなし、失敗・中止で前のファイルに戻る）                                                                                                                                                                                                                                                                                                                                        |
| 単体（フック） | `useMicRecorder` を `fakeMicSession` と進められる時計で（割り込み、10 分、M7 でマイクを閉じる、離れる時に閉じる）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Storybook      | 部品ごとに 1 つ以上。`fakeMicSession` で M2〜M8、測定の成功と失敗、残り 1 分、自動停止、a11y。worklet の `addModule` が dev で読めることも 1 つの story で（本物の context）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| e2e            | 新しい Playwright のプロジェクト `mic`（`testMatch: /mic\.spec/`、`launchOptions.args`: `--use-fake-ui-for-media-stream`・`--use-fake-device-for-media-stream`・`--use-file-for-fake-audio-capture=<合成の鼻歌 wav>%noloop`）。既定の `chromium` の `testIgnore` に `mic\.spec` を足す。wav は既存の合成の鼻歌（`src/lib/analysis/fixtures/hum.wav`）に前の無音を足したもので、ブラウザが起動する前に要るので、設定の読み込み時か `globalSetup` で作る（引数のパスは設定の読み込み時に決まるが、ファイルが要るのは起動の時）。流れ: マイクで録る → 数え → 数秒録る → 止める → M7 → 下書きを作る → S4 に音符 → 保存（download イベント）。偽のマイクは時刻がそろわないので流れだけを見る。余所への要求 0 件 |
| CSP            | `npm run e2e:csp` の設定にも同じ引数を足し、マイクの流れで違反 0 件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 実機           | G1。ヘッドホンをマイクに当てたまま録った wav で、クリックの位置とファイルの拍の時刻の差を `latency.ts` の検出で測る（±10 ms 以内なら補正は合っている）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

テストの音は合成だけ。ユーザーの録音はリポジトリに入れない。

## 4. タスク

ブランチは `<type>/<issue#>-<slug>`、issue は本書の確定後に作る。PR は小さく、各タスクは自分のファイルだけを変える。テストは対象だけを回す（WSL が落ちやすいため。全体は T7 で）。レビューは毎回「正しさ ＋ DRY ＋ YAGNI」を見る独立のもの。

| id                                      | 中身                                                                                                                                                                                                                                                                                                                                                                     | ファイル                                                                                         | 依存                           | 終わりの条件 / 確かめ                                                                                                                                   | モデル                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| R1 `refactor/…-hum-setup-source`        | **動作を変えない**: `HumSetup` の 1 枚目のカードの中身（`AudioFileField`）、エラーの「別のファイルを選ぶ」、まとめの「ファイル」の行、「録り方」を、受け取る側（`source` などの props）にする。今のファイルの形はそのまま組み立てる                                                                                                                                      | `HumSetup`、`HumImportScreen`                                                                    | —                              | 既存の単体・stories・`e2e/hum-import.spec.ts` が意味を変えずに通る。PR に確かめ方を書く                                                                 | Sonnet → Opus のレビュー                                       |
| T1 `feature/…-mic-lib-click-latency`    | `clickTrack.ts`・`latency.ts`（T13 の写し ＋ 判定 ＋ 補正）・`storage.ts` の遅れの鍵、テスト駆動                                                                                                                                                                                                                                                                         | `src/lib/mic/`、`storage.ts`                                                                     | —                              | 単体が通る。T13 の元のテストも写って通る                                                                                                                | Sonnet（関数の形・端の場合を渡す）→ Opus のレビュー            |
| T2 `feature/…-mic-lib-take-wav`         | `takeBuffer.ts`・`wav.ts`、テスト駆動（切り出しは §2.1、10 分は §2.4）                                                                                                                                                                                                                                                                                                   | `src/lib/mic/`                                                                                   | —                              | 単体（wav は `audioFile.ts` で読み直して一致）                                                                                                          | Sonnet → T1 と合わせて Opus のレビュー                         |
| T3 `feature/…-mic-session`              | `micSession`・worklet（`?worker&url`、バナーを解析の Worker だけに）・`fakeMicSession`、`csp.ts` のコメント、`e2e:csp` の引数、`check-bundle` で入口の chunk にマイクのコードが無いこと                                                                                                                                                                                  | `src/audio/`、`vite.config.ts`、`csp.ts`、`playwright.csp.config.ts`、`scripts/check-bundle.mjs` | T1, T2                         | dev の story とビルド（`e2e:csp` 違反 0）の両方で `addModule` が通る。実機で `getSettings()` の `deviceId` が実際の機器のものになっていることを確かめる | Opus（ブラウザ・Vite・CSP にまたがる）→ 独立レビュー           |
| T3b `feature/…-analysis-run-start-file` | `useAnalysisRun.startFile`（§2.3）と `humImport.ts` の `humRunInfoAtBar1`（§2.2）                                                                                                                                                                                                                                                                                        | `useAnalysisRun.ts`、`humImport.ts`                                                              | —                              | 単体（§3）。既存の `ImportScreen`・`HumImportScreen` のテストが変わらず通る                                                                             | Sonnet → Opus のレビュー                                       |
| T3c `feature/…-save-file`               | `saveFile.ts` とファイル名の関数（純粋な部分は `src/lib/` でテスト駆動）                                                                                                                                                                                                                                                                                                 | `src/audio/`、`src/lib/fileName.ts`                                                              | —                              | 単体                                                                                                                                                    | Sonnet                                                         |
| T4 `feature/…-mic-recorder-state`       | `recorderState.ts`・`micTexts.ts`（§2.6 の表を全部）、`useMicRecorder`                                                                                                                                                                                                                                                                                                   | `src/lib/mic/`、`src/hooks/`                                                                     | T1, T2, T3（インターフェース） | 単体（偽のセッションと時計）                                                                                                                            | Opus（端の場合が多い）→ 独立レビュー                           |
| T5 `feature/…-mic-recorder-ui`          | `MicRecorder`・`LevelMeter`・`TakeWaveform`・`LatencyDialog` と stories（`fakeMicSession`）                                                                                                                                                                                                                                                                              | `src/components/`                                                                                | T4                             | `npm run test:storybook` の対象の stories が通る（a11y 込み）。キャンバスと見比べるスクリーンショット                                                   | Sonnet（キャンバスの M2〜M8 と props を渡す）→ Opus のレビュー |
| T6 `feature/…-mic-hum-import`           | S2 の切り替え、録音 → `startFile` → S4、フォーカスとライブ領域、離れる時にマイクを閉じる                                                                                                                                                                                                                                                                                 | `HumImportScreen`、`HumSetup`                                                                    | R1, T3b, T5                    | 単体・stories・`e2e/hum-import.spec.ts`                                                                                                                 | Opus（画面をまたぐつなぎ）→ 独立レビュー → 直しは Sonnet       |
| T6a `feature/…-hum-save-take`           | S4（`HumReview`）の「録音を保存（wav）」（マイクの録音のときだけ）                                                                                                                                                                                                                                                                                                       | `HumReview`、`HumImportScreen`                                                                   | T3c, T6                        | 単体・story                                                                                                                                             | Sonnet → Opus のレビュー                                       |
| T6b `feature/…-mic-e2e`                 | e2e の `mic` プロジェクトと `e2e/mic.spec.ts`（偽の音の wav を設定の読み込み時に作る、`writeWav16` を `wav.ts` に置きかえ）。T7 用の 10 分の計測の道具（10 分の偽の音の wav と、Playwright で録音中の RSS を測るスクリプト、測り方を先頭のコメントに）                                                                                                                   | `playwright.config.ts`、`e2e/`                                                                   | T6a                            | `npm run e2e`（mic と hum-import）・`npm run e2e:csp`                                                                                                   | Sonnet → Opus のレビュー                                       |
| T7                                      | 全体の確かめ: `npm test`・`tsc -b`・lint・prettier・build・`test:storybook`・`e2e`・`e2e:csp`。T6b の道具で 10 分の録音のメモリを測る（目安: 録音中の増え 150 MB 以下）                                                                                                                                                                                                  | —                                                                                                | T6b                            | 結果の短いまとめ（数字は自分で確かめる）                                                                                                                | Haiku                                                          |
| G1                                      | ユーザーが自分のマイク（L-12）で: 遅れを測る、数曲録る、下書きを作る、保存した wav を「ファイルを選ぶ」で使い直す。録音中にタブを隠しても録音とクリックが続くか。10 分の録音でクリックを全部先に予約しても音の途切れ・負荷が出ないか（出たら 1 小節のループ 1 つに替える）。1 回はヘッドホンをマイクに当てたまま録り、その wav でずれを測る（§3 実機。耳ではなく検出で） | —                                                                                                | T7                             | 使い心地の判断。ずれ ±10 ms 以内。直すことがあれば小さな fix の PR                                                                                      | —（ずれの計算は Haiku）                                        |
| S1                                      | SOLID のレビュー（マイク録音の範囲全体。SRP・OCP・LSP・ISP・DIP を 1 人ずつ、5 人の独立の Opus）。直しは別の refactor の PR                                                                                                                                                                                                                                              | —                                                                                                | G1                             | 指摘の一覧と、直す / 直さないの判断                                                                                                                     | Opus ×5                                                        |
| T8 `docs/…-mic-recording`               | `CLAUDE.md`（Source layout: `src/lib/mic/`・`src/audio/`・部品、Gotchas: worklet の読み込み、遅れの補正、e2e の `mic` プロジェクト）、`docs/csp.md`、`roadmap.md`（済みへ）、`audio-integration-plan.md` §10 ① からのリンク、本書の実績                                                                                                                                  | docs                                                                                             | G1                             | 文書の先頭に読者と目的。レビューに「削除提案」                                                                                                          | Sonnet                                                         |

- R1・T1・T2・T3b・T3c は並べられる（ファイルが重ならない）。

## 5. 未決（ユーザーに聞く）

無し。

## 6. リスク

| リスク                                                                                                                                                                        | 対策                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 開き直しで遅れが数 ms 変わる（T13 で 3.7 ms）                                                                                                                                 | `baseLatency`・`outputLatency` は毎回、クリックが鳴っている間に読み直す。残りは許容（16 分音符の手直しの範囲）。G1 で確かめる |
| 遅れを測っていない人の 45〜50 ms のずれ                                                                                                                                       | 控えめな案内。`onsetBias` が 160 bpm 未満ならほぼ吸収する（§2.2）。G1 で測る前後を比べる                                      |
| ヘッドホンなしでクリックが録音に漏れる                                                                                                                                        | 案内（決定）。エコー除去を切っているので消えない。下書きが乱れたら録り直し                                                    |
| タブを隠した時に Chromium が録音やクリックを止める・遅らせる                                                                                                                  | クリックは全部先に予約、10 分の止めは worklet の中。G1 で実機で確かめ、だめなら決め直す                                       |
| M7 の「クリックありで聞く」は `<audio>` と Web Audio のサイン波を混ぜるので、出力の道と遅れが違い、録音中のクリックとも音が違う。耳で聞くと補正が合っていないように聞こえうる | 補正の正しさは G1 で検出で測る（耳で判断しない）。ずれて聞こえるのが目立てば G1 の後に直し方を決める                          |
