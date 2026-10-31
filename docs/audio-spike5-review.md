# スパイク 5 T15: 独立レビュー（ドラム解析のブランチ全体）

読む人: T16（指摘の修正）と T17（記録・結論）の担当、それと結論を確かめるユーザー。
目的: `spike/5-drums`（`research/audio-analysis...9fae96a`、94 ファイル）を、計画 §7 T15 の観点（正解を読まない構造・合成の正解・mir_eval との一致・見る時点・プライバシー・AI 無し・ライセンス・通信・凍結）とバグ・DRY/YAGNI・文書で調べた指摘の一覧。コードは直していない。

## 確かめたこと（問題なし）

- **正解を読まない**: `ts/drum` の解析のファイル（analyze・onset・classify・cymbals・toms・ext・quantize・strength・swing・toDrums・templates・bands・config）は `render/`・truth・score・report を import しない。正解を読むのは `cli.ts`・`heldout_eval.ts`・`pool.ts`・`classify_eval.ts` の、解析の後だけ。`analyze.test.ts` の構造テストあり。
- **合成の正解**: `render/drum` のテスト（調整用・開発用・R1・キット D/H の ±1 ms、`parseDrums` の往復、ゴールデンのハッシュ 3 本）が通る。キット C の音はこのテストの描画と ±1 ms の確かめだけで、解析には渡っていない。
- **mir_eval との一致**: 今の `score.ts` で `drum_mireval_check.py gen → score_check.ts → compare` をやり直し、207 例 × 2 つの許す幅 = 414 の比べで差 0。
- **見る時点のログ**（`out/results/heldout-log.jsonl` の 13 行）: 取り込みの register 6 行（e・f が heldOut）→ ① R2（`94d5028cad36`/`5abbbd4`）→ ② R3（`29e9d1cb07c2`/`cec27a0`）→ 開始の直しの rerun 2 行（設定は ①② と同じ、`rerun: true`）→ note 1 行（e・f は `.txt` の値だけ、音を読まず）→ ③ 開発用（`fb158baf9dfe`/`dc0ec5a`）→ ③ ホールドアウト 1 行（`fb158baf9dfe`/`c8ab055`、T14）。文書の主張と一致。② と解析の 1 回だけの変更（`dc0ec5a`）の間に `ts/drum` の解析は変わっていない。`dc0ec5a`→`c8ab055` は `cli.ts` の export 3 つと評価のファイルだけ。T14 の後は文書だけ。
- **開始の直し**: 開発用 4 本の正解は、`drum_intake.py` の `parse_drum_txt`+`build_truth`（`--reparse` と同じ道）で作り直したものと一致（`recordings/` と `out/rec/` の 2 つとも、最大の差 0）。ホールドアウトの正解は読んでいない。
- **T14 の数字**: `out/heldout-eval/final/summary.md`（集計）と t14.md の表・手数（264/529、281/461）・ずらし（-11・-5、-13・+15 ms）が一致。t12b と r3 の ①② の数字も一致。
- **凍結**: `src/`・`ts/dsp/`・`ts/hum/`・`py/dsp/`・`ts/parity/`・`render/hum/`・ルートの設定の差分 0。外の変更は `.gitignore`・`RECORDING.md` §8・`privacy_check.py`（2 行）・`render/types.ts`（任意の欄だけ）・`THIRD_PARTY.md`（追記）。
- **AI 無し・通信無し**: 学習済みモデルは無い（決めたテンプレートの NMF と規則だけ）。Worker は fetch など 5 つを消す。`analyze.test.ts`・`cli.test.ts` に `stubNoNetwork`。
- **ライセンス**: キット A（MIT、表示文あり）・B・C（CC0）・D（CC-BY 4.0、`THIRD_PARTY.md` に表示と変更点）。サンプルは gitignore で、アプリにも Worker にも入らない。GPL/LGPL のコードは無い（librosa・mir_eval は開発の道具だけ）。
- 実行したテスト: vitest `ts/drum render/drum` 212 通過・1 スキップ、`tsc --noEmit` 0、Python `unittest discover -s py/tests` 580 通過（スキップ 4）、`privacy_check.py --no-log` OK。

## must-fix

1. **文書 4 つが `prettier --check` を通らない**（`docs/audio-spike5-t12.md`・`t12b.md`・`t13.md`・`t9-baseline.md`）。CI の `check`（`prettier --check .`、`spikes/` だけ除外）が落ち、`research/audio-analysis` への PR がマージできない。直し: `npx prettier --write` をこの 4 つに。
2. **合成のホールドアウト（キット C、種 6〜7）が一度も走っていない**。計画 §4・§5（「ホールドアウトと開発用の差: 合成 .1 以内」）と T14 の行は合成も含むが、T14 は録音だけ。開発用の合成（キット B）も T10 の後は測っていない（S-9・S-ext の開発用の合成の数字が無い）。さらに `heldout_guard.ts:60` の `hasDrumLook3` は「ドラムの look-3 の行が 1 つでもあれば断る」ので、今は合成のホールドアウトをガード越しに走らせる道が無い。直し: T17 の前にユーザーに決めてもらう（a. 固定の `fb158baf9dfe` で合成のホールドアウトを 1 回だけ走らせる。ガードに `take: "synthetic"` の別の行を足す。b. 走らせないと決め、結論に「合成のホールドアウトは未測定」と書く）。

## should-fix

1. **`pool.ts` が外す小節を無視し、許す幅を固定**（`ts/drum/pool.ts:21`・`:32-33`・`:59-60`）。`scoreTake` は `excludedBars` を正解・推定から外すのに、`pool.ts` の合算の F と格子は全部の小節で数え直し、幅も `0.05` 固定（`cfg.score.toleranceSec` を見ない）。外す小節がある録音（今の 6 本は 0）だと、合算の表と録音ごとの表がずれる。直し: `scoreTake` が楽器ごとの `matched/nRef/nEst` と格子の数を返し、`pool.ts` はそれを足すだけにする（DRY も）。
2. **直す手数が正解の小節の外の推定を数えない**（`ts/drum/score.ts:450`・`:454`）。`editScores` は正解の小節だけを回すので、最後の小節の後（`quantize.ts` の規則 5 の閉じの頭 `bar = nBars` を含む）や正解に無い小節の推定は「消す」手数にならない。格子の P はそれを数えるので、2 つが食い違い、手数は少なめに出る。直し: 正解と推定の小節の和集合（外す小節を除く）を回す。テストに「正解の後の小節に推定 2 打 → 手数 +2」。
3. **ホールドアウトの入口が別の設定を受け付ける**（`ts/drum/heldout_eval.ts:113-114`）。`--final-heldout` に `--config x.json` と `--commit` を渡せ、ログには渡した設定のハッシュがそのまま入る。固定した設定かどうかは確かめない。今回は既定の設定で 1 回だけ走ったので結果は正しいが、この入口を流用すると穴になる。直し: final では `--config` を断る（または期待するハッシュを引数で受けて照らす）、`--commit` はいつも `git rev-parse` から。
4. **開発用の見る回数が仕組みで守られていない**。録音の開発用の行は手で足した（`r3.md:13`。`cli.ts --look-point` は録音ごとに 1 行書くので使わなかった）。開発用の合成（キット B）の通しはログに残らない。T9（基準線は開発用を含む）＋ T10 の確かめ 3 回で、開発用の合成は 4 回見ている（`t10.md:69`）。T11 は「T10 が 3 回を使い切った」と読んで開発用を走らせていない（`t11.md:8`）。直し: T17 で「開発用の合成を見た回数と目的」を 1 か所に書く。流用するなら `runAll` が split に dev を含むとき 1 行を書く。
5. **T14 の「速さ・メモリ・大きさは T13（変更なし）」が違う**（`t14.md:82`）。T13（`e4a97ee`）の後に `dc0ec5a` で解析が変わり、Worker は 31,269 → 31,463 B、Node の速さは t12b §3 で測り直した。Chromium のメモリは測り直していない。直し: 「T13 と t12b §3（大きさ 31,463 B、Node）。Chromium のメモリは `dc0ec5a` の後は未測定」に。
6. **計画の本文が決定と食い違う**（T17 で直す）: ①`plan.md:14` のサンプルのライセンス（CC0・PD・MIT/BSD だけ）にキット D（CC-BY 4.0、T10b のユーザー決定）の例外が無い。②`plan.md:92` の `開始:` は「1 打目のだいたいの秒」だが、コードと `DRUM_RECORDING.md:44` は「1 小節目の頭の秒（正確）」。1 小節のずれ（t12b §1）はこの値の意味に関わるので、結論に「開始がずれると誤りが目立たない（繰り返しの型で多くが合う）」も書く。③「開発用は 3 回だけ」が録音だけか合成もかを書く（上の 4）。
7. **§5 の「録音（開発用の平均）≤ .5」と、文書の合算の比がずれる**。r3・t12b・t14 の直す手数/キーボードは全部の手数 ÷ 全部のキーボードの比。開発用 ③ S-3 の録音ごとの平均は .566（.496・.514・.560・.695）で、合算 .546 と違う。直し: 結論でどちらで判定したかを書き、両方を出す。
8. **結びついた 2 つの値**（`ts/drum/config.ts:198-209`）: `cymbals.crKeepSpCn` と `ext.cymVote` は同じ値でないと、S-9 が CR のまま残した打点を S-ext が SP・CN にできない（注に「= ext.cymVote」とあるだけ）。直し: 片方からもう片方を作る（または `config.test.ts` で等しいことを確かめる）。
9. **ゴールデンのハッシュがキット A・B・C の 3 本だけ**（`render/drum/render.test.ts:16-20`）。T10b〜T12b の調整が頼ったキット D・H と R1 には同じ種で同じ wav の固定が無い。t12b §2 の「今までの 606 本は変わらない（golden のハッシュのテストが通る）」は 3 本分の根拠。直し: D・H・R1 を 1 本ずつ GOLDEN に足す。

## nice

1. **YAGNI**: 切ってある切り替え（`refit`・`hpss`・`metalDecay`/`metalTakeFastMin`・`eqRounds`・帯域の規則の道）のコードが `classify.ts` に残り、Worker の大きさ（31.5 KB、枠 35 KB）に入っている。表を取り直す道としてスパイクの間は残してよいが、main に移すときに消す。
2. **held-out の入口が 2 つ**: `cli.ts` の `--look-point`（`gate`・`logLook`）と `heldout_eval.ts`。T14 の後はどちらも断るので、`cli.ts` の look-point の道は使われない。どちらか 1 つにする。`cli.ts:207` の held-out の確かめも `assertNoHeldOut` と重なる。
3. **`ext.ts:88`**: SP・CN に名前を変えた打点も `metal.inst !== 'CR'` を通るので、音の高さの山（`tonalAt`）でさらに RD.bell になりうる。条件を `HH`/`HO`/`RD` に絞る。
4. **`analyze.test.ts:112`** の構造テストはファイルを手で並べている（`bands.ts`・`config.ts` が入っていない）。`ts/drum/*.ts` からテスト・評価・CLI を除いた全部を見る形に。
5. **`drum_intake.py:247`** の注「before the audio is touched」: 音は `:235` で読んで変換済み（解析はしていない）。「before anything is analysed」だけにする。
6. **`privacy_check.py`**: ドラムの録音から照らす語は 0（名前が a〜f で、楽譜は自作）。これは録音の音・曲名の漏れの穴ではない。ただし `recordings/drum-scores/`（ホールドアウトの楽譜）の中身は照らさないので、文書に貼られても気付かない。ホールドアウトを使い終えた今は影響が小さい。流用するなら小節の並びを照らす（鼻歌の音の並びと同じ考え）。
7. **`ts/THIRD_PARTY.md` のキット D の変更点**に R1 の変更（高い帯域を下げる棚、SD の胴、タムの高さ）が無い。音は共有しないので義務ではないが、一覧として足す。
8. **t14 §3** の S-ext の違いに CR（.200 → .250）が抜けている。
9. **コピー版の比**（直す手数 ÷ コピー版のキーボード）は、直す側にコピーを数えないので 1 を超えやすい（録音で 1.35〜2.2）。結論で「一から打ってコピーする方が速い」と読むときに、この非対称を書き添える。

## 削除提案

1. `spikes/analysis/DRUM_SAMPLES.md:80-` 「`ts/THIRD_PARTY.md` への追記の案」の節: もう `THIRD_PARTY.md` に入っていて（キット D も）、案はキット D を含まない古い版。「`ts/THIRD_PARTY.md` を見る」の 1 行に。
2. `spikes/analysis/DRUM_SAMPLES.md:70-` 「キット A のワンショットの取り出し方（T2 向けの推奨）」: T2 で実装済み。「やり方は `render/drum/kits.ts`」の 1〜2 行に。
3. `docs/audio-spike5-r3.md:107` 「1 小節目の前の音（ユーザーに確認したい）」と `:126` 「どれを選んでも…」: G2 の決定 9 と t12b §1 で解決済み（文書の頭の注で足りる）。
4. `docs/audio-spike5-r3.md:120-126` 「T14 の前の選択肢」: G2 の決定 10 で選択肢 2 に決まった。「選択肢 2 を選んだ（t11 G2 の決定 10）」の 1 行に。
5. `docs/audio-spike5-t12b.md:137-151` 「T14 の実行方法」: コマンドに `GIT_DIR`/`GIT_WORK_TREE` が無く古い（t14 §1）。ガードの説明は `heldout_eval.ts` の頭の注と重なる。「入口は `heldout_eval.ts`、コマンドは t14 §1」の 1 行に。
6. `docs/audio-spike5-t12b.md:156-157` 「正解の 開始 の直し」の `out/t12b/fix_start.py`（gitignore で残らない）: 同じことは `drum_intake.py --reparse` でできる（開発用で一致を確かめた）。行を消すか `--reparse` に置き換える。
7. `docs/audio-spike5-t11.md:94-98` 「G2 で決めること（案）」: 直後の「G2 の決定」と重なる。決定 1 の「上の案 B」を「S-3 はそのまま、目標は S-9 の閉じた HH で見る」に書き換えたうえで消す。
8. `docs/audio-spike5-t10.md:97-` 「T11（S-9）が知っておくこと」と `docs/audio-spike5-t11.md:191-` 「T12 以降が知っておくこと」: 次のタスクへの引き継ぎで、そのタスクは済んだ。結論に要る 1 行（未知のキットの HH が金属の列に吸われる、名前の比は 3 キットからの仮定）だけ T17 の結論に移して消す。
