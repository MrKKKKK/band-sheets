# Content-Security-Policy（CSP）

この文書は、band-sheets の CSP を変更・確認する開発者（ユーザー本人と、作業する AI エージェント）向けです。
本番ビルドに入れている CSP の中身・各ディレクティブの理由・テスト方法と、デプロイ後に手で確かめる手順をまとめます。

## 方針

- GitHub Pages は HTTP ヘッダーを設定できないため、`<meta http-equiv="Content-Security-Policy">` で配信する。
- 対象は本番ビルドだけ（`vite.config.ts` の `band-sheets:csp-meta` プラグイン、`apply: 'build'`）。開発サーバーはインラインスクリプトと HMR の WebSocket を使うので CSP を付けない。Storybook の `iframe.html` も対象外（`CSP_PAGES` に入れたページだけ）。
- ポリシーの正本は `src/lib/csp.ts` の `CSP_DIRECTIVES`。ここだけを直せば、ビルド・`check-bundle`・e2e がすべて追従する。
- 目的は多層防御。XSS の入口は見つかっていない（innerHTML / eval / dangerouslySetInnerHTML なし）が、Google のアクセストークンを localStorage に置いている（ユーザー判断）ので、スクリプトの実行元と送信先を絞る。
- meta の CSP では `frame-ancestors`、`report-uri` / `report-to`、`sandbox` は効かない（ブラウザが無視する）。

## ポリシーと理由

| ディレクティブ | 値                                                                                                                                                              | 理由                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default-src`  | `'self'`                                                                                                                                                        | 下に書いていない種類（manifest、media など）は自分のオリジンだけ                                                                                                                                                  |
| `script-src`   | `'self' https://accounts.google.com/gsi/client`                                                                                                                 | アプリのチャンクと GIS ライブラリ（ファイル単位で指定）。`'unsafe-inline'` / `'unsafe-eval'` なし                                                                                                                 |
| `style-src`    | `'self' 'unsafe-inline' https://accounts.google.com/gsi/style`                                                                                                  | 実行時に入る `<style>`（Bravura の @font-face、alphaTab の `alphaTabStyle`、GIS 自身）と alphaTab の SVG 内の `style` 属性に必要。外すと Bravura が読めず譜面が崩れる（e2e で確認）。`gsi/style` は Google の指示 |
| `font-src`     | `'self'`                                                                                                                                                        | @fontsource（Noto Sans JP、JetBrains Mono）と Bravura はビルド成果物。小さいフォントが data: に埋め込まれないよう `build.assetsInlineLimit` でフォントのインライン化を止めた                                      |
| `img-src`      | `'self'`                                                                                                                                                        | favicon.svg、icons.svg だけ。data: や外部画像は使っていない                                                                                                                                                       |
| `connect-src`  | `'self' https://www.googleapis.com/drive/v3/ https://www.googleapis.com/upload/drive/v3/ https://accounts.google.com/gsi/ https://oauth2.googleapis.com/revoke` | Drive v3（メタデータ・`alt=media`・アップロード）、GIS のエンドポイント（Google の指示どおり親 URL）、ログアウト時のトークン取り消し（GIS の `oauth2.revoke` が送る先。Google の CSP ガイドには載っていない）     |
| `frame-src`    | `https://accounts.google.com/gsi/`                                                                                                                              | Google の指示。トークンモデルのログインはポップアップ（`window.open`、CSP の対象外）なので今は使っていないが、GIS が iframe を使う場合に備える                                                                    |
| `worker-src`   | `'self'`                                                                                                                                                        | 解析 Worker は同じオリジンの別チャンク（`assets/*.worker-*.js`）。alphaTab は `core.useWorkers = false` かつプレイヤー無効なので blob: Worker を作らない                                                          |
| `object-src`   | `'none'`                                                                                                                                                        | プラグイン不使用                                                                                                                                                                                                  |
| `base-uri`     | `'none'`                                                                                                                                                        | `<base>` を使わない                                                                                                                                                                                               |
| `form-action`  | `'none'`                                                                                                                                                        | フォームはすべて `onSubmit` で処理し、URL へ送信しない                                                                                                                                                            |

確認に使った資料（2026-10-24）: Google の GIS CSP ガイド（developers.google.com/identity/gsi/web/guides/get-google-api-clientid の「Content Security Policy」）、GIS スクリプト本体（`accounts.google.com/gsi/client`）、`src/lib/drive/fetchDriveClient.ts`、`PartScore` / `SectionScore` の alphaTab 設定、ビルド結果の `dist/`。

## テスト

- `src/lib/csp.test.ts`（`npm test`）: ポリシーの形（`'unsafe-eval'`・`*`・data:・blob: がない、meta で効かないディレクティブがない など）と meta の挿入位置。
- `npm run check-bundle`: `dist/index.html` の meta が `src/lib/csp.ts` と一致し、どの script / link / style よりも前にあり、インライン `<script>` がないこと。
- `npm run e2e:csp`（`playwright.csp.config.ts`、ポート 5175）: 本番ビルド（base `/band-sheets/`、解析ハーネスのページも含む）を `vite preview` で配信し、偽の GIS / Drive（`e2e/support/fakeDrive.ts`、本物と同じ URL で応答）でログイン・一覧・新規・保存・開く・編集・保存・エディタの譜面（メロディ・ドラム）・閲覧モードの譜面・フォント読み込み・解析 Worker を通し、`securitypolicyviolation` と CSP のコンソールエラーが 0 件であることを確かめる。インラインスクリプトを差し込むと 1 件検出されることも確認する（検出の仕組みが動いている証拠）。

## デプロイ後の手動確認（本物の Google）

e2e では本物の Google に接続できないため、デプロイ後に GitHub Pages の URL で次を確認する。PC の Chrome で開発者ツールの Console を開いたまま行い、`Content Security Policy` / `Refused to` を含むエラーが出ないことを各手順で見る。

1. ページを再読み込みし、開発者ツールの Elements で `<head>` に CSP の meta があることを確認する。
2. 「Google でログイン」→ ポップアップでアカウントを選び、許可 → 一覧が表示される。
3. 新しい曲を作り、Ctrl+S で保存 → 「保存済み」になる（Drive にファイルができる）。
4. 一覧に戻ってページを再読み込み → その曲を開く → 本文が読み込まれる。
5. 少し編集して再度保存 → 「保存済み」になる。
6. 閲覧モードで、メロディとドラムの譜面（音符・記号のフォント）が正しく表示される。
7. アカウントメニューからログアウト → エラーなく未ログイン状態になる（トークン取り消し `oauth2.googleapis.com/revoke`）。
8. 1 時間以上たってからの操作など、トークンの再取得が起きたときにもエラーが出ないか、気づいたら確認する。
9. （任意）iPad の Safari でも 2〜6 を行い、表示と保存ができる。

- 結果（2026-10-24、ユーザーが PC の Chrome で確認）: 1〜7 はすべて正常で、CSP の違反は 0 件。
- ログインの間だけ `Cross-Origin-Opener-Policy policy would block the window.closed call.` が何度も出る。これは CSP ではなく、Google のライブラリがポップアップの `window.closed` を確かめるときに、Google 側のページの COOP が止めて出る警告。ログインは完了するので、無視してよい。

違反が出たら、Console のメッセージ（ブロックされた URL とディレクティブ）を控え、`src/lib/csp.ts` に必要最小限の値を足して `npm run e2e:csp` を通す。
