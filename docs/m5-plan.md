# M5 タスク計画: ドラムの編集画面（＋メロディの連符）

方針は `m5-decisions.md`（方式C・キー割り当て・Shift＋キーの同時打ち・連符ボタン・セクションごとのシャッフル・ゴースト/アクセント、フラムは見送り）、alphaTex の書き方は `m5-alphatab-findings.md` に従う。M4 と同じく純粋関数を `src/lib/` に置いて TDD、コンポーネントは薄く Storybook で確認。元データは ChordPro テキスト 1 つ（`App` の `text`）で、ドラムの編集も `song → part.body を書き換え → onChange(song) 1 回 → setText` の経路に乗るので、下書きの自動保存（`useAutosave`）はそのまま効く。

## 主な設計判断

1. **連符はドラムとメロディ共通の仕組み**（`src/lib/tuplet.ts`）。
   - **表し方**: イベントの平らな配列はそのまま（M4 のカーソル・選択・歌詞の流し込みがすべて「イベントの添字」で動いているため、入れ子の構造にはしない）。連符の中の各イベントに `tuplet?: TupletMark`（`{ n: number; slot: number }`、slot = 0〜n−1）を付ける。**1 つの連符 = 印の付いた連続する n 個のイベント**（slot 0 から n−1 まで順番どおり）。
   - **長さの意味**: 連符の中のイベントの `ticks` は**書かれた音価**（例: 8分 = 8）。連符全体の実際の長さ（span）は `tupletDen(n) × 単位の ticks`。`tupletDen(n)` = **n より小さい最大の 2 のべき乗**（3→2、5・6・7→4、9〜15→8）。例: 8分の3連 = 8分 2 つ分（16）、16分の5・6・7連 = 4分 1 つ分（16）、32分の11連 = 4分 1 つ分。
     - 理由: alphaTab の `{tu N}`（引数 1 つ）の既定の分母がまさにこの値（`_getTupletDenominator`: 3→2、5〜7→4、9〜12→8 をソースで確認）なので、書き出しが短く読みやすい `{tu N}` で済み、alphaTab の解釈と必ず一致する。単純拍子の一般的な記譜の慣習とも一致する。単位の ticks は 2 以上、分母は 2 以上なので **span は常に整数の ticks** になり、M4 の ticks（全音符 = 64）の計算・小節の検証をそのまま使える。
     - 採らなかった案: (a) 分母も自由に持たせる（UI が複雑、ほぼ使われない）、(b) ticks の分解能を上げる（任意の N では最小公倍数が際限なく大きくなり、M4 の ticks 前提のコードがすべて変わる）。連符の中の各音の実際の位置は小数になるが、それを使うのは描画（x 座標）だけで、小節の計算は連符単位の整数で行う。
   - **連符の中は同じ音価の n 個だけ**（付点なし・タイなし。休符は可）。単位は 2分・4分・8分・16分・32分。alphaTab の括弧のまとめ方（`TupletGroup.check`: 同じ長さの拍なら n 個で閉じる）と完全に一致し、読み込み時の区切りも一意になる（`{tu N}` が付いた同じ音価の拍を n 個ずつ数える）。長さの違う音が混ざる連符（4分＋8分の3連など）は alphaTab 側の括弧のまとめ方が不安定なので M5 では読み取り専用（確認したい点 4）。
   - **N の範囲**: 3〜15 で 4・8 を除く（`isValidTupletN`）。書き出しは alphaTab が既定の分母を持つ N（3・5・6・7・9・10・11・12）なら `{tu N}`、それ以外（13・14・15）は `{tu N D}`。読み込みは両方受け付け、D が `tupletDen(N)` と違えば読み取り専用。
   - **`{tu N}` は連符の全拍に書く**（findings §1）。グループの開始・終了の記号はない。
   - **連符は 1 小節の中に収める**（小節線をまたぐ連符は読み取り専用、編集でまたぐことになる操作は受け付けない — 確認したい点 2）。小節線が連符の音の途中に来る場合を書き表せないため。alphaTab は小節の長さを検証しないので（findings §1）、検証は `groupsFitBars` と各パーサーの小節長チェックで自分たちが行う。
   - **連符の編集（両エディタ共通の規則、`tuplet.ts` の汎用関数 + 各 input モジュール）**:
     - 「連符」ボタン → 3・5・6・7・その他（数を入力、3〜15・4 と 8 を除く）。**入力モードのカーソル位置に、今の音価を単位とする休符 n 個の連符を挿入**し、カーソルはその先頭へ。付点が選ばれていても単位は付点なし。カーソルが連符の中なら「連符の中に連符は入れられません」。
     - **埋める動作**: カーソルが連符の中（先頭 < カーソル < 末尾）にあるとき、音・楽器・休符のキーは**挿入せずにカーソル位置の枠を置き換えて**カーソルを 1 つ進める。カーソルが連符の先頭にあり、連符がまだ全部休符（作った直後）なら先頭の枠を置き換える。先頭にあって 1 つでも埋まっていれば、通常どおり連符の前に挿入する。
     - Backspace: 直前の枠が連符の中なら**消さずに休符に戻す**（カーソルは 1 つ戻る）。全部休符になった連符でもう一度 Backspace → **連符ごと削除**。選択モードの Backspace も同じ。連符の一部だけが消えてグループが壊れることはない。
     - 連符の枠を選んで音価・付点キー → 変更しない（「連符の中の音価は変えられません」）。「連符を削除」ボタン（カーソル・選択が連符の中にあるとき）で連符をまるごと消す。
     - どの操作でも、結果が `groupsFitBars` を満たさない（後ろの連符が小節線をまたぐ）ときは**操作を受け付けず**、理由を live 領域とエラー表示に出す。
2. **メロディの連符を編集可能にする（M4 の移行）**。
   - `MelodyEvent` に `tuplet?: TupletMark`。`splitAtBars` は連符を 1 つのかたまり（span）として小節に並べ、中の拍は分割しない（`BarPiece` に `tuplet` を追加）。
   - 書き出し: `:8 C4{tu 3 lyrics "き"} D4{tu 3} r{tu 3}`（効果の順は `d t tu lyrics ch slur`。連符では `d`・`t` は出ない）。メリスマのスラーは連符をまたいでもよい（音符の効果なので無関係）。
   - 読み込み: `tu` を受け付け、上の規則（n 個・同じ音価・付点/タイなし・小節内・D の一致）を外れたら読み取り専用（理由は日本語）。手書きの `C4.8{tu 3}`（`.N` の直後の `{}` に**拍の効果 `tu`/`d` だけ**がある形）も受け付ける（findings §1 の検証例の書き方。`.N` の後に `t` など音符の効果が来る形は従来どおり読み取り専用）。
   - `mergeRests` は連符の枠の休符を結合しない（連符の前後の休符とも結合しない）。歌詞の流し込み（`insertNote`/`deleteNote`）は、枠の置き換え = 削除＋挿入の扱いで M4 と同じく「後ろはまとめてずれる」。
   - M4 で「連符は読み取り専用」を確かめていたテスト（`melodyParse.test.ts` の `tuplet`、`melodyPart.test.ts` の `:4 C4{tu 3} |`）は「受け付ける」テストに書き換え、長さの違う連符・不足・小節またぎなどの読み取り専用テストを追加する。
3. **ドラムのデータモデル**（`src/lib/drumKit.ts`, `src/lib/drum.ts`）。
   - 楽器表 `DRUM_KIT`（9 種）: id（alphaTex の別名）、日本語名、キー（`e.code`）、五線の位置、符頭の種類。キー: F=SD、J=BD、H=HH、G=HO、K=T1、L=T2、;(`Semicolon`)=FT、U=CR、I=RD。
   - **五線の位置は alphaTab の描画と同じにする**（入力用の五線と確認用表示がずれないように）。alphaTab の `InstrumentArticulation` の `staffLine` を確認した結果、現行の `DRUM_ARTICULATIONS` では T2(45) と FT(41) が同じ位置（第2間）に重なる。一般的なドラム譜の配置（ハイタム E5・ミッドタム D5・スネア C5・フロアタム A4・バスドラム F4）に合わせ、**T1 を 48→50、T2 を 45→48 に変える**（FT は 41 のまま）。位置（下の線 = 0、上の線 = 8）: CR 10（加線、太い×）、HH・HO 9（×、HO は ○付き×）、RD 8（×）、T1 7、T2 6、SD 5、FT 3、BD 1。`\articulation` は表示用に `partsToAlphaTex` が足すだけでテキストには保存されないので、既存のテキストは変わらない。
   - `DrumHit = { inst; ghost?: true; accent?: 'normal' | 'heavy' }`、`DrumEvent = { hits: DrumHit[]; ticks: number; tuplet?: TupletMark }`。**`hits` が空 = 休符**。1 拍に複数の楽器（同時打ち）。拍の中の楽器は常に五線の上から順（CR HH HO RD T1 T2 SD FT BD。`DRUM_KIT` の並び＝step の降順）に並べる（サンプル曲の `(HH BD)`・`(HH SD)`・`(SD BD)` はそのまま往復する）。HH と HO は同じ拍に置けない（片方を足すともう片方が外れる）。ゴーストとアクセントは同じ音に同時に付けない。
   - **ドラムのイベント = 書かれた 1 拍**（タイも休符の結合もしない。打楽器にタイは意味がないため）。`ticks` は単一の音価（付点可）。挿入・削除で後ろがずれて**小節線をまたいだ拍は、小節線で「打つ拍＋休符」に分ける**（`normalizeDrums`、添字の対応表を返し、M4 の `mergeRests` と同じくカーソル・選択を補正）。これでエディタ上の配列 = テキストの往復結果が常に成り立つ（M4 レビュー M1 の教訓）。
   - シャッフル: セクションごとに `'none' | '8' | '16'`。音価は変えない。
4. **ドラムの alphaTex サブセット**（`drumTex.ts` / `drumParse.ts`、仕様コメントは `drum.ts` の先頭に M4 の `melody.ts` と同じ粒度で書く）。
   - 書き出し（1 行 1 小節、`|` 区切り、`:N` は変わったときと最初の拍）:
     ```
     \tf triplet8th
     :8 (HH BD) HH (HH SD{ac}) HH (HH BD) (HH BD) (HH SD) HH |
     :16 SD{g tu 6} SD{tu 6} SD{tu 6} SD{tu 6} r{tu 6} (SD BD){tu 6} :4 CR{hac} r |
     ```
     - 1 楽器の拍: `SD{<音の効果> <拍の効果>}`（M4 の `C4{d t lyrics}` と同じく、`:N` 方式なら 1 つの `{}` に音・拍の効果を並べられる。T1 で確認）。同時打ち: `(HH SD{g}){d tu 3}`（音の効果は括弧の中の各音名の直後、拍の効果は括弧の後）。休符 `r`（小文字）。
     - 音の効果: `g`（ゴースト）、`ac`（アクセント）、`hac`（強いアクセント）。拍の効果: `d`、`tu N`。
     - **シャッフルは各セクション本文の 1 行目に必ず `\tf none|triplet8th|triplet16th` を書く**（`\tf` は次の小節以降に持ち越されるので、セクション単位の指定にするには毎回明示するしかない。他のセクションを見ずに済む）。拍が 1 つもないセクションには書かない（シャッフルの選択はセクションに拍ができるまで無効）。
   - 読み込み（厳密、外れたら読み取り専用で本文を書き換えない）: 上の形に加えて、任意の順の楽器、`.N` 付き（`SD.8`、`(HH BD).8`、`r.8`、後ろの `{}` は拍の効果のみ）、1 行目以外の空行・改行の自由、`\tf` の別名（`t8`/`t16`/`no` 等）を受け付け、正規形で書き直す。`\tf` がない → `none` 扱い（次の書き出しで `\tf none` が付く）。読み取り専用: `DRUM_KIT` にない音名・大文字 `R`・同じ楽器の重複・HH と HO の同時・ゴースト＋アクセント・`t`・`lyrics`/`ch`・その他の効果（フラム `{gr}` を含む）・セクション途中の `\tf` やその他の `\`・コメント・小節長の不一致（→ M4 と同じく `barMismatch` と「新しい拍子で小節を引き直す」）。パートの冒頭で `\articulation` が 9 種の別名を別の番号に定義し直している場合はパート全体を読み取り専用。
5. **パートとセクション**: ドラムのパート = `isDrumPart`（`\instrument percussion`）。なければ最初の入力で `Drums`（重複時は `Drums 2`…）を本文 `\instrument percussion` で作る。複数あれば選択、名前変更可（M4 と同じ）。セクションの選択・差し込み位置・`\section` 行の扱いはメロディと共通にするため、`melodyPart.ts` の区間処理を「本文の読み書き方法（codec）を渡せる」形に汎用化し（T4）、ドラムは `drumPart.ts` でそれを使う。`preambleOverrides`（パート冒頭の `\ts`）はドラムでも使う。
6. **入力用の五線（ドラム）**は M4 と同じく自前の SVG（Bravura）。打楽器記号、×符頭、連桁なし・旗、**符尾はすべて上向きの 1 声**（正式な見た目は下の alphaTab の確認用表示）。ゴーストは符頭の丸括弧、アクセントは `>`、強いアクセントは `^`（alphaTab の表示に合わせる）、連符は括弧と数字（メロディと共通の `tupletLayout.ts`）、シャッフルはセクション冒頭に「Shuffle」と ♪♪=♪³♪ の簡易表記。
7. **キー操作（ドラム、譜面にフォーカスがあるときだけ、`e.code` で判定。Tab・Ctrl/Alt/Meta＋文字は奪わない）**:
   - 楽器キー: 入力モード = カーソル位置にその楽器の拍を挿入（連符の中は枠の置き換え）。選択モード = 選んだ拍でその楽器を足す／外す。
   - **Shift＋楽器キー: カーソル直前の拍でその楽器を足す／外す**（カーソルは動かない。最後の 1 つを外すと休符になる。直前に拍がなければ何もしない）。
   - 1 2 4 8 6 音価、`.` 付点、R 休符、← → カーソル、Backspace、Enter（直前の拍を選択）、Esc（入力に戻る）は M4 と同じ。
   - ゴースト・アクセント: キー案 S / A（確認したい点 1）。対象は「直前（選択中）の拍の、最後に入力・クリックした楽器」。
   - マウス: 何もない所のクリック = その高さの楽器をカーソル位置に挿入、既存の拍の真上（同じ列）の別の高さのクリック = その拍にその楽器を足す（確認したい点 6）、符頭のクリック = 拍の選択＋その楽器を「最後の楽器」にする。
8. **画面**（`DrumEditor`、メロディタブと同じ並び）: セクション選択・パート名（M4 の部品を共通化して再利用）→ 読み取り専用／小節の引き直しの通知 → 入力欄（`DurationBar`、連符ボタン、ゴースト・アクセントのボタン、シャッフル なし/8分/16分）→ モード表示（入力中／N 拍目を選択中）→ 入力用の五線 → ドラムパッド（キー表を兼ねたボタン。押しても五線のフォーカスを外さない、Shift＋クリックで直前の拍に足す）→ 確認用 `PartScore`（ドラムのパートだけ、400ms 遅延）。live 領域は `DrumEditor` に 1 つだけ（M4 の M8 と同じ）。

## タスク

各タスクは自分の「主なファイル」だけを変更する（同じ波の中でファイルが重ならない）。テストはタスクごとに対象ファイルだけを実行し、全体のテストは T23 で 1 回だけ流す（WSL が落ちやすいため）。コマンドはすべてコンテナ内: `docker exec -u node -w /workspaces/band-sheets band-sheets <cmd>`。各タスク共通の確認: `npx tsc -b`、`npx oxlint <変更ファイル>`、`npx prettier --check <変更ファイル>`。

| #   | 内容                                                                                                                                                                                                                                                                                                                                                                              | 主なファイル（所有）                                                                                                  | 依存                  | テスト（対象だけ実行）                                                                                                                                                                             | モデル | 実績                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| T1  | alphaTex の追加検証（`AlphaTexImporter` と一時ストーリーのスクリーンショット）: `SD{g tu 3}`、`(HH SD{g}){d tu 3}`、`(SD){tu 3}`、`C4{tu 3 lyrics "x" slur "A-1"}`、`C4.8{tu 3}`、`{tu 13 8}`、同じ N の連符が 2 つ続くときの括弧、`\section "A"` の次の行の `\tf`、シャッフルの後の `\tf none` の表示、T1=50・T2=48・FT=41 の位置。結果を findings §8 に追記、一時ファイルは削除 | docs/m5-alphatab-findings.md                                                                                          | —                     | 手動（Node スクリプト、Storybook のスクリーンショット）                                                                                                                                            | sonnet | 完了（2026-10-04）findings §8 に追記                                                   |
| T2  | 共通の連符: `TupletMark`、`isValidTupletN`、`tupletDen`、`tupletTex` / `parseTupletItem`、`tupletGroups`（検証つき）、`atoms`、`groupAt`、`fillZone`（埋める動作の判定）、`insertGroup` / `removeGroup`、`groupsFitBars`、`slotOffset`。型は下の「共通 API」どおり                                                                                                                | src/lib/tuplet.ts, tuplet.test.ts                                                                                     | —                     | `npx vitest run --project unit src/lib/tuplet.test.ts`（N の境界 2/3/4/8/15/16、各単位の span、壊れたグループ 6 種、小節またぎ、先頭・中・末尾での fillZone、全部休符の判定）                      | opus   | 完了（2026-10-04）tuplet.ts・tuplet.test.ts 80件                                       |
| T3  | ドラムキット表 `DRUM_KIT`（id・日本語名・e.code・位置・符頭）、`DRUM_ARTICULATIONS` の T1=50・T2=48 への変更                                                                                                                                                                                                                                                                      | src/lib/drumKit.ts, drumKit.test.ts, partsToAlphaTex.ts, partsToAlphaTex.test.ts                                      | —（T1 の結果で確定）  | `src/lib/drumKit.test.ts src/lib/partsToAlphaTex.test.ts`（キーの重複なし、位置が alphaTab の staffLine と一致、AlphaTexImporter で 9 種が読めること）                                             | sonnet | 完了（2026-10-04）drumKit.ts、DRUM_ARTICULATIONS 修正                                  |
| T4  | `melodyPart.ts` の区間処理を汎用化: `readSectionWith(body, label, ts, codec)`、`writeSectionText(body, label, tex, chartOrder)`、`reflowSectionWith`。メロディ用の既存 API はこの上の薄い包みにして挙動を変えない                                                                                                                                                                 | src/lib/melodyPart.ts, melodyPart.test.ts                                                                             | —                     | `src/lib/melodyPart.test.ts`（既存がすべて通ること＋汎用版を偽の codec で数件）                                                                                                                    | sonnet | 完了（2026-10-04）melodyPart.ts 汎用化                                                 |
| T5  | 連符の括弧の位置計算（拍の x と符尾の先から、括弧の線・数字の位置。段をまたがない前提）                                                                                                                                                                                                                                                                                           | src/lib/tupletLayout.ts, tupletLayout.test.ts                                                                         | —                     | `src/lib/tupletLayout.test.ts`                                                                                                                                                                     | sonnet | 完了（2026-10-04）tupletLayout.ts                                                      |
| T6  | ドラムのモデル: 型、`sortHits`、`toggleHit`（HH/HO 排他）、`setArticulation`（ゴースト/アクセント排他）、`normalizeDrums`（小節またぎの拍を打つ拍＋休符に、対応表つき、連符は分けない）、`drumBars`、サブセットの仕様コメント、golden data                                                                                                                                        | src/lib/drum.ts, drum.test.ts, src/lib/fixtures/drumFixtures.ts                                                       | T1, T2, T3            | `src/lib/drum.test.ts`                                                                                                                                                                             | opus   | 完了（2026-10-04）drum.ts・drumFixtures.ts                                             |
| T7  | メロディの連符: `MelodyEvent.tuplet`、`splitAtBars`/`BarPiece` の連符対応、仕様コメント更新、`serializeMelody` の `tu`、`parseMelody`（連符の組み立て・検証、`.N{tu}`）、`mergeRests` の除外、既存の「連符は読み取り専用」テストの書き換え、AlphaTexImporter での照合、fixture 追加                                                                                               | src/lib/melody.ts, melodyTex.ts, melodyParse.ts（各 .test.ts）, src/lib/fixtures/melodyFixtures.ts, roundTrip.test.ts | T1, T2                | `src/lib/melody.test.ts src/lib/melodyTex.test.ts src/lib/melodyParse.test.ts src/lib/roundTrip.test.ts`（M4 の既存分がすべて通ること）                                                            | opus   | 完了（2026-10-04）melody.ts/melodyTex.ts/melodyParse.ts の連符対応                     |
| T8  | `TupletPicker`: 「連符」ボタン＋ポップオーバー（3・5・6・7・その他 → 数の入力と検証メッセージ）、「連符を削除」、押しても五線のフォーカスを外さない（選んだ後は `onDone` で五線へフォーカスを戻せる）                                                                                                                                                                             | src/components/TupletPicker/*                                                                                         | T2                    | `npx vitest run --project storybook src/components/TupletPicker`（その他に 4・16・abc を入れたときのエラー、Esc で閉じる、a11y）                                                                   | sonnet | 完了（2026-10-04）TupletPicker                                                         |
| T9  | `DrumPads`: 9 楽器のボタン（キーのヒント付き、五線の位置順）、クリック = 入力、Shift＋クリック = 直前の拍に足す／外す、`onMouseDown` で preventDefault（`PianoKeyboard` と同じ）                                                                                                                                                                                                  | src/components/DrumPads/*                                                                                             | T3                    | `npx vitest run --project storybook src/components/DrumPads`                                                                                                                                       | sonnet | 完了（2026-10-04）DrumPads                                                             |
| T10 | `MelodyEditor` から共通部品を切り出す: `SectionPartBar`（セクション選択・パート選択・名前変更）、`SectionNotice`（読み取り専用の通知・テキスト入力へのボタン・小節の引き直しの確認）、`ModeStatus`（入力中／選択中＋「入力に戻る」）。メロディの見た目・動作は変えない                                                                                                            | src/components/SectionPartBar/_, SectionNotice/_, ModeStatus/_, src/components/MelodyEditor/_                         | —                     | 新しい 3 部品のストーリー＋`npx vitest run --project storybook src/components/MelodyEditor`（既存のストーリーがすべて通ること）                                                                    | sonnet | 完了（2026-10-04）SectionPartBar/SectionNotice/ModeStatus 切り出し                     |
| T11 | `serializeDrums(events, shuffle, ts)`（`\tf` 行、小節線、`:N`、同時打ち、音・拍の効果、連符）＋ AlphaTexImporter で拍・音・効果・連符の比率・`tripletFeel` を照合                                                                                                                                                                                                                 | src/lib/drumTex.ts, drumTex.test.ts                                                                                   | T6                    | `src/lib/drumTex.test.ts`                                                                                                                                                                          | sonnet | 完了（2026-10-04）drumTex.ts                                                           |
| T12 | `parseDrums` / `parseDrumsIgnoringBars`（厳密、読み取り専用の書き方 15 種以上、`.N`、別名の `\tf`、楽器の並べ替え）と T11 との往復                                                                                                                                                                                                                                                | src/lib/drumParse.ts, drumParse.test.ts, drumRoundTrip.test.ts                                                        | T6（往復は T11 後）   | `src/lib/drumParse.test.ts src/lib/drumRoundTrip.test.ts`                                                                                                                                          | opus   | 完了（2026-10-04）drumParse.ts・drumRoundTrip.test.ts                                  |
| T13 | `keyToDrumCommand` / `applyDrumCommand`: 入力・選択モード、Shift＋キー、埋める動作、Backspace の休符化・連符ごと削除、連符の挿入・削除、音価・付点、ゴースト・アクセント（「最後の楽器」）、`normalizeDrums` 後のカーソル補正、受け付けない操作の理由（`message`）                                                                                                                | src/lib/drumInput.ts, drumInput.test.ts                                                                               | T2, T6                | `src/lib/drumInput.test.ts`（各操作 × 入力/選択/連符の中/先頭 の組み合わせ、同じ配列を返す恒等性）                                                                                                 | opus   | 完了（2026-10-04）drumInput.ts                                                         |
| T14 | `layoutDrums`: 打楽器の五線、楽器ごとの位置・符頭（×・○付き×・太い×）、符尾上向き・旗、休符、付点、ゴーストの括弧、アクセント、連符の括弧（T5）、シャッフル表記、小節線、段組み、カーソル、当たり判定（拍の列・高さ → 楽器）、ホバー表示                                                                                                                                          | src/lib/drumLayout.ts, drumLayout.test.ts                                                                             | T3, T5, T6            | `src/lib/drumLayout.test.ts`                                                                                                                                                                       | opus   | 完了（2026-10-04）drumLayout.ts                                                        |
| T15 | メロディの連符の編集: `applyCommand` に連符の挿入・削除、埋める動作、Backspace の休符化、音価キーの拒否、`groupsFitBars` による拒否と理由、歌詞の流し込み                                                                                                                                                                                                                         | src/lib/melodyInput.ts, melodyInput.test.ts, melodyLyrics.ts, melodyLyrics.test.ts                                    | T7                    | `src/lib/melodyInput.test.ts src/lib/melodyLyrics.test.ts`                                                                                                                                         | opus   | 完了（2026-10-04）melodyInput.ts/melodyLyrics.ts の連符対応                            |
| T16 | 入力用の五線（メロディ）の連符: 連符の拍の間隔（実際の長さで）、括弧と数字（T5）、カーソル・当たり判定が連符でも正しいこと                                                                                                                                                                                                                                                        | src/lib/staffLayout.ts, staffLayout.test.ts                                                                           | T5, T7                | `src/lib/staffLayout.test.ts`                                                                                                                                                                      | opus   | 完了（2026-10-04）staffLayout.ts（段の高さ修正含む）                                   |
| T17 | `drumParts` / `ensureDrumPart` / `readDrumSection` / `writeDrumSection` / `reflowDrumSection`（T4 の汎用版の上に、シャッフルも含めて）、冒頭の `\articulation` の再定義を読み取り専用に                                                                                                                                                                                           | src/lib/drumPart.ts, drumPart.test.ts                                                                                 | T4, T11, T12          | `src/lib/drumPart.test.ts`（サンプル曲のドラムがそのまま読めること、範囲外の本文が 1 バイトも変わらないこと）                                                                                      | sonnet | 完了（2026-10-04）drumPart.ts                                                          |
| T18 | `DrumStaff`: SVG、ホバーで半透明の符頭、クリックで挿入・足す・選択、カーソル、選択表示、`liveMessage` を受け取る、キーは `onKeyDown` で親へ。必要ならトークン追加                                                                                                                                                                                                                 | src/components/DrumStaff/*, src/theme.css                                                                             | T13, T14              | `npx vitest run --project storybook src/components/DrumStaff` ＋ Playwright のスクリーンショット（`docs/m5-t18-staff.png`）                                                                        | opus   | 完了（2026-10-04）DrumStaff、docs/m5-t18-staff.png                                     |
| T19 | ドラムの読み上げ文: 拍の説明（「8分 ハイハット＋バスドラム」「3連の 2 つ目」）、状態変化、拒否の理由                                                                                                                                                                                                                                                                              | src/lib/drumLabels.ts, drumLabels.test.ts                                                                             | T13                   | `src/lib/drumLabels.test.ts`                                                                                                                                                                       | sonnet | 完了（2026-10-04）drumLabels.ts                                                        |
| T20 | メロディの画面に連符を組み込む: `TupletPicker` を入力欄に、受け付けない操作の理由を表示・読み上げ、`MelodyStaff` に括弧を描く、連符の枠の読み上げ（labels）                                                                                                                                                                                                                       | src/components/MelodyEditor/_, src/components/MelodyStaff/_                                                           | T8, T10, T15, T16     | `npx vitest run --project storybook src/components/MelodyEditor src/components/MelodyStaff` ＋ `src/components/MelodyStaff/labels.test.ts` ＋スクリーンショット（`docs/m5-t20-melody-tuplet.png`） | sonnet | 完了（2026-10-04）MelodyEditor/MelodyStaff の連符組み込み                              |
| T21 | `DrumEditor`: セクション・パート（T10 の部品）、通知、入力欄（DurationBar・TupletPicker・ゴースト/アクセント・シャッフル）、モード表示、`DrumStaff`、`DrumPads`、確認用 `PartScore`、live 領域 1 つ、セクション×パートごとのカーソル状態、`onChange(song)` を操作 1 回につき 1 回                                                                                                 | src/components/DrumEditor/*                                                                                           | T8, T9, T10, T17〜T19 | `npx vitest run --project storybook src/components/DrumEditor` ＋スクリーンショット（`docs/m5-t21-editor.png`）                                                                                    | opus   | 完了（2026-10-05）DrumEditor、docs/m5-t21-editor.png                                   |
| T22 | App に組み込む（ドラムタブ、`onRequestTextEdit` も同じように）、App のテスト・ストーリー更新                                                                                                                                                                                                                                                                                      | src/App.tsx, App.test.tsx, App.stories.tsx                                                                            | T21                   | `npx vitest run --project unit src/App.test.tsx` ＋ `npx vitest run --project storybook src/App.stories.tsx`                                                                                       | sonnet | 完了（2026-10-05）App.tsx にドラムタブ組み込み                                         |
| T23 | e2e（ドラム: キーで 8 ビート → Shift＋F で同時打ち → 3連を作って埋める → シャッフル 8分 → テキスト入力で `\tf triplet8th`・`{tu 3}` を確認 → 再読み込み。メロディ: 3連を入れてテキストを確認）、**全検証を 1 回**、ドキュメント更新（CLAUDE.md の構成・gotcha、requirements の M5、本書の実績）                                                                                   | e2e/drums.spec.ts, e2e/melody.spec.ts, CLAUDE.md, docs/requirements.md, docs/m5-plan.md                               | T20, T22              | 全部: `npm test`、`npx tsc -b`、`npm run lint`、`npm run build`、`npm run test:storybook`、`npm run e2e`、`npx prettier --check .` ＋スクリーンショット（`docs/m5-app-drums.png`）                 | sonnet | 完了（2026-10-05）e2e・全検証・ドキュメント更新（本章末尾の実績参照）                  |
| T24 | 独立レビュー（M4 と同じ観点＋連符のグループが壊れる経路、シャッフルの持ち越し、ドラムのキーとブラウザのショートカットの衝突、alphaTab と入力用五線の位置の一致）→ `docs/m5-review.md`                                                                                                                                                                                             | docs/m5-review.md                                                                                                     | T23                   | 必要に応じて対象だけ                                                                                                                                                                               | opus   | 完了（2026-10-05、docs/m5-review.md。R1〜R4・R6・R8〜R10 修正、R5 現状維持、R7 は M6） |

### 共通 API（並行作業の前提として先に固定する）

```ts
// src/lib/tuplet.ts（T2）
export interface TupletMark {
  n: number;
  slot: number;
} // slot 0..n-1
export interface Timed {
  ticks: number;
  tuplet?: TupletMark;
}
export const TUPLET_PRESETS: readonly number[]; // [3, 5, 6, 7]
export const TUPLET_UNITS: readonly Duration[]; // ['2','4','8','16','32']
export function isValidTupletN(n: number): boolean; // 3..15, 4・8 を除く
export function tupletDen(n: number): number; // n 未満の最大の 2 のべき乗
export function tupletTex(n: number): string; // 'tu 3' | 'tu 13 8'
export function parseTupletItem(
  args: string[],
): { n: number } | { error: string };
export interface TupletGroup {
  start: number;
  end: number;
  n: number;
  unitTicks: number;
  span: number;
}
export function tupletGroups(
  events: readonly Timed[],
): TupletGroup[] | { error: string };
export type Atom =
  | { kind: 'single'; index: number; ticks: number }
  | { kind: 'group'; group: TupletGroup };
export function atoms(events: readonly Timed[]): Atom[]; // 壊れたグループは RangeError
export function groupAt(
  events: readonly Timed[],
  index: number,
): TupletGroup | null;
export function fillZone(
  events: readonly Timed[],
  cursor: number,
  isRest: (i: number) => boolean,
): TupletGroup | null;
export function insertGroup<T extends Timed>(
  events: readonly T[],
  at: number,
  n: number,
  unit: Duration,
  makeRest: (ticks: number, mark: TupletMark) => T,
): T[] | { error: string };
export function removeGroup<T extends Timed>(
  events: readonly T[],
  index: number,
): { events: T[]; start: number };
export function groupsFitBars(
  events: readonly Timed[],
  barTicks: number,
): { ok: true } | { ok: false; error: string };
export function slotOffset(group: TupletGroup, slot: number): number; // 連符の先頭からの実際の位置（小数）

// src/lib/drumKit.ts（T3）
export type DrumInstrument =
  'CR' | 'RD' | 'HH' | 'HO' | 'T1' | 'SD' | 'T2' | 'FT' | 'BD';
export interface DrumKitEntry {
  id: DrumInstrument;
  midi: number;
  name: string;
  code: string;
  step: number;
  head: 'normal' | 'x' | 'circleX' | 'heavyX';
}
export const DRUM_KIT: readonly DrumKitEntry[]; // 五線の上から順

// src/lib/drum.ts（T6）
export interface DrumHit {
  inst: DrumInstrument;
  ghost?: true;
  accent?: 'normal' | 'heavy';
}
export interface DrumEvent {
  hits: DrumHit[];
  ticks: number;
  tuplet?: TupletMark;
}
export type Shuffle = 'none' | '8' | '16';
```

## 波

1. T1, T2, T3, T4, T5
2. T6, T7, T8, T9, T10
3. T11, T12, T13, T14, T15, T16（T12 の往復テストは T11 の完了後に実行）
4. T17, T18, T19, T20
5. T21 → T22 → T23 → T24

ファイルの重なりの確認: `MelodyEditor` は T10（波 2）と T20（波 4）、`melodyPart.ts` は T4 のみ、`partsToAlphaTex.ts` は T3 のみ、`theme.css` は T18 のみ、`App.tsx` は T22 のみ、`CLAUDE.md`・`requirements.md` は T23 のみ。

## 検証の進め方

- 各タスクは「テスト」列のコマンドと `npx tsc -b`・対象ファイルの oxlint / prettier だけを実行し、結果（変更ファイル・テスト件数・未解決の点）を短く報告する。全体の `npm test`・`npm run test:storybook`・`npm run e2e` は T23 で 1 回だけ。
- 描画の確認（T18・T20・T21・T23）はコンテナ内の Playwright（Storybook のストーリー、または dev サーバー）でスクリーンショットを撮り、`docs/` に保存する。jsdom では見た目を判断しない。
- alphaTex の正しさは、書き出しの単体テストで必ず `AlphaTexImporter` に通して確かめる（拍数・音価・`hasTuplet`・`tupletNumerator/Denominator`・`isGhost`・`accentuated`・`MasterBar.tripletFeel`）。
- Storybook の `userEvent.keyboard` は `e.code` が付かない文字があるので `[Semicolon]`・`[Period]` のように書く（CLAUDE.md の gotcha）。Shift＋キーは `{Shift>}[KeyF]{/Shift}`。

## 確認したい点（ユーザーへの質問）

1. **ゴースト・アクセントのキー**: 決まっているのはボタンだけ。キー案は **S = ゴースト（付ける／外す）、A = アクセント（なし → アクセント → 強いアクセント → なし の順に切り替え）**。対象は直前（選択中）の拍の、最後に入力またはクリックした楽器。強いアクセント（`^`）も入れるかどうかも含めて → **推奨: この案どおり（強いアクセントも入れる。alphaTab で見分けられることを確認済み）**。
2. **連符が小節線をまたぐことになる操作**: 連符より前に音を足す・消すと、後ろの連符がずれて小節線をまたぐことがある。連符は小節線で分けて書けないので、(a) その操作を受け付けず理由を表示する、(b) 自動で休符を足して連符を次の小節の頭へ送る、のどちらか → **推奨: (a)**（勝手に休符が増えるより分かりやすい。直すには連符の前で休符を足す／消す）。
3. **「その他」の連符の数の範囲**: 3〜15（4・8 を除く）を提案。9〜15 連符は 32分音符を単位にすれば 4分音符 1 つ分に入る → **推奨: 3〜15**。
4. **長さの違う音が混ざる連符**（メロディの「4分＋8分」の 3連など）: M5 は「同じ長さの音 N 個」の連符だけを扱い、混ざったものはテキスト入力で書けば表示はされるが、メロディ画面では読み取り専用になる → **推奨: M5 では対応しない**（必要になったら後で追加）。
5. **ドラムの拍が小節線をまたいだとき**: 途中に拍を足して後ろがずれると、小節線をまたぐ拍が出る。ドラムはタイを使わないので、**小節線で「打つ拍＋休符」に分ける**。後で拍を消しても元の 1 拍には戻らない → **推奨: これでよい**（ドラムは頭から順に入力することが多いため）。
6. **マウスでの同時打ち**: 既にある拍の真上（同じ列）で別の楽器の高さをクリックしたら、新しい拍を挿入せずにその拍に楽器を足す → **推奨: そうする**（キーの Shift＋楽器と同じ結果をマウスでも得られる）。
7. **6/8 などの複合拍子の 2連・4連**、**32分音符の入力**: M5 では扱わない（連符は「N 個を 2 のべき乗の長さに」だけ、入力できる音価はメロディと同じ全〜16分） → **推奨: どちらも M5 では見送り**。

### 回答（2026-10-04）

- 1〜6: すべて推奨どおり。
- 7: M5 では見送り。今後の課題として docs/requirements.md の「MVP 後に回すもの」に記録した。

## 実績

（各タスクの完了時に追記する）

- **T2（2026-10-04 完了）**: `src/lib/tuplet.ts`・`tuplet.test.ts`（80 件）。共通 API は計画どおり。後続タスク向けの細かい仕様:
  - `TupletGroup.end` は含まない（`start + n`）。`fillZone` は `start < cursor < end`、または `cursor === start` で全部休符のとき。
  - 壊れたグループがあると `atoms`・`groupAt`・`fillZone`・`insertGroup`・`removeGroup` は RangeError。エラーを返すのは `tupletGroups`・`groupsFitBars` だけ。`removeGroup` は連符の外の index で RangeError（先に `groupAt`）。
  - `insertGroup` は小節の検証をしない（呼び出し側で `groupsFitBars`）。`slotOffset` は slot 0〜n（n は終端）。
  - `TUPLET_UNITS` に '32' を含む。32分を入力させないのは UI 側で絞る。
  - **循環 import 注意**: `tuplet.ts` は `melody.ts` の `DURATION_TICKS`・`Duration` を値で使う（モジュール初期化時の `UNIT_TICKS` も）。T7 で `melody.ts` から `tuplet.ts` を参照するときは `import type` にする。値が必要なら `UNIT_TICKS` を関数内計算に変える。
- **T4（2026-10-04 完了）**: `melodyPart.ts`（テスト 86 件、既存は無変更で通過）。汎用 API: `SectionCodec<E> { parse(body, ts); parseIgnoringBars(body) }` → `SectionParseResult<E>`、`readSectionWith(body, label, ts, codec)`、`writeSectionText(body, label, tex, chartOrder)`（読み取り専用チェックなし、呼び出し側で先に `readSectionWith`）、`reflowSectionWith(body, label, ts, chartOrder, codec, serialize)`。codec は `E[]` しか返さないので、T17 でシャッフル（`\tf`）も扱うときは codec 側で吸収するか形を調整する。
- **T5（2026-10-04 完了）**: `src/lib/tupletLayout.ts`（テスト 19 件）。`layoutTupletBracket({ n, xs, tipYs, side, staffSpace })` → `{ line: LineSegment[4], number: { text, x, y } }`。括弧は水平 1 本（最も外側の符尾から 1 staff space 離す）、数字は Bravura U+E880〜E889。`side` の決定（メロディで符尾の向きが混ざる場合）と、全部休符の連符の `tipYs` は呼び出し側（T14・T16）が決める。
- **T1（2026-10-04 完了）**: findings §8・`docs/m5-t1-check.png`。計画の前提はすべて確認できた（連符と音・拍の効果の組み合わせ、同じ N の連符が続くときは別の括弧、`\section` 直後の `\tf` は安全、`\tf none` で表記が切り替わる）。T1=50・T2=48・FT=41 で staffLine は CR -2, RD 0, HH/HO -1, T1 1, T2 2, SD 3, FT 5, BD 7 → `DRUM_KIT.step = 8 − staffLine`。T23 で CLAUDE.md に「`\tf` の後の最初の拍にも `:N` が要る」を追記する（findings §8.5）。
- **T3（2026-10-04 完了）**: `src/lib/drumKit.ts`（`DRUM_KIT` は共通 API どおり＋`drumKitEntry(id)`（無ければ例外）・`drumKitEntryForCode(code)`）、`DRUM_ARTICULATIONS` を T1=50・T2=48 に変更。テスト 17 件。step: CR10・HH9・HO9・RD8・T1 7・T2 6・SD5・FT3・BD1、符頭 CR=heavyX・HH/RD=x・HO=circleX・他=normal。設計判断 3 の並び順の誤記（RD と SD の位置）を `DRUM_KIT` の順（step の降順）に直した。
- **T8（2026-10-04 完了）**: `src/components/TupletPicker/*`（ストーリー 8 件）。props: `onInsert(n)`・`onRemove()`・`canRemove`・`disabled?`・`onDone()`（`onInsert`/`onRemove` の直後に同期で呼ぶ。親が五線へフォーカスを戻す）。挿入・削除してよいか（`insertGroup`/`removeGroup`/`groupsFitBars`）の判定と、拒否理由の表示・読み上げは呼び出し側（T20・T21）。Esc では `onDone` を呼ばない。
- **T9（2026-10-04 完了）**: `src/components/DrumPads/*`（ストーリー 3 件）。props: `onInput(inst)`・`onToggleOnPrevious(inst)`・`disabled?`。キー表示は e.code から（`KeyF`→F、`Semicolon`→;）。ストーリーの Shift＋クリックは `userEvent` では `shiftKey` が付かないので `fireEvent.click(el, { shiftKey: true })` を使う → T23 で CLAUDE.md の gotcha に追記する。
- **T7（2026-10-04 完了）**: メロディの連符を編集可能に（対象テスト 463 件、tsc 全体 0 エラー）。`MelodyEvent.tuplet?: { n, slot }`（`ticks` は書かれた音価、グループの実長 = `tupletDen(n) × ticks`）、`totalTicks(events)` 追加、`splitAtBars`・`serializeMelody` は壊れたグループや小節またぎの連符で RangeError（日本語メッセージ）。効果の順 `d t tu lyrics ch slur`、13〜15 連は `tu N 8`。`mergeRests` は連符の中・前後を結合しない。`.N{d}` / `.N{tu N}` を受け付けるようになった。`tuplet.ts` の `UNIT_TICKS` を関数内計算に変更（循環 import 対策）。書き換えたテスト: 読み取り専用の表の連符 1 件 → 読み取り専用 17 件＋受け付ける describe、`.N followed by {d}` を受け付けに。
  - T15 向け: 編集結果は先に `groupsFitBars` で確かめる（`serializeMelody`/`splitAtBars` は例外を投げる）。`mergeRests` の対応表は連符部分では 1 対 1。
  - T16 向け: 連符の `piece.ticks` は書かれた音価。`staffLayout.ts` の `spring(piece.ticks)` と 394 行目付近の小節が埋まったかの判定（`=== barSize`）は実長（`slotOffset` か `totalTicks`）に直す。連符の event は常に piece 1 つ。
- **T6（2026-10-04 完了）**: `src/lib/drum.ts`・`drum.test.ts`（82 件）・`fixtures/drumFixtures.ts`。共通 API に加えて `SHUFFLE_TEX`、`Articulation`（none/ghost/accent/heavy）と `articulationOf(hit)`、`isDrumRest`、`hasHit`、`isValidDrumTicks`、`DrumBar { start, end(含まない), ticks }`。
  - `toggleHit` は最後の 1 つを外すと休符。`setArticulation` は楽器が無ければ `ev` をそのまま返す。S/A キーの切り替えは T13 が `articulationOf` で組み立てる。
  - `normalizeDrums(events, ts)` → `{ events, map }`（変更なしなら同じ配列）。カーソル c は `c < len ? map[c] : 新しい長さ`。連符が小節をまたいでも例外にしない → T13 は必ず `groupsFitBars` で拒否する。`drumBars` は小節またぎで RangeError。
  - 仕様コメント（drum.ts 先頭）: 拍なし = `''`、拍があれば 1 行目は必ず `\tf <値>`（none も）、`SD{g tu 6}`・`(HH SD{g}){tu 3}`・`r{d}`。`SD{tu 3}.8` と `HH{}` は読み取り専用。
  - fixtures: `drumFixtures` 11 件（T11: `serializeDrums(events, shuffle, ts) === tex`）、`drumReadVariants` 3 件（T12: `parseDrums(tex, ts)` → `{ events, shuffle }`、書き直し後 `canonical`）。
- **T10（2026-10-04 完了）**: `SectionPartBar`・`SectionNotice`・`ModeStatus` を切り出し、`MelodyEditor` はそれを使う形に（ストーリー 29 件、MelodyEditor の既存 17 件は無変更で通過、App 単体 17 件）。
  - `SectionPartBar`: `sectionOptions`・`sectionLabel`・`onSectionLabelChange`・`partNames`・`partOrdinal`・`onPartOrdinalChange`・`partName?`（未作成なら `noPartHint` を表示）・`noPartHint`・`onRenamePart(name) → エラー文字列 | undefined`。
  - `SectionNotice`: `{ id, status: 'readonly', reason, onRequestTextEdit? }` | `{ id, status: 'barMismatch', reason, timeSigLabel, onReflow }`。
  - `ModeStatus`: `readOnly`・`selected`・`unit`（ドラムは `"拍"`）・`onClearSelection`。
  - 文言（「拍子が変わったため小節が合いません」・パート・セクション）はドラムでも同じ前提。違える場合は T21 で prop を足す。
- **T16（2026-10-04 完了）**: `staffLayout.ts`（テスト 49 件）。連符の枠の実長 `real = ticks × tupletDen(n) / n` で間隔と小節が埋まったかの判定（誤差 1e-6）。T20 向け: `layout.tuplets: LayoutTuplet[]` = `{ start, end(含まない), n, system, side, line: LineSegment[4], number: { text, x, y } }`、線の太さは `layout.thickness.tuplet`、テスト id は `start` で。side は「符尾が下向きの音が過半数で、歌詞の付いた音がないときだけ下」。T20 で見た目を確認する点: 下に置いた括弧が五線のかなり下まで下がる場合、高い音を上で避けて段の上端からはみ出す場合（クランプなし）。`layoutMelody` は event をオブジェクトの同一性で区別する（同じオブジェクトを使い回さない）。
- **T12（2026-10-04 完了）**: `drumParse.ts`（テスト 95 件）・`drumRoundTrip.test.ts`（14 件、T11 の完了後に実行して通過）。`parseDrums(body, ts)` / `parseDrumsIgnoringBars(body)` → `{ ok: true, events, shuffle } | { ok: false, reason }`（そのまま `SectionCodec<DrumEvent>` に使える。シャッフルは `readSectionWith` が返さないので T17 で取り出す）。drum.ts の仕様に加えた読み取り専用: `"` やコメント、`\tf` の重複・不明な値、括弧内の `.N`・拍の効果、効果の重複、`{}` 2 組、`:1` 単位の連符、未知の楽器名、空の小節など。T17 向け: 拍のない本文でも `\tf` の値を返す（書き出すと `''`）。`parseDrumsIgnoringBars` の結果は reflow で `normalizeDrums`・`groupsFitBars` に通す。
- **T15（2026-10-04 完了）**: `melodyInput.ts`（126 件）・`melodyLyrics.ts`（51 件）。Command に `{ type: 'insertTuplet'; n }`・`{ type: 'removeTuplet' }`（キー割り当てなし、TupletPicker から送る）。`CommandContext.ts?` を渡すと小節をまたぐ連符になる操作を拒否。`CommandResult.message?`（拒否時は events/state を `===` のまま返す）。`tupletAtCursor(events, state)` → 削除対象の連符 or null。melodyLyrics に `replaceNote`・`deleteRange`。
  - T15 が決めた細かい動き（ユーザー確認の候補）: 選択モードで「連符」を押すと選択を外して選んだ拍の後ろに挿入／埋める動作で音を別の音に置き換えたら歌詞は残す／全部休符の連符の先頭での Backspace は連符を消す（直前の音を消すには Enter で選択してから）。
- **T11（2026-10-04 完了）**: `drumTex.ts`（テスト 26 件、fixtures 11 件と完全一致・AlphaTexImporter で照合）。`serializeDrums(events, shuffle, ts)`。入力は `normalizeDrums` 済み・`DRUM_KIT` 順が前提。小節またぎは `drumBars` の RangeError がそのまま出る（メッセージが英語 — 画面には T13 が `groupsFitBars` で先に止めるので出ない想定。T24 で確認）。
- **T13（2026-10-04 完了）**: `drumInput.ts`（テスト 113 件、仕様は先頭コメント）。`DrumEditorState { cursor, selected, duration, dotted, lastInst }`、`DrumCommand`（instInput / toggleOnPrevious / rest / setDuration / toggleDot / toggleGhost(S) / cycleAccent(A) / moveLeft / moveRight / deleteBackward / selectBefore / clearSelection(Esc も keyToDrumCommand で) / select{index, inst?} / placeAt{index, inst} / addAt{index, inst} / insertTuplet{n} / removeTuplet）、`applyDrumCommand(events, state, cmd, { ts }) → { events, state, message? }`、`keyToDrumCommand(e)`、`initialDrumEditorState(events)`（末尾・8分）、`tupletForRemoval(events, state)`（canRemove 用）、`MESSAGES`。拒否時は同じ配列・状態＋日本語 `message`。
  - T13 が決めた細かい動き（ユーザー確認の候補）: 全部休符の連符の先頭で Backspace → 連符ごと削除／`addAt` 後はクリックした拍が「直前の拍」になり S/A が効く（既にある楽器は外さない）／S/A の対象は「最後の楽器」→ 無ければ楽器が 1 つの拍ならそれ → それ以外は拒否（複数楽器の拍をキーだけで選ぶと S/A できない。T21 で要検討）／`placeAt` が連符の中なら枠を置き換え／初期の音価は 8分。
- **T14（2026-10-04 完了）**: `drumLayout.ts`（テスト 31 件）。`layoutDrums(events, ts, { width, staffSpace?, shuffle? })` → `DrumLayout { width, height, staffSpace, fontSize, thickness, systems[], beats[], tuplets[], shuffle?, cursors[] }`（詳細は drumLayout.ts、グリフは `DRUM_GLYPHS`）。当たり判定 `hitTestDrums(layout, x, y)` → `head{event, inst}`（選択）| `column{event, inst, rest}`（その拍に楽器を足す＝Q6）| `insert{cursor, inst}`。`yToInstrument`・`instrumentY`・`drumSystemAt`・`nearestDrumCursor`・`previewDrum(layout, target, { d, dotted })`。
  - アクセントは拍ごとにまとめて表示（どの楽器に付いたかは見分けない、alphaTab と同じ）。Shuffle 表記の見た目は T18 のスクリーンショットで確認。拍のないセクションでも shuffle ≠ none なら表示。
  - **決定（2026-10-04）**: 休符の列のクリックは「楽器を足す」（休符が打つ拍になる。連符の枠を埋めるのと同じ感覚）。休符の選択はキーボード（Enter・←→）だけ。ユーザーの手動テストで違和感があれば見直す。
- **T19（2026-10-04 完了）**: `drumLabels.ts`（テスト 30 件）。`instrumentLabel`・`hitsLabel`・`durationLabel`・`tupletSlotLabel`（「3連の 2 つ目」）・`beatLabel`・`describeBeat`（「1 拍目: 8分 スネア」）・`announcement(events, cursor, selected)`・`stateChangeMessage(before, after)`・`shuffleMessage`・`tupletInsertedMessage(n)`・`tupletRemovedMessage()`・`toggleOnPreviousMessage(inst, before, after)`・`rejectionMessage(message?)`。HH/HO は正式名「ハイハット（クローズ）」のまま読む（長ければ手動テストで見直す）。T21 は `result.message ?? 個別の文 ?? stateChangeMessage ?? announcement` の順で live 文を決める。
- **T17（2026-10-04 完了）**: `drumPart.ts`（テスト 26 件）。`drumParts(song)`・`ensureDrumPart(song, name?) → { song, partIndex }`・`readDrumSection(body, label, ts)` → missing | readonly | barMismatch{events, shuffle, reason} | ok{events, shuffle}・`writeDrumSection(body, label, events, shuffle, ts, chartOrder)`（読み取り専用・barMismatch は日本語で throw）・`reflowDrumSection(body, label, ts, chartOrder)`（連符が新しい小節線をまたげば日本語で throw）。シャッフルは同じセクションを `parseDrumsIgnoringBars` でもう一度読んで取り出す。拍のないセクションに書くとシャッフルは消える（拍ができるまでシャッフル選択は無効）。パート冒頭の `\articulation` 再定義（既定と違う番号）はパート全体を読み取り専用に。
- **T18（2026-10-04 完了）**: `src/components/DrumStaff/*`（ストーリー 12 件）・`docs/m5-t18-staff.png`。props: `events`・`ts`・`shuffle?`・`state`（DrumEditorState をそのまま）・`readOnly?`・`onCommand(cmd)`・`onKeyDown(e)`（Esc も含め全部親へ）・`liveMessage?`・`width?`・`ariaLabel`。クリック: head → select、column → addAt（休符の列も）、insert → placeAt。Shift＋クリックは普通のクリックと同じ（クリックした拍の楽器を外すコマンドが無いため。外すのは選択してからパッド／キー）。カーソルは入力モードのときだけ表示。スクリーンショットは良好。drumLayout.ts の修正 2 件（付点が旗に重なる、Shuffle 表記の「=」が右の図に近い）は T14 の担当に依頼。最後の小節線は 1 本線。
- **T20（2026-10-04 完了）**: MelodyEditor に TupletPicker、`applyCommand` に `ts` を渡す（小節をまたぐ連符で例外になっていたのを修正）、拒否理由の表示と読み上げ、MelodyStaff に括弧と数字、labels に「3連の 2 つ目」（ストーリー 39 件・単体 19 件）。`docs/m5-t20-melody-tuplet.png`。**不具合**: 極端な高音を含む連符の括弧を上に置くと、括弧が段の上端より上（y<0）に出て viewBox で切れて見えなくなる → `staffLayout.ts` の段の高さに括弧の分を入れる修正を T16 の担当に依頼。
- **表示の修正（2026-10-04）**: `staffLayout.ts` — 括弧がはみ出す段だけ上の余白を足す（段の高さは段ごとに違ってよい、各段の `top` は積み上げ、テスト 50 件）。`drumLayout.ts` — 旗の付いた付点は旗の右端の外に 1 列でそろえる、Shuffle 表記の「=」の後ろの間隔を広げた（テスト 33 件、`docs/m5-t18-staff.png` 撮り直し済み）。
- **T21（2026-10-04 完了）**: `src/components/DrumEditor/*`（ストーリー 11 件）・`docs/m5-t21-editor.png`。props: `song`・`onChange(song)`（操作 1 回につき 1 回）・`onRequestTextEdit?`。ドラムのパートが無ければ最初の入力で作る。シャッフルは拍が無いあいだ押せない。パッドは広い画面で五線の右、狭い画面で下。複数楽器の拍で S/A が決まらないときは拒否のまま（Shift＋キー 2 回でその楽器が「最後の楽器」になる）。状態を保存していないセクションでカーソルが末尾に飛ぶ不具合を直した → MelodyEditor の `setState` にも同じ形があるので確認を依頼。2 段目が 1 小節だけ横いっぱいに引き伸ばされる見え方 → drumLayout の段の割り振りの見直しを依頼。
- **表示の修正 2（2026-10-05）**: `drumLayout.ts` — 段の数は最小のまま、最後以外の段の埋まり具合がそろうように小節を振り分け直す（`breakSystems(widths, availOf)`）。最後以外の段の引き伸ばしは自然な幅の 1.5 倍（`MAX_STRETCH`）までで、それを超えるときは左寄せ（右に余白が残る）。テスト 38 件、DrumStaff・DrumEditor のストーリー 23 件。`docs/m5-t21-editor.png` 撮り直し済み。
- **T22（2026-10-05 完了）**: `App.tsx` のドラムタブを `DrumEditor` に（メロディと同じ配線、`soon` ヘルパーと `.soon*` CSS を削除）。App 単体 19 件（ドラム 2 件追加: キー入力でテキストが変わり自動保存も効く／読み取り専用の通知からテキスト入力へ）、App ストーリー 5 件（`DrumsTab` 追加）。
- **MelodyEditor の確認（2026-10-05）**: 保存していないセクションの状態でカーソルが末尾に飛ぶ不具合は、今の操作では起きないことを確認。将来のために DrumEditor と同じガード（最初の操作で必ず状態を保存）を入れ、回帰テストのストーリー `FirstOperationPersistsCursor` を追加（ストーリー 40 件）。
- **T23（2026-10-05 完了）**: `e2e/drums.spec.ts`（新規）・`e2e/melody.spec.ts`（連符のテストを追加）。全検証を 1 回実施、結果はすべて成功（修正はテストファイル自身の prettier フォーマットのみ、アプリコードの修正なし）:
  - `npm test`: 38 ファイル・1523 件 成功。
  - `npx tsc -b`: エラー 0。
  - `npm run lint`（oxlint）: 141 ファイルで警告・エラー 0。
  - `npm run build`: 成功（1,531 kB チャンクの警告のみ、既存・対象外）。
  - `npm run test:storybook`: 26 ファイル・186 件 成功（`EasyEditor`・`SongInfoPopover` ストーリーに既存の act 警告2件、テスト自体は成功・対象外）。
  - `npm run e2e`: 5 ファイル 5 件 成功（`drums.spec.ts` 1 件、`melody.spec.ts` 2 件、`editor.spec.ts`・`smoke.spec.ts` 各 1 件）。
  - `npx prettier --check .`: 初回 `e2e/drums.spec.ts` が未整形 → `npx prettier --write` で修正、再チェックで全ファイル適合。
  - `e2e/drums.spec.ts`: ドラムタブで H・Shift+J・Shift+F を使って 8 ビート（HH 8 つに BD・SD を同時打ちで重ねる）を入力 → 「連符」ボタンで 3 連符を挿入し F・J・H で埋める → シャッフル「8分」→ テキスト入力で `\tf triplet8th` と `{tu 3}` を確認 → リロードして下書きが残ることを確認。
  - `e2e/melody.spec.ts`: 既存テストはそのまま、新しいテストでメロディタブに 3 連符を挿入して埋め、テキストに `{tu 3}` が書き出されることを確認。
  - スクリーンショット `docs/m5-app-drums.png`（開発サーバーではなく Playwright、実アプリ）: ドラムタブに 1 小節目の 8 ビート（HH×8、BD・SD の同時打ち込み）＋ 2 小節目の 3 連符（ブラケットと数字）、左上に Shuffle 表記（♪♪=♪³♪）、シャッフル「8分」が選択済み、下部の仕上がり確認（`PartScore`）にも同じ連符とシャッフル表記が描画されている。目視で良好、不具合なし。
  - ドキュメント更新: `CLAUDE.md`（Source layout に M5 の lib/components を追記、`melodyPart.ts`・`staffLayout.ts`・`MelodyEditor`/`MelodyStaff` の説明を更新、Gotchas に 7 件追加）、`docs/requirements.md`（M5 を「実装完了（レビュー待ち）」に）、本ファイルの実績欄（T1〜T23）と本エントリ。`npx prettier --write` を変更した docs に実行済み。
