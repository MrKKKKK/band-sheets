# スパイク 7 T1: 採点の守りと、録音 a〜f の登録し直し

想定読者: スパイク 7 の後のタスク（T4〜T15）で採点の道具を書く・走らせるエージェントと、T16 の独立レビューをする人。
目的: 計画 `audio-spike7-plan.md` §4 の守りが、どのファイルで・どの規則として入ったかと、スパイク 6 の録音 a〜f をどう開発用に登録し直したかを、集計だけで残す。

## 守り（`spikes/analysis/ts/chords2/eval/guard.ts`）

開発用・ホールドアウトのもの（合成の dev / heldOut、登録した録音）を開く chords2 の道具は、**開く前に** `beginLook(req, commitArg(argv))` を呼び、集計を出し終えたら返り値の `finish()` を呼ぶ。調整用（tuning）の合成だけの仕事は「見る」に入らず、呼ばなくてよい。守りの規則はこのファイルだけに置く（`ts/bass/` は使わず、変えていない）。

- **見る時点**: `dev-1`〜`dev-5`（① G1・② G2・③〜⑤ G3〜G5）と `heldout`。どれも 1 回だけなので、開発用は最大 5 回。ログは `out/results/heldout-log.jsonl`（input `chords2`）。
- **始めの印を先に**: `look-start` の行（look・split・task・commit = HEAD の完全な sha・configHashes・takes・synthetic の数・reason）を、ファイルを開く前に書く。終わりに `look-done`。
- **2 回目は断る**: 同じ look の 2 回目の start は、終わっていても、途中で止まっていても（start だけで done が無い）断る。途中で止まった回も「見た」に数える。スパイク 6 の穴（開発用の道具に 1 回だけの守りが無い、ホールドアウトの `done` が成功の後にしか書かれない）をふさいだ。
- **走らせ直し**: 途中で止まった look だけ、`harness-fix` の行を 1 本、**直す前に**書ける（`guard.ts --log-harness-fix <look> --files ... --reason ...`）。変えてよいファイルは `spikes/analysis/ts/chords2/eval/` の下だけ（解析器・設定・正解のコードは不可）。走らせ直しは、きれいな後のコミットで、最初の start からの差分がその一覧の中だけ、configHashes・takes・合成の数が最初と同じときに 1 回だけ。
- **毎回**: `--commit` か `BAND_SHEETS_COMMIT` が必要で、HEAD と一致（7 文字以上の前方一致）、作業ツリーがきれい、task・reason・config ハッシュが空でない。takes は `recordings/chd-ids.local.json` でその look の split（dev / heldOut、`heldOut` の印と一致）に登録されていること。試運転（selftest）も `committedBlock()` でコミット済みのコードに限る。
- 状態の確認: `npx tsx ts/chords2/eval/guard.ts --status`（今は 6 つとも `unused`）。ワークツリーでは `docker exec` に `-e GIT_DIR=/workspaces/band-sheets/.git/worktrees/spike7 -e GIT_WORK_TREE=/workspaces/band-sheets/.worktrees/spike7` を渡す。

## a〜f の登録し直し（決定 6）

`ts/chords2/eval/reclassify.ts`（1 回だけの道具。2 回目は断る）を b41ba6b で走らせた。

- スパイク 6 の録音 6 本について、音・正解・元の楽譜テキスト（1 本 3 ファイル、計 18 ファイル）を `.worktrees/spike6/spikes/analysis/recordings/` から spike7 の `spikes/analysis/recordings/`（gitignore。写す前に `git check-ignore` で確かめた）へ写した。中身は開いていない（写したものがバイト単位で同じことだけ確かめた）。
- スパイク 7 の登録簿 `recordings/chd-ids.local.json` に 6 本を開発用（`split: dev`、`heldOut: false`）で登録。元の印は `from: {spike: 6, heldOut}` に残した（うち 2 本がスパイク 6 のホールドアウト）。id はスパイク 6 と同じ。
- ログに `reclassify` の行を 1 行（task T1、6 本、スパイク 6 では開発用 4・ホールドアウト 2 でホールドアウトは 1 回見た、決定 6 を引く、commit b41ba6b）。
- スパイク 6 の登録簿・ログ（15 行）は変えていない。
- `py/privacy_check.py` は `chd-ids.local.json` を他の登録簿と同じに読む（そうしないとファイル名そのものが秘密の語になり、計画の本文に当たる）。

## テスト

- `guard.test.ts`（16）: 通す（新しい dev look、5 つの dev と heldout を 1 回ずつ、他の input の行は無視）、断る（6 つ目の look、task・reason・ハッシュが空、commit 無し・HEAD と違う・汚れた作業ツリー、split の違う takes、終わった look の 2 回目）、途中で止まった場合（2 回目の start を断る、ホールドアウトも同じ、harness-fix の条件、1 回だけの走らせ直し、古いコミット・一覧の外の変更・設定の違いを断る）。
- `reclassify.test.ts`（5）: 登録と行の形、2 回目・想定外のスパイク 6 の登録簿を断る、登録後に e/f が dev look に入りホールドアウトには入らない。
- 既存: bass の守りのテストは変わらず通る。spike の TS 全体は `ts/drum/classify.test.ts` 以外が通る（このワークツリーに音色ファイル `soundfonts/`（gitignore）が無いため。T1 と関係なし）。`tsc --noEmit` 通る。Python 607 通る。`privacy_check --history --base origin/research/audio-analysis --allow-empty` は 0 で終わる。
