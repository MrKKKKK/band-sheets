# マイク録音の組み込み計画（鼻歌から下書き・S2）

想定読者: このリポジトリで作業するユーザーとエージェント（文脈を持たないサブエージェントを含む）。
目的: 「鼻歌から下書き」の S2 に「マイクで録る」を足すための設計・決定・タスクを 1 か所にまとめ、各タスクをこの文書だけで始められるようにする。

2026-10-31 作成。[roadmap.md](roadmap.md) §2 の 3 番。土台は [audio-integration-plan.md](audio-integration-plan.md)（§9 Q6 (b)、§10 ①）と、研究ブランチの遅れの計測（`research/audio-analysis` の `docs/audio-spike4-plan.md` T13 の結果）。

## 1. 決まったこと

ユーザーの決定（変えない）:

- **補正 = 録る時の `baseLatency` ＋ `outputLatency` ＋ この端末に覚えた「入力側の残り」**。T13（ZOOM L-12・Chromium）で往復 94〜106 ms、1 回の中のばらつき 0、申告値 50〜58 ms、残り 44〜53 ms。エコー除去・ノイズ除去・自動音量は切る。
- 画面は Claude Design のキャンバス（https://claude.ai/artifact/N3nRtuzeSSPQ2iPWNDZay9 、M1〜M8）のとおり:
  - S2 の 1 枚目のカードに切り替え 「ファイルを選ぶ」（今のまま）/「マイクで録る」。マイクの許可は「マイクで録る」を選んだ時にだけ求める。
  - M2: 許可されない / マイクが無い。どちらにも「ファイルを選ぶ」への近道。
  - M3: マイクの選択、音量のメーター、「入力の遅れ（このマイク）: まだ測っていません ［遅れを測る］」または「48 ms ［測り直す］」、止めない控えめな案内、ヘッドホンの注意、● 録音。
  - M4: 遅れを測る小さなダイアログ（ヘッドホンをマイクに当てる、クリック約 4 回・約 5 秒。測定中 / 「入力の遅れ 48 ms を覚えました」/「クリックを拾えませんでした」）。
  - M5: 1 小節の数え（クリック、1 拍目を強く。音楽としては使わない）。「やめて戻る」は使えない。「やめる」で M3 に戻り、何も残さない。
  - M6: 録音中。経過時間（最大 10 分。9 分から残り時間、10 分で自動で止めて 1 回だけ知らせる）、今の小節・拍、メーター、■ 止める。クリックは鳴り続ける。
  - M7: 録れた録音のカード（長さ、小節線つきの波形、クリックあり / なしで聞く、「録り直す」、「録音を保存（wav）」、「下書きを作る」）。
  - M8: 録り直しの前の確認（「今の録音は消えます。録り直しますか？」録り直す / やめる）。
  - 「歌い始めの場所」は今のまま（数えの次の拍 = 1 小節目の 1 拍目）。
- 遅れは小さなダイアログで測る。録り直しの前に確認する。長さの上限は 10 分（ファイルと同じ）。遅れは**マイクごと（ブラウザの `deviceId`）に、この端末に覚える**。
- 録音はアプリが持ち続けない（選んだファイルと同じく、画面を離れると消える）。M7 と S4 の「録音を保存（wav）」で保存し、後で「ファイルを選ぶ」から使い直せる。
- PC だけ（鼻歌の入口がすでに PC だけ）。音はどこにも送らない。

この計画で決めたこと（理由つき。変えたければユーザーが言う）:

- 録音は **wav の `File`** にして、今の流れ（`useAnalysisRun.pick` → 長さの確かめ → 解析 → S4、`useAudioPlayer`、聞き比べ、保存）にそのまま渡す（§2.1）。
- 1 小節目の時刻は**秒で解析に渡す**（`info.startSec`、`firstNoteAuto` は使わない。§2.2）。
- 自分の声をヘッドホンに返す（モニター）はしない。ブラウザ経由では約 100 ms 遅れて歌いにくい。必要な人は機材の直接モニターを使う（M3 の注意に一言）。
- 録音の音の形: マイクの 1 チャンネル（`channelCount: 1`、それ以上なら worklet で平均）、`AudioContext` の標本化周波数のまま、16 bit の PCM。

## 2. 設計

### 2.1 全体の形

```
S2（HumSetup）── 切り替え ─┬─ ファイル: AudioFileField（今のまま）
                            └─ マイク: MicRecorder（M2〜M8）
                                  └ useMicRecorder（状態: lib/mic/recorderState.ts）
                                       └ MicSession（src/audio/。getUserMedia・AudioContext・worklet・クリック）
録れた録音 → takeToWav → File ─→ useAnalysisRun.pick(file) → 解析（startSec つき）→ S4（HumReview。今のまま＋保存ボタン）
```

- 録音を wav の `File` にすれば、`probeDuration`（wav の見出し）、`decodeFile`（wav を少しずつ読む）、`useAudioPlayer`・`useHumPlayback`、Worker への受け渡しが何も変わらない。`{ audio: DecodedAudio }` で渡す道もあるが、S4 の再生と保存に結局ファイルが要り、標本が Worker へ移されて消える（transfer）ので使わない。
- **ファイルの 0 秒 = 聞こえた数えの 1 拍目**、1 小節目 = 0 秒 ＋ 1 小節の長さ。補正はファイルを作る時に済ませる（切り出しの始まりを遅れの分だけ後ろにずらす）。だから M7 の「クリックありで聞く」はファイルの時刻にそのままクリックを置けばよく、保存した wav も同じ並び。数えの小節（ヘッドホンなら無音）はファイルに残す（§5 Q1）。

### 2.2 1 小節目の時刻の渡し方（`startSec` か `firstNoteAuto` か）

- マイクでは 1 小節目の時刻が時計から分かる。`humRunInfo` に `bar1Sec` を足し、あれば `startSec: bar1Sec`（`startMode: 'barStart'`）で送り、`firstNoteAuto` は付けない。
- 理由: `firstNoteAuto` は「最初に見つかった音 = 歌い始めの拍」と決めつける。息の音や早めの入りで全体がずれる。`startSec` は測った 4 回で ±5 ms（120 bpm の 16 分音符の 4 %）。解析の位相の探索は `phaseBarPriorBeats` 0.05 拍で「小節頭はほぼ正しい」として動き、歌い手の一定の早め・遅めは `onsetBias` が取る。遅れを測っていないマイクで残る 45〜50 ms もこれでかなり吸収される。
- 「歌い始めの場所」は今のまま見せて渡す。`startSec` があると解析は `firstNoteTick` を使わないが、音符は 1 小節目から数えるので、3 小節目から歌えば 3 小節目に入り、食い違わない。
- 保存した wav を後で「ファイルを選ぶ」で使うと、今どおり `firstNoteAuto` で動く（ファイルからは時計が分からないため）。

### 2.3 純粋な部分（`src/lib/mic/`、テスト駆動）

| ファイル           | 中身                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clickTrack.ts`    | 拍の時刻と強弱（拍は `beatTicksOf(ts)`、♩ = `{tempo}`。数えの 1 小節、録音中の拍、M6 の「今の小節・拍」、M7 の小節線）。先読みで鳴らすための「この時刻の窓に入る拍」。クリックの音 `clickSamples`（強拍は高く）。M7 のクリックありの再生用の `SoundingNote[]` も作る             |
| `latency.ts`       | T13 の `highPass`・`detectClicks`・`stats` を写す（spike から import しない。テストも写す）。遅れの測定の判定（4 回中 3 回以上拾えて、ばらつき 5 ms 以内、0〜300 ms → `remainderMs` = 実測の中央値 −（base＋output））、補正の秒の計算                                           |
| `takeBuffer.ts`    | worklet から来たかたまり（`{frame, data}`）を、context のフレームの軸の上に **Int16 のかたまりのまま**ためる（隙間は 0 で埋めて数える）。切り出し（始まりのフレーム = 数えの 1 拍目 ＋ 補正）。メーターと波形のための区間ごとの最大値（10 ms ごと、10 分で 6 万個）。10 分の判定 |
| `wav.ts`           | Int16 のかたまり → wav（44 バイトの見出し ＋ かたまりの配列、`Blob` に渡す部品）。往復のテストは `src/analysis/audioFile.ts` の読み手で                                                                                                                                          |
| `recorderState.ts` | M2〜M8 の状態と移り変わり（reducer）。許可されない / マイクが無い / 測定中 / 数え / 録音中 / 録れた / 確認、割り込み（§2.6）、10 分の自動停止、残り 1 分の案内を 1 回だけ                                                                                                        |
| `micTexts.ts`      | 日本語の文言（エラー、案内、ライブ領域の文）。`importErrors.ts` の形にならう                                                                                                                                                                                                     |

- `storage.ts` に `MIC_LATENCY_KEY`（`band-sheets:mic-latency`、JSON `{v:1, devices: {[deviceId]: {remainderMs, measuredAt}}}`）と `loadMicRemainder` / `saveMicRemainder` を足す。他と同じく全部 try/catch、壊れた値は「まだ測っていない」。`deviceId` はトラックの `getSettings().deviceId`（`'default'` という名前ではなく実際の機器）。
- メモリ: 10 分・48 kHz のモノ Float32 は約 115 MB。worklet のかたまりはすぐ Int16 にして（10 分で約 58 MB）、wav は見出し ＋ かたまりの配列のまま `new Blob([...])` に渡し、ためた配列はすぐ捨てる。全部をつないだ大きな配列は作らない。

### 2.4 ブラウザの部分（`src/audio/`）

`src/analysis/` と同じく、画面から差し替えられる入口を 1 つ置く。

- `micSession.ts`: `MicSession` のインターフェースと本物。`open(deviceId?)`（`getUserMedia({audio: {deviceId, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1}})`、`new AudioContext()`、worklet、`baseLatency`・`outputLatency` を読む）、`listDevices()`、`onDeviceChange`、`startCapture(fromTime)` / `stopCapture()`、`scheduleClicks(times)`（`AudioBufferSourceNode`、先読み 25 ms ごとに 100 ms 先まで）、`onLevel`、`onInterrupted(reason)`（`ctx.onstatechange` の suspended / interrupted、トラックの `ended`、`permissions` の変化）、`close()`（トラックを止めて context を閉じる）。
- `captureWorklet.ts`: T13 の worklet と同じく `currentFrame` を付けて送る。ただし 128 フレームごとではなく約 4096 フレームにまとめて送る。モノにまとめる。
- `fakeMicSession.ts`: 単体テスト・Storybook 用。許可されない / マイクが無い / 合成の声 / 割り込み / 測定の成功と失敗を再現する（`fakeAnalysisClient` と同じ考え）。
- `saveFile.ts`: `<a download>` ＋ object URL（すぐ revoke）で保存。M7 と S4 で同じものを使う。ファイル名は `鼻歌_<曲名>_<セクション>_<YYYYMMDD-HHmm>.wav`（禁止文字は `fileName.ts` と同じ規則）。
- worklet の読み込み: T13 は blob: URL だったが、CSP の `script-src` に blob: を足したくない。Vite の `?worker&url` で同じ origin の chunk にして `audioWorklet.addModule(url)` に渡す（AudioWorklet の読み込みは `script-src` で決まる。`'self'` で足りる見込み）。T3 で `npm run e2e:csp` で確かめ、違反があれば方針を変える前にユーザーへ。
- Permissions-Policy: GitHub Pages は送らず、`microphone` の既定は自分の origin で許される。何もしない。`getUserMedia` は https か localhost が要る（どちらも満たす）。

### 2.5 フックと部品

- `useMicRecorder({session, storage, tempo, ts, onTake})`: `recorderState` を `MicSession` につなぐ。M7 に入ったらマイクを止める（ブラウザの録音中の印を消す。録り直す時に開き直す。許可は 2 回目から聞かれない）。画面を離れる・「ファイルを選ぶ」に切り替える時も止める。
- M7 の再生は **`useHumPlayback(file, clickNotes)` をそのまま使う**（録音が時計、「クリックあり」= 両方、「なし」= 録音だけ）。新しい再生の仕組みは作らない。
- 部品（CSS Modules ＋ stories）: `MicRecorder`（M2・M3・M5・M6・M7 の面）、`LevelMeter`、`TakeWaveform`（小節線つき）、`LatencyDialog`（M4、`Dialog` の上）。M8 は既存の `ConfirmDialog`、切り替えは既存の `SegmentedControl`。
- 「下書きを作る」= `pick(takeFile)` の後に今の「解析する」と同じ `start`。`HumImportScreen` は `take: {file, bar1Sec}` を持ち、`phase.file === take.file` のときだけ `startSec` で送る。
- 「ファイル」と「マイク」を切り替えても、この画面にいる間は選んだファイルと録れた録音の両方を覚えておき、選んでいる方を解析に使う。

### 2.6 割り込みと端の場合

| 起きたこと                                                                                                            | ふるまい                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 許可されない（`NotAllowedError`）/ マイクが無い（`NotFoundError`）/ 他のアプリが使用中（`NotReadableError`）          | M2。それぞれの文言、「ファイルを選ぶ」への近道                                                     |
| 録音の前に `devicechange`                                                                                             | 一覧を読み直す。選んでいたマイクが消えたら既定に戻して知らせる。遅れの表示も選んだマイクのものに   |
| 数え（M5）の途中で割り込み                                                                                            | M3 に戻り、何も残さない                                                                            |
| 録音中（M6）にタブが隠れた・context が止まった・マイクが抜けた・許可が取り消された・かたまりの途切れが 0.5 秒を超えた | そこで止める。録れた分の扱いは §5 Q2（おすすめ: 録れた分を M7 に出し、理由を知らせる）             |
| 10 分                                                                                                                 | 自動で止めて M7、1 回だけ知らせる（9 分で「残り 1 分」も 1 回）                                    |
| 1 小節目より前に止めた（声が 1 小節も無い）                                                                           | M7 に出さず M3 に戻し「短すぎます」                                                                |
| 録音中に「やめて戻る」・ブラウザの戻る                                                                                | 「やめて戻る」は M5・M6 で使えない（決定）。ブラウザの戻るは録音を止めて捨て、今と同じく画面を出る |
| `outputLatency` が取れない                                                                                            | 0 として扱う（PC の Chromium では取れる）                                                          |

### 2.7 アクセシビリティ

- ライブ領域は S2 の 1 つだけ（`import-live`、`useAnalysisRun` の `say`）。`MicRecorder` は文を `say` に渡すだけで、自分のライブ領域を持たない。`LatencyDialog` も同じ。
- 読み上げるのは状態が変わった時だけ（許可された、数えを始めた、録音を始めた、残り 1 分、止めた・自動で止めた・割り込み、遅れを覚えた / 拾えなかった）。拍ごと・秒ごとには読まない。数えの表示は `aria-hidden`。
- フォーカス: M3 → ● 録音、M5 → 「やめる」、M6 → ■ 止める、M7 → 録音のカードの見出し、M2 → エラーの枠（今の `notice` と同じ）。ダイアログは `Dialog` の決まり（閉じたら開いたボタンへ）。
- エラーの文は `role="alert"` にしない（CLAUDE.md の決まり。読み上げはライブ領域だけ）。メーターは `role="meter"`（ライブにしない）。

## 3. テスト

| 種類           | 何を                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 単体           | `src/lib/mic/` の全部（拍の時刻と 6/8・3/4、検出の写しのテスト、遅れの判定の境目、かたまりの順序の乱れ・隙間・重なり、切り出しと補正の丸め、10 分、wav の往復、状態の移り変わり全部）。`storage.ts` の新しい鍵（壊れた値・例外）                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 単体（フック） | `useMicRecorder` を `fakeMicSession` で（割り込み、M7 でマイクを止める、離れる時に閉じる）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Storybook      | 部品ごとに 1 つ以上。`fakeMicSession` で M2〜M8、測定の成功と失敗、残り 1 分、自動停止、a11y                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| e2e            | 新しい Playwright のプロジェクト `mic`（`testMatch: /mic\.spec/`、`launchOptions.args`: `--use-fake-ui-for-media-stream`・`--use-fake-device-for-media-stream`・`--use-file-for-fake-audio-capture=<合成の鼻歌 wav>%noloop`）。既定の `chromium` の `testIgnore` に `mic\.spec` を足し、他のプロジェクトはこの引数を持たない。wav は既存の合成の鼻歌（`src/lib/analysis/fixtures/hum.wav`）から `e2e/support/analysisAudio.ts` の `writeWav16` で前に無音を足して作る。流れ: マイクで録る → 数え → 数秒録る → 止める → M7 → 下書きを作る → S4 に音符が出る → 保存（download イベント）。偽のマイクは時刻がそろわないので、ここでは流れだけを見る。余所への要求 0 件 |
| CSP            | `npm run e2e:csp` の設定にも同じ引数を足し、マイクの流れで違反 0 件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 実機           | G1（下記）。ヘッドホンをマイクに当てたまま録った wav で、クリックの位置とファイルの拍の時刻の差を `latency.ts` の検出で測る（±10 ms 以内なら補正は合っている）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

テストの音は合成だけ。ユーザーの録音はリポジトリに入れない。

## 4. タスク

ブランチは `<type>/<issue#>-<slug>`、issue は本書の確定後に作る。PR は小さく、各タスクは自分のファイルだけを変える。テストは対象だけを回す（WSL が落ちやすいため。全体は T7 で）。レビューは毎回「正しさ ＋ DRY ＋ YAGNI」を見る独立のもの。

| id                                   | 中身                                                                                                                                                                                                                                    | ファイル                                                                                   | 依存                           | 終わりの条件 / 確かめ                                                                                         | モデル                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Q                                    | §5 の質問にユーザーが答え、本書を確定                                                                                                                                                                                                   | 本書                                                                                       | —                              | 決定を §1 に移す                                                                                              | —                                                              |
| R1 `refactor/…-hum-setup-source`     | **動作を変えない**: `HumSetup` の 1 枚目のカードの中身（`AudioFileField`）、エラーの「別のファイルを選ぶ」、まとめの「ファイル」の行、「録り方」を、受け取る側（`source` などの props）にする。今のファイルの形はそのまま組み立てる     | `HumSetup`、`HumImportScreen`                                                              | Q                              | 既存の単体・stories・`e2e/hum-import.spec.ts` が意味を変えずに通る。PR に確かめ方を書く                       | Sonnet → Opus のレビュー                                       |
| T1 `feature/…-mic-lib-click-latency` | `clickTrack.ts`・`latency.ts`（T13 の写し ＋ 判定 ＋ 補正）・`storage.ts` の遅れの鍵、テスト駆動                                                                                                                                        | `src/lib/mic/`、`storage.ts`                                                               | Q                              | 単体が通る。T13 の元のテストも写って通る                                                                      | Sonnet（関数の形・端の場合を渡す）→ Opus のレビュー            |
| T2 `feature/…-mic-lib-take-wav`      | `takeBuffer.ts`・`wav.ts`、テスト駆動                                                                                                                                                                                                   | `src/lib/mic/`                                                                             | Q                              | 単体（wav は `audioFile.ts` で読み直して一致）                                                                | Sonnet → T1 と合わせて Opus のレビュー                         |
| T3 `feature/…-mic-session`           | `src/audio/`（`micSession`・worklet の `?worker&url`・`fakeMicSession`・`saveFile`）、`csp.ts` のコメント、`e2e:csp` の引数、`check-bundle` で入口の chunk にマイクのコードが無いこと                                                   | `src/audio/`、`csp.ts`、`playwright.csp.config.ts`、`scripts/check-bundle.mjs`             | T1, T2                         | 仮のページか story で本物のマイクが開き、`npm run e2e:csp` が違反 0、ビルドが通る                             | Opus（ブラウザ・Vite・CSP にまたがる）→ 独立レビュー           |
| T4 `feature/…-mic-recorder-state`    | `recorderState.ts`・`micTexts.ts`（§2.6 の表を全部）、`useMicRecorder`                                                                                                                                                                  | `src/lib/mic/`、`src/hooks/`                                                               | T1, T2, T3（インターフェース） | 単体（偽のセッションと時計）                                                                                  | Opus（端の場合が多い）→ 独立レビュー                           |
| T5 `feature/…-mic-recorder-ui`       | `MicRecorder`・`LevelMeter`・`TakeWaveform`・`LatencyDialog` と stories（`fakeMicSession`）                                                                                                                                             | `src/components/`                                                                          | T4                             | `npm run test:storybook` の対象の stories が通る（a11y 込み）。見た目をキャンバスと見比べるスクリーンショット | Sonnet（キャンバスの M2〜M8 と props を渡す）→ Opus のレビュー |
| T6 `feature/…-mic-hum-import`        | S2 の切り替え、録音 → `pick` → `startSec` の解析（`humRunInfo` の `bar1Sec`）、S4 の「録音を保存（wav）」、フォーカスとライブ領域、離れる時にマイクを閉じる、e2e の `mic` プロジェクトと `e2e/mic.spec.ts`                              | `HumImportScreen`、`HumSetup`、`HumReview`、`humImport.ts`、`playwright.config.ts`、`e2e/` | R1, T5                         | 単体・stories・`npm run e2e`（mic と hum-import）・`npm run e2e:csp`                                          | Opus（画面をまたぐつなぎ）→ 独立レビュー → 直しは Sonnet       |
| T7                                   | 全体の確かめ: `npm test`・`tsc -b`・lint・prettier・build・`test:storybook`・`e2e`・`e2e:csp`。10 分の偽の録音で Playwright の RSS を測る（目安: 録音中の増え 150 MB 以下）                                                             | —                                                                                          | T6                             | 結果の短いまとめ（数字は自分で確かめる）                                                                      | Haiku                                                          |
| G1                                   | ユーザーが自分のマイク（L-12）で: 遅れを測る、数曲録る、下書きを作る、保存した wav を「ファイルを選ぶ」で使い直す。1 回はヘッドホンをマイクに当てたまま録り、その wav でずれを測る（§3 実機）                                           | —                                                                                          | T7                             | 使い心地の判断。ずれ ±10 ms 以内。直すことがあれば小さな fix の PR                                            | —（ずれの計算は Haiku）                                        |
| S1                                   | SOLID のレビュー（マイク録音の範囲全体。SRP・OCP・LSP・ISP・DIP を 1 人ずつ、5 人の独立の Opus）。直しは別の refactor の PR                                                                                                             | —                                                                                          | G1                             | 指摘の一覧と、直す / 直さないの判断                                                                           | Opus ×5                                                        |
| T8 `docs/…-mic-recording`            | `CLAUDE.md`（Source layout: `src/lib/mic/`・`src/audio/`・部品、Gotchas: worklet の読み込み、遅れの補正、e2e の `mic` プロジェクト）、`docs/csp.md`、`roadmap.md`（済みへ）、`audio-integration-plan.md` §10 ① からのリンク、本書の実績 | docs                                                                                       | G1                             | 文書の先頭に読者と目的。レビューに「削除提案」                                                                | Sonnet                                                         |

- R1・T1・T2 は Q の後に並べられる（ファイルが重ならない）。T3 は T1・T2 の型を待つ。
- ファイルの重なり: `HumSetup`・`HumImportScreen` は R1 と T6 だけ（順番）。`storage.ts` は T1 だけ。`playwright*.config.ts` は T3（csp）と T6（既定）で別のファイル。`CLAUDE.md` は T8 だけ。

## 5. 未決（ユーザーに聞く）

1 つずつ聞く。

- **Q1 録音のファイルに数えの 1 小節を残すか**。(a) 残す（おすすめ。ファイルの 0 秒 = 数えの頭で分かりやすく、M7 の小節線・クリックの再生・保存した wav の使い直しがそろう。S4 の始めに 1 小節ぶんの無音が見える）。(b) 1 小節目の 1 拍前から始める（無音が短い。ただし早めに入った声が切れないよう余白の長さを決める必要がある）。(c) 1 小節目ちょうどから。
- **Q2 録音中に割り込み（タブが隠れた・マイクが抜けた・許可の取り消しなど）で止まった時**。(a) 録れた分を M7 に出し、理由を知らせる（おすすめ。長い録音が無駄にならない。要らなければ録り直す）。(b) 捨てて M3 に戻る（分かりやすいが、9 分録った後でも消える）。

## 6. リスク

| リスク                                                                                                           | 対策                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| worklet の chunk が CSP（`script-src 'self'`）で読めない、または Vite が `?worker&url` で worklet 向けに出せない | T3 の最初に `e2e:csp` で確かめる。だめなら blob: を `script-src` に足す前にユーザーに聞く（トークンが localStorage にあるため） |
| 開き直しで遅れが数 ms 変わる（T13 で 3.7 ms）                                                                    | `baseLatency`・`outputLatency` は毎回読み直す。残りは許容（16 分音符の手直しの範囲）。G1 で実機で確かめる                       |
| 遅れを測っていない人の 45〜50 ms のずれ                                                                          | 控えめな案内。解析の `onsetBias` がかなり吸収する。G1 で測る前後を比べる                                                        |
| ヘッドホンなしでクリックが録音に漏れる                                                                           | 案内（決定）。エコー除去を切っているので消えない。下書きが乱れたら録り直し                                                      |
| 長い録音のメモリ                                                                                                 | Int16 のかたまり、つながない、すぐ捨てる。T7 で 10 分を測る                                                                     |
| 偽のマイクでは時刻の正しさを e2e で確かめられない                                                                | 補正の計算は単体で、実機は G1 のヘッドホンを当てた録音で                                                                        |
| Bluetooth のヘッドホン（遅れが大きく揺れやすい）                                                                 | 申告値に出る分は補正される。揺れは G1 では確かめない。案内に「有線のヘッドホン」を入れるかは T5 で文言を見て決める              |
