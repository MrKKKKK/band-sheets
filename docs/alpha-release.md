# α版の公開: 決定事項と次の手順

## ユーザー判断（2026-10-10）

- MVP（M0〜M7）が完了したので、α版として公開する。
- **公開先は Cloudflare Pages**（例: `band-sheets.pages.dev`）。
- **band-sheets を Git で管理し、GitHub に置く**。Cloudflare Pages は GitHub とつないで自動で公開する。
- 2026-10-10 追記: ユーザーは「GitHub のリポジトリは公開でもよいかも」と言っている（最終決定はまだ）。公開にする場合は次を先に行う:
  - 公開してよい内容かの確認: 秘密情報は無い（クライアント ID は `.env.local` で除外済み、そもそも秘密ではない）。個人の情報は `docs/m7-google-setup.md` 88 行目と `docs/m5-alphatab-findings.md` 126 行目のローカルのパス（`/home/mrk5/...`）だけ → 相対パスに直す。コミット前に `git grep` でもう一度確かめる。
  - ライセンスを決める（MIT など。ユーザーに聞く）。依存ライブラリのライセンス（alphaTab は MPL-2.0、Bravura は SIL OFL）との相性も確認。
  - 公開リポジトリなら GitHub Pages も無料で使えるが、公開先は Cloudflare Pages のまま（変えるならユーザーに確認）。

## 前提

- アプリは静的な SPA（`npm run build` の `dist/` を置くだけ）。ルートはハッシュ（`#/…`）なので、サーバー側のリライト設定は要らない。
- 曲のデータは各自の Google Drive にあり、公開先には置かない。Google Cloud が「テスト中」のあいだは、テストユーザーだけがログインできる。
- `VITE_GOOGLE_CLIENT_ID` はビルド時に埋め込まれる（秘密ではない）。Cloudflare Pages では環境変数としてビルドに渡す。`.env.local` は `*.local` で git から除外済み。

## 次の手順（まだ何もしていない）

1. `git init`、`.gitignore` の確認（`node_modules`・`dist`・`*.local`・`test-results`・`storybook-static` など）、最初のコミット（コミットメッセージの末尾に指示された Co-Authored-By 行）。
2. GitHub にリポジトリ（公開か非公開かをユーザーに最終確認）を作って push（`gh` CLI。ユーザーのログインが必要なら手順を渡す）。
3. Cloudflare Pages: GitHub とつないでプロジェクトを作る（ビルドコマンド `npm run build`、出力 `dist`、Node のバージョン、環境変数 `VITE_GOOGLE_CLIENT_ID`）。アカウント操作はユーザーが行うので、手順書を渡す。
4. Google Cloud のクライアント ID の「承認済みの JavaScript 生成元」に公開先のアドレス（`https://<project>.pages.dev`）を追加（ユーザーの作業）。
5. 公開先で本物の確認: PC のブラウザと実際の iPad（Safari）で、ログイン・保存・閲覧。iPad で Wake Lock（演奏中に画面が消えない）、VoiceOver の読み上げ位置（M6 R15）、Safari のポップアップ（M7 R9）を確かめる。
6. 結果を見て、残りの課題（requirements.md の「MVP 後に回すもの」、M6/M7 レビューで後回しにした点）の優先順位をユーザーと決める。
