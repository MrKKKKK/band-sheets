# M2 タスク計画: データモデルとテキストの往復変換

方針は `format-decision.md` の「合意済みの方針」と「M2 に向けて合意した方針」を参照。すべて `src/lib/` の純粋関数として、TDD で作る。

## データモデル（実装済み: `src/lib/song.ts`）

```ts
interface Song {
  meta: SongMeta;
  chart: ChartSection[]; // コード譜（ファイル内の順）
  parts: Part[]; // 楽器パート（ファイル内の順）
}
interface SongMeta {
  title: string; // {title:} がなければ ''
  key?: string;
  tempo?: number; // 数値として読めない {tempo:} は RawLine として残す
  time?: string; // "4/4" などの生テキスト。描画前に厳密チェックする
}
interface ChartSection {
  kind: string; // verse / chorus / bridge …（start_of_<kind>）。'' = 暗黙のセクション
  label: string; // "A"、"サビ" など。パートとの対応付けに使う。'' もありうる
  lines: ChartLine[];
}
type ChartLine = LyricLine | RawLine;
interface LyricLine {
  segments: Segment[]; // 空行は []
}
interface RawLine {
  raw: string; // # コメント行・未知のディレクティブ。そのまま書き戻す
}
interface Segment {
  chord?: string; // 解釈しない文字列。最初の [ より前の歌詞は chord キーなし
  lyrics: string;
}
interface Part {
  name: string; // {start_of_part: Drums}
  body: string; // alphaTex（生テキスト、行は '\n' 区切り、末尾改行なし）
}
isDrumPart(part); // body に \instrument percussion があればドラム（保存しない）
```

### 読み書きの規則

- **暗黙のセクション**: セクションの外に書かれたコード譜の行・コメント・未知のディレクティブは、`kind: ''`, `label: ''` のセクションにまとめる。空行で区切られた連続行ごとに 1 セクション。書き出すときは囲みなしで出す。
- **正規化した出力**（`serializeSong`）: メタ情報 → コード譜 → パートの順。ブロック間は空行 1 つ、改行は `\n`、末尾に改行。短縮形（`{t:}` `{sov}` など）は正式名に揃える。
- このため、パートより後ろに書かれたトップレベルのコメント等はコード譜側（パートより前）に移動する。内容は失われない。
- 2 回目以降のメタ情報ディレクティブ（転調の `{key: D}` など）とセクション内のディレクティブは RawLine として位置を保って残す。
- 壊れた入力: 閉じていないセクション・パートはファイル末尾か次のブロック開始で閉じる。対応しない `{end_of_x}` は今開いているセクションを閉じる（開いていなければ RawLine）。CRLF と BOM を受け付ける。例外は出さない。
- `partsToAlphaTex` はドラム用の既定の別名（HH/SD/BD/CR/RD/HO/T1/T2/FT）と `\clef neutral` を `\instrument percussion` の行の直後に補う（本文で定義済みのものは補わない）。
- フォントは `@coderline/alphatab/font/Bravura.*?url` を import して `core.smuflFontSources` に渡す（alphaTab 1.8.4 同梱の Vite プラグインは非推奨かつ中身が欠けているため使わない）。

## タスク

| #   | 内容                                                                                                                                                                                       | 完了条件                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| T1  | 型定義とサンプル曲のテスト用データ（きらきら星 + ドラム、セクション2つ）                                                                                                                   | 型チェックが通る                |
| T2  | `parseSong(text): Song`: メタ情報、セクション、`[C]` 付きの行、パートのブロック                                                                                                            | 各要素の単体テスト              |
| T3  | `serializeSong(song): string`: 正規化した形で出力する                                                                                                                                      | 単体テスト                      |
| T4  | 往復と堅牢性: parse → serialize → parse で一致する。壊れた入力（閉じていないブロック、未知のディレクティブ、空ファイル、`(C)` のような単音表記、テンションの付いたコード）で例外を出さない | 単体テスト                      |
| T5  | `partsToAlphaTex(song, partNames)`: 描画用に alphaTex を組み立てる。ドラムの既定の音色名（HH/SD/BD/CR…）と `\clef neutral` を補う                                                          | 単体テスト + Storybook で実描画 |
| T6  | `sectionLabels(song)`: コード譜とパートからセクション名を集め、名前で対応付ける                                                                                                            | 単体テスト                      |

## 未知の要素の扱い（提案）

- Drive 上で手で編集されたファイルを開いても内容が失われないように、**未知のディレクティブやコメント行は、出現した位置にそのまま残して往復させる**。
- パートの種類（メロディ / ドラム）は保存しない。本文に `\instrument percussion` があればドラムと判定する（`body` から導く値にする）。
- 画面とファイル入出力は M2 の範囲外。
