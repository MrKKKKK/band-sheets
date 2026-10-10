# M3 タスク計画: コード + 歌詞の編集画面

方針は `m3-decisions.md`。純粋関数は `src/lib/` に置いて TDD で作り、コンポーネントは薄くして Storybook で確かめる。sheet-for-player の `chordRow.ts`（等幅の空白で桁をそろえる方式）と `transpose.ts`（移調は M3 の範囲外）は流用しない。

## 主な設計判断

1. **元データは App が持つ `text`（ChordPro テキスト）1つだけ。** `song = useMemo(() => parseSong(text))`。
   - B は textarea の値をそのまま `text` にする。整形しないので、カーソルも書き方も崩れない。
   - A・曲情報・パレット編集は「song を変える → serializeSong → onChange 1回」で反映する。
   - A ⇔ B の切り替えでは何も変換しない。
2. **B のヘルパーはテキストを直接書き換える。** 戻り値は `{text, caret}`、挿入後に caret を戻す。
3. **パレット:** `SongMeta.palette?: string[]`。トップレベルで最初の `{x_palette:}` を空白で区切って読み、書き出しは `{time:}` の直後（空なら出さない）。表示順は「自分で追加 → 使用中（出現順）→ ダイアトニック」で、重複は除く。
4. **コード文字列のチェック `isValidChordText`:** 空でない・空白なし・`[]{}` を含まない。
5. **A の手順 1:** 下書きを手元で持ち、「反映」ボタンで1回だけ `applyLyrics`。歌詞の行がなければ手順 1、あれば手順 2 を表示する。
6. **変わった行の判定:** 曲全体の歌詞行を LCS（完全一致）で突き合わせ、一致した行のコードを残す。
   - 新しいブロックは、一致した行の多い旧セクションの kind/label を引き継ぐ。引き継げなければ verse + 次の英字。
   - RawLine、空行、コードだけの行は手順 1 に出さず、位置を保って残す。
7. **コードの配置:** 文字の位置はコードポイント単位。行末にも置ける。既存のコードは区間の番号で指定して編集・削除する。
8. **ダイアトニック:** 三和音のみ。`parseKey` で厳密に読む（読めなければ段を出さない）。綴りは文字名で決める（F#m → F#m G#dim A Bm C#m D E、Bb → Bb Cm Dm Eb F Gm Adim）。マイナーは自然的短音階 7 つ + V のメジャー（Am なら E）。
9. **下書きの自動保存:** localStorage に曲 ID ごとに自動保存する（`band-sheets:draft:<songId>`、500ms 遅延）。M3 は曲 ID `local` 固定。M7 以降も「編集途中の下書き」として残し、Drive への書き込みは明示的な操作で行う。
10. **フォント:** `@fontsource/noto-sans-jp` と `@fontsource/jetbrains-mono` を同梱し、トークンは `src/theme.css` に置く。

## タスク

| #   | 内容                                                                       | 完了条件                                       |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| T1  | `meta.palette` と `{x_palette:}` の読み書き・往復                          | 単体テスト                                     |
| T2  | `chordText.ts`: isValidChordText / lineLyrics / usedChords                 | 単体テスト                                     |
| T3  | `keys.ts`: parseKey / diatonicChords                                       | 単体テスト（C, Am, F#m, Bb, Eb, 不正なキー）   |
| T4  | `palette.ts`: paletteGroups / addToPalette / removeFromPalette             | 単体テスト                                     |
| T5  | `chartEdit.ts`: setChordAt / updateChord / Song 上の行を書き換えるヘルパー | 単体テスト（サロゲートペア、行末）             |
| T6  | `lyrics.ts`: lyricsText / applyLyrics / nextSectionLabel                   | 単体テスト（変更・挿入・削除・繰り返し・保持） |
| T7  | `textEdit.ts`: insertAt / insertSection                                    | 単体テスト                                     |
| T8  | 土台: theme.css、フォント、Popover、Button / Chip                          | Storybook テスト（Esc、a11y）                  |
| T9  | ChordLyricLine / ChartPreview                                              | stories + スクリーンショット                   |
| T10 | ChordPopover                                                               | stories + 操作テスト                           |
| T11 | Editor A（EasyEditor）                                                     | stories の操作テスト                           |
| T12 | PaletteEditor                                                              | stories                                        |
| T13 | Editor B（TextEditor）                                                     | stories（caret、整形しない）                   |
| T14 | SongInfoPopover + validateMeta                                             | 単体テスト + stories                           |
| T15 | App シェル（タブ、A/B 切り替え、自動保存）                                 | 単体テスト                                     |
| T16 | e2e（A で置く → B で確認・編集 → A に反映）と全検証、ドキュメント更新      | 全チェックが通る                               |

## 依存関係（波）

1. T1, T2, T3, T5, T6, T7, T8（T6 は T2 の後）
2. T4, T9, T14
3. T10, T12
4. T11, T13
5. T15 → T16

## 実績（2026-10-03）

T1〜T16 すべて完了。画面のスクリーンショットは `m3-app-easy.png`（かんたん入力・手順 2）と `m3-app-text.png`（テキスト入力）。

- **App シェル（T15）:** ヘッダー（曲名・曲情報・「閲覧モード」は無効で「準備中（M6）」）、楽器タブ「コード譜 / メロディ / ドラム」（矢印キー・Home / End で移動、メロディとドラムは「準備中です」）、コード譜タブに「かんたん入力 / テキスト入力」の切り替え（aria-pressed のボタン 2 つ）。選んだ入力方法は localStorage（`band-sheets:editor-mode`）に覚える。
- **下書きの自動保存:** `src/lib/storage.ts`（`draftKey` / `loadDraft` / `saveDraft` ほか、すべて try/catch）と `src/hooks/useAutosave.ts`（500ms 遅延、アンマウント時と `pagehide` で保存待ちを書き出す。起動時のテキストは書き戻さない）。下書きがなければ `{title: 無題の曲}` だけの新しい曲で始まり、A は手順 1 から。
- **e2e（T16）:** `e2e/editor.spec.ts` で「キー C を設定 → A で歌詞を反映 →「ひ」に F → B で `きらきら[F]ひかる` を確認し `[G]` を「よ」の前に入力 → A で G が「よ」の上にある → 再読み込みしても残る」を確認。

計画からの変更・補足:

- e2e でダイアトニックの F チップを選ぶため、先に曲情報でキー C を設定している（キーがないとダイアトニックの段が出ない）。
- タブと切り替えは汎用コンポーネント `Tabs` / `SegmentedControl` にした。タブの中身は非表示でもマウントしたまま（`aria-controls` の参照先を常に置くため）。
- 見出しの順番（h1 → h3 の飛び）を a11y テストが検出したので、コード譜パネルに画面外の h2「コード譜」を置いた。
- 曲情報の変更は B で入力中でも `serializeSong` を通すので、テキストが整形される（方針どおり）。
- App は `storage` を props で受け取れる（既定は `window.localStorage`）。stories と単体テストはメモリ上の storage を使い、本物の localStorage を共有しない。
