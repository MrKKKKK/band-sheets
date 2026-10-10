# M7: Google Drive API・GIS の前提の確認（T2）

`docs/m7-plan.md` の「主な設計判断」1〜3 の前提を、Google の公式ドキュメント（2026-10-06 時点）で確かめた結果。本物の Google へのリクエストはしていない（ドキュメントを読んだだけ）。実際の動きは U1（ユーザーの手での確認）で最終確認する。

## まとめ（計画への影響）

| #   | 前提                                                               | 結果                                                                                        | 計画への影響                                                                                                                                                   |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `drive.file` はアプリが作った・開いたファイルだけ                  | 正しい                                                                                      | なし                                                                                                                                                           |
| 2   | 同じクライアント ID なら別の端末でも見える                         | 公式に明記は無い。アプリの単位が Cloud プロジェクトであることは Picker の説明から読み取れる | なし（U1 の「別のブラウザで同じ曲を開く」で確かめる）                                                                                                          |
| 3   | `version` はサーバー側のあらゆる変更で増える単調増加の番号、文字列 | 正しい（`string (int64)`）                                                                  | なし。比較は文字列の一致だけ（計画どおり）                                                                                                                     |
| 4   | v3 に条件付き更新（If-Match）が無い                                | 正しい（v3 の File に `etag` が無く、`files.update` に前提条件の記述が無い）                | なし。確認してから書く方式のまま                                                                                                                               |
| 5   | multipart の create / PATCH                                        | 正しい                                                                                      | なし                                                                                                                                                           |
| 6   | `appProperties` はこのアプリだけ・1 組 124 バイト                  | 正しい（さらに 1 ファイル 100 個まで）                                                      | なし                                                                                                                                                           |
| 7   | ゴミ箱                                                             | `trashed: true` で正しい。**ゴミ箱のファイルも `files.get` で取れる**                       | `getMeta` は `trashed` を見て notFound にする（実装済み・計画どおり）                                                                                          |
| 8   | 403/429 の理由の形                                                 | 正しい（`error.errors[0].reason`）                                                          | なし                                                                                                                                                           |
| 9   | GIS `prompt: ''`                                                   | 正しい（初回だけ同意画面）。**`prompt` の既定値は `'select_account'`**                      | T8: 期限切れの取り直しは必ず `prompt: ''` を明示する（省略するとアカウント選択が毎回出る）                                                                     |
| 10  | ポップアップはユーザー操作の中で                                   | 正しい                                                                                      | なし                                                                                                                                                           |
| 11  | テストモードの制限                                                 | **テスト中のアプリの許可は同意から 7 日で切れる**                                           | **変更あり（小）**: T8/U1・`m7-google-setup.md` に「テスト中は 7 日ごとに同意画面がもう一度出る。避けたければ公開ステータスを『本番』にする」を書く（後述）    |
| 12  | create の 5xx を 1 回再試行                                        | ドキュメントは「指数バックオフで再試行」。ただし作成は冪等でない                            | **変更あり（小）**: `create` だけは 5xx を再試行しない（rateLimit は再試行する）。T2 で実装済み                                                                |
| 13  | 衝突の確認で本文を読む（計画 3 の (3)）                            | `text/plain` のファイルには `md5Checksum` がある                                            | 任意の改善案（M7 では採らなくてよい）: 本文を読む代わりに `md5Checksum` と `base` の本文の MD5 を比べられる。T7 の判断に任せる。`DriveFileMeta` は変えていない |

## 1. `drive.file` で見える範囲

- スコープの説明: 「Create new Drive files, or modify existing files, that you open with an app or that the user shares with an app while using the Google Picker API or the app's file picker.」、非機密（non-sensitive）スコープで、基本の OAuth アプリ確認だけでよい。
  — https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- 「`drive.file` は Drive API のすべての REST リソースで、広いスコープと同じように使える」（同上）。つまり `files.list` の `q` もそのまま使え、結果はこのアプリが触れるものだけになる。
- **アプリの単位**: `drive.file` の許可が OAuth クライアント単位か Cloud プロジェクト単位かは、Drive のガイドには明記が無い。Google Picker の `setAppId` は「`drive.file` スコープに必須」で、値は **Cloud プロジェクト番号**。ここから、ファイルへの許可は「ユーザー × Cloud プロジェクト（アプリ）」に付くと読める。端末やブラウザには付かない（トークンの持ち主はユーザー）。
  — https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder.setappid
- 計画どおり: アプリが作ったフォルダ・ファイルは、同じユーザーが同じクライアント ID でログインすれば PC でもタブレットでも見える。ユーザーが Drive の画面で手で作った「band-sheets」フォルダや手でアップロードしたファイルは見えない（アプリが作っていないため）。
- **U1 で確かめること**（計画の U1 にもう入っている）: 別のブラウザ（＝別の端末相当）で同じ曲が一覧に出ること。

## 2. `version`・`modifiedTime`・`trashed`

— https://developers.google.com/workspace/drive/api/reference/rest/v3/files

- `version`: 「A monotonically increasing version number for the file. This reflects every change made to the file on the server.」型は `string (int64 format)`。→ 名前・`appProperties`・ゴミ箱への移動など、本文以外の変更でも増える。いくつ増えるかは決まっていない（1 ずつとは限らない）ので、**一致かどうかだけを見る**（計画 3 の (3) で「版だけ進んだ」を吸収するのは必要）。
- `modifiedTime`: 「The last time the file was modified by anyone (RFC 3339 date-time).」
- `trashed`: 「Whether the file has been trashed, either explicitly or from a trashed parent folder.」→ フォルダごとゴミ箱に入れると、中のファイルも `trashed: true`。
- `headRevisionId` は「バイナリの中身のファイルだけ」。`md5Checksum` も「バイナリの中身のファイル（Google ドキュメント形式以外）」に付く → `text/plain` の曲ファイルには付く（表の 13）。
- **`etag` フィールドは v3 の File リソースに無い。**

## 3. 条件付き更新（If-Match）

— https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update

- `files.update` は `PATCH https://www.googleapis.com/drive/v3/files/{fileId}`（メタデータ）と `PATCH https://www.googleapis.com/upload/drive/v3/files/{fileId}`（本文つき、`uploadType=media|multipart|resumable`）。
- クエリパラメータは `addParents`・`removeParents`・`keepRevisionForever`・`ocrLanguage`・`supportsAllDrives`・`uploadType`・`useContentAsIndexableText`・`includePermissionsForView`・`includeLabels` などで、**版の前提条件（If-Match・etag・expectedVersion のようなもの）は文書化されていない**。
- 結論: 計画どおり「保存の直前に `getMeta` で版を確かめてから書く」。`If-Match` は送らない（テストで送っていないことを確認）。確認と書き込みのあいだの競合（数百ミリ秒）は残る（T20 の観点）。

## 4. アップロード（multipart の create / PATCH）

— https://developers.google.com/workspace/drive/api/guides/manage-uploads

- `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`、`Content-Type: multipart/related; boundary=…`（RFC 2387）。**1 つ目がメタデータで `Content-Type: application/json; charset=UTF-8`、2 つ目が本文（任意の MIME 型）**。境界は `--<boundary>`、最後は `--<boundary>--`。5 MB 以下向け（曲は数 KB）。
- 「To update an existing file, use `PATCH`」。`files.update` の upload URI が `uploadType=multipart` を受けるので、名前・`appProperties` と本文を 1 回で変えられる（計画どおり）。
- ガイドは `Content-Length` を付けるよう書くが、ブラウザの `fetch` では付けられない（禁止ヘッダー）。ブラウザが文字列の本文から自動で付けるので問題ない。
- `fields` は upload URI でも使える（`files` リソースの標準パラメータ）。v3 は `fields` を省くと `kind,id,name,mimeType` しか返さないので、`version` などを受け取るには必須。
  — https://developers.google.com/workspace/drive/api/guides/fields-parameter
- 作成は冪等でない。ガイドは「事前に生成した ID（`files.generateIds`）なら不確定なサーバーエラーやタイムアウトのあと安全に再試行できる」とする。M7 ではそこまでせず、**`create` は 5xx を再試行しない**（表の 12）。5xx のあとに実はファイルができていた場合は、次の保存で `songId` の同じファイルが 2 つになりうる → 計画 4 の「同じ `songId` のファイルが 2 つあれば `drive-<fileId>`」で壊れずに扱える（重複が一覧に出るだけ）。

## 5. `appProperties`

— https://developers.google.com/workspace/drive/api/guides/properties

- このアプリ（OAuth クライアント ID で得たトークン）だけが読み書きできる非公開のキーと値。
- 上限: **1 組（キー＋値、UTF-8）で 124 バイト**、**1 ファイルに 100 個（全ソースの合計）**。計画の `app`・`songId`（UUID 36 文字）・`device`・`format` は十分小さい。`device` は端末名（「Android タブレット」でも 30 バイト未満）。
- 更新は差分（`PATCH` で渡したキーだけ変わる）。消すときは値を `null`。→ `DriveClient.update` は「マージ」と JSDoc に書き、偽物も同じ動きにした。
- 検索: `appProperties has { key='songId' and value='…' }`（M7 では使わない。一覧はフォルダの中を全部取る）。
  — https://developers.google.com/workspace/drive/api/guides/search-files

## 6. 検索の書き方

— https://developers.google.com/workspace/drive/api/guides/search-files 、 https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list

- `name = '…'`、`mimeType = '…'` / `!=`、`'<id>' in parents`、**`'root' in parents`（マイドライブ直下）**、`trashed = false` はどれも公式の例にある。
- 文字列の中の `'` と `\` は `\` でエスケープ（`quoteQ` で実装）。
- `pageSize` の最大は 1000、続きは `nextPageToken` → `pageToken`。`orderBy` に `createdTime` が使える → `findFolder` は `orderBy=createdTime` で一番古いフォルダを返す（「2 つできたら古いほう」は `DriveClient` 側で済む）。
- `corpora` の既定は `user`、`spaces` は `drive`（明示している）。

## 7. ゴミ箱

— https://developers.google.com/workspace/drive/api/guides/delete

- v3 は `files.update` で `trashed: true`。ゴミ箱のファイルは **30 日で自動的に完全削除**。持ち主だけがゴミ箱に入れられる（ほかは `insufficientFilePermissions`）。自分の Drive・自分だけなので問題ない。
- **ゴミ箱のファイルも `files.get` で取れる**（`trashed: true` で返る）。→ `getMeta` は `trashed` も取り、true なら `notFound` にする（計画どおり、実装済み）。`download`・`update` はゴミ箱のファイルにも成功しうるので、保存の前に `getMeta` を通す計画 3 の流れが必要（T7）。

## 8. エラーの形

— https://developers.google.com/workspace/drive/api/guides/handle-errors

- 本文: `{ "error": { "code", "message", "errors": [{ "domain", "reason", "message" }] } }`。
- 401 `authError`（トークンの取り直し）、403 `rateLimitExceeded`・`userRateLimitExceeded`（レート）、403 `dailyLimitExceeded`・`storageQuotaExceeded`・`insufficientFilePermissions`・`appNotAuthorizedToFile`、404 `notFound`、429 `rateLimitExceeded`、500/502/503/504。推奨は指数バックオフでの再試行。
- 実装: 401 → `auth`、404 → `notFound`、429 と 403 の `rateLimitExceeded`/`userRateLimitExceeded` → `rateLimit`、5xx → `server`、`fetch` の失敗 → `network`、それ以外（`storageQuotaExceeded` などの 403 も）→ `other`。rateLimit と 5xx は 1 秒後に 1 回だけ再試行（計画どおり。M7 の規模なら指数バックオフは不要）。`dailyLimitExceeded` は再試行しても直らないので `other`。

## 9. GIS トークンモデル

— https://developers.google.com/identity/oauth2/web/guides/use-token-model 、 https://developers.google.com/identity/oauth2/web/reference/js-reference

- `google.accounts.oauth2.initTokenClient({ client_id, scope, callback, error_callback, prompt, … })` → `requestAccessToken(overrides?)`。
- `prompt`: `''` =「最初にアクセスを求めたときだけ同意画面」、`'none'` = 画面を出さない、`'consent'` = 同意を求める、`'select_account'` = アカウントを選ばせる。**既定値は `'select_account'`**。→ 期限切れの取り直し（`ensureToken`）は `prompt: ''` を必ず明示する（T8）。初回の `signIn()` は既定（アカウント選択）のままでよい。
- 「A user gesture triggers the token flow」— `requestAccessToken` はクリックなどのユーザー操作の中から呼ぶ（計画どおり）。`error_callback` の `type` は `popup_failed_to_open`・`popup_closed`・`unknown`（ブロックされた・閉じられたを区別できる）。
- `TokenResponse`: `access_token`・`expires_in`（秒）・`scope`・`error`・`error_description`。アクセストークンは「設計上、寿命が短い」、切れたら次のユーザー操作で `requestAccessToken()` を呼び直す。リフレッシュトークンは無い。`expires_in` の値そのものは仕様に書かれていない（実際は約 3600）ので、**固定の 1 時間ではなく `expires_in` から期限を計算する**（計画どおり）。
- `scope` には実際に許可されたものが入る（細かい同意で `drive.file` を外されることがある）。`google.accounts.oauth2.hasGrantedAllScopes(tokenResponse, scope)` で確かめて、外されていたら「Drive への許可がありません」として扱うのが安全（T8 の小さな追加）。
- `google.accounts.oauth2.revoke(accessToken, done)` は、そのアプリに与えたすべてのスコープの許可を取り消す（計画どおりログアウトで使う）。

## 10. テストモード（OAuth 同意画面の公開ステータス「テスト」）

— https://support.google.com/cloud/answer/15549945 、 https://developers.google.com/identity/protocols/oauth2

- テスト中のアプリは、登録したテストユーザー（最大 100 人）しか使えない。
- **テストユーザーの許可は同意から 7 日で切れる**（リフレッシュトークンも同じ）。トークンモデルでは、7 日たつと `prompt: ''` でも同意画面がもう一度出る（ポップアップの中なので操作は増えるが壊れはしない）。
- `drive.file` は非機密スコープなので、公開ステータスを「本番」にしても基本のブランド確認だけで済む（自分だけで使うなら確認の申請をしなくても、未確認アプリの警告が出るだけ）。
- 計画への影響: T8 は「`prompt: ''` で同意画面が出ることもある」前提で、待っている間の案内を出す。`docs/m7-google-setup.md`（担当タスク）に「テストのままだと 7 日ごとに同意画面がもう一度出る。気になるなら『アプリを公開』で本番にする」を書く。

## 実装との対応（T2）

- `src/lib/drive/driveClient.ts`: `DriveClient`・`DriveError`（共通 API どおり）、`isDriveError`・`FOLDER_MIME_TYPE`・`SONG_MIME_TYPE`（追加）。
- `src/lib/drive/fetchDriveClient.ts`: `createFetchDriveClient`（共通 API の注釈では driveClient.ts にあるが、タスク表のファイル分けに合わせてこちら）。URL・`fields`・`multipart/related` の組み立て、ページ送り、エラーの変換、再試行（上記）。
- `src/lib/drive/fakeDriveClient.ts`: `createFakeDriveClient`。版はあらゆる変更（本文・名前・`appProperties`・ゴミ箱）で増え、`modifiedTime` は本文・名前・`appProperties` の変更で進む（ゴミ箱では進まないことにした。ゴミ箱で `modifiedTime` が変わるかは公式に記述が無く未確認。呼び出し側は `modifiedTime` で版を判断しないこと）。`appProperties` はマージ。ゴミ箱のファイルは `getMeta` で notFound、一覧に出ないが `download`・`update` はできる（本物と同じ）。親フォルダがゴミ箱ならファイルもゴミ箱扱い。
