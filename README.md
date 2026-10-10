# band-sheets

バンド用の楽譜アプリです（α版）。パートごとの画面で、コード譜と歌詞・メロディ・ドラムを入力し、PC で編集してタブレットで見ることを想定しています。曲のデータはテキストファイル（ChordPro と alphaTex の組み合わせ）として、各自の Google Drive に保存します。

**試す**: https://mrkkkkk.github.io/band-sheets/ （「サンプル曲で試す」からすぐに使えます。ログインは不要です）

## 開発

```sh
npm install
cp .env.example .env.local   # Google Drive を使う場合は VITE_GOOGLE_CLIENT_ID を設定（docs/m7-google-setup.md）
npm run dev
```

要件と設計のメモは [docs/](docs/) にあります（[docs/requirements.md](docs/requirements.md) から読むのがおすすめです）。

## ライセンス

MIT（[LICENSE](LICENSE)）。依存ライブラリはそれぞれのライセンスに従います（alphaTab は MPL-2.0、楽譜フォント Bravura は SIL Open Font License 1.1）。
