# α版の公開: 決定事項と次の手順

## ユーザー判断（2026-10-10）

- MVP（M0〜M7）が完了したので、α版として公開する。
- ~~公開先は Cloudflare Pages~~ → 2026-10-10 に **GitHub Pages** に変更（ユーザー）。リポジトリを公開にしたので無料で使え、Cloudflare のアカウントが要らず、設定をほぼ `gh` で済ませられるため。公開先は `https://mrkkkkk.github.io/band-sheets/`。
- **band-sheets を Git で管理し、GitHub に置く**。`main` に push すると GitHub Actions で自動的に公開される。
- 2026-10-10 追記: ユーザーは「GitHub のリポジトリは公開でもよいかも」と言っている（最終決定はまだ）。公開にする場合は次を先に行う:
  - 公開してよい内容かの確認: 秘密情報は無い（クライアント ID は `.env.local` で除外済み、そもそも秘密ではない）。個人の情報は `docs/m7-google-setup.md` 88 行目と `docs/m5-alphatab-findings.md` 126 行目のローカルのパス（`/home/mrk5/...`）だけ → 相対パスに直す。コミット前に `git grep` でもう一度確かめる。
  - ライセンスを決める（MIT など。ユーザーに聞く）。依存ライブラリのライセンス（alphaTab は MPL-2.0、Bravura は SIL OFL）との相性も確認。
  - 公開リポジトリなら GitHub Pages も無料で使える（→ 上のとおり GitHub Pages に変更した）。

## 前提

- アプリは静的な SPA（`npm run build` の `dist/` を置くだけ）。ルートはハッシュ（`#/…`）なので、サーバー側のリライト設定は要らない。
- 曲のデータは各自の Google Drive にあり、公開先には置かない。Google Cloud が「テスト中」のあいだは、テストユーザーだけがログインできる。
- `VITE_GOOGLE_CLIENT_ID` はビルド時に埋め込まれる（秘密ではない）。GitHub Actions のリポジトリ変数としてビルドに渡す。`.env.local` は `*.local` で git から除外済み。

## 進み具合

- 2026-10-10: リポジトリは**公開**、ライセンスは **MIT** に決定（ユーザー）。個人のパス 2 か所を直し、`LICENSE`・README（ひな形から差し替え）・`package.json` の `license`・`.nvmrc`（Node 24、GitHub Actions のビルド用）を追加。コミットの作者は `MrKKKKK <38149405+MrKKKKK@users.noreply.github.com>`（このリポジトリだけの設定。Gmail を公開しないため）。
- 2026-10-10: 手順 1・2 完了。https://github.com/MrKKKKK/band-sheets （公開、ブランチ `main`）。
- 2026-10-10: 公開先を GitHub Pages に変更。`.github/workflows/deploy-pages.yml`（`main` への push で、ビルドして公開）を追加。サブフォルダで公開するため、ワークフローの中だけ `vite build --base=/band-sheets/` にしている（`vite.config.ts` は変えていないので、開発サーバーと e2e は `/` のまま）。手元でこのビルドを試し、フォントなども `/band-sheets/` から読み込まれることを確認。Pages は `gh api` で有効化（build_type=workflow）。クライアント ID はリポジトリの Actions 変数 `VITE_GOOGLE_CLIENT_ID` から渡す（2026-10-10 に `.env.local` と同じ値を登録）。Google Cloud の承認済みの生成元に `https://mrkkkkk.github.io` を追加済み（ユーザー）。手順 3・4 完了。

## 次の手順

1. `git init`、`.gitignore` の確認（`node_modules`・`dist`・`*.local`・`test-results`・`storybook-static` など）、最初のコミット（コミットメッセージの末尾に指示された Co-Authored-By 行）。
2. GitHub にリポジトリ（公開か非公開かをユーザーに最終確認）を作って push（`gh` CLI。ユーザーのログインが必要なら手順を渡す）。
3. GitHub Pages: ワークフローを追加し、Pages を有効にして、Actions 変数 `VITE_GOOGLE_CLIENT_ID` を設定する（Cloudflare Pages の案はやめた）。
4. Google Cloud のクライアント ID の「承認済みの JavaScript 生成元」に公開先のアドレス（`https://mrkkkkk.github.io`。パスは含めない）を追加（ユーザーの作業）。
5. 公開先で本物の確認: PC のブラウザと実際の iPad（Safari）で、ログイン・保存・閲覧。iPad で Wake Lock（演奏中に画面が消えない）、VoiceOver の読み上げ位置（M6 R15）、Safari のポップアップ（M7 R9）を確かめる。
6. 結果を見て、残りの課題（requirements.md の「MVP 後に回すもの」、M6/M7 レビューで後回しにした点）の優先順位をユーザーと決める。
