# M4 タスク計画: メロディの編集画面

方針は `m4-decisions.md`。純粋関数を `src/lib/` に置いて TDD、コンポーネントは薄く Storybook で確認。元データは ChordPro テキスト 1 つ。

## 主な設計判断

1. **データモデル**（`src/lib/melody.ts`）: `MelodyEvent = { kind: 'note' | 'rest'; pitch?: 'C#4'; ticks: number; lyric?: string; chord?: string }`。長さは ticks（全音符 = 64、付点込み）。1 セクション = 小節なしの平らな配列。
   - 書き出し: 1 行 1 小節、`|` 区切り、`:N` は変わったときだけ、`C4{d lyrics "き" ch "C"}`、休符 `r`。
   - **歌詞は音符ごとの `{lyrics}`**（パート全体の `\lyrics` は使わない。セクション単位で扱えず、歌詞なしの表現が壊れやすいため）。のばす・歌詞なし = 歌詞のない音符、つめる = `{lyrics "きら"}`。歌詞から `" \ { }` を除去。
   - **厳密なパーサー**: 上記 + 同音タイ `{t}` のみ受け付ける。3 連符・和音・その他の効果・セクション内の `\ts`/`\ks`・`//` コメントを含むセクションは読み取り専用（「テキスト入力で編集してください」）で、本文は一切書き換えない。編集したセクションの範囲だけ書き換え、最初の `\section` より前は保持。パート全体の `\lyrics` があれば「音符ごとの歌詞に変換」ボタンを出す。
   - alphaTab に渡すのはこのシリアライザーの出力だけ。テストで `AlphaTexImporter` を通して拍・音価・歌詞・タイが一致することを確認。
2. **小節線は拍子から自動**（`meta.time`、読めなければ 4/4）。小節をまたぐ音は自動でタイに分割（歌詞は最初の音だけ）、読むときに 1 つに戻す。弱起・途中の拍子変更は M4 では扱わない。
3. **入力用の五線は自前の SVG**（Bravura フォント、連桁なし・旗、臨時記号は毎回表示）。alphaTab は五線の線の y 座標を返す公開 API がなく、キー入力ごとの再描画でちらつくため。下に `PartScore`（alphaTab）で仕上がりを 400ms 遅延で表示。クリック位置の音名は曲のキーの調号に合わせる。
4. **セクション**: メロディのパート = ドラムでないパート（なければ最初の入力で `Vocal` を作成、複数なら選択、名前変更可）。選択肢は `sectionLabels(song)` の順。編集範囲は選んだラベルの最初の `\section` から次の `\section` まで。ないラベルはコード譜の順で `\section` を差し込む。歌詞の取り込みはそのラベルを持つコード譜の最初のセクションから。
5. **状態**: 操作 1 回 → イベント列 → `writeSection` → `part.body` → `onChange(song)` 1 回。カーソル・音価・基準オクターブ・選択中のセクション/パートは MelodyEditor 内。
   - カーソルは音符の間。↑↓・Shift＋↑↓・Backspace はカーソル直前の音符が対象。音をクリック = 選択モード（音価・付点・休符キーがその音符を書き換える）。
   - キーは `e.code` で判定（JIS 配列・IME の影響を受けない）。五線要素（tabIndex=0）にフォーカスがあるときだけ。Tab・Ctrl＋文字・Alt＋文字は奪わない。Ctrl＋↑↓ のみ preventDefault。
   - 音節: 小書き ゃゅょぁぃぅぇぉゎ（カタカナも）と「っ」は前の字とまとめる、「ー」は 1 音節、空白は捨て、句読点は前の字に付ける、英字は単語ごと（`-` でも分ける）。
   - 歌詞の割り当て: 各音符が使う音節数の並び（休符 0）。のばす = 次に 0 を差し込む、歌詞なし = 0 にして後ろへ、つめる = +1、分ける = −1。音符の追加・削除でも後ろへ流れる。ずれ件数 = コード譜の音節数 − 置いた音節数、最初に食い違う音符から後ろをオレンジ表示。

## タスク

| #   | 内容                                                                                                  | 主なファイル                          | モデル |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| T1  | モデル型、ticks（durationTicks / decompose / splitAtBars）、仕様コメント、fixture                     | melody.ts, fixtures                   | opus   |
| T2  | serializeMelody（小節線、タイ、`:N`、効果、文字除去）+ AlphaTexImporter で照合                        | melodyTex.ts                          | sonnet |
| T3  | parseMelody（厳密、読めない書き方 10 種以上、タイの結合）、T2 との往復                                | melodyParse.ts                        | opus   |
| T4  | partSections / readSection / writeSection / 差し込み位置、melodyParts / ensureMelodyPart / renamePart | melodyPart.ts                         | opus   |
| T5  | 音の高さ（MIDI、キーに合わせた綴り、e.code → 半音、五線位置 ⇔ 音高）                                  | pitch.ts                              | sonnet |
| T6  | splitSyllables、chartSyllables(song, label)                                                           | syllables.ts                          | sonnet |
| T7  | 歌詞の操作（自動割り当て、のばす、つめる、分ける、歌詞なし、追加・削除、lyricMismatch）               | melodyLyrics.ts                       | opus   |
| T8  | keyToCommand / applyCommand（カーソル、入力・選択モード、オクターブ 3〜5）                            | melodyInput.ts                        | opus   |
| T9  | layoutMelody（段組み、符頭、加線、臨時記号、旗、休符、タイ、小節線、カーソル、歌詞、yToPitch）        | staffLayout.ts                        | opus   |
| T10 | トークン（warning / note-preview / selection）、Bravura の @font-face                                 | theme.css, index.css                  | sonnet |
| T11 | MelodyStaff（SVG、ホバーで半透明の音、クリックで置く・選ぶ、カーソル、オレンジ、aria-live）           | components/MelodyStaff                | opus   |
| T12 | DurationBar、PianoKeyboard（押しても五線のフォーカスを外さない）                                      | components/DurationBar, PianoKeyboard | sonnet |
| T13 | LyricsPanel（取り込み、操作 4 つ、ずれ件数、`\lyrics` 変換の案内）                                    | components/LyricsPanel                | sonnet |
| T14 | パート全体の `\lyrics` → 音符ごとの歌詞に変換                                                         | melodyPart.ts                         | sonnet |
| T15 | PartScore: AlphaTabApi を作り直さず api.tex、debounceMs                                               | components/PartScore                  | sonnet |
| T16 | MelodyEditor（セクション選択、パート名、組み立て、読み取り専用表示、確認用 PartScore）                | components/MelodyEditor               | opus   |
| T17 | App に組み込む（メロディタブ）                                                                        | App.tsx                               | sonnet |
| T18 | e2e（キーで入力 → 取り込み → のばす → テキストで確認 → 再読み込み）、全検証、ドキュメント更新         | e2e/melody.spec.ts, docs              | sonnet |
| T19 | 独立レビュー                                                                                          | —                                     | opus   |
| T20 | （任意）上下ドラッグで音の高さを変える                                                                | MelodyStaff                           | sonnet |

## 波

1. T1, T5, T6, T10, T15
2. T2, T3, T9, T12
3. T4, T7, T11
4. T8, T13, T14
5. T16 → T17 → T18 → T19（T20 は T16 の後）

## 実績（T17/T18, 2026-10-04）

上記の設計通りに実装・結合した（T19 の独立レビューは別タスク）。

- **App 組み込み（T17）**: メロディタブに `<MelodyEditor song={song} onChange={(next) => setText(serializeSong(next))} />`。ドラムタブは準備中のまま。読み取り専用セクションの通知には、`MelodyEditor` に追加した任意 prop `onRequestTextEdit` を App から渡し、コード譜タブ＋テキスト入力モードへ1クリックで切り替えられるボタンにした（この prop がなければ従来どおり文言のまま）。五線はタブパネルの幅（`.main`、最大 1200px）に対して素直にブロック幅いっぱいになるため、追加 CSS は不要だった。
- **e2e（T18）**: `e2e/melody.spec.ts` — キー C 設定 → コード譜/かんたん入力で歌詞貼り付け＋反映 → メロディタブでキー入力（A A G G H H, Digit2+G で ド ド ソ ソ ラ ラ ソ(2分)）→「コード譜から歌詞を取り込む」→ 音符上の歌詞（き ら き ら ひ か る）を確認 → テキスト入力でアルファTex本文（`\section "A"`、`lyrics "き"`）を確認 → リロードしても歌詞付きメロディが残ることを確認。
- **全検証**: `npm test`（778 件）、`npx tsc -b`、`npm run lint`（警告1件、既存・無関係、下記）、`npm run build`、`npm run test:storybook`（117 件）、`npm run e2e`（3 件）、`npx prettier --check .` をすべて実行し、最終的に全て成功。
- **実装中に見つかった既存の差分 / 仕様の実際の挙動**（T1〜T16 で決まっていたもの。T18 で初めてドキュメント化）:
  - `melodyParse.ts` は spec 通り、ピッチに直接つけた `.N`（例 `C4.4`）も読み取り、書き出し時は常に `:N` 前置き形に正規化する（`.N` は alphaTab の手書き流儀を受け付けるだけで、エディタはこの形で書き出さない）。
  - 隣接する休符は書き出し時に1つへ統合される（統合先に独自の `ch` がある場合は統合しない）。
  - 音域は MIDI 48〜96（C3〜C7）にクランプ（`melodyInput.ts` の `MIN_MIDI`/`MAX_MIDI`）。
  - 歌詞操作のショートカットは N（のばす）/ M（つめる）/ V（分ける）/ C（歌詞なし）。音符入力キー（A S D F G H J K, W E T Y U）と衝突しない文字を選んである。
  - フレーズ区切り線（コード譜の行の先頭音符にマーク）は暫定機能だったが、ユーザー判断で削除した（下記「フィードバック対応」）。
  - `src/lib/fixtures/sampleSong.ts` は M2 時点では Vocal/Drums パートの本文が空だったが、M4 で実データ（`\lyrics`、`\section "A"`/`"B"` の実ノート、ドラムの `(HH BD)` 等）に差し替えられ、M4 のストーリー・テストや本レポートのスクリーンショットもこれに依拠している。
  - メロディを新規作成しても、取り込み前は歌詞が自動で付かない（空の音符として入る）。歌詞は必ず「コード譜から歌詞を取り込む」を押すまで反映されない。
- **スクリーンショット**: `docs/m4-app-melody.png`（実アプリ、上記 e2e と同じ操作後）。五線がタブパネル幅いっぱいに描画され、歌詞・鍵盤・歌詞パネル・alphaTab 確認用プレビューが揃って表示されることを確認した。
- **T17/T18 以外に直したもの**（既存テストが M4 結合で初めて踏んだ不具合）:
  - `src/test/setup.ts` に `ResizeObserver` の空スタブを追加。`App` の `Tabs` は非選択タブも `hidden` でマウントし続けるため、メロディタブを開かなくても `MelodyStaff` が常にマウントされるが、jsdom に `ResizeObserver` が存在せず即座に例外になっていた。
  - `src/components/PartScore/PartScore.tsx`：`new AlphaTabApi(...)` の同期的な例外（jsdom などブラウザ外環境で `"Usage of AlphaTabApi is only possible in browser environments"`）を捕まえて既存の `error` 状態に落とすようにした（`queueMicrotask` で遅延させ、oxlint の `set-state-in-effect` にも抵触しないようにしてある）。これも同じ「メロディタブ以外でも常にマウントされる」経路で必要になった。
  - `npm run lint` には対応済みの行の少し下（`PartScore.tsx` の `setApiCreateCount((c) => c + 1)`）に既存の `set-state-in-effect` 警告が1件残っているが、これは T17/T18 以前から存在する警告で、エラーではなく（`npm run lint` の終了コードは 0）、今回のスコープ外として手を付けていない。

## 実績（フィードバック対応, 2026-10-04）

`docs/m4-decisions.md`「実際に触ってのフィードバック」の 3 点を実装した。

- **フレーズ区切り線（M14）を削除**: `SHOW_PHRASE_MARKS`、`phraseStartsFor` / `chartLineSyllables`、`MelodyStaff` の `phraseStarts` とその描画・テスト・ストーリー。
- **メリスマの自動スラー**: 歌詞のある音に歌詞のない音が続く範囲（休符で切れる）を `melismas` で求め、書き出し時に `slur "<セクション名>-<n>"` を始点（最初の拍）と終点（最後の音の最後のタイ拍）に付ける。alphaTab 1.8.4 で構文と描画を確認（id はパート内で一意である必要がある）。読み込みはメリスマと一致するスラーだけ受け付け、一致しないものは読み取り専用。スラーのないメリスマは受け付けて、次の書き出しで付く。入力用五線にも同じスラーを描く（段またぎは start / middle / end に分割）。
- **モード表示**: 五線の上に「入力中（カーソル位置に音を追加）」/「N 音目を選択中 — Esc または五線の空いた所をクリックで入力に戻る」＋「入力に戻る」ボタン / 「読み取り専用」。動作は変えていない。
- スクリーンショット: `docs/m4-app-melody-v3.png`（入力用五線と alphaTab の両方にスラー）。
