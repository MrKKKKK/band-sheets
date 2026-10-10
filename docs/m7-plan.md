# M7 タスク計画: Google Drive への保存・読み込み

方針は `m7-decisions.md`（マイドライブの専用フォルダ「band-sheets」・自分だけで使う・衝突は 3 択＋キャンセル・端末名は自動・Drive のファイル名は曲名と連動し曲の区別は内部 ID・タブレットの閲覧から編集には入れない・通信が遅いときは前回の一覧と曲を先に出す・並び順の初期値は「更新が新しい順」・閲覧だけでは下書きを作らない）と、承認済みのキャンバス「band-sheets Drive 保存（M7）」（https://claude.ai/artifact/2M2aEXmUjKRpm46WsnYaX5 の 初回ログイン／曲の一覧／編集画面のヘッダー／保存の衝突／タブレットの曲選び／下書きと Drive の関係）に従う。

元データはこれまでどおり **ChordPro テキスト 1 つ**（編集画面の `App` の `text`）。M7 で増えるのは「どの曲を開いているか」「その曲の Drive の版」「この端末の下書き」の管理と、その上の画面（ログイン・一覧・保存・衝突）。M2〜M6 と同じく、判断はすべて純粋関数（`src/lib/`）に置いて TDD、Drive との通信は差し替えられる `DriveClient` の後ろに隠し、テストでは本物の Google に一度もつながない。Google Cloud 側の準備（OAuth クライアント ID の作成）はユーザーが `docs/m7-google-setup.md` の手順で行う。

## 主な設計判断

1. **認証: バックエンドなし、Google Identity Services（GIS）のトークンモデル＋`drive.file` スコープ**。
   - サーバーを持たない静的アプリなので、ブラウザだけで完結する GIS の **トークンモデル**（`google.accounts.oauth2.initTokenClient({ client_id, scope: 'https://www.googleapis.com/auth/drive.file', callback, error_callback })` → `requestAccessToken()`）を使う。クライアントシークレットは使わない（Web アプリのトークンモデルでは不要。クライアント ID は秘密ではない）。リフレッシュトークンは無い。
   - アクセストークンの寿命は約 1 時間（`expires_in`）。トークンと期限を `localStorage` の `band-sheets:auth` に保存し、**期限内ならアプリを開き直しても自動でログイン状態**（キャンバスの付箋「ログインは毎回出さず、トークンが残っていれば自動で一覧へ」）。期限の 1 分前からは「期限切れ」として扱う。
   - **期限切れのとき**: `requestAccessToken({ prompt: '' })` は一度許可した人には同意画面を出さずにポップアップを一瞬開いて閉じるだけで新しいトークンを返す。ただしポップアップはユーザーの操作（クリック・キー）の中でしか開けない（ページを開いた直後に自動で呼ぶとブロックされる）。そこで、(a) 「保存」・Ctrl+S・「最新の状態に更新」・「もう一度つなぐ」の操作の中で、`await` より前に同期的に `requestAccessToken` を呼ぶ（`auth.ensureToken()` が「有効ならそのまま返す／切れていればその場で要求して Promise を返す」）、(b) ページを開いた時点で切れていれば、前回の一覧（キャッシュ）を出したうえで「Drive に再接続」のバナーを出す。API が 401 を返したらトークンを捨てて同じ扱い。
   - ログアウト: アカウントのメニューから。`google.accounts.oauth2.revoke(token)`、`band-sheets:auth` と Drive の一覧・本文のキャッシュを消す。**下書き（未保存の変更）は残す**（この端末の作業を失わない）。
   - **ログインしなくても使える**（キャンバスどおり）: 曲を作って編集でき、下書きはこの端末に自動保存。一覧には「この端末だけ（Drive 未保存）」の曲として出る（確認したい点 1）。保存ボタンは「ログインして保存」。
   - GIS のスクリプト（`https://accounts.google.com/gsi/client`）は `index.html` に書かず、**ログインが必要になったときに `<script>` を動的に足して読み込む**（`loadGis()`、1 回だけ・失敗は「Google に接続できません」）。テスト・ストーリーは GIS を読まない（`DriveAuth` インターフェースを偽物に差し替え）。今は CSP を設定していないので追加の設定は不要（公開時に CSP を入れるなら `script-src https://accounts.google.com/gsi/client`・`connect-src https://www.googleapis.com`・`frame-src https://accounts.google.com` が要る、と T18 で CLAUDE.md に書く）。
   - クライアント ID は `import.meta.env.VITE_GOOGLE_CLIENT_ID`（`.env.local`、`.gitignore` の `*.local` で除外済み）。未設定ならログインのボタンを出さず「Drive は設定されていません（docs/m7-google-setup.md）」を出して、ローカルだけで動く。
   - 採らなかった案: (a) GIS のコードモデル＋バックエンドでリフレッシュトークン（サーバーが要る、MVP の「静的ホスティング」と合わない）、(b) `gapi.client`（重い・グローバル・テストで差し替えにくい。使う API は 6 種類だけ）。

2. **Drive API v3 は `fetch` で直接呼ぶ（`gapi` は使わない）**。`DriveClient` インターフェースの本物は `createFetchDriveClient({ getToken, fetch })`、テスト用は `createFakeDriveClient()`（メモリ上の Drive、版番号・更新時刻・ゴミ箱・失敗の注入つき）。使うもの:
   - フォルダ: `files.list` の `q = "name = 'band-sheets' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false"`。無ければ `files.create`（`appProperties: { app: 'band-sheets', role: 'root' }`）。フォルダの ID は一覧のキャッシュに覚える。2 台で同時に初回を迎えて 2 つできたら `createdTime` が古いほうを使う。
   - **`drive.file` で見えるのは、このアプリ（同じ OAuth クライアント＝同じ Cloud プロジェクト）が作った・開いたファイルだけ**。したがって: フォルダはアプリが作ったものでないといけない（ユーザーが手で作った「band-sheets」は見えないので、同名のフォルダがもう 1 つできる）。PC で作った曲はタブレットでも見える（同じユーザー・同じクライアント ID なら端末に関係なく見える）。ユーザーが Drive の画面でフォルダに手でアップロードしたファイルは一覧に出ない（M7 では取り込み機能を作らない。説明だけ）。→ T2 で公式ドキュメントで再確認して findings に書く。
   - 一覧: `files.list`（`q = "'<folderId>' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'"`、`fields = nextPageToken, files(id, name, version, modifiedTime, appProperties, size)`、`pageSize = 1000`、`nextPageToken` で続き）。並べ替えはアプリ側。
   - 本文: `files.get?alt=media`。メタデータ: `files.get?fields=id,name,version,modifiedTime,appProperties,trashed`。
   - 新規: `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`（`multipart/related`、1 つ目にメタデータ JSON `{ name, mimeType: 'text/plain', parents: [folderId], appProperties }`、2 つ目に本文 `text/plain; charset=UTF-8`）。更新: `PATCH .../upload/drive/v3/files/<id>?uploadType=multipart`（名前・`appProperties` と本文を 1 回で）。どちらも `fields=id,name,version,modifiedTime,appProperties` を付けて新しい版を受け取る。
   - 削除: `PATCH files/<id>` で `{ trashed: true }`（ゴミ箱。30 日は Drive から戻せる）。複製: 本文を読んで新しい曲として `create`（`files.copy` は `appProperties` の曲 ID まで写るので使わない）。
   - `appProperties`（このアプリだけに見えるキーと値、1 組 124 バイトまで）: `app: 'band-sheets'`・`songId`・`device`（最後に保存した端末名）・`format: '1'`。
   - エラーは `DriveError { kind: 'auth' | 'notFound' | 'rateLimit' | 'network' | 'server' | 'other', status? }` にまとめる（401 → auth、403 の `rateLimitExceeded`/`userRateLimitExceeded` と 429 → rateLimit、`fetch` の失敗・オフライン → network）。rateLimit と 5xx は 1 回だけ 1 秒後に再試行。

3. **衝突の検出: 保存の直前に Drive の版を確かめる（確認してから書く）**。
   - Drive v3 の `files.update` には、v2 の ETag / `If-Match` のような「この版のときだけ書く」という条件付き更新が**文書化されていない**（v3 のファイルには `etag` が無い）。これを前提にしない（T2 で確認。もし使えるなら追加の安全策として足すだけ）。
   - 各曲について「最後に Drive とそろえた版」（`base`: `fileId`・`version`・`modifiedTime`・本文）をこの端末に覚える。保存のとき: (1) `files.get` で今の `version` を取る、(2) `base.version` と同じなら書く、(3) 違えば本文を読み、`base` の本文と同じなら（名前の変更・Drive 内部の処理などで版だけ進んだ）書く、(4) 本文も違えば**衝突**（ダイアログ）。`version` は「サーバー側のあらゆる変更で増える単調増加の番号」なので、版だけ違って中身が同じ、という空振りを (3) で吸収する。
   - (1) と書き込みのあいだに別の端末が保存する競合は残る（数百ミリ秒）。自分 1 人の PC とタブレット（タブレットは編集しない）なので許容し、レビュー（T20）の観点に入れる。
   - 衝突ダイアログ（キャンバス「保存がぶつかったとき」、m7-decisions.md の 3 択＋キャンセル）: **上書きする**（確認なしで書く）／**Drive の方を読み直す（手元の変更は別の曲として残す）**（手元の本文の曲名を「<曲名>（手元の版 10/6 15:12）」に変えて新しい曲として Drive に作り、この画面は Drive の最新を開き直す）／**Drive の方を読み直す（手元の変更は捨てる）**（下書きを消して開き直す）／**キャンセル**（何もしない。未保存のまま）。ダイアログには Drive の版（更新時刻・端末名）と手元の版（下書きの時刻・この端末名・元にした版の時刻）を出す。キャンバスの「変更の目安: Aメロのコードが 2 小節ぶん違います」は M7 では出さない（差分の要約は作らない。確認したい点 4）。

4. **曲 ID と下書き・Drive の対応**。
   - **曲 ID** = `crypto.randomUUID()`。新しい曲を作った時点（ログイン前でも）で決まり、Drive に保存すると `appProperties.songId` に書く。曲は ID で区別し、ファイル名や曲名では区別しない。Drive のファイルに `songId` が無い・同じ `songId` のファイルが 2 つある（Drive の画面で複製したなど）ときは、`drive-<fileId>` をその曲の ID とみなす（決まった値なので端末が変わっても同じ）。
   - この端末に覚えるもの（すべて `storage.ts` 経由、try/catch）:
     - `band-sheets:index` — 曲の一覧のキャッシュ `{ v: 1, folderId?, listedAt?, songs: SongEntry[] }`（Drive の一覧＋この端末だけの曲）。通信が遅い・つながらないときはこれを先に出す。
     - `band-sheets:base:<songId>` — 最後に Drive とそろえた版 `{ fileId, version, modifiedTime, device?, text }`。オフラインでの閲覧・衝突の判定の元。タブレットの「この iPad に保存済み」はこれがあること。
     - `band-sheets:draft:<songId>` — 下書き。**値を JSON `{ v: 1, text, baseVersion, savedAt }` に変える**（`baseVersion` = 編集を始めたときの `base.version`、ログイン前・未保存の曲は `null`）。JSON として読めない値は M3〜M6 の生のテキストとみなす（ChordPro は `{title: …}` で始まり JSON にならない）。
     - `band-sheets:viewer:<songId>`（M6 のまま）、`band-sheets:editor-mode`（そのまま）、`band-sheets:auth`、`band-sheets:device`（自動判定した端末名を初回に固定。確認したい点 2）。
   - **「未保存の変更あり」= 下書きがあり、その本文が `base` の本文と違う**。保存に成功したら `base` を新しい版で書き換えて下書きを消す（キャンバスの「保存に成功したら下書きは Drive と同じ印にして…」を「消す」で実現）。編集で元と同じ本文に戻したときも未保存の印は消える。
   - **閲覧だけでは下書きを作らない**: 閲覧画面は `text` を書かないし、編集画面の `useAutosave` も「開いたときの本文は書き戻さない」（M3 から）ので、編集画面を開いただけでも下書きはできない。
   - **曲を編集で開くとき**（キャンバス「下書きと Drive の関係」A/B/C、`decideOpen`）: Drive の今の版を取りに行き（つながらなければ `base` で判断）、
     - A. 下書きが無い／`base` と同じ → Drive の版を開く（聞かない）。
     - B. 下書きがあり、`draft.baseVersion` が Drive の今の版と同じ（保存し忘れ）→「保存していない下書きが残っています」: **下書きから続ける**（既定）／**Drive の版を開く（下書きは破棄）**。
     - C. 下書きがあり、Drive の方が新しい（別の端末で保存された）→「Drive の版が新しくなっています」: **Drive の版を開く**（既定、下書きは破棄）／**古い下書きも別の曲として残す**（下書きを「<曲名>（手元の版 …）」の新しい曲として Drive に作ってから Drive の版を開く）。
     - Drive に無い曲（この端末だけ）→ 下書きをそのまま開く。オフラインで `base` も無い Drive の曲 →「Drive につながらないため開けません」。
   - **既存の `local` の移行**（`migrateLegacyLocal`、起動時に 1 回）: `band-sheets:draft:local` があり、一覧のキャッシュにまだ無ければ、新しい曲 ID を作って下書き（JSON に変換、`baseVersion: null`）と `band-sheets:viewer:local` をその ID に移し、「この端末だけ」の曲として一覧に入れ、古いキーを消す。`LOCAL_SONG_ID` は移行のためだけに残す。
   - **端末名**: `deviceName({ userAgent, platform, maxTouchPoints })` で「iPad」「iPhone」「Android タブレット」「Android」「Mac」「Windows PC」「Linux PC」「PC」（iPadOS 13 以降の Safari は Mac の UA を名乗るので `maxTouchPoints > 1` の Mac を iPad とみなす）。一覧の「最終更新（端末）」と衝突ダイアログに出す。
   - **ファイル名**: `fileNameForTitle(title)` = 曲名の前後の空白を除き、`/ \ : * ? " < > |` と制御文字を `_` に、連続する空白を 1 つに、80 文字で切り、空なら「無題の曲」、拡張子 `.chordpro`（確認したい点 3）。Drive は同じ名前のファイルを許すので、**同じ曲名でも番号を付けない**（区別は曲 ID。一覧では更新時刻と端末で見分ける）。曲名を変えて保存すると、その保存でファイル名も変える（本文と名前を 1 回の `PATCH` で）。
   - 一覧の「名前を変える」= 本文の `{title:}` とファイル名を変えて保存（上と同じ衝突の確認つき）。その曲に未保存の変更があるときは押せない（「未保存の変更があるときは編集画面で曲名を変えてください」）。「複製する」= 「<曲名> のコピー」の新しい曲。「削除する…」= 確認のうえ Drive のゴミ箱へ、この端末の下書き・`base`・閲覧の設定も消す（この端末だけの曲は確認のうえ下書きを消すだけ）。

5. **画面と URL（ハッシュで切り替え、`src/lib/route.ts`）**。
   - `#/`（空も）= 曲の一覧、`#/edit/<songId>` = 編集、`#/view/<songId>` = 閲覧、`#/new` = 新しい曲を作って `#/edit/<id>` に置き換え（e2e と「新しい曲」ボタン用）。M6 の `#view` はタブレットのブックマーク用だったので、`#view` で開いたら一覧に置き換える。
   - 新しく `src/Root.tsx`（ルーティング・ログイン状態・一覧の状態を持つ一番外側）を作り、`main.tsx` は `Root` を描く。今の `App` は「1 曲の編集画面」として残し（テキストが唯一の元データ・編集の各タブはそのまま）、`initialText`・`baseVersion`・ヘッダーの差し込み（左に「‹ 曲の一覧」、右に保存の状態＋「保存」）・`onTextChange` を props で受ける。閲覧の切り替えは M6 の「`App` の中の閲覧モード」を保ち、ハッシュの読み書きだけ `Root` に移す（`App` は `viewing`/`onEnterView`/`onExitView` を受ける）: 編集から「閲覧モード」→ `#/view/<id>` を `pushState`、**編集のツリーはマウントしたまま `hidden`**（M6 と同じ）。一覧や直接の URL から `#/view/<id>` を開いたときは編集画面をマウントせず閲覧画面だけ（下書きを作らない）、閲覧のバーの左端は「‹ 曲の一覧」。
   - **曲の一覧（PC）**（キャンバス「曲の一覧」）: 上のバー（band-sheets・「マイドライブ / band-sheets」・「最新の状態に更新」・アカウント）、見出し・件数（「5 曲 ・ 1 曲は未保存の変更あり」）・曲名で検索・並び順（更新が新しい順／曲名順）・「新しい曲」、表（曲名とパート・キー/テンポ/拍子・最終更新（端末）・状態・「開く」「閲覧で開く」「…」（名前を変える・複製する・削除する…））。状態は 同期済み／未保存の変更あり／Drive が新しい（下書きの元にした版より Drive が新しい）／この端末だけ。0 件の案内、オフラインのバナー（「Drive につながりません。前回読み込んだ一覧（10/6 14:40 時点）を表示しています…」＋「もう一度つなぐ」）。一覧の曲名・キーなどは Drive の一覧に無いので、本文を読んだ曲は `base` から、読んでいない曲はファイル名から出す（「更新」のときに本文の無い・古い曲の本文を順に取って `base` を埋める。M7 の規模（数十曲）なら問題ない）。
   - **曲を選ぶ（タブレット）**（キャンバス「タブレット: 曲を選んで閲覧」）: 行全体をタップで閲覧、「編集」は出さない（m7-decisions.md）。同期の状態と「更新」、検索、並び順（**更新が新しい順**／曲名順。キャンバスの「最近開いた順」は決定に合わせて直す）、行ごとに「この iPad に保存済み／Drive から取得します／読み込み中…」。下の説明は「曲の編集は PC で行います。」だけにする（キャンバスの「閲覧画面の『編集』から開けます」は決定と合わないので消す）。どちらの一覧を出すかは `matchMedia('(hover: none) and (pointer: coarse)')`（タッチだけの端末）で決める。
   - **ログイン画面**（キャンバス「初回: Google でログイン」）: 一度もログインしたことがなく、この端末に曲も無いときの最初の画面。「Google でログイン」（押すとポップアップ、待っている間の案内）、「ログインせずに編集を始める →」（`#/new`）、「このアプリがさわれるもの」の説明、許可の取り消し方。一覧の上のバーの「ログイン」からも同じ処理。
   - **編集画面のヘッダー**（キャンバス「編集画面のヘッダー（保存）」）: 状態 保存済み（「14:32 に Drive へ保存」、ボタンは目立たせない）／未保存の変更あり（「下書きは自動保存済み（14:35）」、主ボタン）／保存中…（ボタンを押せない、編集は続けられる）／保存に失敗（「通信できませんでした。下書きは残っています」・「ログインの期限が切れました」など、赤、「もう一度保存」）＋ログインしていないとき（「この端末だけに保存」、「ログインして保存」）。**Ctrl+S（Mac は ⌘S）** で保存（`preventDefault` でブラウザの「ページを保存」を止める。閲覧中・ダイアログ表示中は無視。IME 変換中も無視）。未保存のまま「‹ 曲の一覧」を押したら「保存せずに一覧に戻りますか？（下書きはこの端末に残ります）」: 保存して戻る／保存せずに戻る／キャンセル。
   - 閲覧画面でも、Drive の版が開いたあとに新しくなっていたら（開いた直後の確認で分かったら）、キャッシュで出していた版を新しい版に差し替えて「Drive の新しい版を表示しています」を 1 行出す（演奏中の差し替えを避けるため、確認は開いたときの 1 回だけ）。

6. **テスト**: 本物の Google には一度もつながない。
   - 純粋関数（route・deviceName・fileName・storage・songIndex・draftState）は Vitest の単体テストで TDD。
   - Drive の処理（`songSync.ts`）と状態のフック（`useSongLibrary`・`useSongDocument`）は `createFakeDriveClient()` を注入して単体テスト（衝突・版だけ進んだ・オフライン・401・同じ songId のファイル 2 つ、など）。`fetchDriveClient` は `fetch` を偽物にして、URL・メソッド・ヘッダー・multipart の本文・エラーの変換をテスト。
   - 部品と画面はストーリー＋play テスト（偽の Drive と偽の認証を props / `Root` の引数で注入）。
   - e2e は Playwright の `page.route` で `https://www.googleapis.com/**` をメモリ上の偽 Drive（`e2e/support/fakeDrive.ts`）に、`https://accounts.google.com/gsi/client` を偽の GIS スクリプト（`initTokenClient` がすぐ偽トークンを返す）に差し替える。本物の `fetchDriveClient` を通る。`playwright.config.ts` の `webServer` で `VITE_GOOGLE_CLIENT_ID=e2e-fake-client-id` を渡す。
   - 最後に 1 回だけ、ユーザーが本物のクライアント ID で手で確かめる（U1）。

## 共通 API（並行作業の前提として先に固定する）

```ts
// src/lib/syncTypes.ts（T1。型だけ）
export interface DriveFileMeta {
  id: string;
  name: string;
  /** Drive の version（数字の文字列）。比較は文字列の一致だけ */
  version: string;
  modifiedTime: string; // RFC 3339
  appProperties?: Record<string, string>;
}
export interface BaseRecord {
  fileId: string;
  version: string;
  modifiedTime: string;
  device?: string;
  text: string;
}
export interface DraftRecord {
  v: 1;
  text: string;
  /** 編集を始めたときの base.version。Drive に無い曲は null */
  baseVersion: string | null;
  savedAt: string; // ISO
}
export type SongStatus = 'synced' | 'dirty' | 'driveNewer' | 'localOnly';
export interface SongEntry {
  songId: string;
  fileId?: string; // 無ければこの端末だけ
  title: string;
  /** 「C ・ ♩=100 ・ 4/4」。本文を読んでいなければ '' */
  summary: string;
  /** 「コード譜・メロディ・ドラム」。本文を読んでいなければ '' */
  parts: string;
  modifiedTime?: string; // Drive の更新時刻（この端末だけの曲は下書きの時刻）
  device?: string; // 最後に保存した端末
  version?: string; // Drive の今の版（一覧を取ったとき）
}
export interface SongIndex {
  v: 1;
  folderId?: string;
  listedAt?: string;
  songs: SongEntry[];
}
export type SortOrder = 'modified' | 'title';
export type SaveState =
  | { kind: 'saved'; at: string }
  | { kind: 'dirty'; draftAt: string }
  | { kind: 'saving' }
  | { kind: 'failed'; reason: 'network' | 'auth' | 'other' }
  | { kind: 'localOnly'; draftAt?: string }; // ログインしていない／Drive に無い
export type OpenDecision =
  | { kind: 'drive' } // A
  | { kind: 'askResume' } // B
  | { kind: 'driveNewer' } // C
  | { kind: 'draftOnly' } // Drive に無い曲
  | { kind: 'unavailable' }; // オフラインで base も下書きも無い
export type ConflictChoice = 'overwrite' | 'reloadKeepCopy' | 'reloadDiscard';
export type DriveErrorKind =
  'auth' | 'notFound' | 'rateLimit' | 'network' | 'server' | 'other';

// src/lib/route.ts（T3）
export type Route =
  | { screen: 'list' }
  | { screen: 'new' }
  | { screen: 'edit'; songId: string }
  | { screen: 'view'; songId: string };
export function parseRoute(hash: string): Route; // '#view'・不明 → list
export function routeHash(route: Route): string; // '#/edit/<id>' など

// src/lib/deviceName.ts（T3）
export function deviceName(env: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}): string;

// src/lib/fileName.ts（T3）
export const SONG_FILE_EXT = '.bandsheet'; // 2026-10-06 決定: 独自の拡張子（中身は ChordPro 互換ではないため）。mimeType は text/plain
export function fileNameForTitle(title: string): string;
export function copyTitle(title: string): string; // 「<曲名> のコピー」
export function localCopyTitle(title: string, at: Date): string; // 「<曲名>（手元の版 10/6 15:12）」

// src/lib/storage.ts（T4。既存に追加）
export type KeyValueStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;
export function loadDraftRecord(
  s: KeyValueStorage | null,
  songId: string,
): DraftRecord | null; // 生テキストは baseVersion null として読む
export function saveDraftRecord(
  s: KeyValueStorage | null,
  songId: string,
  d: DraftRecord,
): boolean;
export function removeDraft(s: KeyValueStorage | null, songId: string): void;
export function loadBase(
  s: KeyValueStorage | null,
  songId: string,
): BaseRecord | null;
export function saveBase(
  s: KeyValueStorage | null,
  songId: string,
  b: BaseRecord,
): boolean;
export function removeSongData(s: KeyValueStorage | null, songId: string): void; // draft・base・viewer
export function loadIndex(s: KeyValueStorage | null): SongIndex; // 壊れていれば空
export function saveIndex(s: KeyValueStorage | null, idx: SongIndex): boolean;
export interface AuthRecord {
  accessToken: string;
  expiresAt: number;
}
export function loadAuth(s: KeyValueStorage | null): AuthRecord | null;
export function saveAuth(s: KeyValueStorage | null, a: AuthRecord | null): void; // null で消す
export function loadDeviceName(
  s: KeyValueStorage | null,
  detect: () => string,
): string; // 初回に固定
export function migrateLegacyLocal(
  s: KeyValueStorage | null,
  newId: () => string,
  now: Date,
): string | null; // 移した曲 ID
// loadDraft/saveDraft（生テキスト）は削除し、呼び出し側（App・useAutosave）は T14 で置き換える

// src/lib/songIndex.ts（T5）
export function songSummary(song: Song): {
  title: string;
  summary: string;
  parts: string;
};
export function entryFromFile(
  f: DriveFileMeta,
  base: BaseRecord | null,
): SongEntry; // songId の決め方（drive-<fileId>）
export function mergeIndex(
  cached: SongIndex,
  files: DriveFileMeta[],
  localOnly: SongEntry[],
  folderId: string,
  now: Date,
): SongIndex;
export function songStatus(
  e: SongEntry,
  draft: DraftRecord | null,
  base: BaseRecord | null,
): SongStatus;
export function sortSongs(
  songs: readonly SongEntry[],
  order: SortOrder,
): SongEntry[]; // 更新が新しい順は modifiedTime 降順、同じなら曲名
export function filterSongs(
  songs: readonly SongEntry[],
  query: string,
): SongEntry[]; // 大文字小文字・全角半角・ひらがなカタカナを区別しない
export function formatModified(iso: string, now: Date): string; // 「今日 14:32」「昨日 21:05」「10/3 18:20」「2025/12/1」

// src/lib/draftState.ts（T6）
export function isDirty(
  draft: DraftRecord | null,
  base: BaseRecord | null,
): boolean;
export function decideOpen(a: {
  draft: DraftRecord | null;
  base: BaseRecord | null;
  remote: DriveFileMeta | null;
  online: boolean;
  hasFile: boolean;
}): OpenDecision;
export function saveStateOf(a: {
  signedIn: boolean;
  hasFile: boolean;
  draft: DraftRecord | null;
  base: BaseRecord | null;
  saving: boolean;
  failed: SaveState | null;
}): SaveState;
export function withTitle(text: string, title: string): string; // parseSong → meta.title → serializeSong

// src/lib/drive/driveClient.ts（T2）
export class DriveError extends Error {
  kind: DriveErrorKind;
  status?: number;
}
export interface DriveClient {
  findFolder(name: string): Promise<DriveFileMeta | null>;
  createFolder(
    name: string,
    appProperties: Record<string, string>,
  ): Promise<DriveFileMeta>;
  listFiles(folderId: string): Promise<DriveFileMeta[]>; // ページをたどって全部
  getMeta(fileId: string): Promise<DriveFileMeta>; // ゴミ箱のものは notFound
  download(fileId: string): Promise<string>;
  create(a: {
    folderId: string;
    name: string;
    text: string;
    appProperties: Record<string, string>;
  }): Promise<DriveFileMeta>;
  update(
    fileId: string,
    a: { name: string; text: string; appProperties: Record<string, string> },
  ): Promise<DriveFileMeta>;
  trash(fileId: string): Promise<void>;
}
export function createFetchDriveClient(o: {
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
}): DriveClient;
// src/lib/drive/fakeDriveClient.ts（T2）
export function createFakeDriveClient(seed?: {
  files?: { meta: Partial<DriveFileMeta>; text: string; parents?: string[] }[];
}): DriveClient & {
  /** 次の n 回の呼び出しを失敗させる */ failNext(
    kind: DriveErrorKind,
    n?: number,
  ): void;
  /** 別の端末の保存をまねる（version を進める） */ externalUpdate(
    fileId: string,
    text: string,
    device?: string,
  ): void;
  files(): { meta: DriveFileMeta; text: string; trashed: boolean }[];
  calls: string[];
};

// src/lib/drive/songSync.ts（T7）
export const FOLDER_NAME = 'band-sheets';
export function ensureFolder(
  c: DriveClient,
  cachedId?: string,
): Promise<string>;
export function fetchList(
  c: DriveClient,
  folderId: string,
): Promise<DriveFileMeta[]>;
export function loadRemote(
  c: DriveClient,
  fileId: string,
): Promise<{ meta: DriveFileMeta; text: string }>;
export type SaveResult =
  | { kind: 'saved'; base: BaseRecord }
  | { kind: 'conflict'; remote: DriveFileMeta; remoteText: string };
export function saveSong(
  c: DriveClient,
  a: {
    songId: string;
    folderId: string;
    text: string;
    base: BaseRecord | null;
    device: string;
    force?: boolean;
  },
): Promise<SaveResult>; // base が無ければ create
export function createSongFile(
  c: DriveClient,
  a: { songId: string; folderId: string; text: string; device: string },
): Promise<BaseRecord>;
export function renameSong(
  c: DriveClient,
  a: {
    songId: string;
    folderId: string;
    base: BaseRecord;
    title: string;
    device: string;
  },
): Promise<SaveResult>;
export function duplicateSong(
  c: DriveClient,
  a: { folderId: string; text: string; device: string; newId: string },
): Promise<BaseRecord>;
export function trashSong(c: DriveClient, fileId: string): Promise<void>; // notFound は成功扱い

// src/lib/auth/gis.ts（T8）
export type AuthStatus = 'unconfigured' | 'signedOut' | 'signedIn' | 'expired';
export interface DriveAuth {
  status(): AuthStatus;
  /** 有効なトークンを返す。切れていれば同期的に GIS の要求を始める（必ずユーザー操作の中で呼ぶ） */
  ensureToken(opts?: { interactive?: boolean }): Promise<string>;
  signIn(): Promise<void>; // 同意画面を出す（prompt: 'consent' ではなく既定）
  signOut(): Promise<void>; // revoke + saveAuth(null)
  invalidate(): void; // 401 を受けたとき
  subscribe(fn: () => void): () => void;
}
export function createGisAuth(o: {
  clientId: string | undefined;
  storage: KeyValueStorage | null;
  loadScript?: () => Promise<GoogleOAuth2>;
  now?: () => number;
}): DriveAuth;
export function createFakeAuth(
  initial?: AuthStatus,
): DriveAuth & { setStatus(s: AuthStatus): void };
```

## タスク

各タスクは自分の「主なファイル」だけを変更する（同じ波の中でファイルが重ならない）。テストはタスクごとに対象ファイルだけを実行し、全体のテストは T19 で 1 回だけ流す（WSL が落ちやすいため）。コマンドはすべてコンテナ内: `docker exec -u node -w /workspaces/band-sheets band-sheets <cmd>`。各タスク共通の確認: `npx tsc -b`、`npx oxlint <変更ファイル>`、`npx prettier --check <変更ファイル>`。ストーリーは `parameters: { a11y: { test: 'error' } }`、偽の Drive・偽の認証・`createMemoryStorage` を注入し、ネットワークに出ない。報告は短く（変更ファイル・テスト件数・未解決の点）。

| #   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 主なファイル（所有）                                                                                                                                                                                                                              | 依存        | テスト（対象だけ実行）                                                                                                                                                                        | モデル   | 実績                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| T1  | 共通 API の `syncTypes.ts`（型だけ）を本書のとおりに作る                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | src/lib/syncTypes.ts                                                                                                                                                                                                                              | —           | `npx tsc -b`                                                                                                                                                                                  | haiku    | 完了（2026-10-06）: `syncTypes.ts`                                                                              |
| T2  | Drive の公式ドキュメントで前提を確認して findings に（`drive.file` で見える範囲・同じクライアントの別端末・`version` の意味・v3 に条件付き更新が無いこと・multipart の create/PATCH・`appProperties` の上限と検索・403/429 の理由の形・GIS トークンモデルの `prompt: ''`・ポップアップとユーザー操作・`expires_in`・`revoke`・テストモードの制限）。食い違いがあれば計画への影響を書く。そのうえで `DriveClient`・`DriveError`・`createFetchDriveClient`（URL・`fields`・`multipart/related` の組み立て、ページ送り、エラーの変換、rateLimit/5xx の 1 回だけの再試行、401 で `auth`）と `createFakeDriveClient`（version・modifiedTime の進み方を本物に合わせる、`failNext`・`externalUpdate`）                                                                                               | src/lib/drive/driveClient.ts, fetchDriveClient.ts, fetchDriveClient.test.ts, fakeDriveClient.ts, fakeDriveClient.test.ts, docs/m7-drive-findings.md                                                                                               | T1          | `npx vitest run --project unit src/lib/drive/fetchDriveClient.test.ts src/lib/drive/fakeDriveClient.test.ts`                                                                                  | opus     | 完了（2026-10-06）: driveClient/fetch/fake（49 件）＋ findings                                                  |
| T3  | `route.ts`（`parseRoute`/`routeHash`、`#view`・空・不明・ID の文字のエスケープ）、`deviceName.ts`（iPad の Mac 偽装・Android の tablet 判定・不明は「PC」）、`fileName.ts`（禁止文字・制御文字・空白・80 文字（サロゲートペアを割らない）・空・`copyTitle`・`localCopyTitle`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | src/lib/route.ts, route.test.ts, src/lib/deviceName.ts, deviceName.test.ts, src/lib/fileName.ts, fileName.test.ts                                                                                                                                 | T1          | `npx vitest run --project unit src/lib/route.test.ts src/lib/deviceName.test.ts src/lib/fileName.test.ts`                                                                                     | sonnet   | 完了（2026-10-06）: route・deviceName・fileName（23 件）                                                        |
| T4  | `storage.ts` の追加（共通 API）: `removeItem`、下書きの JSON 化（生テキストの読み込み）、`base`・`index`・`auth`・`device`、`removeSongData`、`migrateLegacyLocal`（下書きと閲覧の設定を移す・2 回目は何もしない・壊れた値）。`createMemoryStorage` に `removeItem`。既存の `loadDraft`/`saveDraft` は残したまま `@deprecated`（削除は T14）                                                                                                                                                                                                                                                                                                                                                                                                                                                  | src/lib/storage.ts, storage.test.ts                                                                                                                                                                                                               | T1          | `npx vitest run --project unit src/lib/storage.test.ts`                                                                                                                                       | sonnet   | 完了（2026-10-06）: storage の JSON 下書き・base/index/auth/device キー（36 件）                                |
| T5  | `songIndex.ts`: `songSummary`、`entryFromFile`（songId の決め方・重複）、`mergeIndex`（消えたファイル・この端末だけの曲を残す・`base` の情報で曲名などを埋める）、`songStatus`、`sortSongs`、`filterSongs`、`formatModified`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | src/lib/songIndex.ts, songIndex.test.ts                                                                                                                                                                                                           | T1          | `npx vitest run --project unit src/lib/songIndex.test.ts`                                                                                                                                     | sonnet   | 完了（2026-10-06）: songIndex（34 件）                                                                          |
| T6  | `draftState.ts`: `isDirty`、`decideOpen`（A/B/C・Drive に無い・オフライン・`baseVersion` が null の生テキストの下書き＝ B として扱う）、`saveStateOf`、`withTitle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | src/lib/draftState.ts, draftState.test.ts                                                                                                                                                                                                         | T1          | `npx vitest run --project unit src/lib/draftState.test.ts`                                                                                                                                    | sonnet   | 完了（2026-10-06）: draftState（29 件）                                                                         |
| T7  | `songSync.ts`: `ensureFolder`（キャッシュの ID がゴミ箱・消えていたら探し直す・2 つあれば古いほう）、`fetchList`、`loadRemote`、`saveSong`（版が同じ→書く／版が違うが本文が同じ→書く／違う→conflict／`force`／ファイルが消えていた→新しく作る）、`createSongFile`、`renameSong`、`duplicateSong`、`trashSong`。偽の Drive で単体テスト                                                                                                                                                                                                                                                                                                                                                                                                                                                        | src/lib/drive/songSync.ts, songSync.test.ts                                                                                                                                                                                                       | T2, T3, T6  | `npx vitest run --project unit src/lib/drive/songSync.test.ts`                                                                                                                                | opus     | 完了（2026-10-06）: songSync（44 件）                                                                           |
| T8  | `auth/gis.ts`: `loadGis`（動的 `<script>`、1 回だけ、失敗）、`createGisAuth`（トークンの保存と期限、`ensureToken` がユーザー操作の中で同期的に `requestAccessToken` を呼ぶこと、`error_callback`（ポップアップを閉じた・開けない）、`signOut` の revoke、`invalidate`、`subscribe`、クライアント ID 未設定）、`createFakeAuth`。GIS は偽の `google.accounts.oauth2` を注入して単体テスト                                                                                                                                                                                                                                                                                                                                                                                                      | src/lib/auth/gis.ts, gis.test.ts, src/lib/auth/fakeAuth.ts                                                                                                                                                                                        | T4          | `npx vitest run --project unit src/lib/auth/gis.test.ts`                                                                                                                                      | opus     | 完了（2026-10-06）: gis・fakeAuth（34 件）                                                                      |
| T9  | ダイアログ: 汎用の `Dialog`（`role="dialog"`・`aria-modal`・Tab の循環・Esc・開いたらフォーカスを中へ、閉じたら元へ）、`ConflictDialog`（キャンバスどおり 2 つの版の表示＋3 択のラジオ＋キャンセル＋選んだ内容で変わる実行ボタン）、`OpenDraftDialog`（B と C の 2 種類）、`ConfirmDialog`（削除・一覧に戻る確認の 3 ボタン）、`RenameDialog`（曲名の入力、空は不可）                                                                                                                                                                                                                                                                                                                                                                                                                         | src/components/Dialog/_, src/components/ConflictDialog/_, src/components/OpenDraftDialog/_, src/components/ConfirmDialog/_, src/components/RenameDialog/*                                                                                         | T1          | `npx vitest run --project storybook src/components/Dialog src/components/ConflictDialog src/components/OpenDraftDialog src/components/ConfirmDialog src/components/RenameDialog`              | sonnet   | 完了（2026-10-06）: Dialog 系 5 種（ストーリー 12 件）                                                          |
| T10 | `SaveStatus`（ヘッダーの状態の点・文言・補足と「保存」ボタン、5 つの状態、`Ctrl+S` の表示、保存中は押せない）、`ConnectionBanner`（オフライン・再接続が必要・Drive 未設定）、`AccountMenu`（ログイン中の表示・ログアウト／未ログインなら「ログイン」）。状態の色のトークン（同期済みの緑など）が要れば `theme.css` に追加                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | src/components/SaveStatus/_, src/components/ConnectionBanner/_, src/components/AccountMenu/*, src/theme.css                                                                                                                                       | T1          | `npx vitest run --project storybook src/components/SaveStatus src/components/ConnectionBanner src/components/AccountMenu`                                                                     | sonnet   | 完了（2026-10-06）: SaveStatus・ConnectionBanner・AccountMenu（21 件）                                          |
| T11 | `SignInScreen`（キャンバス「初回」: 説明・「Google でログイン」と待っている間の案内・「ログインせずに編集を始める →」・さわれるものの説明・取り消し方、未設定のときの表示）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | src/components/SignInScreen/*                                                                                                                                                                                                                     | T1          | `npx vitest run --project storybook src/components/SignInScreen`                                                                                                                              | sonnet   | 完了（2026-10-06）: SignInScreen（5 件）                                                                        |
| T12 | `SongList`（PC、キャンバス「曲の一覧」: バー・件数・検索・並び順・新しい曲・表・状態のチップ・「開く」「閲覧で開く」「…」のメニュー（名前を変える・複製する・削除する…、未保存の曲は名前を変えられない）・0 件・オフラインのバナーの位置）。データとコールバックは props だけ（Drive を知らない）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | src/components/SongList/*                                                                                                                                                                                                                         | T5, T9, T10 | `npx vitest run --project storybook src/components/SongList`                                                                                                                                  | sonnet   | 完了（2026-10-06）: SongList（12 件）                                                                           |
| T13 | `TabletSongList`（キャンバス「タブレット」: 行全体のボタン、44px 以上、同期の状態と「更新」、検索、並び順 2 つ、「この iPad に保存済み／Drive から取得します／読み込み中…」、下の説明は「曲の編集は PC で行います。」だけ）、幅 1194×834 の枠のストーリー                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | src/components/TabletSongList/*                                                                                                                                                                                                                   | T5, T10     | `npx vitest run --project storybook src/components/TabletSongList`                                                                                                                            | sonnet   | 完了（2026-10-06）: TabletSongList（7 件）                                                                      |
| T14 | `App` を「1 曲の編集画面」に: props `songId`・`initialText`・`baseVersion`・`headerStart`/`headerEnd`・`onTextChange`・`viewing`/`onEnterView`/`onExitView`（ハッシュの処理を外へ）、閲覧の「‹ 曲の一覧」/「編集に戻る」の文言を `Viewer`/`ViewerToolbar` の `backLabel` で。`useAutosave` は `DraftRecord` を保存（`baseVersion` つき、開いたときの本文は書かない、曲 ID が変わったら古い ID に書いてから切り替える（今のまま））。`loadDraft`/`saveDraft` の削除。App のテスト・ストーリーを新しい props に直す                                                                                                                                                                                                                                                                             | src/App.tsx, App.module.css, App.test.tsx, App.stories.tsx, src/hooks/useAutosave.ts, useAutosave.test.ts, src/components/Viewer/Viewer.tsx, src/components/ViewerToolbar/ViewerToolbar.tsx, src/lib/storage.ts（loadDraft/saveDraft の削除だけ） | T4, T6      | `npx vitest run --project unit src/App.test.tsx src/hooks/useAutosave.test.ts` と `npx vitest run --project storybook src/App.stories.tsx src/components/Viewer src/components/ViewerToolbar` | sonnet   | 完了（2026-10-06）: App を 1 曲の編集画面に（unit 73・storybook 41）                                            |
| T15 | 状態のフック: `useDriveSession`（auth の状態・`ensureToken`・端末名・Drive クライアント）、`useSongLibrary`（キャッシュを先に出す → 一覧の取得 → `mergeIndex`・本文の無い曲の補充・オフライン・401 で再接続の状態、新しい曲・名前を変える・複製・削除）、`useSongDocument`（開くときの `decideOpen` とダイアログの答え、保存（`saveSong`）・衝突と 3 択の処理・失敗の理由、保存成功で `base` 更新と下書き削除、`localCopyTitle` での別の曲）。偽の Drive・偽の認証・メモリの storage で `renderHook` の単体テスト                                                                                                                                                                                                                                                                             | src/hooks/useDriveSession.ts(+test), src/hooks/useSongLibrary.ts(+test), src/hooks/useSongDocument.ts(+test)                                                                                                                                      | T7, T8, T14 | `npx vitest run --project unit src/hooks/useDriveSession.test.ts src/hooks/useSongLibrary.test.ts src/hooks/useSongDocument.test.ts`                                                          | opus     | 完了（2026-10-06）: useDriveSession・useSongLibrary・useSongDocument/useSongView（73 件）                       |
| T16 | 組み立て: `Root`（ハッシュのルーティング、`#/new`・`#view` の置き換え、最初の画面（ログイン画面／一覧）、PC とタブレットの一覧の切り替え、起動時の `migrateLegacyLocal`、`useDriveSession`/`useSongLibrary` の注入口）、`EditorScreen`（`App` ＋ヘッダーの「‹ 曲の一覧」と `SaveStatus`、開くときのダイアログ、Ctrl+S/⌘S、衝突、一覧に戻る確認、閲覧の `pushState` と編集のツリーを残す）、`ViewerScreen`（一覧からの閲覧、編集をマウントしない、新しい版の差し替えの 1 行）、`main.tsx`。Root のテスト（ルーティング・移行・閲覧で下書きができない・Ctrl+S・戻る確認）とストーリー（偽の Drive で一覧 → 編集 → 保存 → 衝突）                                                                                                                                                                 | src/Root.tsx, Root.module.css, Root.test.tsx, Root.stories.tsx, src/screens/EditorScreen.tsx(+css), src/screens/ViewerScreen.tsx(+css), src/main.tsx                                                                                              | T9〜T15     | `npx vitest run --project unit src/Root.test.tsx` と `npx vitest run --project storybook src/Root.stories.tsx`                                                                                | opus     | 完了（2026-10-06）: Root・EditorScreen・ViewerScreen（unit 131・storybook 26）                                  |
| T17 | e2e: `vite.config.ts` に `server.port: 5173`・`strictPort: true`（OAuth の許可した送信元とずれないように）、`.env.example`（`VITE_GOOGLE_CLIENT_ID=`）、`playwright.config.ts` の `webServer.env` に偽のクライアント ID、`e2e/support/fakeDrive.ts`（`page.route` の偽 Drive・偽 GIS、版の進み方は T2 の偽物と同じ）、`e2e/support/app.ts`（`#/new` で新しい曲を開く・下書きのキーを URL の ID から求める）、`e2e/drive.spec.ts`（ログイン → 新しい曲 → 保存 → 再読み込みで一覧に出る／別の端末の保存をまねて衝突 → 3 択それぞれ／下書きが残った状態で開く（B・C）／オフラインで一覧と曲のキャッシュ／ログアウト）、タブレットの `tablet` プロジェクトで一覧 → 閲覧（下書きができない）。既存の spec（editor・melody・drums・viewer・smoke）を新しい入口（`#/new`）と JSON の下書きに合わせる | vite.config.ts, .env.example, playwright.config.ts, e2e/support/_, e2e/drive.spec.ts, e2e/editor.spec.ts, e2e/melody.spec.ts, e2e/drums.spec.ts, e2e/viewer.spec.ts, e2e/smoke.spec.ts, docs/m7-_.png                                             | T16         | `npx playwright test`                                                                                                                                                                         | sonnet   | 完了（2026-10-06）: e2e 21 件成功、専用ポート 5174（小修正後）                                                  |
| T18 | ドキュメント更新: CLAUDE.md（構成に M7 の lib/hooks/components/screens、Gotchas: ルートと `#/new`、下書きの JSON と `base`、`drive.file` で見える範囲、条件付き更新が無いので確認してから書く、GIS はユーザー操作の中で、テストは本物の Google につながない（偽の Drive・`page.route`）、`strictPort`、公開時の CSP と送信元の追加）、requirements.md の M7 の状態、本書の実績                                                                                                                                                                                                                                                                                                                                                                                                                | CLAUDE.md, docs/requirements.md, docs/m7-plan.md                                                                                                                                                                                                  | T17         | `npx prettier --check CLAUDE.md docs/requirements.md docs/m7-plan.md`                                                                                                                         | sonnet   | 完了（2026-10-06）: CLAUDE.md・requirements.md・m7-plan.md・google-setup 更新                                   |
| T19 | 全検証を 1 回: `npm test`・`npx tsc -b`・`npm run lint`・`npm run build`・`npm run test:storybook`・`npm run e2e`（両プロジェクト）・`npx prettier --check .`。結果を短く報告（失敗は直さずに報告）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | （なし）                                                                                                                                                                                                                                          | T18         | 左のとおり                                                                                                                                                                                    | haiku    | 完了（2026-10-06）: npm test 2033件、tsc 成功、lint 0警告、build 成功、storybook 332件、e2e 21件、prettier 成功 |
| T20 | 独立レビュー（これまでの観点＋: 衝突の判定の抜け（確認と書き込みのあいだ・ファイル名だけの変更・ゴミ箱に入ったファイル・同じ songId）、下書きが消えてはいけない場面で消えないか（保存の失敗・ログアウト・衝突のキャンセル・別の曲として残す途中の失敗）、閲覧で下書きができないこと、`local` の移行、トークンの扱い（期限・401・ユーザー操作の外で GIS を呼んでいないか・ログに出していないか）、オフライン、テストが本物の Google に出ていないこと、Drive のファイル名の禁止文字）→ `docs/m7-review.md`                                                                                                                                                                                                                                                                                      | docs/m7-review.md                                                                                                                                                                                                                                 | T19         | 使い捨てのスクリプト＋対象のテスト                                                                                                                                                            | opus     |                                                                                                                 |
| U1  | ユーザーによる本物の確認（`docs/m7-google-setup.md` の最後の手順）: 本物のクライアント ID でログイン → 新しい曲を保存 → Drive の画面で「band-sheets」フォルダとファイルを確認 → 別のブラウザ（またはシークレットウィンドウ）で同じ曲を開いて保存 → 元の画面で保存して衝突のダイアログ → ログアウト。結果を本書の実績に                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | （なし）                                                                                                                                                                                                                                          | T20         | 手で確認                                                                                                                                                                                      | ユーザー |                                                                                                                 |

## 波

0. T1
1. T2, T3, T4, T5, T6
2. T7, T8, T9, T10, T11
3. T12, T13, T14
4. T15
5. T16
6. T17 → T18 → T19 → T20 → U1

ファイルの重なりの確認: `storage.ts` は T4（波 1）と T14（波 3、`loadDraft`/`saveDraft` の削除だけ）で波が違う。`theme.css` は T10 のみ（ほかのタスクで新しい色が要るときは既存のトークンを使う）。`App.tsx`・`useAutosave.ts`・`Viewer`・`ViewerToolbar` は T14 のみ、`main.tsx` は T16 のみ、`vite.config.ts`・`playwright.config.ts`・`e2e/*` は T17 のみ、`CLAUDE.md`・`requirements.md` は T18 のみ。`Dialog` は T9 が作り、`SettingsDrawer` は変更しない（共通化は後回し）。

## 検証の進め方

- 各タスクは「テスト」列のコマンドと `npx tsc -b`・対象ファイルの oxlint / prettier だけを実行する。全体の `npm test`・`npm run test:storybook`・`npm run e2e` は T19 で 1 回だけ。
- **本物の Google（`googleapis.com`・`accounts.google.com`）にはテストから一度もつながない**。単体テストは偽の Drive（`createFakeDriveClient`）と偽の認証（`createFakeAuth`）、`fetchDriveClient` は偽の `fetch`、e2e は `page.route` で差し替え（差し替えていない Google の URL へのリクエストはテストを失敗にする `page.route('**/*google*/**', …)` の網を張る）。
- 純粋関数（T3〜T7）は TDD。T7 は「版が違うが本文が同じ」「別の端末の保存（`externalUpdate`）」「保存中のネットワークの失敗」で下書きが消えないことを必ず確かめる。
- 画面（T9〜T13・T16）はストーリー＋play テスト。T16 のストーリーは偽の Drive の上で一覧 → 編集 → 保存 → 衝突までを通す。
- タブレットの確認は M6 と同じく e2e の `tablet` プロジェクト（1194×834、タッチ）。実際の iPad でのログインは公開（HTTPS）後になる（確認したい点 5）。
- 最後に U1 だけユーザーが本物のクライアント ID で確認する。

## 確認したい点（ユーザーへの質問）

1. **ログインしていないときの一覧**: キャンバスの付箋は「一覧は空にして『ログインすると曲が一覧に出る』と案内」。ただしログインせずに作った曲が一覧に出ないと、もう一度開く方法が無い。案: (a) この端末だけの曲は一覧に「この端末だけ」の印で出し、上に「ログインすると Drive に保存して、ほかの端末でも使えます」を出す、(b) 付箋どおり空にする → **推奨: (a)**（今の `local` の曲も移行後ここに出る）。
2. **端末名を変えられるようにするか**: 自動（「Windows PC」「iPad」など）で決めて固定する。PC が 2 台あると同じ名前になる。案: (a) 自動だけ、(b) 自動＋アカウントのメニューで変えられる → **推奨: (a)**（M7 は自分の PC 1 台とタブレット。必要になったら (b) は小さい）。
3. **Drive のファイルの拡張子**: 案: (a) `<曲名>.chordpro`（中身が分かる。Drive の画面ではテキストとしてプレビューされる（`text/plain`））、(b) `<曲名>.txt`（どのアプリでも開ける）、(c) `<曲名>.cho` → **推奨: (a)**。
4. **衝突のダイアログの「変更の目安」**（キャンバスの「Aメロのコードが 2 小節ぶん違います」）: 2 つの版の違いを要約するのは別の仕事として大きい。案: (a) M7 は更新時刻と端末だけ出す、(b) 違う行数だけ出す（「12 行が違います」）→ **推奨: (b)**（行単位の比較は既存の `lyrics.ts` の LCS の考え方で小さく作れる。T9 の表示と T15 の計算に足す）。
5. **実際のタブレット（iPad）での確認の時期**: Google のログインは `http://localhost` か HTTPS の送信元でしか使えないので、PC の開発サーバーに iPad から `http://192.168.x.x:5173` でつないでもログインできない。案: (a) M7 は PC のブラウザ（タブレット表示の e2e と、PC 上で 2 つのブラウザを PC とタブレットに見立てた U1）までにして、iPad の実機は公開（静的ホスティング、MVP 後）のときに確認、(b) M7 の中で公開先（GitHub Pages・Cloudflare Pages など）を決めて HTTPS で出す → **推奨: (a)**（requirements.md で公開は MVP 後。公開するときは送信元を 1 行足すだけ、`m7-google-setup.md` の手順 5 に書いた）。
6. **PC の一覧から「閲覧で開く」とき、未保存の変更があれば**: 案: (a) 下書き（いま編集していた内容）を出し、上に「未保存の変更を含む表示です」、(b) Drive に保存した版を出す → **推奨: (a)**（編集画面の「閲覧モード」と同じ内容になる。タブレットには下書きが無いので影響しない）。

### 回答（2026-10-06）

- 1・2・4・5・6: 推奨どおり。
- 3: **拡張子は独自の `.bandsheet`**（`.chordpro` は使わない。`.chordpro` を名乗るなら ChordPro の仕様を守るべきで、この形式は今後も独自に広げるため）。中身は UTF-8 のテキスト、Drive の mimeType は `text/plain`。本書の `.chordpro` の記述はすべて `.bandsheet` と読み替える。

## 実績

（各タスクの完了時に追記する）

- **T1（2026-10-06 完了）**: `src/lib/syncTypes.ts`（`DriveFileMeta`・`BaseRecord`・`DraftRecord`・`SongStatus`・`SongEntry`・`SongIndex`・`SortOrder`・`SaveState`・`OpenDecision`・`ConflictChoice`・`DriveErrorKind`）。定数（`SONG_FILE_EXT = '.bandsheet'` など）は T3。
- **T6（2026-10-06 完了）**: `draftState.ts`（`isDirty`・`decideOpen`・`saveStateOf`・`withTitle`、テスト 29 件）。決めたこと: 下書きがあり base が無ければ dirty。`decideOpen`: `hasFile=false` → `draftOnly`／オンラインで Drive にファイルが無い → 下書きがあれば `draftOnly`、無ければ `unavailable`（base だけ残っていても `unavailable`。T7/T16 で base を開く必要があれば仕様を足す）／未保存の下書きは、`baseVersion` が null かオフラインなら `askResume`、オンラインで版が同じなら `askResume`、違えば `driveNewer`。`saveStateOf` の優先順: saving → failed → localOnly → dirty → saved。`withTitle` は parseSong → title 差し替え → serializeSong（本文は正規化される）。
- **T3（2026-10-06 完了）**: `route.ts`・`deviceName.ts`・`fileName.ts`（テスト 23 件、共通 API どおり、`SONG_FILE_EXT = '.bandsheet'`）。route: `#/`・空 = 一覧、`#/new`・`#/edit/<id>`・`#/view/<id>`、`#view`・不明・空 ID・壊れたエスケープは一覧に倒す。deviceName: iPad（Mac の UA で `maxTouchPoints > 1` も iPad）→ iPhone → Android（`Mobile` なしは「Android タブレット」）→ Mac → Windows → その他は「PC」。fileName: 空白をまとめ、禁止文字・制御文字を `_`、80 文字（コードポイント）で切る、空なら「無題の曲」。`localCopyTitle` は端末のローカル時刻（`10/6 15:12`）。
- **T4（2026-10-06 完了）**: `storage.ts`（テスト 36 件、共通 API どおり＋`baseKey`・`INDEX_KEY`・`AUTH_KEY`・`DEVICE_KEY`）。`KeyValueStorage` に `removeItem` が必須になった（Viewer のストーリーの手書きストレージに追加済み）。古い `loadDraft`/`saveDraft` は `@deprecated` で残す（T14 で削除）。`loadDraftRecord` は JSON でない値を生テキストの下書き（`baseVersion: null`、`savedAt: ''`）として読む → `savedAt` が空の扱いは T14/T16 で。`migrateLegacyLocal` は `local` の下書きがあるときだけ動き、新しい ID に移して一覧に項目を足し、全部書けてから古いキーを消す（途中で失敗したら元のまま）。
- **T5（2026-10-06 完了）**: `songIndex.ts`（テスト 34 件、共通 API どおり）。songId は `appProperties.songId`（無ければ `drive-<fileId>`、同じ songId が複数ならすべて `drive-<fileId>`）。曲名は `.bandsheet` を除いたファイル名、base と同じ版なら base の曲名・要約。`mergeIndex` は Drive から消えたファイルのキャッシュを捨てる（`localOnly` に同じ songId があれば「この端末だけ」で残す → `localOnly` を作るのは呼び出し側）。`songStatus` は下書きが無ければ Drive が進んでいても synced（開くとき A で最新を取る）、「Drive が新しい」は未保存の下書きがあるときだけ（`isDirty` と同じ判定を中に持つ → T20 で重複を確認）。並び順は「更新が新しい順」（時刻なしは最後）と曲名順（`Intl.Collator('ja')`）。検索は曲名だけ（NFKC・小文字・カタカナ→ひらがな）。`formatModified`: 今日／昨日／M/D／YYYY/M/D。
- **T11（2026-10-06 完了）**: `src/components/SignInScreen/*`（ストーリー 5 件、`Sync/SignInScreen`）。props: `configured`（T16 は `Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID)`）・`signingIn?`・`error?`・`onSignIn()`（クリックの中で呼ぶ）・`onStartWithoutSignIn()`（呼び出し側が `#/new` へ）。未設定のときはログインボタンの代わりに案内、どちらでも「ログインせずに編集を始める →」は押せる。幅が狭いと縦に積む。
- **T10（2026-10-06 完了）**: `SaveStatus`・`ConnectionBanner`・`AccountMenu`（ストーリー 21 件）、`theme.css` に `--success`・`--success-bg`・`--warning-border`・`--disabled-bg`。
  - `SaveStatus`: `state`・`signedIn?`（false なら localOnly のボタンが「ログインして保存」）・`onSave`・`shortcutLabel?`（Mac は `'⌘S'`）。`role="status"`、`data-testid="save-status"`/`data-state`。Ctrl+S のキー処理は T16。
  - `ConnectionBanner`: `kind: 'offline'|'reconnect'|'unconfigured'`・`listedAt?`・`onRetry?`・`retrying?`。reconnect の文面はキャンバスに無いので仮（`content()`）。
  - `AccountMenu`: `signedIn`・`accountName?`（`drive.file` だけでは名前が取れないかもしれない → T15/T16 で確認）・`onSignIn`・`onSignOut`・`busy?`・`configured?`。
- **T9（2026-10-06 完了）**: `Dialog`（＋`formatWhen.ts`「今日 15:08」「10/5 15:08」、ほかの画面でも使ってよい）・`ConflictDialog`・`OpenDraftDialog`・`ConfirmDialog`・`RenameDialog`（ストーリー 12 件）。
  - `Dialog`: `open`・`onClose`・`title`・`icon?`・`description?`・`children?`・`footer?`・`initialFocusRef?`・`size?`。portal、aria-modal、Tab 循環、Esc で閉じる、背景クリックでは閉じない。
  - `ConflictDialog`: `songTitle`・`drive {modifiedTime, device?}`・`local {editedAt, device, baseModifiedTime?}`・`changedLines?`（1 以上のときだけ「N 行が違います」）・`onChoose(ConflictChoice)`・`onCancel`・`busy?`・`now?`。初期選択は「読み直して手元は別の曲に残す」。
  - `OpenDraftDialog`: `kind: 'draftNewer'|'driveNewer'`（B/C）・`draft`・`drive`・`onChoose(OpenDraftChoice = 'resumeDraft'|'openDrive'|'keepDraftCopy')`・`onCancel?`。
  - `ConfirmDialog`: 削除は 2 ボタン、`secondaryLabel`/`onSecondary` で 3 ボタン（「一覧に戻る」の文言は T16 が渡す）。`RenameDialog`: 空白だけは不可、Enter で送信。
- **T2（2026-10-06 完了）**: `src/lib/drive/driveClient.ts`・`fetchDriveClient.ts`（`createFetchDriveClient` はここ）・`fakeDriveClient.ts`（テスト 49 件）・`docs/m7-drive-findings.md`。追加: `isDriveError`・`FOLDER_MIME_TYPE`・`SONG_MIME_TYPE`、偽物の `folders()`・種データの `folder?`/`trashed?`。`findFolder` は複数なら一番古いもの、`update` の `appProperties` は既存にマージ、偽物の `calls` は `"<method>:<id>"`。
  - 計画を変える発見: (1) `create` の 5xx は再試行しない（重複ファイルのおそれ。rateLimit は再試行）。(2) テスト中の OAuth は 7 日で許可が切れ、`prompt: ''` でも同意画面が出る → T8 に伝達済み、setup 手順書に「気になるなら本番に公開」を T18 で追記。(3) GIS の `prompt` の既定は `'select_account'` → 取り直しは `prompt: ''`、`hasGrantedAllScopes` で `drive.file` を確かめる（T8 に伝達済み）。(4) ゴミ箱のファイルも `files.get`/`download`/`update` が成功しうる → T7 の保存は必ず先に `getMeta`（ゴミ箱は notFound）。(5) `text/plain` は `md5Checksum` があり、衝突の確認で本文を読む代わりに使える（T7 の判断）。
  - 公式に明記なし: 同じクライアント ID なら別の端末でも見える（U1 で確認）、ゴミ箱に入れて `modifiedTime` が進むか。
- **T8（2026-10-06 完了）**: `src/lib/auth/gis.ts`（`createGisAuth` など共通 API どおり＋`DRIVE_SCOPE`・`AuthError`/`AuthErrorKind`・`createGisLoader`/`loadGis`）・`fakeAuth.ts`（`createFakeAuth`、`failNext`・`calls`・`token()` 付き。`./auth/fakeAuth` から import）・テスト 33 件。取り直しは `prompt: ''`、`drive.file` がもらえなければ `denied`。保存済みトークンがあれば作った時点で GIS を読み込み始める（初回ログインはクリック後に読み込むので、ブラウザによってはポップアップが止められ `popupBlocked` → もう一度押せば開く）。`invalidate()` は状態を `expired` に（再接続のバナー用）。
  - T15/T16 向け: `ensureToken()` はクリック・キーの処理の中で `await` より前に呼ぶ。起動時の確認は `ensureToken({ interactive: false })`（トークンが無ければ `needsSignIn`）。エラーの種類 `unconfigured`・`needsSignIn`・`popupBlocked`・`popupClosed`・`denied`・`scriptLoad`・`unknown`。`signOut()` は端末の保存を消して revoke（キャッシュ削除は呼び出し側、下書きは残す）。クライアント ID は呼び出し側で `import.meta.env.VITE_GOOGLE_CLIENT_ID`。`status()` + `subscribe` は `useSyncExternalStore` 向き。期限切れのトークンでの revoke は Google 側の同意が残ることがある（T20 で確認）。
  - T8 追記（2026-10-06）: `hasGrantedAllScopes`（無ければ応答の `scope`）で `drive.file` を確かめ、足りなければ `denied`（テスト 34 件）。待ち時間に時間切れの処理はない → T16 は「Google の画面を開いています」の表示を同意画面がすべて出る場合でも違和感のない文言にし、時間切れで画面を戻さない。
- **T13（2026-10-06 完了）**: `src/components/TabletSongList/*`（ストーリー 7 件、`Sync/TabletSongList`、1194×834）。props: `songs`・`cachedIds`・`openingId?`・`query`/`onQueryChange`・`order`/`onOrderChange`・`offline?`・`listedAt?`・`refreshing?`・`onRefresh()`・`onOpenView(songId)`・`now?`。絞り込み・並べ替えは中で `filterSongs`/`sortSongs`。行全体が 1 つのボタン（88px）、「この iPad に保存済み／Drive から取得します／Drive から読み込み中…」。オフラインで本文が無い行は押せない。「iPad」の文言は固定、「Drive と同期済み」は reconnect などを区別しない（T16 で必要なら足す）。曲名順は `Intl.Collator('ja')` でかなが漢字より先。
- **T14（2026-10-06 完了）**: `App` を 1 曲の編集画面に（unit 73 件・storybook 41 件）。`storage.ts` の `loadDraft`/`saveDraft` を削除。App props（すべて任意）: `storage`・`songId`（既定 `LOCAL_SONG_ID`）・`initialText`・`baseVersion`・`headerStart`/`headerEnd`・`onTextChange(text)`（開いたときの本文では呼ばない）・`viewing`/`onEnterView`/`onExitView`（`viewing` を渡さなければ App が内部で切り替え、ハッシュは触らない）・`viewBackLabel`。`useAutosave(text, songId, storage, baseVersion = null, delay)` は `{v:1, text, baseVersion, savedAt}` を書き、開いたときの本文は書かない。`Viewer`/`ViewerToolbar` に `backLabel?`。
  - T15/T16 向け: `initialText`・`baseVersion` を必ず明示し `key={songId}` で作り直す（省略時の下書き読み込みは暫定）。`viewing` は必ず渡し、ハッシュは Root が持つ（戻るの文言 `viewBackLabel='‹ 曲の一覧'`）。Drive に保存したら `baseVersion` を更新するだけでよい。`main.tsx` の `LOCAL_SONG_ID` は T16 で置き換える。
- **T12（2026-10-06 完了）**: `src/components/SongList/*`（ストーリー 12 件、`Sync/SongList`）。props: `songs`・`statuses?`・`signedIn`・`configured?`・`accountName?`・`onSignIn`・`onSignOut`・`signingIn?`・`onRefresh?`・`refreshing?`・`connection?: ConnectionBannerProps`・`onNew()`・`onOpen(id)`・`onOpenView(id)`・`onRename(id, title)`（localOnly では呼ばれない）・`onDuplicate(id)`・`onDelete(id)`（確認の後）・`busy?`・`order?`/`onOrderChange?`・`now?`。名前を変えられないのは localOnly（Drive に無い曲）だけ、dirty は変えられる。複製はどの状態でも押せる（localOnly の複製の扱いは T15/T16）。ログアウト中の注意書き・検索 0 件・メニューの補足の文面は仮。表は PC 専用。
- **T7（2026-10-06 完了）**: `src/lib/drive/songSync.ts`（テスト 44 件、drive 一式 93 件）。追加: conflict に `changedLines`（`countChangedLines`、行単位の LCS、改行コードと最後の改行は無視）、`resolveConflict(c, {choice, songId, folderId, text, base, device, newId, now})` → `{kind:'saved', base}` | `{kind:'reloaded', base, copy?}`（reloadKeepCopy は先に手元を新しい曲として作り、失敗したら読み直さずエラー）、`baseFromRemote`、`driveErrorKind(e)`。失敗は必ず `DriveError`。Drive の本文がこれから書く本文と同じときも衝突にしない。`duplicateSong` は中で「<曲名> のコピー」。`ensureFolder` は作ったあと探し直して一番古いものを使う。md5Checksum は使わない。保存は必ず `getMeta` から（ゴミ箱・消えていれば同じ songId で新しく作る）。`loadRemote` はメタデータ → 本文の順。確認と書き込みの間の競合は許容（T20 の観点）。
  - T15 向け: 失敗した保存は storage に触れない → `saved`/`reloaded` のとき呼び出し側で base 更新・下書き削除（`copy` があればその曲の base と一覧も）。auth エラーは `auth.invalidate()`。一覧の前に `ensureFolder(c, index.folderId)`。`fetchList` は並べ替えしない。`trashSong` はファイルが無ければ成功。
  - **決定（2026-10-06）**: `renameSong` は base の本文で曲名を変えるので、未保存の変更がある曲（dirty・driveNewer）と localOnly では名前を変えられないようにする。T12 の SongList は dirty でも押せる作りなので、T16 で SongList を直す。
- **T15（2026-10-06 完了）**: `useDriveSession`・`useSongLibrary`・`useSongDocument`（＋`useSongView`）（テスト 73 件）。T16 向けの API と決めたことは T15 の報告どおり: `useDriveSession({auth, storage, client?, detectDevice?})`（`connected` は signedIn か expired、401 で `auth.invalidate()`、`signOut()` は Drive のキャッシュを消し未保存の曲は残す、`failReason(e)`）、`useSongLibrary(session)`（キャッシュ → 自動取得、`canRename(id)`、`refresh`/`rename`/`duplicate`/`remove` はクリックの中で直接呼ぶ、一覧を出すときに `reload()`）、`useSongDocument(session, songId)`（`<App key={doc.editorKey} initialText baseVersion onTextChange>`、`save()` → saved/reloaded/conflict/failed/skipped、`ask`/`conflict` はダイアログの props）、`useSongView(session, songId)`（下書きを作らない、`notice: 'draft'|'updated'`）。複製: Drive の曲は Drive 上に未保存の変更ごと写す、この端末だけの曲・未ログインはこの端末だけのコピー。名前を変えられるのは Drive にあって未保存の変更が無い曲だけ。アカウント名は渡さない。
  - **T16 の前に直す（T16 で対応）**: (1) T14 の `App` は `text !== openedText` のときしか `onTextChange` を呼ばないので、開いたときの本文に戻すと古い本文が保存される → 一度変わったらその後はすべて呼ぶ。(2) SongList の「名前を変える」は `library.canRename(id)` で判定する。
- **T16（2026-10-06 完了）**: `Root`・`screens/EditorScreen`・`screens/ViewerScreen`・`main.tsx`（`<Root auth={createGisAuth({clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID, storage})} storage={localStorage} />`）、持ち越し修正（App の `onTextChange`、SongList の `canRename?`）。unit 131 件・storybook 26 件、build 成功。
  - ルート: `#view`・空・不明 → `#/`、`#/new` → `#/edit/<新しい ID>`（`replaceState`）。編集からの閲覧は `#/view/<id>` を `pushState`（戻るは「← 編集に戻る」）、一覧・URL からの閲覧は ViewerScreen だけ（下書きなし、戻るは「‹ 曲の一覧」）。最初の画面は曲 0 件で未ログインなら SignInScreen、それ以外は一覧。PC/タブレットの一覧は `matchMedia('(hover: none) and (pointer: coarse)')`。新しい曲は最初の編集で下書きと一覧の項目を書く。一覧をまだ取っていないときの `#/edit`・`#/view` は取得を待つ（`root-loading`）。Ctrl+S/⌘S は window のキャプチャで `save()` を同期で呼ぶ（IME 変換中・閲覧中は無視、ダイアログ中は preventDefault だけ）。一覧に戻る確認は Drive 設定済みで未保存の変更があるときだけ。
  - クライアント ID が無いとき: `unconfigured`、GIS を読まない、SignInScreen の案内か一覧の「Drive 未設定」バナー、保存ボタンの代わりに「この端末だけに保存（Drive 未設定）」。
  - 残り: (1) タブレットでオフラインのとき「更新」が押せず、読み直す以外につなぎ直す方法が無い。(2) OpenDraftDialog にエラーの prop が無いので開くときの失敗はダイアログの後ろに出る。(3) ブラウザの戻る・タブを閉じるときに未保存の確認は出さない（下書きが残るため）。(4) SignInScreen のボタンは同意画面のあいだ「Google の画面を開いています…」のまま。→ T20 / 手動テストで確認。
- **T17（2026-10-06 完了）**: `vite.config.ts`（port 5173・strictPort）、`.env.example`、`playwright.config.ts`（webServer に偽のクライアント ID、tablet は viewer/tablet spec）、`e2e/support/fakeDrive.ts`（GIS スクリプトの偽物と Drive v3 のメモリ上の偽物、Google のほかのホストは abort）・`e2e/support/app.ts`、`e2e/drive.spec.ts`（11 件）・`e2e/tablet.spec.ts`（1 件）、既存の spec を `#/new` からの入口と JSON の下書きに対応。`npm run e2e` 21 件成功。スクリーンショット `docs/m7-*.png`。`.env.local` は `.gitignore` の `*.local` で除外済み。
  - 問題: (1) 新しい曲で入力の数 ms 後に Ctrl+S を押すと直前の本文が保存される（`EditorScreen` の `live` ref が `useEffect` で更新されるため）→ 修正を依頼。(2) e2e の webServer が `reuseExistingServer` で、ユーザーの起動した dev サーバー（偽のクライアント ID なし）を使い回して失敗する → T17 の担当がユーザーの dev サーバーを止めてしまった。e2e は別のポートで必ず自前のサーバーを起動するように直す。
- **T17 後の小修正（2026-10-06 完了）**: Ctrl+S 直前の入力が保存されない競合を修正（`App` が本文の変更を effect でなく変更時に同期で報告、`useSongDocument.onTextChange` が `stRef` を同期更新、Root.test に回帰テスト追加）。e2e の `settle()` を削除（下書きの 500ms 自動保存を待つ箇所だけ `expect.poll`）。e2e の webServer は専用ポート 5174（strictPort・`reuseExistingServer: false`・偽クライアント ID）で、ユーザーの dev server（5173）と並行できる。
- **T19（2026-10-06）**: 全体の検証 — npm test 2033件（59ファイル）成功、tsc -b 成功、lint 0警告0エラー、build 成功（181モジュール、1チャンクサイズ警告は error ではない）、test:storybook 332件（49ファイル）成功、e2e 21件（11 chromium + 10 tablet）成功、prettier 成功。失敗なし。
- **U1（2026-10-10 完了）**: ユーザーが本物の Google Drive で手順 7 をすべて確認し、正常に動作した。
