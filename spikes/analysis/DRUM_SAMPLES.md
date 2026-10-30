# スパイク 5 の合成ドラムのサンプル（T1）

想定読者: スパイク 5 の T2（合成のドラム・ミキサー）以降を受けるエージェントとユーザー。
目的: 合成に使うキット A・B・C・D の出どころ・ライセンス（原文で確認）・入っている楽器・取得方法を決め、`ts/THIRD_PARTY.md` への追記の案を示す。キット D は T10b（2026-10-25）で足した調整用だけのキット。

2026-10-25 調査。ダウンロード 1.85 GB、展開後 2.1 GB（T10b のキット D で +0.35 GB・+0.34 GB）（`--keep-zip` で zip も残すと `drumkits/` は 3.9 GB）。取得: `bash spikes/analysis/fetch-drum-samples.sh`（キット A は `fetch-soundfont.sh` を呼ぶ）。置き場所は gitignore の `soundfonts/`・`drumkits/`。サンプルは git・アプリに入れない。

## キットの表

○ = ある、— = ない。S-拡張の列は `docs/audio-spike5-plan.md` §2 の表の対象。

| キット                                   | ライセンス（原文の場所）                                                                                       | 版・取得物・大きさ                                                                 | BD  | SD  | HH 閉/開                 | タム                  | CR  | RD  | スプラッシュ | チャイナ | カウベル | リムショット | クロススティック | ライドのベル | フットスプラッシュ | ペダル HH |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --- | --- | ------------------------ | --------------------- | --- | --- | ------------ | -------- | -------- | ------------ | ---------------- | ------------ | ------------------ | --------- |
| **A** MuseScore_General（GM の Standard） | MIT（`MuseScore_General_License.md`、取得スクリプトが保存）                                                     | 0.2（2020-05-13）、sf3 39.9 MB（既存の pin）                                       | ○   | ○   | ○ / ○（46 は Half-Open） | 6 音（41–50、3 種の音） | ○ 2 | ○ 2 | ○ 55         | ○ 52     | ○ 56     | —（GM に無い） | ○ 37 Rim Tap     | ○ 53         | —                  | ○ 44      |
| **B** Virtuosity Drums                   | CC0 1.0（zip 内 `LICENSE`、GitHub の repo の `LICENSE`）                                                        | v0.925（2026-04-21）、zip 1,227,151,376 B、展開 1.4 GB                           | ○   | ○   | ○ / ○（＋1/2・3/4）       | **2**（high・low）     | ○   | ○（＋フラットライド） | —            | —        | ○        | ○            | ○                | ○            | ○（hh splash）     | ○         |
| **C** Big Rusty Drums                    | CC0 1.0（zip 内 `LICENSE`、GitHub の repo の `LICENSE`）                                                        | v1.100（2023-04-29）、zip 619,600,370 B、展開 708 MB                             | ○   | ○   | ○ / ○（tight・1/4 など）  | **4**（14・15・18・22″） | ○（＋sizzle） | ○（＋sizzle） | —            | ○        | —        | ○            | ○ sidestick      | ○            | ○                  | ○ chik    |
| **D** MuldjordKit v1.0（sfz 版、**調整用だけ**） | **CC-BY 4.0**（zip 内 `LICENSE` = CC BY 4.0 の全文、README の License 節）。表示が要る（下の追記）                | commit `fc16571`（2021-08-15）の archive、zip 346,255,411 B、展開 340 MB           | ○ 2 | ○   | ○ / ○                    | **4**（3 つ吊り＋フロア） | ○ 2 | ○ 2 | —            | ○        | —        | —            | —（SnareRest は不明なので使わない） | ○            | —                  | —（チョークの鍵だけ） |

強さの層とマイク（ミキサーの「近さ」に使える）:

| キット | 強さの層                                                                     | ラウンドロビン | マイク                                                        | 形式            |
| ------ | ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------- | --------------- |
| A      | 1 つのサンプル（BD・SD だけ強さで低域通過の周波数が変わる 7 区間。中身は同じ音） | なし           | ステレオ 1 本（ドライ）                                       | sf3（Vorbis）   |
| B      | 層ごとに 1 ファイル（SD 中心 36、ほか 9〜16）                                  | 層で代用       | kick・snare・mid・oh・room・lofi の 6 本、各ステレオ          | FLAC 24 bit・48 kHz・ステレオ（perc は WAV） |
| C      | 4〜14（SD 中心 10、BD 14、CR 5）                                               | 3〜4           | 近い（kick・top/btm・cl）＋ oh。room は無い                   | FLAC 16 bit・44.1 kHz・モノ |
| D      | 4〜5（sfz の `lovel=$vXXl` の順。ピークで弱→強を確認）                          | 1〜11          | 16 本のモノ（近い・OH L/R・Amb L/R ほか。どの打点も全マイク） | FLAC 24 bit・44.1 kHz・モノ |

確かめたこと:

- **A の楽器**: sf3 の `pdta` を読んで bank 128 の preset 0（Standard）の鍵盤ごとの zone を列挙（scratchpad の使い捨てスクリプト、git には入れない）。スプラッシュ 55 `Splash`、チャイナ 52 `China Crash`、カウベル 56 `Cow Bell`、ライドのベル 53 `BellRide`、サイドスティック 37 `Rim Tap`、ペダル HH 44 `Hi-Hat Foot` はある。46 は `Hi-Hat Half-Open`（全開は無い）。40 は `Std Snr 2`（エレクトリックスネア）でリムショットではない。フットスプラッシュは無い。タムは 41/43 `Low Flr`・`Flr`、45 `Low`、47 `Md`、48 `MdHi`、50 `Hi`（6 音・6 サンプル）。
- **A の強さの層**: BD 35/36・SD 38 は 7 つの velRange があるが、全部が同じサンプル（`Std Kick#816`・`Std Snr 1#774`）で、`initialFilterFc` だけが 11108→11921（BD）、11690→12308（SD）と変わる。ほかの楽器は 1 区間。つまり**本当の強さの層は無い**。
- **A の別の音色**: preset 16（Power）は BD・SD・タムが別のサンプル（`Power Bass Drum 2`・`Power Snare 1`・`Tom Floor` など）、シンバル・HH は Standard と同じ。preset 8（Room）は BD だけ別、preset 32（Jazz）は BD・SD が別。調整用の「別チューニング」に使える（キット B・C は使わない）。
- **A のライセンス**: `MuseScore_General_License.md` に「MuseScore_General.sf2 is shared under the MIT license as described in COPYING, as was FluidR3Mono and FluidR3 before it.」。COPYING は MIT の全文（Copyright (c) 2014-16 Michael Cowgill, (c) 2000-2002, 2008 Frank Wen）。ドラムキット（bank 128 の 0〜48）は `MuseScore_General_Sample_Sources.csv` に別の出どころの記載が無い（＝ FluidR3Mono のまま）。別の出どころは 56〜59 の Marching 系だけで、使わない。また「The acknowledgements and copyright notices above must be included in any derivative work.」とある（下の追記の案に入れる）。
- **B・C のライセンス**: どちらも Creative Commons の「CC0 1.0 Universal」の原文そのもの（Statement of Purpose から始まる全文）。取得スクリプトが展開後の `LICENSE` に「CC0 1.0 Universal」があるかを確かめる。B の README: 「Virtuosity Drums KVRDC'21 entry by Versilian Studios and Karoryfer Samples」。
- **SHA-256**: 2026-10-25 に実際に取得して計算（取得スクリプトに固定）。B は GitHub の release の asset の digest（`sha256:c6c5d0fe…`）とも一致。

## キット D（T10b、調整用だけ）

- **なぜ**: T10 で、未知のキット（B）の閉じた HH がキット A の RD のテンプレートに吸われると分かったが、キット A のアコースティックのプリセットは HH・RD・CR が同じサンプルなので、調整用の中で再現できなかった。ユーザーの決定（2026-10-25）: CC-BY のキットを表示つきで調整用だけに足す。B・C は調整に使わない。
- **選んだもの**: T1 で「C の代わりの第一候補」にしていた MuldjordKit（Tama Superstar、2010 年録音のメタル・ロックのキット）。HH 閉・開、RD（＋ベル）、CR、チャイナ、タム 4 つがそろい、シンバルは FluidR3 と別の録音。Naked Drums（CC-BY 4.0）も同じ条件を満たすが、1.25 GB と大きいので 1 つで止めた。CC0 のシンバル付きのキットは T1 の調べで B・C 以外に無い（The Hat With The Phat は CC0 だが HH だけで、C と同じ Karoryfer なので避けた）。
- **ライセンス（原文で確認）**: zip の `LICENSE` は「Attribution 4.0 International」の全文、README の License 節は「This work is licensed under a Creative Commons Attribution 4.0 International License」。README に「This work is not to be used as in the original scope with the DrumGizmo software and then don't contact the original authors for any reason about it.」とある（DrumGizmo では使わない・作者に連絡しない）。表示の文は `ts/THIRD_PARTY.md`（作者・出どころ・ライセンスの URL・変更の内容）。
- **取得**: release が無いので、固定した commit の archive（codeload）を SHA-256 で固定（2026-10-25 に 2 回取得して同じバイト）。取得スクリプトが展開後の `LICENSE` に「Attribution 4.0 International」があるかを確かめる。
- **楽器の対応**（`render/drum/kits.ts` の `KIT_D`）: BD = KdrumL、SD = Snare（top＋bottom）、HH = HihatClosed、HO = HihatOpen、T1・T2・FT = Tom1・Tom2・Tom4、CR = CrashL（近いマイク無し、OH だけ）、RD = RideR、RD.bell = RideRBell、CN = China。無いもの: スプラッシュ、カウベル、リムショット、クロススティック（SnareRest は叩き方が分からないので対応させない）、ペダル HH、フットスプラッシュ。
- **混ぜ合わせのキット H**: キット A の太鼓（＋カウベル・クロススティック）に、キット D の HH・HO・RD・RD.bell・CR・CN（近いマイクの混ぜ方、キット A の同じ楽器と最初の 100 ms の RMS をそろえる）。シンバルの音だけを変えた効き方を見るため。HH.foot・SP は A の金属なので外した。
- **作った量と確認（2026-10-30）**: キット D・H とも種 11〜13 で 114 本（D0 27・D1 30・D2 30・D3 27、キット A の調整用と同じ数）。正解の時刻は全打点（各 14,014）が ±1 ms 以内（最大 0.023 ms）、クリップ無し。キット A のテンプレート（config drum-v0 a3e68494763b）での分類（`classify_eval.ts --split tuning --detail`）で HH の F50 は D: D0 .844・D1 .821・D2 .835・D3 .028（取りこぼし。P ≒ .98、R ≒ .73、D3 は R .01）、H: .990・.960・.964・.715（HH は取れるが SD の P が .41〜.68 に落ちる）。キット D で未知のキットの HH の問題が調整用の中で再現する。

## 分け方の案（§4 の 調整・開発・ホールドアウト）

| 分け       | キット                                         | 理由                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 調整（A、D、H） | MuseScore_General Standard（＋ Power を別チューニングに）。T10b から種 11〜13 でキット D・H も | 計画どおり。S-拡張のうちスプラッシュ・チャイナ・カウベル・ベル・クロススティック・ペダルがそろう。強さの層が無いので、強さはフィルタと音量の変化だけ（D1 の「強さの揺れ」は音色が変わらない点に注意） |
| 開発（B）   | Virtuosity Drums                               | 本物の強さの層が多く、room・oh のマイクがあるので「近さ」を試せる。S-拡張の叩き方（リム・クロス・ベル・フットスプラッシュ・ペダル）とカウベルがそろう。タムが 2 つ（§2 の「タムの数がキットで違う」を開発で見られる）          |
| ホールドアウト（C） | Big Rusty Drums                                | 9 種類が全部そろう（タム 4 つ）。叩き方の S-拡張がそろい、チャイナもある。B と録音場所・奏者・マイクが違う                                                                                                                  |

- スプラッシュは A にしか無い（B・C・候補のどれも CC0 で普通のスティックのものが無い）。スプラッシュは「調整用の合成だけで測る」になる。カウベルは C に無い（A・B だけ）。
- C は room マイクが無い。ホールドアウトの部屋は §4 どおりミキサーの部屋（調整・開発で使わない部屋）で作る。
- B と C の入れ替え（C を開発、B をホールドアウト）もあり得る。今の案は「ホールドアウトに 9 種類が全部ある」ことを優先した。

## 候補から外したもの

| キット                                 | ライセンス                 | 外した理由                                                                                                       |
| -------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Swirly Drums（Karoryfer）              | CC0 1.0（repo の `license`） | ブラシで叩いたキット。BD がカホン・マーチングのキック。スプラッシュ・チャイナ・カウベルはあるが、スティックの音ではない |
| Unruly Drums（Karoryfer）              | CC0 1.0                    | 全部の太鼓にスナッピーが付いた特殊なキット                                                                       |
| SM Drums（sfzinstruments）             | 「Public Domain」と一覧に書いてあるだけ | repo に LICENSE が無く、本家（smmdrums.wordpress.com）にも許諾の文が無い。あいまいなので使わない               |
| MuldjordKit・DRSKit（DrumGizmo の sfz 版） | CC-BY 4.0                  | 表示が要る。古い版の移植で「元の作者に連絡しないこと」と README にある。B・C で足りる（Muldjord はタム 4・チャイナ・ベルがあり、C の代わりの第一候補）。**T10b で Muldjord を調整用だけのキット D に採用** |
| Naked Drums（Wilkinson Audio）         | CC-BY 4.0                  | 表示が要る。B・C で足りる                                                                                        |
| Salamander Drumkit・Sam's Sonor        | CC-BY-SA                   | 継承の条件付き。計画のライセンスの規則（CC0・PD・MIT/BSD 系）の外                                                |

## キット A のワンショットの取り出し方（T2 向けの推奨）

**推奨: 今の alphaTab の描画の道（`render/renderAudio.ts` の `musescore` = `soundfonts/MuseScore_General.sf2`）で、1 音だけの MIDI を楽器ごと・強さごとに描いて wav にする。** sf2 のサンプルの塊を直接読むのはやめる。

- 理由: 鳴る音は sample だけでなく、zone の generator（BD・SD の強さごとの `initialFilterFc`、エンベロープ、減衰、音量 `initialAttenuation`、パン、チューニング）で決まる。直接読むとこれを全部自分で書き直すことになり、今の合成（スパイク 0〜4 の伴奏）とも音が合わなくなる。描画なら A のドラムの鳴り方が alphaTab の再生そのもので、手間も小さい（`renderAudio.ts` の関数に MIDI を渡すだけ）。
- やり方: チャンネル 10（bank 128、program 0。別チューニングは 16）で、鍵盤 35〜59 の使う音ごとに、強さ 32・56・80・104・127 などの数段で 1 音を描く。長さは音が消えるまで（シンバル 6 s、ほか 2 s 程度。末尾は −90 dB で切る）。最初のサンプルが 0 でない位置を「音の始まり」として記録し、ミキサーはそこを打点に合わせる（正解 ±1 ms の条件）。ステレオはモノに下ろす（今の `downmixStereo`）。描いた wav は `drumkits/musescore/` に置き、キャッシュとして扱う（毎回作り直してよい）。
- リスク: ① alphaTab の強さ → 音量の曲線は GM の既定（sf2 の modulator）で、強さの層が無いので音色の差は小さい（上の確認のとおり）。② HH の 42/44/46 は sf2 の `exclusiveClass` で互いに止め合う。1 音ずつ描くとその効果は出ないので、ミキサー側で「次の HH の打点で前の HH を短くフェードアウト」を自分で書く（B・C も同じ処理が要る）。③ 描画の始まりに無音や遅れがあれば、始まりの検出で吸収する（固定の値を仮定しない）。④ sf3 → sf2 の変換（`sf3ToSf2.py`）が前提。osuosl に公式の `MuseScore_General.sf2`（215,614,036 B、2020-07-10）もあるが、今の pin は sf3 なので変えない。

B・C は sfz のサンプルが FLAC/WAV のワンショットそのもの（層 `vlN`・ラウンドロビン `rrN`・マイクがファイル名とフォルダで分かれる）なので、sfz を解釈せずファイル名から表を作れる。FLAC の読み込みと B の 48 kHz → 44.1 kHz の変換は T2 で決める（例: 取得後に Python の画像で 44.1 kHz の WAV に一度だけ変換して `drumkits/` に置く）。

## `ts/THIRD_PARTY.md` への追記の案

T2 でサンプルを使い始めるときに入れる（今は案だけ）。

```markdown
## Drum samples for spike 5's synthetic data (not shipped, not in git)

Downloaded by `spikes/analysis/fetch-drum-samples.sh` (SHA-256 pinned) into the gitignored
`spikes/analysis/soundfonts/` and `spikes/analysis/drumkits/`. Used only to render local test
audio; never committed, never bundled into the app. Details: `spikes/analysis/DRUM_SAMPLES.md`.

- MuseScore_General 0.2 (MIT; drum kit = FluidR3Mono samples). Notice required in derivative
  works: "FluidR3 (original version) by Frank Wen Copyright (c) 2000-02; Mono conversion
  (FluidR3Mono) by Michael Cowgill Copyright (c) 2014-17; Adaptation for MuseScore_General.sf2 by
  S. Christian Collins Copyright (c) 2018-19." Full text: `soundfonts/MuseScore_General_License.md`.
- Virtuosity Drums v0.925 by Versilian Studios and Karoryfer Samples (CC0 1.0 Universal).
  https://github.com/sfzinstruments/virtuosity_drums
- Big Rusty Drums v1.100 by Karoryfer Samples (CC0 1.0 Universal).
  https://github.com/sfzinstruments/karoryfer.big-rusty-drums
```
