# M6 タスク計画: タブレット向けの閲覧画面

方針は `m6-decisions.md`（使う場面・ページ送り 3 方式・表示の組み合わせ 2 種・案A の上のバー・譜面全体の拡大・カウントイン 1 小節・練習番号は左の列・Shuffle はドラムの段のセクションの頭だけ・設定は曲ごと・確認は PC のタブレット表示と Playwright）と、承認済みのキャンバス「band-sheets 閲覧画面（M6）」（https://claude.ai/artifact/JUUh33ZzeJSvy18apK5jh8 の ①〜⑤、案A）に従う。元データはこれまでどおり ChordPro テキスト 1 つ（`App` の `text`）で、閲覧画面は **読むだけ**（テキストを一切書き換えない）。M2〜M5 と同じく純粋関数を `src/lib/` に置いて TDD、コンポーネントは薄く Storybook で確認する。

## 主な設計判断

1. **閲覧画面の置き場所: `App` の中の「閲覧モード」（URL は `#view`）**。
   - `App` に `screen: 'edit' | 'view'` を持たせ、`location.hash` と同期する（`#view` なら閲覧、それ以外は編集）。ヘッダーの「閲覧モード」ボタン（今は「準備中（M6）」で無効）を有効にし、押すと `location.hash = 'view'`。閲覧画面のバーの左端に「編集に戻る」（`history.back()` ではなく `location.hash = ''`。直接 `#view` で開いたときも編集に戻れるように）。ブラウザの戻るでも `hashchange` で編集に戻る。
   - 閲覧中も**編集画面のツリーはマウントしたまま `hidden`**にする（`Tabs` のパネルと同じ考え方）。かんたん入力の手順 1 の下書き・選んでいたタブ・各エディタのカーソルなどが、閲覧から戻っても残る。閲覧画面には `song`（`useMemo(parseSong(text))` そのもの）・`songId`・`storage` を props で渡すので、別のルートにして下書きを localStorage 経由で受け渡す案（アンマウントで編集の一時状態が消える、同じテキストを 2 か所で持つ）より単純で、「テキストが唯一の元データ」の原則も崩れない。
   - `#view` で直接開くと閲覧画面から始まる（タブレットのホーム画面のブックマーク用）。M7 で曲が複数になったら `#view` を `#view/<songId>` に広げる（M6 では曲は `LOCAL_SONG_ID` の 1 つだけ）。
   - 閲覧中は `document.title` を「<曲名> - 閲覧 - band-sheets」にする。
   - 採らなかった案: (a) 編集画面のタブの 1 つにする（タブレットでは編集のヘッダー・タブが邪魔、演奏モードで全部隠すのも難しい）、(b) 別の HTML エントリ（Vite の multi-page。M7 の Drive の認証を 2 か所で持つことになる）。

2. **描画: セクションごとに 1 つの alphaTab で、表示するパートを複数のトラックとして描く**（両方の表示で共通）。
   - 「自分のパート＋コード譜」は「コード譜のセクション（コード＋歌詞）→ そのセクションのパートの五線」を交互に並べる必要がある。1 つの alphaTab の SVG の段と段のあいだに HTML を差し込むことはできないので、**セクション単位で alphaTab を分ける**。スコア表示も同じ仕組みにする（セクションの中では 1 つの alphaTab に全パートをトラックとして渡すので、**小節は alphaTab が自動でそろえる**）。
   - 各セクションの alphaTex は `src/lib/viewerSections.ts` が作る: そのパートの冒頭の設定行（`\instrument percussion`・`\staff`・`\clef`・`\articulation`・`\ts`・`\ks` など、`\` で始まる行だけ。冒頭の音符は捨てる）＋**持ち越しの補い**（そのセクションより前に出てきた最後の `\ts`・`\ks`・`\clef`、ドラムは引き継ぎの `\tf`、最初の拍に音価が無ければ直前の音価 `:N`）＋そのセクションの本文。持ち越しの値は**パート全体を `AlphaTexImporter` で 1 回読んだ結果**（各セクション頭のマスターバーの拍子・調・`tripletFeel`、最初の拍の音価）から取るので、手書きのテキストでも alphaTab の解釈と一致する。パート冒頭の `\lyrics`（パート単位の歌詞、M4 で変換を用意したもの）はセクションに切ると位置がずれるので閲覧では出さない（メロディ画面で音符ごとの歌詞に変換すれば出る。閲覧画面にそのことを 1 行出す）。
   - 同じ読み込みの結果から、**各セクションの小節数と各小節の拍子**（自動スクロールの時間）、**曲全体での小節番号**（セクションの小節数 = そのセクションを持つ全パートの最大）を出す。パートの表示・非表示で小節番号が変わらないよう、最大は**表示中かどうかに関係なく全パート**で取る。
   - セクションの並び（`buildViewerSections`）: コード譜のセクションの順。同じラベルがコード譜に 2 回出たら（1 番・2 番の A など）パートの同じラベルを 2 回とも出す（パートに同じラベルが k 個あれば k 回目どうしを対応させ、足りなければ最初のもの）。パートにしか無いラベルは、そのパートの中で直前にあるラベルの後ろに入れる。コード譜の名前の無いセクション（`kind: ''`）はラベルなしのブロック。パートの冒頭（最初の `\section` より前）の音符は「（ラベルなし）」のセクションとして先頭に出す。
   - パートが alphaTab で読めない（エラー）ときは、そのパートだけ外して「<パート名> は読み込めませんでした（テキスト入力で確認してください）」をバーの下に出す。ほかのパートとコード譜は表示する。
   - 性能: 曲全体でセクション 10〜20 個 × トラック 1〜3 本。`AlphaTabApi` をセクションの数だけ作る。T1 で 20 セクション × 3 トラックの描画時間を CPU 4 倍遅い設定で測り、遅ければ「画面に近いセクションから順に描く」（全部の高さがそろうまでページ数は「計算中」）にする。
   - 採らなかった案: (a) 曲全体を 1 つの alphaTab で描き、`track.lineBreaks`（alphaTab 1.8.4 にある。全トラックが同じ小節で改行を求めると段を変える、`PageViewLayout._needsLineBreak`）でセクションの頭で段を変え、コード譜は上に重ねる — 段と段のあいだに HTML の高さを確保できない。(b) パートごとに別の alphaTab を縦に並べる — 音部記号の幅などが違うので小節の位置がそろわない。(c) 曲全体を読み込んで `display.startBar`/`barCount` で範囲だけ描く — パートごとにセクションの小節数が違うと、マスターバーの番号でそろうため別のセクションと並んでしまう（R7 の (c)）。

3. **R7（`\tf` は全パート共通）と Shuffle の表記**。
   - 閲覧画面の alphaTab では `NotationElement.EffectTripletFeel` を**無効**にする。確認したこと（alphaTab 1.8.4 `alphaTab.core.mjs`）: `TripletFeelEffectInfo` は `hideOnMultiTrack = true` で、`renderer.staff.trackIndex === 0`（**描くトラックの並びの先頭**、`RenderStaff` の `trackIndex` は `renderer.tracks` の添字）のときだけ描かれる。つまり alphaTab に任せると、メロディが上にあるスコア表示では Shuffle がメロディの段に付き、ドラムの段には付かない。さらに `\tf` はマスターバーの属性なので、メロディが先にあるとドラムの `\tf` は最初の 1 小節にしか効かない（R7 (a)）。
   - 代わりに **Shuffle 表記を自分で描く**（`ShuffleMark`、M5 の `drumLayout.ts` の Shuffle 表記と同じ Bravura のグリフ）。位置は alphaTab の `boundsLookup`（`staffSystems[0].bars[0].bars[k]` = ドラムのトラックの最初の小節の `BarBounds.visualBounds`）から取り、ドラムの段のすぐ上、セクションの頭に重ねる。値は `viewerSections.ts` がドラムのパートの各セクションの実効値（自分の `\tf`、なければ引き継いだ値。`drumPart.ts` の R2 の読み方と同じ）として出す。**メロディの段には出さない**。
   - `\tf` はセクションの alphaTex にそのまま残す（表記を無効にしたので見た目には影響しない。再生は使わない）。R7 (a)(b) は表記を自前にしたことで、(c) はセクションごとに描くことで起きなくなる。セクションの中でパートごとに小節数が違うときは、alphaTab が短いパートの残りを空の小節で埋める（T1 で確認）。

4. **練習番号とコード名の重なり（format-decision.md の既知の課題）**: 閲覧画面の alphaTab では `NotationElement.EffectMarker` を**無効**にする（`MarkerEffectInfo` は staff 0・voice 0・beat 0 かつ `masterBar.isSectionStart` のときに描かれるもの。これが 1 拍目の `ch` と同じ帯に入って重なっていた）。練習番号はキャンバスどおり**左の専用の列（ガター）**に HTML で置く。列の幅は 2 つの表示で同じ（キャンバスの付箋の「要確認」はこれで決める。切り替えても譜面の左端が動かない）。編集画面の確認用 `PartScore` は今のまま（セクションの境目が見えるほうが確認に便利。重なりは閲覧画面で解消すれば十分）。
   - あわせて閲覧画面では `TrackNames`（各段の左のパート名、ガターと重なる）・`EffectTempo`（セクションごとに出てしまう）・`ScoreTitle` 系（`\title` を書かない）・`BarNumber` を無効にし、**小節番号は自分で描く**: alphaTab の小節番号は `bar.index + 1`（`BarNumberGlyph`）なので、セクションごとに描くと毎回 1 から始まる。`boundsLookup` の各段の最初の小節の位置に、曲全体の番号（`firstBar + 段の中の位置`）を出す（ユーザー評価「小節番号が表示される点は良い」を保つ）。

5. **譜面全体の拡大（文字の大きさ）**: 倍率 `zoom` を 0.8〜1.4 の 0.1 刻み（キャンバスどおり、基準 22px、表示は「22px」のように px で）。コード譜は CSS 変数 `--viewer-font-size: calc(22px * zoom)` で em 指定、alphaTab は `display.scale = ALPHATAB_BASE_SCALE * zoom`（`api.settings.display.scale` を変えて `api.updateSettings(); api.render()`、T1 で確認）。`ALPHATAB_BASE_SCALE` は T17 のスクリーンショットで五線と文字の釣り合いを見て決める（初期値 1.0）。
   - 拡大・パートの切り替え・画面の回転のあとは**読んでいた位置を保つ**: 変更前に画面の上端にあった「単位」（下の 6）とその中の割合を覚え、描き直し後にそこへ戻す（ページめくりならそれを含むページ）。

6. **ページめくり: 描いた譜面を「単位」に切って画面の高さに詰める**。
   - 単位 = コード譜の 1 行、または alphaTab の 1 段（`boundsLookup.staffSystems[i].realBounds`）。セクションの見出し（ガターの番号はコード譜の 1 行目か最初の段に付くので別の単位にはしない）。コード譜の最後の行は次の段と離さない（`keepWithNext`）。
   - `paginate(units, viewportHeight)`（純粋関数）: 単位を割らずに上から詰め、入りきらない単位から次のページ。1 単位が画面より高ければその単位の中で画面の高さごとに切る。
   - 表示: 内容は 1 本の長い列のまま描き、ページ k は `transform: translateY(-pages[k].top)` で見せ、`pages[k].bottom` より下は背景色の覆いで隠す（次のページの頭が半分だけ見えないように）。DOM を分けないので alphaTab を描き直す必要がない。alphaTab の `core.enableLazyLoading` を `false` にする（画面外の部分を後回しにしない）。
   - 操作: 左 30%・右 30% のタップ領域（キャンバス ①、通常時は「タップで前／次のページ」の薄い案内つき、演奏モードでは案内なしで 32%）、下の「‹ 2 / 5 ›」。キー: **次へ = PageDown・→・↓・Space・Enter、前へ = PageUp・←・↑・Shift＋Space**（Bluetooth のフットペダルはほぼこのどれかを送る）。修飾キー（Ctrl/Alt/Meta）付き・IME 変換中・入力欄にフォーカスがあるときは何もしない（`viewerKeys.ts`）。最後のページで「次へ」は何もしない（端の表示は 0.3 秒のゆれだけ）。スワイプはキャンバスに無いので M6 では入れない。
7. **縦スクロール**: ふつうの `overflow-y: auto`。タップ領域なし。ペダルのキーは「画面の 85% だけスクロール」（`scrollBy({ behavior: 'smooth' })`、少し重ねて読み続けやすく）。
8. **自動スクロール: 小節 → 縦の位置の対応表を作って、時間で補間する**。
   - 時間: 1 小節 = `拍子の分子 × (4 / 分母) × 60 / (テンポ × 速度%)` 秒（`{tempo:}` は 4分音符の数として扱う。キャンバスの「♩=100」と同じ）。曲にテンポが無ければ ♩=100 とし、バーに「テンポ未設定（♩=100）」を出す。曲の途中の `\tempo` の変化は M6 では見ない。
   - 対応表（`buildTimeline`）: 時間のある単位（alphaTab の段 = その段の小節の秒数の合計。表示中のパートにそのセクションが無い・コード譜だけのときは、コード譜のブロックにセクション全体の秒数）ごとに `(開始時刻, 単位の上端の y)` を置き、あいだを直線で補間する。時間の無い単位（コード譜の行）は前後の段のあいだを通り過ぎる。**今の位置を画面の上から 30% の線に合わせる**（`scrollTop = y(t) − 0.3 × 画面の高さ`）。
   - どのパートにも小節が無いセクション（コード譜だけの曲など）の時間は確認したい点 3。
   - 再生は `requestAnimationFrame` で `scrollTop` を書く。▶ を押すと**今の scrollTop に対応する時刻から**始める（`timeAtScrollTop`）。再生中に指でスクロールしたら、その位置から続ける（一時停止はしない）。
   - 速度は ±5%（50〜150%、キャンバス ④）。テンポ表示は「♩=<テンポ×速度>」。
   - **カウントイン（1 小節、拍子どおり、入り切り可）**: ▶ の直後、開始位置の小節の拍子で 1 小節分、画面の中央に大きく拍を数える（1・2・3・4）。そのあいだはスクロールしない。音を鳴らすかは確認したい点 4。キャンバスの「(4拍)」は「(1小節)」に直す（m6-decisions.md の決定）。
   - 今の位置のセクションの番号を強調（キャンバス ④ の「再生中」）。
   - 最後まで行ったら止まる。▶ は ⟲（最初から）に変わる。
9. **演奏モード**: 上のバー・ページの案内・下のページ番号の行を隠し、譜面を画面いっぱいに。上端 26px の帯をタップすると操作バー（終了・曲名・ページ番号・A−/A＋）が下りてくる（もう一度タップ、または 4 秒操作が無ければ隠れる）。Esc でも終了。入ったときに `requestFullscreen()`、画面が消えないように `navigator.wakeLock.request('screen')` を試す（どちらも失敗しても何もしない。確認したい点 5）。自動スクロールの操作パネルは演奏モードでも出す（再生中は半透明）。
10. **設定は曲ごとに記憶**: `band-sheets:viewer:<songId>` に JSON で（`storage.ts` の流儀: 読み書きとも try/catch、失敗は黙って既定値）。中身は表示の組み合わせ・自分のパート・スコアで隠しているパート・スコアでコード譜を出すか・ページの進め方・倍率・速度・カウントイン。読み込み時に 1 項目ずつ検証して、おかしい項目だけ既定値に戻す（`normalizeViewerSettings`）。覚えていたパート名がもう無ければ最初のパート。スコアは「隠しているパート名」を覚える（あとで足したパートは表示される）。既定値: 自分のパート＋コード譜／最初のドラム以外のパート（無ければ最初のパート、パートが 1 つも無ければ「コード譜だけ」）／ページめくり／倍率 1.0／速度 100%／カウントイン入り。
11. **設定のドロワー（キャンバス ⑤）**: バーの右端の「設定」ボタンで右から開く。中身はバーと同じ項目＋説明文、下に「この曲につき設定を記憶します」。画面幅が 1100px 未満のときは、バーからページの進め方と文字の大きさを外してドロワーだけにする（タブレットの縦向き用）。

## タスク

各タスクは自分の「主なファイル」だけを変更する（同じ波の中でファイルが重ならない）。テストはタスクごとに対象ファイルだけを実行し、全体のテストは T20 で 1 回だけ流す（WSL が落ちやすいため）。コマンドはすべてコンテナ内: `docker exec -u node -w /workspaces/band-sheets band-sheets <cmd>`。各タスク共通の確認: `npx tsc -b`、`npx oxlint <変更ファイル>`、`npx prettier --check <変更ファイル>`。ストーリーは `parameters: { a11y: { test: 'error' } }` と、タッチの確認が要るものは `globals: { viewport: ... }` ではなく幅 1194・高さ 834 の枠（`decorators`）で描く。

| #   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 主なファイル（所有）                                                                   | 依存                      | テスト（対象だけ実行）                                                                                       | モデル | 実績                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| T1  | alphaTab の確認（一時ストーリー＋スクリーンショット、確認後に削除）: `EffectMarker`・`EffectTripletFeel`・`BarNumber`・`TrackNames`・`EffectTempo` を無効にした見た目、メロディ＋ドラムのセクション 1 つの文書でセクションの中の小節数が違うとき（短いほうが空の小節で埋まるか）、`ch` が 1 拍目でも重ならないこと、`boundsLookup` の `staffSystems[].realBounds` と各トラックの `BarBounds` の座標（コンテナ基準か・`display.scale` が掛かっているか・`postRenderFinished` の時点で揃っているか）、`display.scale` を `updateSettings` で変えて描き直せるか、`core.enableLazyLoading = false` で `transform` で隠れた部分も描かれるか、20 セクション × 3 トラックの描画時間（Playwright、CPU 4 倍遅く）、持ち越しの補い（`\ts`・`\ks`・`\tf`・`:N`）を入れたセクションの文書が全体の読み込みと同じ拍・音価になること。結果を findings に | docs/m6-alphatab-findings.md, docs/m6-t1-check.png                                     | —                         | （一時ストーリーのみ）                                                                                       | opus   | 完了（2026-10-05）。findings に計画への影響 9 項目、食い違い 5 点（クレジット行・postRenderFinished 2 回など） |
| T2  | 閲覧の設定: 型・既定値・`normalizeViewerSettings`（項目ごとの検証、消えたパート名）・`ZOOM_STEPS`/`zoomStep`・`clampSpeed`、`storage.ts` に `viewerSettingsKey`・`loadViewerSettings`・`saveViewerSettings`（try/catch、壊れた JSON）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | src/lib/viewerSettings.ts, viewerSettings.test.ts, src/lib/storage.ts, storage.test.ts | —                         | `npx vitest run --project unit src/lib/viewerSettings.test.ts src/lib/storage.test.ts`                       | sonnet | 完了（2026-10-05）。viewerSettings.ts・storage.ts、テスト 28 件                                                |
| T3  | `paginate(units, viewportHeight)`・`pageIndexAt(pages, y)`・`anchorOf(units, y)`（拡大の前後で位置を保つための「単位＋割合」）: 空、ちょうど入る、`keepWithNext`、画面より高い単位の分割、高さ 0 の単位、最後のページ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | src/lib/pagination.ts, pagination.test.ts                                              | —                         | `npx vitest run --project unit src/lib/pagination.test.ts`                                                   | sonnet | 完了（2026-10-05）。pagination.ts、テスト 21 件                                                                |
| T4  | 自動スクロールの計算: `barSeconds(bar, tempo, speedPct)`、`buildTimeline(timedUnits, tempo, speedPct)`、`scrollTopAt(tl, t, anchorPx)`、`timeAtScrollTop(tl, scrollTop, anchorPx)`（逆関数、範囲外・同じ y の単位・時間 0 の区間）、`countInBeats(bar)`、`sectionAt(tl, t)`、小節の無いセクションの時間の見積もり（確認したい点 3 の答えに合わせる）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | src/lib/autoScroll.ts, autoScroll.test.ts                                              | —                         | `npx vitest run --project unit src/lib/autoScroll.test.ts`                                                   | opus   | 完了（2026-10-05）。autoScroll.ts、テスト 36 件（sectionAt・rescaleTime・barAt 等を追加）                      |
| T5  | `viewerKeyToAction(e, ctx)`: 次へ・前へ・再生/一時停止（自動のときの Space/Enter）・演奏モード終了（Esc）、修飾キー・IME（`isComposing`/229）・入力欄・`repeat` の扱い                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | src/lib/viewerKeys.ts, viewerKeys.test.ts                                              | —                         | `npx vitest run --project unit src/lib/viewerKeys.test.ts`                                                   | sonnet | 完了（2026-10-05）。viewerKeys.ts、テスト 20 件                                                                |
| T6  | `ViewerToolbar`（案A の上のバー）: 編集に戻る・曲名・表示の組み合わせ（`SegmentedControl`）・自分のパートの選択（「コード譜だけ」を含む）またはスコアのパートの入り切り（チップ、コード譜も）・ページの進め方・A−/「22px」/A＋（端で押せない）・演奏モード・設定。幅 1100px 未満の省略。必要ならトークン追加                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | src/components/ViewerToolbar/*, src/theme.css                                          | —                         | `npx vitest run --project storybook src/components/ViewerToolbar`                                            | sonnet | 完了（2026-10-05）。ViewerToolbar、ストーリー 4 件、--viewer-bar-h。のち 1400px 未満の省略に変更               |
| T7  | `PageNav`: 左右のタップ領域（通常 30% で案内つき・演奏モード 32% で案内なし）、下の「‹ n / N ›」、端で押せない、`aria-label`「前のページ」「次のページ」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | src/components/PageNav/*                                                               | —                         | `npx vitest run --project storybook src/components/PageNav`                                                  | sonnet | 完了（2026-10-05）。PageNav、ストーリー 4 件                                                                   |
| T8  | `AutoScrollBar`（浮かぶ操作パネル: ▶/⏸/⟲・テンポ「♩=N」・速度 −/＋ と %・カウントイン「(1小節)」のスイッチ、再生中の半透明）と `CountIn`（画面中央の拍の数字、`aria-live` なし・`aria-hidden`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | src/components/AutoScrollBar/_, src/components/CountIn/_                               | —                         | `npx vitest run --project storybook src/components/AutoScrollBar src/components/CountIn`                     | sonnet | 完了（2026-10-05）。AutoScrollBar・CountIn、ストーリー 11 件                                                   |
| T9  | `SettingsDrawer`（キャンバス ⑤）: レイアウト・表示するパート・ページ送り方式・文字サイズ、「この曲につき設定を記憶します」、Esc と背景のタップで閉じる、開いたらフォーカスを中へ・閉じたら「設定」ボタンへ戻す                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | src/components/SettingsDrawer/*                                                        | —                         | `npx vitest run --project storybook src/components/SettingsDrawer`                                           | sonnet | 完了（2026-10-05）。SettingsDrawer、ストーリー 5 件                                                            |
| T10 | `PlayModeChrome`: 上端の帯（「上端をタップで操作バー」）と下りてくる操作バー（終了・曲名・ページ・A−/A＋）、4 秒で隠れる（タイマーは props の `now`/コールバックで試験できる形に）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | src/components/PlayModeChrome/*                                                        | —                         | `npx vitest run --project storybook src/components/PlayModeChrome`                                           | sonnet | 完了（2026-10-05）。PlayModeChrome、ストーリー 4 件                                                            |
| T11 | `ViewerChartBlock`: 左のガター（練習番号の枠、ラベルなしは空、再生中の強調）＋コード譜の行（`ChordLyricLine` をそのまま、`--viewer-font-size` の em で拡大）、各行に `data-unit` を付けて高さを測れるように。`SectionGutter` も同じフォルダ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | src/components/ViewerChartBlock/*                                                      | —                         | `npx vitest run --project storybook src/components/ViewerChartBlock`                                         | sonnet | 完了（2026-10-05）。ViewerChartBlock・SectionGutter、ストーリー 5 件                                           |
| T12 | `buildViewerSections(song)`（並び・繰り返し・パートだけのラベル・名前の無いセクション・冒頭の音符・読めないパート）、パートごとの全体の読み込み（`AlphaTexImporter`）からセクションの小節・拍子・持ち越しの値・ドラムの実効シャッフル、`firstBar`、`sectionScoreTex(meta, section, partNames)` → `{ tex, trackCount, drumTrack? }`。golden fixtures（T1 で確かめた文書）                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | src/lib/viewerSections.ts, viewerSections.test.ts, src/lib/fixtures/viewerFixtures.ts  | T1                        | `npx vitest run --project unit src/lib/viewerSections.test.ts`                                               | opus   | 完了（2026-10-05）。viewerSections.ts、テスト 29 件、fixtures/viewerFixtures.ts                                |
| T13 | `SectionScore`: セクション 1 つの alphaTab（閲覧用の設定: 上の無効にする要素・`enableLazyLoading: false`・`scale`）、`percussionStemsUp`、`ShuffleMark` と小節番号を `boundsLookup` の位置に重ねる、描き終わったら `onLayout(systems)`（段ごとの `top`・`height`・`barStart`・`barCount`）、幅・倍率の変更で描き直し、エラー表示。`ShuffleMark` も同じフォルダ                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | src/components/SectionScore/*                                                          | T1                        | `npx vitest run --project storybook src/components/SectionScore`                                             | opus   | 完了（2026-10-05）。SectionScore・ShuffleMark、ストーリー 6 件。クレジット行の切り取り、見えない文字の帯       |
| T14 | `ViewerSheet`: 表示の組み合わせに応じてセクションを並べる（ガター＋コード譜＋`SectionScore`）、全部の単位を測って `onUnits({ units, timedUnits })`（コード譜の行は DOM、段は `onLayout`）、全セクションの描画が揃うまでは `ready=false`、読めないパートの通知、パート冒頭 `\lyrics` の 1 行の注意                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | src/components/ViewerSheet/*                                                           | T2, T3, T4, T11, T12, T13 | `npx vitest run --project storybook src/components/ViewerSheet`                                              | opus   | 完了（2026-10-05）。ViewerSheet・sheetModel、ストーリー 7 件・単体 10 件                                       |
| T15 | `Viewer`: 設定の状態と保存（T2）、3 つのページの進め方（ページめくりの `translateY`＋覆い、スクロール、自動の rAF とカウントイン）、キー（T5）、拡大・切り替え・回転の後の位置の保持、演奏モード（全画面・Wake Lock）、ドロワー、`document.title`、`onExit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | src/components/Viewer/*                                                                | T5〜T10, T14              | `npx vitest run --project storybook src/components/Viewer`                                                   | opus   | 完了（2026-10-05）。Viewer・viewerClock、ストーリー 9 件                                                       |
| T16 | App に組み込む: `screen` と `#view` の同期、「閲覧モード」ボタンを有効に（`viewSoonId` の説明を削除）、編集のツリーは `hidden` で残す、`hashchange`、App のテスト（`#view` で開く・戻る・編集した内容が閲覧に出る・閲覧から戻っても EasyEditor の下書きが残る）とストーリー（`ViewerScreen`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | src/App.tsx, App.module.css, App.test.tsx, App.stories.tsx                             | T15                       | `npx vitest run --project unit src/App.test.tsx` と `npx vitest run --project storybook src/App.stories.tsx` | sonnet | 完了（2026-10-05）。App の #view 同期、App テスト 27 件・ストーリー 6 件                                       |
| T17 | e2e（タブレット）: `playwright.config.ts` に `tablet` プロジェクト（`devices['iPad Pro 11 landscape']`＝1194×834・`hasTouch`・`isMobile` に `browserName: 'chromium'`、`testMatch: /viewer\.spec/`、既存の `chromium` は `testIgnore` で除外）。`e2e/viewer.spec.ts`: 編集で曲を作る → 閲覧モード → タップ（`page.tap`）と PageDown で次のページ → スコアに切り替えてパートを隠す → A＋ で読んでいた位置が保たれる → 再読み込みで設定が残る → 自動（`page.clock` で時間を進めて scrollTop が増える・カウントインのあいだは動かない・速度＋で速くなる）→ 演奏モード（上端のタップでバー、Esc）→ 編集に戻る。スクリーンショット `docs/m6-*.png`（両方の表示・演奏モード・自動）と `ALPHATAB_BASE_SCALE` の決定                                                                                                                              | playwright.config.ts, e2e/viewer.spec.ts, docs/m6-*.png                                | T16                       | `npx playwright test --project tablet`                                                                       | sonnet | 完了（2026-10-05）。tablet プロジェクト、viewer.spec 4 件、e2e 9 件成功。実機の 4 件の問題を修正               |
| T18 | ドキュメント更新: CLAUDE.md（構成に M6 の lib/components、Gotchas: 閲覧の alphaTab は要素を無効にして番号・Shuffle を自前で描く理由、`hideOnMultiTrack`、セクションごとの文書と持ち越し、`#view`、e2e の `tablet` プロジェクト）、requirements.md の M6 の状態、本書の実績                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | CLAUDE.md, docs/requirements.md, docs/m6-plan.md                                       | T17                       | `npx prettier --check CLAUDE.md docs/requirements.md docs/m6-plan.md`                                        | sonnet | 完了（2026-10-05）。CLAUDE.md・requirements.md・本書を更新                                                     |
| T19 | 全検証を 1 回: `npm test`・`npx tsc -b`・`npm run lint`・`npm run build`・`npm run test:storybook`・`npm run e2e`（両プロジェクト）・`npx prettier --check .`。結果を短く報告（失敗は直さずに報告）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | （なし）                                                                               | T18                       | 左のとおり                                                                                                   | haiku  | 完了（2026-10-05）                                                                                             |
| T20 | 独立レビュー（M5 と同じ観点＋: 閲覧画面がテキストを書き換えないこと、セクションの並び・繰り返し・持ち越しの補いが alphaTab の全体の読み込みと一致するか（ランダムなパートの組で照合）、R7 と重なりが本当に解消したか（スクリーンショット）、ページの切れ目で単位が欠けない・重ならない、自動スクロールの時刻と位置の往復、拡大の後の位置、ペダルのキーとブラウザの操作の衝突、設定の壊れた値、`#view` と戻る、編集の状態が残るか）→ `docs/m6-review.md`                                                                                                                                                                                                                                                                                                                                                                                   | docs/m6-review.md                                                                      | T19                       | 使い捨てのスクリプト＋対象のテスト                                                                           | opus   |                                                                                                                |

### 共通 API（並行作業の前提として先に固定する）

```ts
// src/lib/viewerSettings.ts（T2）
export type ViewerLayout = 'part' | 'score';
export type NavMode = 'page' | 'scroll' | 'auto';
export interface ViewerSettings {
  layout: ViewerLayout;
  /** 「自分のパート」。null = コード譜だけ */
  part: string | null;
  /** スコアで隠しているパート名 */
  scoreHidden: string[];
  /** スコアでコード譜を出すか */
  scoreChart: boolean;
  nav: NavMode;
  zoom: number; // ZOOM_STEPS のどれか
  speedPct: number; // 50..150, 5 刻み
  countIn: boolean;
}
export const ZOOM_STEPS: readonly number[]; // [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4]
export const BASE_FONT_PX = 22;
export function defaultViewerSettings(song: Song): ViewerSettings;
export function normalizeViewerSettings(
  raw: unknown,
  song: Song,
): ViewerSettings;
export function zoomStep(zoom: number, dir: 1 | -1): number; // 端ではそのまま
export function clampSpeed(pct: number): number;

// src/lib/storage.ts（T2）
export function viewerSettingsKey(songId: string): string; // `band-sheets:viewer:<id>`
export function loadViewerSettings(
  storage: KeyValueStorage | null,
  songId: string,
): unknown; // JSON.parse 済み、失敗は undefined
export function saveViewerSettings(
  storage: KeyValueStorage | null,
  songId: string,
  s: ViewerSettings,
): boolean;

// src/lib/pagination.ts（T3）
export interface FlowUnit {
  /** 内容の列の上端からの位置（px） */
  top: number;
  height: number;
  /** 次の単位と同じページに置く（コード譜の最後の行 → 最初の段） */
  keepWithNext?: boolean;
}
export interface Page {
  top: number;
  bottom: number;
} // bottom は含まない
export function paginate(
  units: readonly FlowUnit[],
  viewportHeight: number,
): Page[]; // 単位が無ければ [{top:0,bottom:viewportHeight}]
export function pageIndexAt(pages: readonly Page[], y: number): number;
export interface Anchor {
  unit: number;
  ratio: number;
} // ratio 0..1
export function anchorOf(units: readonly FlowUnit[], y: number): Anchor;
export function anchorY(units: readonly FlowUnit[], a: Anchor): number;

// src/lib/viewerSections.ts（T12）
export interface BarInfo {
  num: number;
  den: number;
}
export interface ViewerPartSection {
  part: string;
  isDrum: boolean;
  /** トラック 1 本分（`\track` から）。持ち越しの補いを含む */
  trackTex: string;
  bars: BarInfo[];
  /** ドラムだけ。読めない `\tf` は 'other'（表記なし） */
  shuffle?: Shuffle | 'other';
}
export interface ViewerSection {
  key: string; // React の key（`<index>-<label>`）
  label: string; // '' = ラベルなし
  chart?: ChartSection;
  parts: ViewerPartSection[]; // 曲のパートの順
  /** そのセクションの小節（全パートの最長）。どのパートにも無ければ [] */
  bars: BarInfo[];
  /** 曲全体での最初の小節番号（1 始まり） */
  firstBar: number;
}
export interface ViewerPartError {
  part: string;
  message: string;
}
export function buildViewerSections(song: Song): {
  sections: ViewerSection[];
  errors: ViewerPartError[];
};
export function sectionScoreTex(
  section: ViewerSection,
  partNames: readonly string[], // 表示するパート（曲の順に並べ直す）
): {
  tex: string;
  trackCount: number;
  drumTrack?: number;
  shuffle?: Shuffle;
} | null; // 表示するパートがこのセクションに無ければ null

// src/lib/autoScroll.ts（T4）
export interface TimedUnit {
  top: number;
  height: number;
  bars: BarInfo[];
}
export interface Timeline {
  keys: { t: number; y: number }[];
  duration: number;
}
export function barSeconds(
  bar: BarInfo,
  tempo: number,
  speedPct: number,
): number;
export function buildTimeline(
  units: readonly TimedUnit[],
  tempo: number,
  speedPct: number,
): Timeline;
export function scrollTopAt(tl: Timeline, t: number, anchorPx: number): number;
export function timeAtScrollTop(
  tl: Timeline,
  scrollTop: number,
  anchorPx: number,
): number;
export function countInBeats(bar: BarInfo): number; // = num（6/8 なら 6）
export const DEFAULT_TEMPO = 100;

// src/lib/viewerKeys.ts（T5）
export type ViewerAction = 'next' | 'prev' | 'togglePlay' | 'exitPlayMode';
export interface ViewerKeyContext {
  nav: NavMode;
  playMode: boolean;
  targetIsEditable: boolean;
}
export function viewerKeyToAction(
  e: Pick<
    KeyboardEvent,
    | 'key'
    | 'code'
    | 'shiftKey'
    | 'ctrlKey'
    | 'altKey'
    | 'metaKey'
    | 'isComposing'
    | 'keyCode'
    | 'repeat'
  >,
  ctx: ViewerKeyContext,
): ViewerAction | null;

// src/components/SectionScore（T13）
export interface SystemBox {
  top: number;
  height: number;
  barStart: number;
  barCount: number;
} // SectionScore の上端基準、barStart はセクション内 0 始まり
export interface SectionScoreProps {
  tex: string;
  trackCount: number;
  zoom: number;
  firstBar: number; // 小節番号の表示用
  shuffleMark?: { track: number; shuffle: Shuffle };
  onLayout?: (systems: SystemBox[]) => void;
}
```

## 波

1. T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11
2. T12, T13
3. T14
4. T15
5. T16 → T17 → T18 → T19 → T20

ファイルの重なりの確認: `storage.ts` は T2 のみ、`theme.css` は T6 のみ（ほかのタスクで新しい色が要るときは T6 の完了後に T6 の担当へ依頼するか、既存のトークンを使う）、`App.tsx` は T16 のみ、`playwright.config.ts` は T17 のみ、`CLAUDE.md`・`requirements.md` は T18 のみ。`PartScore` は変更しない（T13 は `percussionStemsUp`・`injectBravuraFontFace` を import するだけ。alphaTab の設定は `SectionScore` が自分で持つ）。`ChordLyricLine` も変更しない（T11 は使うだけ）。

## 検証の進め方

- 各タスクは「テスト」列のコマンドと `npx tsc -b`・対象ファイルの oxlint / prettier だけを実行し、結果（変更ファイル・テスト件数・未解決の点）を短く報告する。全体の `npm test`・`npm run test:storybook`・`npm run e2e` は T19 で 1 回だけ。
- 純粋関数（T2〜T5・T12）は Vitest の単体テストで TDD。T12 は必ず `AlphaTexImporter` に通して確かめる（セクションの文書の拍数・音価・拍子・`tripletFeel` が、パート全体を読んだときのそのセクションの部分と一致すること）。
- 部品（T6〜T11・T13〜T15）は Storybook のストーリー＋play テスト（実ブラウザ）。タップは `userEvent.pointer({ keys: '[TouchA]', target })` か `fireEvent.click`、キーは `userEvent.keyboard('{PageDown}')`。alphaTab の描画の確認は jsdom ではしない。
- 描画の見た目（T1・T13・T14・T17）はコンテナ内の Playwright でスクリーンショットを撮り `docs/` に保存する。
- **タブレットの確認は PC のブラウザで行う**（m6-decisions.md）: e2e の `tablet` プロジェクト（1194×834、`hasTouch`、`isMobile`、Chromium）。実際のタブレットでの確認は M7 のあと。
- 自動スクロールの e2e は `page.clock.install()` で時間を進める（実時間を待たない）。

## 確認したい点（ユーザーへの質問）

1. **スコア表示の「コード譜」の段**: ChordPro のコード譜には小節の情報が無い（コードは歌詞の文字に付いている）ので、キャンバス ② のように「小節にそろえたコード名の行」は作れない。案: (a) セクションの頭にコード譜（コード＋歌詞の行）をそのまま出し、その下に小節をそろえた全パートの五線（メロディのパートに `ch` のコードがあれば、五線の上に小節にそろって出る）、(b) コード譜のコード名だけを 1 行に並べる（小節とはそろわない）、(c) スコア表示ではコード譜を出さない → **推奨: (a)**（「コード譜」チップで入り切りできる。(b) は小節とそろっているように見えて誤解を招く）。
2. **Shuffle 表記を出す場所**: キャンバスの付箋は「表記が変わるセクションの先頭」、決定事項は「ドラムの段のセクションの頭」。案: (a) シャッフルのセクションの頭には毎回出す（ページめくりでどこから見ても分かる）、(b) 前のセクションから変わったときだけ出す。シャッフルから「なし」に戻るセクションには「Straight」と出すかも → **推奨: (a) ＋ 戻るところに「Straight」**。
3. **どのパートにも小節が無いセクションの自動スクロールの時間**（コード譜だけの曲、パートを作っていないセクション）: テキストに小節数の情報が無い。案: (a) そのセクションのコードの数を小節数とみなす（1 行にコードが無ければ 1 行 = 1 小節）、(b) 1 行 = 2 小節、(c) そのセクションは自動では流さず止まる → **推奨: (a)**（J-POP のコード譜は 1 小節 1〜2 コードが多い。ずれたら速度で調整、指でのスクロールでも合わせられる）。
4. **カウントインの音**: 再生機能は使っていない（`enablePlayer = false`）。案: (a) 画面に大きく拍を出すだけ、(b) Web Audio でクリック音も鳴らす（入り切りはカウントインのスイッチと共通） → **推奨: (a)**（練習・ライブ中はタブレットの音はほぼ聞こえない。必要なら後で (b) を足すのは小さい）。
5. **演奏モードの全画面と画面の消灯防止**: 演奏モードに入ったときにブラウザの全画面表示と Wake Lock（画面を消さない）を試す。iPad の Safari は要素の全画面に一部しか対応しない・Wake Lock は iPadOS 16.4 以降。自動スクロールの再生中も Wake Lock を掛ける → **推奨: 両方試す（失敗しても黙って続ける）**。
6. **「自分のパート」に「コード譜だけ」を入れる**（ギター・ボーカルなどパートを持たない人用）。また、キャンバスに無い「編集に戻る」ボタンをバーの左端に足す（`#view` で直接開いたときの戻り道） → **推奨: どちらも入れる**。

### 回答（2026-10-05）

- 1〜6: すべて推奨どおり。

## 実績

（各タスクの完了時に追記する）

- **T5（2026-10-05 完了）**: `viewerKeys.ts`（テスト 20 件）。次へ = PageDown・→・↓・Space・Enter、前へ = PageUp・←・↑・Shift+Space、Esc = 演奏モード終了（`playMode` のときだけ）、`nav==='auto'` では Space・Enter・Shift+Space が `togglePlay`（矢印と PageUp/Down は next/prev のまま）。Ctrl/Alt/Meta・Shift（Shift+Space 以外）・IME 変換中・入力欄・キーリピートは無視。T15 向け: `nav='scroll'` でも next/prev を返す → Viewer 側で画面の 85% スクロールに対応させる。
- **T2（2026-10-05 完了）**: `viewerSettings.ts`・`storage.ts`（`viewerSettingsKey`・`loadViewerSettings`・`saveViewerSettings`、テスト 28 件）。既定の `part` = ドラム以外の最初のパート（無ければ最初のパート、パートが無ければ null）。保存値の `part: null` は「コード譜だけ」として有効、無くなったパート名は既定に戻す。`scoreHidden` は存在するパート名だけ残す。`zoom` は `ZOOM_STEPS` 以外なら 1、`speedPct` は `clampSpeed`（5 刻み・50〜150、不正値は 100）。`loadViewerSettings` は読めなければ undefined、`saveViewerSettings` は書けなければ false。
- **T7（2026-10-05 完了）**: `src/components/PageNav/*`（ストーリー 4 件）。props: `page`（1 始まり）・`totalPages`・`onPrev`・`onNext`・`playMode?`。親は `position: relative` 前提、左右 30%（演奏モードは 32%・全高・案内なし）のタップ領域＋下の「‹ n / N ›」。端では押せない。test id: `page-nav`・`tap-prev`・`tap-next`・`page-count`。端での「ゆれ」は入れていない → T15（Viewer）で付ける。
- **T10（2026-10-05 完了）**: `src/components/PlayModeChrome/*`（ストーリー 4 件）。props: `title`・`page`・`pageCount`・`visible`（親が持つ）・`onVisibleChange`・`onExit`・`onZoomOut`・`onZoomIn`・`zoomOutDisabled?`・`zoomInDisabled?`・`autoHideMs?`（既定 4000、計画の `now` の代わり）。上端の帯（26px）のタップで表示切り替え、何もしなければ自動で隠れる。T15 向け: 全画面と Wake Lock は Viewer 側、下の大きなページ番号とペダルの案内は PageNav 側、`onExit` は演奏モードを終えるだけ（閲覧画面からは出ない）。
- **T9（2026-10-05 完了）**: `src/components/SettingsDrawer/*`（ストーリー 5 件）。props: `open`・`onClose`・`anchorRef`（閉じたらフォーカスを戻す）・`settings`・`partNames`・`onChange(next)`（1 操作 1 回）。dialog（aria-modal、Tab 循環、Esc・背景・閉じるで閉じる）。part 表示ではパート＋「コード譜だけ」、score 表示ではパートごとの表示・非表示と「コード譜」のチップ。ドロワーは常に全項目を出す（狭い画面でバーの項目を省くのは T6/T15）。
- **T3（2026-10-05 完了）**: `pagination.ts`（テスト 21 件、共通 API どおり）。最初のページの top は 0、以降はそのページの先頭の単位の top。`keepWithNext` の連なりは 1 ブロック（画面より高ければ無視）。画面より高い単位は画面の高さごとに切る。`pageIndexAt` は top <= y の最後のページ、`anchorOf`/`anchorY` は範囲外を丸める。拡大（1.5 倍）の前後で位置が保たれることをテスト済み。
- **T6（2026-10-05 完了）**: `src/components/ViewerToolbar/*`（ストーリー 4 件）、`theme.css` に `--viewer-bar-h: 72px`。props: `title`・`layout`/`onLayoutChange`・`partNames`・`part`/`onPartChange`（null = コード譜だけ）・`scoreHidden`/`onScoreHiddenChange`・`scoreChart`/`onScoreChartChange`・`nav`/`onNavChange`・`fontPx`（T15 が `BASE_FONT_PX × zoom` を丸めて渡す）・`canZoomOut`/`canZoomIn`/`onZoomOut`/`onZoomIn`・`onBack`・`onPlayMode`・`onOpenSettings`・`settingsRef?`（共通 API への追加、SettingsDrawer の `anchorRef` に渡す）。幅 1100px 未満ではページの進め方・文字の大きさを隠す（CSS、テストなし）。
- **T11（2026-10-05 完了）**: `src/components/ViewerChartBlock/*`（`ViewerChartBlock`・`SectionGutter`、ストーリー 5 件）。`ViewerChartBlock` props: `section`・`sectionKey`・`playing?`・`fontSize?`（`--viewer-font-size`、既定 22px）。`SectionGutter`: `label`・`playing?`。各行は `data-unit` の div（最終行に `data-keep-with-next`）。拡大は em で、ChordLyricLine の rem のトークンをブロック内で em に上書き。
- **T8（2026-10-05 完了）**: `src/components/AutoScrollBar/*`・`src/components/CountIn/*`（ストーリー 11 件）。`AutoScrollBar` props: `playing`・`ended?`（主ボタンが「最初から」に）・`tempo`・`speedPct`・`countIn`・`onPlay`/`onPause`/`onRestart`・`onSpeedChange(pct)`・`onCountInChange(on)`、`SPEED_MIN`/`SPEED_MAX`/`SPEED_STEP` を export（バー内で独自に 50〜150 に丸めている → T15 で `viewerSettings.clampSpeed` に合わせる）。カウントインのスイッチは `role="switch"`「カウントイン (1小節)」。配置は呼び出し側。再生中の半透明は opacity 0.9（0.7 はコントラスト不足）。`CountIn` props: `beat: number | null`、`absolute inset: 0` のオーバーレイ、`aria-hidden`、`data-testid="count-in"`。
- **T4（2026-10-05 完了）**: `autoScroll.ts`（テスト 36 件、共通 API どおり）。`BarInfo {num, den}` は T12 がまだ無いので autoScroll.ts に同じ形で宣言（T12 後に `import type` へ替えてよい）。追加: `sectionAt(tl, t)`（`buildTimeline` に渡した単位の添字、空なら -1）、`rescaleTime(t, fromPct, toPct)`（速度変更で位置を保つ）、`barAt(units, tempo, speedPct, t)`（カウントインの拍子）、`lineBarCount(line)`・`estimateChartBars(section, bar)`（コード 1 つ = 1 小節、コードの無い歌詞の行 = 1 小節、空行・raw 行 = 0）。`scrollTopAt` は 0 未満を返さない、`timeAtScrollTop` は 0 以下なら 0。`meta.time` の解釈（不正なら 4/4 など）は T12/T14 側。
- **T1（2026-10-05 完了）**: `docs/m6-alphatab-findings.md`（計画への影響 9 項目）・`docs/m6-t1-check.png`。計画の前提（要素の無効化で練習番号・Shuffle・小節番号などが消える、パート間で小節線がそろう、`boundsLookup`、`display.scale` の再描画、`enableLazyLoading=false`、持ち越しの補い）はすべて確認。食い違い:
  1. 「rendered by alphaTab」が設定に関係なく各描画の下に 1 行出る → **決定（2026-10-05）**: T13 で各セクションの最後の段の下端で切って隠し、閲覧画面の最後に 1 回だけ「rendered by alphaTab」をアプリ側で出す（T14/T15）。
  2. `postRenderFinished` が 1 回の `tex()` で 2 回来ることがある → T13 の `onLayout` は何度呼ばれてもよい作り、T14 は最新の値で判断。
  3. `\section` 直後の音価の無い音符（手書き）は、全体の読み込みでは名前の 2 つ目の引数として飲み込まれるが、セクション単位で `:N` を補うと音符として出る → `:N` で音符として出す。T12 のテストはこのケースだけ別の期待値。
  4. 2 トラックで `\ts` が違うとマスターバーの拍子は後のトラックのもの → T12 は各パートを単独で読んだ拍子を使う。
  5. 段の間に 10〜15px の隙間（どの段の `realBounds` にも入らない）、左・上の余白 35px は `scale` に関係なく一定。
- **T13（2026-10-05 完了）**: `src/components/SectionScore/*`（`SectionScore`・`ShuffleMark`、ストーリー 6 件）・`docs/m6-t13-section-score.png`（確認済み: クレジット行なし、Shuffle はドラムの段だけ、小節番号は曲の通し番号でコード名と重ならない、3 連符も正しい）。props は共通 API どおり＋`ALPHATAB_BASE_SCALE = 1` を export（T17 で調整）。alphaTab の余白を左右 12px・上 6px・下 0 に変更（T14 のガターとの並びを確認すること）。クレジット行は最後の段の下端とその文字の上端の小さいほうで切る。`onLayout` は描き終わるたびに呼ぶ。`shuffle === 'none'` では「Straight」を出す（いつ渡すかは T14）。ShuffleMark の帯は、描画時だけドラムの最初の拍に見えない文字 3 行の `beat.text` を足して alphaTab に空けさせている（alphaTab の内部の動きに頼る回避策 → T20 で確認。手書きの `{txt}` があるとその文字は帯の下に出る）。倍率 1 の小節番号（約 11px）は小さめ → T17 で見直す候補。
- **T12（2026-10-05 完了）**: `viewerSections.ts`（テスト 29 件、補いを外すと 7 件失敗することも確認）・`fixtures/viewerFixtures.ts`（`carryOver*`・`viewerSongText`・`chartOnlySongText`・`unreadablePartSongText`）。共通 API どおり `sectionScoreTex(section, partNames)`。追加: `ViewerPartSection.shuffleMark?: Shuffle`（描く表記。'8'/'16' はシャッフルのセクションに毎回、`'none'` = 「Straight」で前のブロックがシャッフルのときだけ、表記しないときは undefined）、`songTimeSig(meta)`（不正・未設定なら 4/4）。`tex` は `.\n`＋各トラック（`\section` 行なし、拍子・調・音部記号は各トラックの頭に必ず、ドラムには `\tf`）。T14 向け: コード譜だけのブロックは `bars: []` で `firstBar` を進めない、小節の無いパートのセクションは `parts` に入れない、パート冒頭の `\lyrics` は落とす（`hasPartLevelLyrics` で注意を出すか判断）、読めないパートは `errors`（「<名前> は読み込めませんでした（テキスト入力で確認してください）」）、小節番号はパートを隠しても変わらない。autoScroll.ts の `BarInfo` はそのまま（同じ形）。
- **T14（2026-10-05 完了）**: `src/components/ViewerSheet/*`（`ViewerSheet`・`sheetModel.ts`、ストーリー 7 件・単体 10 件）・`docs/m6-t14-part.png`・`m6-t14-score.png`・`m6-t14-score-zoom.png`。props: `song`・`layout`・`part`・`scoreHidden`・`scoreChart`・`zoom`・`playingSection?`・`onLayout?(l: SheetLayout)`（計画の `onUnits`。命令的 API なし）。`SheetLayout = { ready, units, timedUnits }`（内容の列の上端からの px、中身が変わったときだけ送る）。`SheetUnit` はそのまま `paginate`、`SheetTimedUnit` はそのまま `buildTimeline` に渡せる。位置の保持は `sheetAnchorAt(units, y)` → 新しい `ready` で `sheetAnchorY(units, anchor)`（段の上は「セクションの何小節目か」で覚える）。型と関数は `./sheetModel` から import。スクロール・ページの切り替えは T15。
  - 残り: (1) コード譜に同じラベルが 2 回あると `ViewerChartBlock` が同じ名前の region を 2 つ作り a11y の `landmark-unique` に引っかかる（ViewerSheet のストーリーでだけ規則を止めている）→ T15 で `ViewerChartBlock` に aria-label の上書きを足して直す。(2) ガターの練習番号の枠が拡大で大きくならない → T15 で直す。(3) `ZOOM_STEPS` の上限は 1.4。
- **T15（2026-10-05 完了）**: `src/components/Viewer/*`（`Viewer`・`viewerClock.ts`、ストーリー 9 件）、`ViewerChartBlock` に `ariaLabel?` とガター・枠の拡大、`ViewerSheet` は aria-label を渡し「N 小節」の行の高さの測り方を直した、`landmark-unique` を有効に戻した。スクリーンショット `docs/m6-t15-{part,score-page2,play-mode,count-in,auto}.png`。T16 向け: `<Viewer song songId storage onExit clock? />`、親で高さを決める（`height: 100dvh` など）、キーは `document` で受けるので編集に戻るときはアンマウント、曲が変わったら `key={songId}`、`document.title` は Viewer が設定して戻す。
  - **決定（2026-10-05）**: 上のバーが 1194px に入りきらない → 幅 1400px 未満ではページの進め方と文字の大きさを隠し（設定のドロワーにある）、スコアのチップは「パート ▾」のポップオーバーにまとめ、ボタンは折り返さない・曲名は省略記号。Wake Lock は画面に戻ったとき（`visibilitychange`）に取り直す。左右のタップ領域の矢印が五線に重なる件は T17 で見直す候補。
- **T16（2026-10-05 完了）**: `App.tsx`・`App.module.css`・`App.test.tsx`（27 件、閲覧 5 件追加）・`App.stories.tsx`（`ViewerScreen` 追加、6 件）。閲覧は URL ハッシュ `#view` と同期（ボタンは `pushState`、`hashchange`/`popstate` で戻る、`#view` で直接開いたときの「編集に戻る」は `replaceState`）。Viewer は閲覧中だけマウント（`key={songId}`、`EditorErrorBoundary` で包む）、編集側は `hidden` で残す。閲覧中のキーは編集側に届かないことをテスト済み。`.viewer { height: 100dvh }`。
- **ViewerToolbar 1194px 対応（2026-10-05）**: バー幅（`ResizeObserver`、`COMPACT_BELOW_PX` = 1400）未満でページの進め方・文字の大きさを隠し（ドロワーで操作）、スコアのチップは「パート ▾」ポップオーバーに格納。ボタンは `nowrap`＋`flex-shrink: 0`、曲名は省略表示（最小 4em、`title` に全文）。ストーリー `Tablet1194Part`/`Tablet1194Score` を追加（折り返しなし・曲名表示を検証）。Viewer のストーリー 2 件はドロワー経由に変更。Viewer の Wake Lock は `visibilitychange` で再取得（演奏モード中・失敗は黙って無視、終了・アンマウントで解除）。スクリーンショット `docs/m6-toolbar-1194.png`（パート）・`docs/m6-toolbar-1194-score.png`。
- **T17（2026-10-05 完了）**: `playwright.config.ts` に `tablet` プロジェクト（iPad Pro 11 landscape、1194×834、hasTouch、chromium、`viewer.spec` だけ）、`e2e/viewer.spec.ts`（4 件: 閲覧の一連の操作と設定の保持・編集に戻る、演奏モード、自動スクロール、カウントイン）。`npm run e2e` は 9 件すべて成功。実アプリの画面 `docs/m6-app-{part,score,play-mode,auto}.png`。
  - 見つかった問題（2026-10-05 にまとめて修正を依頼）: (1) タップ後に左のタップ領域が水色のまま残る（タッチの hover/active）、(2) スコア表示で左右のタップ領域の矢印が五線の音符に重なる、(3) 表示を切り替えたあと読み上げのページ数が古いまま、(4) セクションの最後の段が横幅いっぱいに伸びず約 55% で止まる（alphaTab の最後の段）。
- **T17 修正（2026-10-05）**: 実機 e2e の 4 件を修正。(1) タップ領域の hover/active を `@media (hover: hover)` に限定し、タップの反応は 250ms のアニメーションに（`-webkit-tap-highlight-color` 透明・`touch-action: manipulation`）。(2) 矢印は画面の左右端 2px に移し、不透明度 0.3 に。(3) Viewer はレイアウト確定後にページ数が変わったら一度だけ「n / N ページ」を読み上げる（描画中の更新はしない）。(4) alphaTab 1.8.4 の `display.justifyLastSystem = true` を SectionScore で有効化（1 小節だけの段も全幅に伸びる。上限は設けていない）。e2e でスコア切替後の viewer-live も確認。
- **T19（2026-10-05）**: 全体の検証 — npm test 45ファイル・1705件✓、tsc✓、lint✓（0警告）、build✓、test:storybook 37ファイル・259件✓、e2e 9件✓、prettier✓。完了。
