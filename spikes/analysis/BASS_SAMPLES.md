# スパイク 6 の合成ベースのサンプル（T1）

想定読者: スパイク 6 の T2（合成のベース）以降を受けるエージェントとユーザー。
目的: 合成に使うベースの音色 A・B・C（と B・C の代わり）の出どころ・ライセンス（原文で確認）・音域・取得方法を決める。B・C は sfz なので、T2 での読み方の注意も書く。

2026-11-01 調査。B・C でダウンロード 0.43 GB、展開後 0.46 GB（代わりも入れると 0.89 GB・1.1 GB）。取得: `bash spikes/analysis/fetch-bass-samples.sh [--with-alternates]`（音色 A は `fetch-soundfont.sh` を呼ぶ）。置き場所は gitignore の `soundfonts/`・`basskits/`。サンプルは git・アプリに入れない。

## 音色の表

音域は**鳴る高さ**（実測）。sfz の鍵盤番号とのずれは「T2 への注意」を見る。

| 音色                                                   | 楽器・弾き方                                                                                                          | ライセンス（原文の場所）                                            | 版・取得物・大きさ                                   | 録った音（鳴る高さ）                     | 強さの層 × ラウンドロビン | 長さ       | 形式                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- | ------------------------- | ---------- | -------------------------------------------------------------------- |
| **A** MuseScore_General の GM ベース                   | GM 33 Electric Bass (finger) ほか（FluidR3 系）                                                                       | MIT（既存。`DRUM_SAMPLES.md` の A と同じ）                          | 0.2、sf3 39.9 MB（既存の pin）                       | —                                        | —                         | —          | sf3 → sf2 に変換して alphaTab                                        |
| **B** Growlybass（調整・開発）                         | Squier Jazz Bass、ラウンド弦、EADG、ライン録り・両方のピックアップ・つまみ全部 10（明るい）                           | CC0 1.0（zip 内 `Growlybass/LICENSE`、repo の `LICENSE`）           | v1.002（2022-11-04）、zip 167,454,256 B、展開 183 MB | C#1〜D#4 の 14 音（3 半音ごと）          | 4（pp・p・f・ff）× 4      | 6.0 s      | WAV 24 bit・44.1 kHz・モノ                                           |
| **C** D. Smolken double bass（**ホールドアウトだけ**） | 1958 年 Otto Rubner のコントラバス（アップライト）、**ピチカート**、5 度調弦（CGDA）、Spirocore 弦                    | CC0 1.0（zip 内 `dsmolken_double_bass/LICENSE`、repo の `LICENSE`） | v1.001（2022-11-04）、zip 265,232,156 B、展開 277 MB | C1〜A3 の 11 音                          | 3（p・m・f）× 3〜4        | 6.4〜10 s  | WAV **32 bit float**・44.1 kHz・モノ（アルコも入っているが使わない） |
| B′ Swagbass（B の代わり）                              | Ibanez BTB-400QM、**フラット弦**（古い）、5 度調弦（CGDA、C 弦を A まで下げた音も）、ネックのピックアップだけ（暗い） | CC0 1.0（zip 内 `Swagbass/LICENSE`）                                | v1.001（2022-11-04）、zip 144,579,232 B、展開 167 MB | A0〜A4 の 17 音                          | 3 × 4                     | 3.6〜5.6 s | WAV 24 bit・44.1 kHz・モノ                                           |
| C′ Pastabass `linguine`（C の代わり）                  | Squier Bass VI、フラット弦、**ピック弾き**、ブリッジのピックアップ（ほかに指弾き・ミュート・ラウンド弦のマップ）      | CC0 1.0（zip 内 `Pastabass/LICENSE`）                               | v1.101（2022-11-04）、zip 315,271,331 B、展開 467 MB | C#1〜C#5 の 17 音（`fetuccine` は E1〜） | 3 × 4（`fetuccine` は 4） | 5.2〜9.4 s | WAV 16 bit・44.1 kHz・モノ                                           |

選んだ理由:

- **B（Growlybass）**: A と同じエレキベースだが、楽器・弦・録り方が違う（A は FluidR3 の指弾き、B は Jazz Bass のライン録りで、つまみを全部上げた明るい設定）。強さの層とラウンドロビンが多く、6 s 伸びる。E1〜G3 を十分に覆う（C#1 から）。開発で「知らないエレキベース」を見るのに合う。
- **C（コントラバスのピチカート）**: A・B のどちらとも違う種類（アコースティック、胴の響き、音の減り方が速い・倍音の並びが違う）。ホールドアウトで「音色が変わっても `/X` が取れるか」を一番きびしく見られる。C1〜A3 で E1〜G3 を覆う。
- **B′（Swagbass）**: B と同じエレキで、フラット弦・ネックのピックアップの暗い音。B が使えないとき、または開発をもう 1 つ増やすとき。
- **C′（Pastabass `linguine`）**: ピック弾き。C を「アップライト」でなく「ピック弾きのエレキ」にしたいときの代わり。Bass VI（6 弦）なので弦が細く、普通の 4 弦より軽い音。

確かめたこと:

- **ライセンス**: 4 つとも zip の中の `LICENSE` が Creative Commons の「CC0 1.0 Universal」の原文そのもの（「Statement of Purpose」から始まり、2. Waiver に「irrevocably and unconditionally waives, abandons, and surrenders all of Affirmer's Copyright and Related Rights」、121 行。4 つのファイルは同じバイト）。GitHub の repo の `LICENSE` も同じ文で、GitHub の判定も `CC0-1.0`。readme はどれも「Royalty-free for all commercial and non-commercial use.」。Pastabass の readme はさらに「Free download, open source and royalty-free for all commercial and non-commercial use, including conversion into other sampler formats and redistribution as part of larger sample libraries.」。表示の義務は無いので `ts/THIRD_PARTY.md` には足していない（スパイク 5 は CC0 のキットも礼として書いた。T16 で足すかを決める）。取得スクリプトが展開後の `LICENSE` に「CC0 1.0 Universal」があるかを確かめる。
- **音の高さ**: サンプルの 1 秒の倍音の和で f0 を測った（scratchpad の使い捨てスクリプト、`band-sheets-analysis` の image）。Growlybass `db2` = 34.6 Hz（C#1）・`e2` = 41.7 Hz（E1）・`c4` = 131 Hz（C3）、Swagbass `a1` = 28.0 Hz（A0）・`c2` = 33.0 Hz（C1）、Pastabass `linguine/db2` = 34.6 Hz（C#1）・`e3` = 82.6 Hz（E2）、コントラバス `pizz_c1` = 32.5 Hz（C1）・`pizz_a2` = 110 Hz（A2）。ファイル名はベースの記譜（鳴る音より 1 オクターブ上）の名前のものと鳴る音のものが混ざる。
- **形式**: sfz（プレーンテキスト）＋ WAV。ループ（`loop_mode`）は無く、サンプルの長さで音が止まる。リリースのサンプル（弦を離す音）は別のマップ（Growlybass の `dirty`、Swagbass の `swagbass.sfz`）にあり、`*_clean.sfz` には無い。
- **SHA-256**: 2026-11-01 に実際に取得して計算（取得スクリプトに固定）。GitHub の release の asset に digest は出ていない。

## T2 への注意（読み方）

- alphaTab は sf2 しか読まない。B・C・B′・C′ は sfz なので、スパイク 5 のキット B〜D と同じく**自分で読む**（`render/drum/audioFile.ts` の WAV の読み込みと `resample` を使える。C の 32 bit float の WAV もそこで読める）。ベースは音の高さと長さがあるので、ワンショットでなく小さな sfz の再生にする: `lokey`〜`hikey`・`lovel`〜`hivel` で region を選び、ラウンドロビン（`lorand`/`hirand` または `seq_position`）を種で決め、`2^((鍵 − pitch_keycenter)/12 + tune/1200)` で読み替え（同じ `resample`）、音の終わりで `ampeg_release` だけ減衰させる。sfz の opcode は `<group>` から `<region>` に受け継ぐ。パスの区切りは `\`。
- **鍵盤のずれ**: Growlybass と Pastabass の sfz は**鳴る音より 1 オクターブ上の鍵盤**に置いてある（`pitch_keycenter=37` のサンプルが C#1 で鳴る）。MIDI の音 n を鳴らすには sfz の鍵盤 n + 12 を引く。Swagbass とコントラバスは鳴る高さどおり（`pitch_keycenter=24` が C1）。正解の高さは alphaTab の MIDI の note-on から取り、描画のときだけ +12 する。T2 で 1 音ずつ f0 を測るテストを置くとよい。
- **使うマップ**: B = `growlybass_clean.sfz`（伸ばす音、リリース無し）。ミュートの音・ゴーストノート（B2）には `growlybass_vicious.sfz`（スタッカート）が使える。C = `d_smolken_rubner_bass_pizz.sfz`（鍵 84 以上は胴を叩く音などの雑音なので、ベースの音域だけを使う）。B′ = `swagbass_clean.sfz`、C′ = `linguine.sfz`。
- **長さ**: B は 6 s、C は 6〜10 s で、それより長い音は無音になる。遅いテンポの全音符（4/4・60 BPM で 4 s）は収まる。ペダルを小節をまたいで伸ばすときは区間ごとに弾き直す形にする。
- **ホールドアウト**: C と C′ は調整・開発に使わない（`heldOut: true` の変種だけ）。C′ を使うのは C をやめたときだけで、そのときは C を開発に回さない（どちらも一度も見ていない状態を保つ）。
- 音色 A は既存の `render/renderAudio.ts`（`soundfonts/MuseScore_General.sf2`）の GM のベースのまま。調整用に「別チューニング」が欲しければ、スパイク 5 のドラムの Power と同じく、同じ sf2 の GM 34〜39（ピック・フレットレス・スラップ・シンセ）を使える（中身の確認は T2）。

## 候補から外したもの

どれも sfzinstruments の repo で GitHub の判定は `CC0-1.0`（readme だけ読んだ。ダウンロードはしていない）。

| ライブラリ                               | 外した理由                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Fashionbass（Karoryfer）                 | ラウンド弦・ネックのピックアップのエレキで B・B′ の中間。B′ と同じ奏者・録り方で差が小さい    |
| Meatbass・Sneakybass（Karoryfer）        | C と同じコントラバス（Otto Rubner）。Meatbass はアルコ中心、Sneakybass はとても弱いピチカート |
| Ergo（Karoryfer）                        | エレクトリック・アップライト。C と B の中間の音で、C ほど違いがはっきりしない                 |
| Black And Blue Basses（Karoryfer、2023） | エレキ 2 本・多くの弾き方があるが zip が 1.0 GB と大きい。B・B′ で足りる                      |
| Big Little Bass（Karoryfer）             | 12 フレットより上で弾いた特殊な音。普通のベースの線の合成には向かない                         |

CC-BY・CC-BY-SA・NC のベースは要らなかった（CC0 で足りる）。

## 分け方（§4 の 調整・開発・ホールドアウト）

| 分け                      | 音色              | メモ                                                                          |
| ------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| 調整（種 1〜3）           | A                 | 計画どおり。GM 33 の指弾き                                                    |
| 開発（種 4〜5）           | A・B（B′ は予備） | 知らないエレキベース                                                          |
| ホールドアウト（種 6〜7） | C（C′ は代わり）  | 調整・開発で一度も使わない。A・B と種類が違う（アコースティックのピチカート） |

- B′・C は同じ奏者（D. Smolken）の演奏で、B も同じ Karoryfer の録音（どれもドライ。B・B′ はライン録り）。部屋の響きはミキサーで足す（§4 の B2 以降）。
- C と C′ の入れ替え（ホールドアウトをピック弾きのエレキにする）もあり得る。今の案は「A・B と一番違う種類」を優先した。
