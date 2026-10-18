# スパイク 3 T2: librosa 0.11.0 の挙動メモ（TS に移すための元）

2026-10-17 作成（T2）。計画 `audio-spike3-plan.md` の設計判断 6 の「1 か所」がこの文書。T4〜T6（と波 2）の実装は、ここに書いた挙動に従う。ここと librosa のソースが食い違ったら、ソースが正しい（見つけたらこの文書を直す）。

**読んだもの**: Docker のイメージ `band-sheets-analysis` の中のソース（`/usr/local/lib/python3.12/site-packages/`）。版は librosa 0.11.0・scipy 1.18.1・numpy 2.5.3・numba 0.68.0・soxr 1.1.0（`requirements.lock.txt` と同じ）。数値の確かめは、同じイメージの中で小さな合成のサイン波を使った（録音・曲の値は使っていない）。

**対象**: 既定の設定（`adec583eb3c6`）で通る呼び出しだけ。`py/dsp/` で librosa を使うのは `audio.py`・`beats.py`・`chroma.py`・`tempo.py` の 4 つで、ほかの段階（コード・小節の頭・セクション・調・後押し）は numpy だけ（`sections.py` の `np.fft.rfft` は §13）。

各節の書き方: **呼び方**（私たちのコードが渡す値）/ **効く既定値** / **端** / **型** / **合わせ方**（**必須** = 移植で同じにしないと値や形が変わる、**近似可** = 実装が違っても §15 の許す差に収まる）。

## 0. 既定の設定で通る呼び出し

| 場所                                | 呼び出し                                                                                                                                                                                 | 中で呼ばれるもの                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `audio.py`                          | `librosa.load(path, sr=22050, mono=True)`                                                                                                                                                | soundfile（float32）→ `to_mono` → `resample(soxr_hq)`                                                    |
| `audio.py`（`(y, sr)` を渡すとき）  | `librosa.to_mono`、`librosa.resample(y, orig_sr, target_sr=22050)`                                                                                                                       | sr が 22050 なら何もしない                                                                               |
| `audio.py`                          | `librosa.effects.hpss(y, margin=1.0)`                                                                                                                                                    | `stft` → `decompose.hpss`（`median_filter`・`softmask`）→ `istft` ×2                                     |
| `audio.py`                          | `librosa.onset.onset_strength(y=y_perc, sr=22050, hop_length=512)`                                                                                                                       | `melspectrogram`（`stft`・`filters.mel`）→ `power_to_db` → 差分 → 平均                                   |
| `beats.py`                          | `librosa.beat.beat_track(onset_envelope=env, sr, hop_length=512, start_bpm=120, tightness=100, trim=False)`                                                                              | `feature.tempo`（`tempogram`・`autocorrelate`）→ DP（numba）                                             |
| `beats.py`                          | `librosa.frames_to_time(frames, sr, hop_length=512)`                                                                                                                                     | —                                                                                                        |
| `chroma.py`                         | `librosa.feature.chroma_cqt(y=y_harm, sr, hop_length=512, fmin=32.7, n_octaves=6, bins_per_octave=36, norm=None)`                                                                        | `cqt` → `vqt`（`estimate_tuning`・`piptrack`・soxr の間引き・`filters.wavelet`）→ `filters.cq_to_chroma` |
| `chroma.py`                         | 同じで `n_octaves=3`（低音）                                                                                                                                                             | 同上（間引きの道が違う。§7）                                                                             |
| `chroma.py`                         | `librosa.time_to_frames(times, sr, hop_length=512)`                                                                                                                                      | —                                                                                                        |
| `tempo.py`（`tempo_octave='rule'`） | `librosa.stft(y_harm, n_fft=4096, hop_length=512)`、`librosa.fft_frequencies(sr, n_fft=4096)`、`librosa.feature.chroma_stft(S=..., sr, n_fft=4096, tuning=0.0)`、`librosa.util.localmax` | `filters.chroma`                                                                                         |

既定では**使わない**（移さない）: `beat.plp`、`chroma_cens`、`util.sync`（`chroma.py` は自前で列を作る）、`voicing.discount_top_voice`（`top_voice_discount=0`）。

## 1. 全体に効く約束

- **FFT は `scipy.fft`**（`librosa.core.fft.get_fftlib()` の既定。`numpy.fft` ではない）。scipy の FFT は入力が float32 / complex64 なら**単精度で計算**し、float64 なら倍精度で計算する。librosa の STFT は「float64 の窓 × float32 のフレーム」なので**倍精度で計算してから complex64 に丸めて保存**する。TS は fft.js（倍精度）で計算し、結果を Float32Array に入れれば、保存の型まで Python と同じになる（メモリも半分）。**近似可**（差は 1e-7 の桁）。
- **numpy 2 の型の決まり（NEP 50）**: float32 の配列に Python の float を掛けても float32 のまま。だから `power_to_db`・`piptrack`・`pitch_tuning` は float32 で計算される（§5・§8）。
- **丸めは「偶数への丸め」**: `np.round` は 0.5 を偶数に丸める（`np.round(10.5) = 10`、`np.round(11.5) = 12`）。numba の中の `np.round` も同じ（イメージの中で確かめた）。JS の `Math.round` は 0.5 を上に丸めるので、**拍の DP で 1 ずれる**（§6）。`roundHalfEven` を作って使う。**必須**。
- **余り**: `np.mod` / `np.remainder` は割る数の符号（正）になる。JS の `%` は割られる数の符号。既定の道では引数が正なので結果は同じだが、正の余りの関数を使う。
- **窓**: librosa の `get_window('hann', N)` は scipy の**周期的な**ハン窓（`fftbins=True`、`0.5 − 0.5·cos(2πn/N)`、n = 0..N−1）。私たちのコードの `np.hanning(M)`（`beats.py` の `_refine`、`sections.py`）は**対称な**ハン窓（`0.5 − 0.5·cos(2πn/(M−1))`、両端が 0）。取り違えない。**必須**。
- **中央寄せの詰め物は 0**: librosa 0.10 から `stft` の `pad_mode` の既定は `'constant'`（0 で詰める）。`'reflect'` ではない（古い記事は reflect と書いている）。既定の道のすべての STFT（HPSS・打撃・テンポの `rule`・CQT の各オクターブ・`piptrack`）が 0 詰め。**必須**。
- **キャッシュ**: `@cache(level=...)` は joblib のキャッシュで、既定では切ってある（`LIBROSA_CACHE_DIR` なし）。挙動には関係しない。

## 2. `load`・`to_mono`

**呼び方**: `librosa.load(path, sr=22050, mono=True)`（`offset=0`、`duration=None`、`dtype=float32`、`res_type='soxr_hq'`）。

- 読み込み: soundfile（libsndfile）で `dtype=float32`。整数の PCM は libsndfile が float に変える（16 bit なら ÷32768）。soundfile が読めないときだけ audioread（ffmpeg）に落ちる（0.10 から非推奨の道）。
- モノラル: `np.mean(y, axis=0)` を float32 で。2 チャンネルなら `(L + R) / 2` を float32 に丸めた値と同じ（L + R は倍精度で誤差なしに表せるので、TS の `Math.fround((L + R) * 0.5)` と**ビットまで同じ**）。
- 変換: `resample(y, orig_sr, 22050, res_type='soxr_hq', fix=True, scale=False)`。長さは `ceil(n · 22050 / orig_sr)` に揃える（足りなければ 0 を足し、多ければ切る）。sr が同じなら何もしない。出力は入力と同じ float32。soxr は LGPL なので移さない（設計判断 2 の自前の窓つき sinc）。
- **合わせ方**: モノラル化は**必須**（簡単に同じにできる）。変換は**近似可**で、§4 の決めどおり段階ごと・通しの比べでは外す（Python の 22050 Hz の信号をそのまま TS に渡す）。
- ブラウザの注意（T8 向け）: `decodeAudioData` は**コンテキストの sr に変換してから**返す（44.1 kHz のファイルを 48 kHz のコンテキストで読むと 48 kHz になる）。元の sr のまま欲しいなら、ファイルの sr と同じ sr の `OfflineAudioContext` で読む（WAV はヘッダーから、mp3・m4a は一度読んで `buffer.sampleRate` を見る）。mp3 の先頭の遅延（エンコーダーの詰め物）の扱いは libsndfile とブラウザで違うことがあり、数十 ms ずれる恐れがある（合成の wav では起きない。録音を使うときに確かめる）。

## 3. `stft`・`istft`

**呼び方**（HPSS・打撃）: `n_fft=2048`、`hop_length=512`、`win_length=2048`、`window='hann'`（周期的）、`center=True`、`pad_mode='constant'`。テンポの `rule` は `n_fft=4096`、hop 512、ほかは同じ。

- フレーム数: 中央寄せでは `1 + floor(n / hop)`（n は信号の長さ）。フレーム t の中心は元の信号の t·hop。前後に `n_fft/2` 個の 0 を足した信号を切り出すのと同じ（librosa は先頭と末尾だけ別に詰めて計算するが、結果は同じ）。
- 計算: 各フレームに窓（float64）を掛けて `rfft`（float64）→ complex64 で保存。出力の形は `(1 + n_fft/2, フレーム数)`。
- `istft`（HPSS の後）: `n_fft=2048`、hop 512、hann、`center=True`、`length=len(y)`、`dtype=float32`。各フレームを `irfft`（complex64 の入力なので単精度）して窓を掛け、float32 の配列に重ねて足す。最後に「窓の二乗の重ね合わせ」（`window_sumsquare`、float32 で足したもの）で割る。割るのはその値が float32 の `tiny`（1.18e-38）より大きい所だけ。中ほどでは値が 1.5（hann・hop = n_fft/4）で一定、先頭（約 512 サンプル）と末尾（数百サンプル、長さの 512 の余りで変わる）は小さくなる。出力の長さは `len(y)` ちょうど（`center` の詰め物の分を切った後、足りなければ 0、多ければ切る）。
- **合わせ方**: フレームの数と位置、0 詰め、周期的な窓、`window_sumsquare` での割り算（端も含む）は**必須**。FFT の実装と計算の精度は**近似可**。

## 4. `effects.hpss`・`decompose.hpss`・`median_filter`・`softmask`

**呼び方**: `effects.hpss(y, margin=1.0)` → `kernel_size=31`、`power=2.0`、`mask=False`、STFT は §3（2048 / 512 / hann / 中央寄せ / 0 詰め）。

1. `D = stft(y)`（complex64）。`magphase(D)`: `S = |D|`（float32）、`phase = D / |D|`（|D| = 0 の所は phase = 1 + 0i）。**中央値は振幅（|D|）にかける**（パワーではない。`power=2` はマスクの指数）。
2. `harm = median_filter(S, size=(1, 31), mode='reflect')`（時間の方向に 31 フレーム）、`perc = median_filter(S, size=(31, 1), mode='reflect')`（周波数の方向に 31 bin）。2 次元の入力なので scipy の C の `rank_filter` で、31 個の中の 16 番目（rank 15）をそのまま選ぶ（平均しない）。出力は float32。
   - **scipy の `'reflect'` は端の値を含めて折り返す**: `d c b a | a b c d | d c b a`。numpy の `np.pad(mode='reflect')` は端を含めない（`d c b | a b c d`）ので、numpy では `'symmetric'` に当たる。時間の方向は最初と最後のフレーム、周波数の方向は 0 Hz とナイキストの bin で折り返す。**必須**。
3. マスク: `margin = 1` なので `split_zeros=True`。`softmask(X, X_ref, power=2)`: `Z = max(X, X_ref)`、`Z < tiny(float32)` の所は `Z = 1` にして、マスク = 0.5（`split_zeros`）。ほかは `m = (X/Z)²`、`r = (X_ref/Z)²`、マスク = `m / (m + r)`。全部 float32。`mask_harm = softmask(harm, perc)`、`mask_perc = softmask(perc, harm)`（足すと 1）。
4. `stft_harm = (S · mask_harm) · phase`、`stft_perc` も同じ（complex64）→ それぞれ `istft(length=len(y), dtype=float32)`。

- 型: すべて float32 / complex64。
- **合わせ方**: 31・reflect（scipy の意味）・振幅にかけること・マスクの式（0.5 の所を含む）・逆 STFT は**必須**。中央値は「選ぶ」だけなので、入力が同じビットなら TS でもビットまで同じになる（窓をずらしながらの並べ替えでよい）。float32 の丸めの差でマスクが 1e-7 ほど変わるのは**近似可**。
- メモ（T4 向け）: マスクは列ごとに決まる（時間の方向の中央値は前後 15 フレームだけを見る）ので、全体の STFT を持たずに、時間のブロックごと（前後 15 フレームの重なりつき）に計算して逆 STFT へ流せる。5 分で 100 MB を超える複素の配列を避けられる。

## 5. `melspectrogram`・`power_to_db`・`onset_strength`

**呼び方**: `onset_strength(y=y_perc, sr=22050, hop_length=512)` → `onset_strength_multi(n_fft=2048, lag=1, max_size=1, ref=None, detrend=False, center=True, feature=melspectrogram, aggregate=np.mean)`、メルには `fmax=sr/2` が足される。

1. `S = |stft(y_perc)|²`（2048 / 512 / hann / 中央寄せ / 0 詰め、float32）。
2. メルのフィルタ `filters.mel(sr=22050, n_fft=2048, n_mels=128, fmin=0, fmax=11025, htk=False, norm='slaney', dtype=float32)`:
   - メルの尺度は Slaney 式（1000 Hz まで線形 `f / (200/3)`、その上は対数 `15 + ln(f/1000) / (ln 6.4 / 27)`）。HTK 式ではない。
   - 中心は `mel_frequencies(130, 0, 11025)`（メルで等間隔の 130 点を Hz に戻す）。bin の周波数は `rfftfreq(2048, 1/sr)`。三角形 = `max(0, min(−(f_i − f)/(f_{i+1} − f_i), (f_{i+2} − f)/(f_{i+2} − f_{i+1})))`（float64 で計算して float32 に入れる）。
   - Slaney の正規化: 行 i に `2 / (f_{i+2} − f_i)` を掛ける（面積をそろえる）。
3. `M = mel @ S`（`einsum`、float32、BLAS で足す順番は不定）。
4. `power_to_db(M)`（`ref=1.0`、`amin=1e-10`、`top_db=80`）: `10·log10(max(1e-10, M))`、それから**曲全体の最大値** − 80 dB より下を持ち上げる。float32 で計算。**曲全体を見てからでないと切れない**（流しながら計算するなら 2 回に分ける）。
5. 差分: `max(0, S_db[:, t+1] − S_db[:, t])`（lag 1、ref = 自分自身）。
6. 128 本の平均（`np.mean`、float32）。
7. 先頭に **3 個の 0** を足し（lag 1 + `n_fft // (2·hop)` = 2）、フレーム数（`1 + floor(n/512)`）で切る。つまり `env[0..2] = 0`、`env[t] = mean_m max(0, S_db[m, t−2] − S_db[m, t−3])`（t ≥ 3）。

- 型: 出力は float32、長さ = STFT のフレーム数。
- **合わせ方**: Slaney の式と正規化、全体の最大での 80 dB、3 フレームのずらし、平均は**必須**。足す順番・float32 と float64 の差は**近似可**（相対 1e-6 の桁）。

## 6. `feature.tempo`・`beat_track`

**呼び方**: `beat_track(onset_envelope=env, sr=22050, hop_length=512, start_bpm=120.0, tightness=100.0, trim=False)`（`bpm=None`、`prior=None`、`units='frames'`、`sparse=True`）。`env` が全部 0 なら `(0.0, [])` を返す（`beats.py` は先に弾いている）。

### テンポ（`feature.tempo`）

既定の値: `std_bpm=1.0`、`ac_size=8.0`、`max_tempo=320.0`、`aggregate=np.mean`。

1. `win_length = time_to_frames(8.0) = floor(176400 / 512) = 344`。
2. `tempogram(onset_envelope=env, win_length=344, center=True, window='hann', norm=inf)`:
   - 前後に 172 個ずつ `np.pad(mode='linear_ramp', end_values=0)` で足す。左は `env[0]·i/172`（i = 0..171、外側が 0）、右は `env[-1]·(171−j)/172`（j = 0..171、外側が 0）。`linspace(0, 端の値, 172, endpoint=False)` と同じ並び。
   - hop 1 で 344 の長さを切り出し（フレーム数 = env の長さ）、周期的なハン窓（344）を掛ける（float64）。
   - 各フレームの自己相関: `irfft(|rfft(x, n=720)|², 720)[:344]`（720 = `scipy.fft.next_fast_len(687)`）。2·344 − 1 以上の長さなら値は同じなので、**TS は 1024 でよい**（近似可）。
   - 各フレームを最大の絶対値で割る（最大が `tiny` 未満のフレームはそのまま）。
3. 時間の平均 → 長さ 344 の `tg`。
4. `bpms[k] = 60·22050 / (512·k)`（`bpms[0] = inf`）。事前分布 `logprior = −0.5·(log2(bpms) − log2(120))²`。`bpms < 320` が最初に真になる k は 9 なので、k < 9 は `−inf`。
5. `k* = argmax(log1p(1e6·tg) + logprior)`（同点は小さい k）。`tempo = bpms[k*]`（float64、形 (1,)）。

### 拍（Ellis の DP）

1. `frames_per_beat = np.round(frame_rate · 60 / tempo)`、`frame_rate = 22050/512`。テンポが表の値なので、これは k\*（整数）になる。
2. 正規化: `env / (env.std(ddof=1) + tiny)`（float32 のまま）。
3. **型**: `frames_per_beat` が float64 なので、numba の guvectorize は float64 の版を選ぶ（局所の得点・累積の得点は float64。イメージの中で確かめた）。
4. 局所の得点（`__beat_local_score`）: 窓 `w[j] = exp(−0.5·(j·32/fpb)²)`、j = −fpb..fpb（長さ K = 2·fpb + 1）。`localscore[i] = Σ_k w[k]·env[i + K//2 − k]`、k は `max(0, i + K//2 − N + 1) ≤ k < min(i + K//2, K)`。上の端が `i + K//2` で止まるので **`env[0]` は決して使われない**（librosa の端の 1 つずれ。`env[0..2]` は常に 0 なので結果は変わらないが、そのとおりに書く）。
5. DP（`__beat_track_dp`）: `score_thresh = 0.01·max(localscore)`。i = 0 から順に、`loc` を `i − round(fpb/2)` から `i − 2·fpb` まで**1 ずつ減らしながら**（`loc < 0` で止める）、`score = cumscore[loc] − tightness·(ln(i − loc) − ln(fpb))²` の最大を探す。更新は「より大きいとき」だけ（**同点は i に近い方**）。見つかれば `cumscore[i] = localscore[i] + best`、なければ `localscore[i]`。`backlink[i]` は、まだ最初の拍の前で `localscore[i] < score_thresh` なら −1、そうでなければ `best` の位置（最初にしきい値を超えた後はずっと）。
   - **`round(fpb/2)` は偶数への丸め**。fpb が奇数（例 21）だと 10.5 → 10。`Math.round` だと 11 になり、探す範囲が 1 フレームずれる。**必須**。
6. 最後の拍（`__last_beat`）: `cumscore` の局所の最大（§12 の `localmax`）の中央値（`np.ma.median`、偶数個なら真ん中 2 つの平均）の半分をしきい値に、**後ろから見て最初の「局所の最大かつしきい値以上」**のフレーム。なければ最後のフレーム。
7. 後ろから `backlink` をたどって拍の印を立てる。
8. `__trim_beats`（`trim=False` でも走る）: しきい値は 0。**先頭から `localscore ≤ 0` が続く間のフレーム**と、**末尾から `localscore ≤ 0` が続く間のフレーム**の印を消す。完全な無音（デジタルの 0）が前後にあると効く。
9. `np.flatnonzero` → 昇順のフレーム番号（int64）。

- その後は私たちのコード: `frames_to_time`（§11）→ `_refine`（`np.hanning` は対称、§13）。
- **合わせ方**: テンポの表・事前分布・320 の切り・argmax の同点、DP の範囲・偶数への丸め・同点の扱い・最初の拍の決まり・最後の拍の選び方・前後の切り、はすべて**必須**。テンポの bin が 1 つずれると拍の並び全体が変わるので、`log1p(1e6·tg) + logprior` が 2 位と近いときに TS と Python で順位が入れ替わる恐れがある（記録する。§15）。

## 7. `cqt`・`vqt`

**呼び方**: `chroma_cqt` から `cqt(y_harm, sr=22050, hop_length=512, fmin=32.7, n_bins=216 または 108, bins_per_octave=36, tuning=None)`。ほかは既定: `filter_scale=1`、`norm=1`、`sparsity=0.01`、`window='hann'`、`scale=True`、`pad_mode='constant'`、`res_type='soxr_hq'`、`dtype=None`（→ complex64）。`cqt` は `vqt(intervals='equal', gamma=0)` を呼ぶだけ。

### 手順

1. `tuning = estimate_tuning(y=y_harm, sr=22050, bins_per_octave=36)`（§8）。`fmin' = 32.7 · 2^(tuning/36)`。
2. 周波数: `freqs[j] = fmin' · 2^(j/36)`（j = 0..n_bins−1。実装は「オクターブ 2^o × 比 2^(b/36)」を並べて並べ替え）。
3. 相対の帯域: 等間隔なので全部 `alpha = (2^(2/36) − 1)/(2^(2/36) + 1) = 0.0192517`（実装は隣との log2 の差から計算。端は片側）。`Q = 1/alpha`。
4. `wavelet_lengths(freqs, sr)`: `lengths = Q·sr/freqs`、`filter_cutoff = max(freqs·(1 + 0.5·1.50018310546875/Q))`（1.500183… はハン窓の帯域の表の値）。
5. **最初の間引き**（`__early_downsample`）: `count = min(max(0, ceil(log2(11025/filter_cutoff)) − 2), max(0, (512 の 2 の因数 = 9) − n_octaves + 1))`。間引くなら `soxr_hq` で `2^count : 1` に一度で変え、`scale=True`（× sqrt(2^count)）。hop と sr も 2^count で割る。**この後の `sr` は間引いた後の値**（下の 7・9 で使う）。
6. オクターブごと（上のオクターブから）: その 36 本のカーネルを今の `my_sr` で作り（下）、`fft_basis *= sqrt(sr / my_sr)`、応答を計算。それから `my_hop` が偶数なら `my_hop //= 2`、`my_sr /= 2`、`y = resample(y, 2 → 1, soxr_hq, scale=True)`（× sqrt(2)、長さ `ceil(n/2)`）。**最後のオクターブの後にも 1 回間引く**（使われない。TS は省いてよい）。
7. カーネル（`filters.wavelet` → `__vqt_filter_fft`）、bin ごとに:
   - 長さ `L = Q·my_sr/f`（小数）。標本は `n = arange(−ceil(L/2), floor(L/2))`（Python の `-L // 2` は `floor(−L/2)`）。数は `floor(L/2) + ceil(L/2)`。
   - `sig = exp(i·2π·f·n/my_sr)`（`cos + i·sin`、float64）× 周期的なハン窓（長さ = 標本の数）。
   - L1 で正規化（`sig / Σ|sig|`）。
   - 長さ `n_fft = 2^ceil(log2(max L))` に中央寄せ（左に `(n_fft − 長さ)//2` 個、残りを右に 0）。**complex64 に丸める**。
   - `× L / n_fft`。`scipy.fft.fft(n=n_fft)`（complex64 なので単精度）の 0..n_fft/2 だけ残す。
   - `sparsify_rows(quantile=0.01)`: 行ごとに |値| を小さい順に並べ、累積が行の L1 の 1 % に届く最初の値をしきい値に、それ**以上**の要素だけ残す（ほかは 0）。値は 1 % の桁で変わるので**必須**。
8. 応答（`__cqt_response`）: `D = stft(y, n_fft, hop=my_hop, window='ones', center=True, pad_mode='constant')`（長方形の窓、complex64）。`out[bin, t] = Σ_k K[bin, k] · D[k, t]`（**共役を取らない**ただの積和）。
9. まとめ（`__trim_stack`）: 列の数はオクターブの中で最小のもの（ふつう `1 + floor(n/512)`）。下から詰める。
10. `scale=True`: `V /= sqrt(Q·sr/freqs)`（**間引いた後の sr** で計算した長さ）。

### 既定の値で計算した中身（tuning = 0 のとき。tuning は ±0.5 の範囲なので段の数は変わらない）

| 呼び出し               | 最高の bin | cutoff | 最初の間引き                | オクターブごとの hop / sr                    | n_fft | カーネルの長さ（標本） | 残る係数（1 本あたり） |
| ---------------------- | ---------- | ------ | --------------------------- | -------------------------------------------- | ----- | ---------------------- | ---------------------- |
| 全体（216 bin、6 oct） | 2052.9 Hz  | 2082.5 | 1 回（2:1、sr 11025）       | 256 / 11025, 128, 64, 32, 16, 8（sr 344.53） | 1024  | 279〜548               | 約 16.5 / 513          |
| 低音（108 bin、3 oct） | 256.6 Hz   | 260.3  | 4 回分（16:1、sr 1378.125） | 32 / 1378.125, 16, 8                         | 1024  | 279〜548               | 約 16.5 / 513          |

- どのオクターブでも、見る bin は「そのときのナイキストの 37〜38 % まで」。間引きのフィルタが効くのはその下だけ。
- **低音は全体の低い 3 オクターブと同じではない**（間引きの道が 16:1 の一度か、2:1 の 4 回か）。イメージの中で比べた差は、最大で全体の最大値の 2e-4、中央値で 2e-8。

### soxr の間引き（`soxr_hq`）を測った値

- 直線位相で**遅れなし**（入力の 2k の位置のインパルスが出力の k に来る）。端は外が 0 として扱う（1 が続く信号の先頭は 0.74 から始まる）。
- 通過域は出力のナイキストの 0.9 まで ±3e-6 dB で平ら、0.9〜1.0 が遷移、阻止域は約 −140 dB。インパルス応答は出力で ±91 標本（2:1）、±100 標本（16:1）。
- **TS の自前の半帯域フィルタへの条件**（設計判断 2・T6）: 対称な FIR（遅れなしで中央に揃える）、出力のナイキストの 0〜0.5 で ±1e-4 dB 以内、そこへ折り返す帯（出力のナイキストの 1.5 以上）で −120 dB 以下、端は 0 詰め、長さ `ceil(n/2)`、× sqrt(2)。0.5〜1.5 は自由（見る bin に届かない）。遷移が広いので短いフィルタで足りる。
- **近似可**。低音を全体の低い 3 オクターブで代用するのも近似可（差 2e-4）で、CQT を 1 回減らせる。ただし段階ごとの比べは低音も別に出して、差を記録する。

### 型と精度

- 入力が float32 なので出力は complex64。入力を float64 にしても差は全体の最大の 5e-7（測った）。
- **合わせ方**: 手順 1〜10 の構造（tuning、間引きの回数、各オクターブの hop・sr、間引き後の sr を使う 2 か所、カーネルの長さの floor / ceil、周期的な窓、L1、中央寄せの左右、× L/n_fft、1 % の間引き、共役なし、sqrt の掛け算）は**必須**。FFT の精度・soxr の代わりのフィルタ・最後の余分な間引きを省くこと・疎な行列か密か、は**近似可**。

## 8. `estimate_tuning`・`piptrack`（チューニングの推定）

**答え: チューニングは推定されている。** `chroma.py` は `chroma_cqt` に `tuning` を渡さない → `chroma_cqt` の既定は `tuning=None` → `cqt(tuning=None)` → `vqt` が `estimate_tuning(y=y_harm, sr=22050, bins_per_octave=36)` を呼ぶ。全体と低音の 2 回の呼び出しで**それぞれ推定する**が、入力が同じなので値は同じ（TS は 1 回でよい）。テンポの `rule` の `chroma_stft` は `tuning=0.0` を渡しているので推定しない。

1. `piptrack(y=y_harm, sr=22050, n_fft=2048)`: hop は `2048 // 4 = 512`、hann・中央寄せ・0 詰め。`S = |stft|`（**振幅**、float32）。`fmin=150`、`fmax=4000`、`threshold=0.1`、`ref=np.max`。
   - `avg = np.gradient(S, axis=周波数)`（中は `(x[i+1] − x[i−1])/2`、端は片側の差）。
   - 放物線の補間 `shift`: `a = x[i+1] + x[i−1] − 2x[i]`、`b = (x[i+1] − x[i−1])/2`、`|b| ≥ |a|` なら 0、そうでなければ `−b/a`。最初と最後の bin は 0。
   - 候補: `150 ≤ f < 4000` かつ、`S · (S > 0.1·そのフレームの最大)` の周波数の方向の `localmax`（§12）。
   - `pitch = (bin + shift)·22050/2048`、`mag = S + 0.5·avg·shift`。どちらも **float32** に入る。
2. `threshold = median(mag[pitch > 0])`、`mag ≥ threshold` かつ `pitch > 0` の pitch を使う。
3. `pitch_tuning(..., resolution=0.01, bins_per_octave=36)`: `residual = (36·log2(f / 27.5)) mod 1`（**float32 で計算**）、0.5 以上は −1。`np.histogram(residual, bins=linspace(−0.5, 0.5, 101))`、**最も多い bin の左端**（同数なら左）が tuning。単位は 1/36 オクターブ（1 = 33.3 セント）。

- 測った値（合成のサイン波）: ちょうど 440 Hz に合わせた和音でも 0.03（12 bin なら 0.01）、別の合成では −0.05。値は `0.030000000000000027` のように linspace の端の値そのもの。
- 効き方（測った値）: tuning を 0.01・0.03・0.1 ずらしたとき、フレームのクロマの余弦は最小 0.99999、列の和の比は最大 0.3 %・0.55 %・0.34 %。
- **合わせ方**: 手順は**必須**で移す（float32 の丸めを `Math.fround` でまねる）。ただし float32 の `log2` は numpy の SIMD の実装でビットまでは合わせられず、`mag ≥ median` の境の 1 個やヒストグラムの同数で答えが 0.01〜0.02 ずれる恐れがある。だから段階ごとの比べでは **Python の tuning の値を TS の CQT に差し込む**（T1 に頼む。§17）。通しでのずれは記録する（上の効き方なら §15 の許す差に収まる）。

## 9. `chroma_cqt`・`cq_to_chroma`

**呼び方**: `chroma_cqt(y=y_harm, sr=22050, hop_length=512, fmin=32.7, n_octaves=6 または 3, bins_per_octave=36, norm=None)`。既定: `threshold=0.0`、`tuning=None`、`n_chroma=12`、`window=None`、`cqt_mode='full'`。

1. `C = |cqt(...)|`（§7、float32）。
2. `cq_to_chroma(216 または 108, bins_per_octave=36, n_chroma=12, fmin=32.7)`（float32）: 12 × 36 の「3 本ずつ 1 にする」行列を左に 1 列ずらす（`roll(−1)`）→ 各音は **中心の bin とその前後 1 本**の 3 本の和。それをオクターブの数だけ並べる。音の名前のずらしは `round(hz_to_midi(32.7) mod 12) = round(11.998) = 12` → 12 行ずらす = ずらさないのと同じ（行 0 が C）。`base_c=True`。
3. `chroma = cq_to_chroma @ C`（einsum、float32）。`chroma < 0` を 0 にする（何も起きない）。`norm=None` なので**正規化しない**。

- その後は私たちのコード: float64 にして `_SCALE = 1/80` を掛ける。
- **合わせ方**: 3 本の並び（前後 1 本）と C から始まること、正規化しないことは**必須**。

## 10. `chroma_stft`・`filters.chroma`（テンポの `rule`）

**呼び方**: `S = |stft(y_harm, n_fft=4096, hop=512)|²`（float32、§3）。低音用は `S · (freqs < 250)`（`freqs = rfftfreq(4096, 1/22050)`）。`chroma_stft(S=S, sr=22050, n_fft=4096, tuning=0.0)`、既定 `norm=inf`、`n_chroma=12`。S を渡すので STFT はしない（`power` も効かない）。

`filters.chroma(sr=22050, n_fft=4096, n_chroma=12, tuning=0.0, ctroct=5.0, octwidth=2, norm=2, base_c=True, dtype=float32)`:

1. `frequencies = linspace(0, sr, 4096, endpoint=False)[1:]`（4095 個、ナイキストより上も含む）。
2. `frqbins = 12·log2(f / 27.5)`、先頭に `frqbins[0] − 18`（0 Hz 用）を足して 4096 個。
3. `binwidth = [max(frqbins[1:] − frqbins[:-1], 1), 1]`。
4. `D[c, k] = ((frqbins[k] − c + 6 + 120) mod 12) − 6`（6 = `np.round(12/2)`）。
5. `wts = exp(−0.5·(2·D / binwidth)²)`、**列（bin）ごとに L2 で正規化**（4096 列全部で）。
6. `× exp(−0.5·((frqbins/12 − 5)/2)²)`（オクターブの重み、中心は 27.5·2^5 = 880 Hz）。
7. 行を −3 ずらす（A 始まり → C 始まり）。最初の `1 + 4096/2 = 2049` 列だけ残し、float32 に。

`raw = chromafb @ S`（float32）→ フレームごとに最大の絶対値で割る（最大が `tiny` 未満ならそのまま）。

- **合わせ方**: 1〜7 と正規化は**必須**。値はこの後 `_novelty` → `_peaks`（30 % のしきい値）にしか使わないので、浮動小数の差は**近似可**。

## 11. `time_to_frames`・`frames_to_time`・`fft_frequencies`

- `time_to_frames(t, sr, hop)` = `floor(int(t·sr) / hop)`。`int` は **0 の方へ切り捨て**（`astype(int)`）、その後の `//` は **下へ切り捨て**。負の時刻は `t = −0.001` → `int(−22.05) = −22` → `−22 // 512 = −1`（`chroma.py` はその後 0 に切る）。TS: `Math.floor(Math.trunc(t * sr) / hop)`。`t·sr` は倍精度の積なので同じ値になる。**必須**。
- `frames_to_time(f, sr, hop)` = `(f·hop) / sr`（整数の積の後に割る）。**必須**（順番を変えると最後の桁が変わる）。
- `fft_frequencies(sr, n_fft)` = `np.fft.rfftfreq(n_fft, 1/sr)` = `k · (1/(n_fft·(1/sr)))`。`k·sr/n_fft` とは最後の桁が違うことがある。使い道は `freqs < 250` だけで、250 Hz ちょうどの bin は無い（5.38 Hz 刻み）ので**近似可**。

## 12. `util.localmax`

- `x[i] > x[i−1]` かつ `x[i] ≥ x[i+1]`（平らな山は左端が山）。
- **先頭（i = 0）は決して山にならない**（numba の stencil の端は 0 = 偽。`[3, 1, 2, 2, 1, 5]` → 山は 2 と 5 の位置）。
- **末尾は `x[−1] > x[−2]` なら山**。
- 使う所: `tempo.py` の `_peaks`（打撃の強さ・クロマの変化）、`beat_track` の最後の拍、`piptrack`（周波数の方向）。**必須**。

## 13. 私たちのコードが使う numpy の小物（librosa ではないが同じ扱い）

- `np.hanning(M)`: **対称な**ハン窓（`beats.py` の `_refine` で `M = 2w + 1`、`w = int(0.003·22050) = 66`、`sections.py`）。
- `np.convolve(a, k, mode='same')`: 長さ `max(len(a), len(k))`、`full` の `(len(k) − 1)//2` から切り出す（`[0..5] * [1, 2, 3]` → `[1, 4, 10, 16, 22, 22]`）。
- `np.median`: 偶数個なら真ん中 2 つの平均（`chroma.py` の `_aggregate`、`beats.py` の拍の間隔）。
- `ndarray.std(ddof=1)`: n − 1 で割る（拍の正規化）。float32 の配列なら float32 で計算。
- `np.fft.rfft`（`sections.py`）: numpy の FFT（pocketfft、float64）。
- **必須**（窓の種類と `same` の位置。足す順番は近似可）。

## 14. Pyodide と numba

**結論: 「librosa は Pyodide で動かない」を支持する。確信度は、仕組みについて高い、Pyodide の今の包みの一覧について中くらい（ネットでは確かめていない）。**

- 根拠（イメージの中のソース）: librosa の `__init__` は `lazy_loader` で中身を後から読むが、`util/utils.py`（11 行目）・`beat.py`（16 行目）などが**最初の行で `import numba`** し、読み込みのときに `@jit`・`@guvectorize`・`@stencil` を掛ける。`stft` を使うだけでも `util` が読まれるので、numba が無いと librosa は使えない。`METADATA` の `Requires-Dist` にも `numba>=0.51.0` がある。
- numba は llvmlite（LLVM）で**その場で機械語を作って実行する**。WebAssembly の中では、その場で作った機械語を実行する道が無く、numba に wasm の出力先も無い。私の知っている範囲（2025 年ごろまで）では、Pyodide の包みの一覧に numba・llvmlite は無い。
- 仮に numba の代わりの「何もしない飾り」を作っても、`guvectorize`・`stencil` の意味をまねる必要があり、DP は素の Python の繰り返しで遅くなる。soxr・libsndfile（LGPL）をアプリに入れることにもなる（計画の「ライセンス」で禁止）。読み込みも数十 MB。
- 計画 §2 の「使わない道: Pyodide」はこのままでよい。

## 15. §4 の許す差の見直し（提案。計画は変えていない）

| 段階                         | 今（仮）                                           | 提案                                                                                                                                                                                                      | 理由                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STFT・逆 STFT                | 相対誤差 1e-5                                      | **全体のノルムに対する誤差**（差のノルム ÷ X のノルム）≤ 1e-6、各フレームで「差の絶対値の最大 ≤ 1e-5 × X の絶対値の最大」。逆 STFT は信号対誤差比 100 dB 以上                                             | 0 に近い bin の相対誤差は意味がない（complex64 の丸めだけで大きくなる）。差は丸めの桁（1e-7）のはず                                                                                               |
| HPSS                         | 信号対誤差比 60 dB                                 | 合格 60 dB は変えず、**目標 80 dB** を記録。あわせて `y_harm + y_perc` と `y` の差も見る                                                                                                                  | 中央値は「選ぶ」だけなので、同じ入力ならほぼ丸めの差。60 dB を割ったら端の扱いの間違いを疑う                                                                                                      |
| 打撃の強さ                   | 相関 .9999、最大の相対誤差 1e-3                    | 相関 **.99999**、誤差は **差の絶対値の最大 ≤ 1e-3 × env の最大**（点ごとの相対誤差はやめる）                                                                                                              | 値が 0 に近い所が多い（`max(0, …)`）ので点ごとの相対は不安定                                                                                                                                      |
| テンポ（新）                 | —                                                  | Python の打撃の強さを入れたとき、**テンポの bin（k）が完全に一致**。通しでは全部の変化形で一致を記録し、違えば 1 位と 2 位の差を出す                                                                      | bin が 1 つずれると拍の並び全体が変わる。段階ごとの比べに入れると原因が分かる                                                                                                                     |
| 拍                           | 同じ数・±1 ms（Python の打撃）、通し ±5 ms が 99 % | Python の打撃の強さと **Python のテンポ**を入れたとき、**フレームが完全に一致**。`_refine` は Python の `y_perc` を入れて **±1e-9 s**（同じ式なので）。通しはそのまま                                     | DP は整数の世界なので、同じ入力なら同じ答え。±1 ms は甘すぎて、DP の 1 つずれ（23 ms）は見逃さないが、`_refine` のずれを隠す                                                                      |
| チューニング（新）           | —                                                  | 段階ごと: Python の `y_harm` を入れて **値が一致**（違えば ±0.02 以内を記録）。CQT の比べでは Python の値を差し込む                                                                                       | float32 の log2 とヒストグラムの同数で 0.01〜0.02 ずれうる。ずれても効き方は余弦 0.99999・列の和 0.6 % 以下（§8）                                                                                 |
| フレームのクロマ・拍のクロマ | 余弦 .995 が 99 % の列、列の和の比 ±3 %            | Python の tuning を差し込んだとき: 余弦 **.9999 が 99.9 % の列**、列の和の比 **±0.5 %**。TS の tuning のとき: 余弦 .999・列の和 ±1 %。どちらも無音の列（両方の和が `no_chord_energy` の 1/10 未満）は外す | 測った差の元（float32 / 64 で 5e-7、間引きの道の違いで 2e-4、tuning のずれで 0.6 %）より 3 % はずっと大きく、無音の判定（`no_chord_energy` 0.02）と `_SCALE` が絶対値なので甘いと境で反転を見逃す |
| コード以降                   | 完全に一致・事後確率 1e-9                          | そのまま。事後確率は**絶対**の差 1e-9 と書く                                                                                                                                                              | —                                                                                                                                                                                                 |
| 通しの点数                   | （§4 の表）                                        | そのまま。加えて「テンポの bin が違った変化形」の数を記録                                                                                                                                                 | 通しの点数の差は、ほぼテンポの反転から来るはず                                                                                                                                                    |

## 16. ISC の表示

**結論: 要る。** 計画の「ライセンス」の決めどおり、`spikes/analysis/ts/THIRD_PARTY.md` に librosa の ISC の全文を残す。

- 理由: 移植は Python と同じ値を出すために、librosa のコードを**行ごとになぞる**（端の 1 つずれ、丸め、計算の順番まで同じにする）。考え方（アルゴリズム）だけを使うのではなく、コードの書き直し（翻訳）に当たるので、ISC の条件（「著作権表示と許可の文をすべての複製に残す」）に従うのが安全。
- 書くもの: 0.11.0 の `LICENSE.md` の文そのまま（`Copyright (c) 2013--2023, librosa development team.` と許可の文、保証なしの文）。librosa をなぞった各ファイルの先頭に「librosa 0.11.0 の `<モジュール>.<関数>` を移したもの（ISC、THIRD_PARTY.md）」の 1 行。
- アプリに組み込むとき（システムの設計、今は範囲外）: 配る JS にも表示が要る。Vite の圧縮でコメントが消えるので、`/*! … */` の法的なコメントにするか、配るライセンスの一覧のファイル・画面に載せる。
- NumPy・SciPy（BSD-3）: 使うのは公開された意味（scipy の `reflect`、周期的な窓、`linspace`、`histogram` の端の扱い、`np.pad` の `linear_ramp`）だけで、コードは写さないので、表示は必須ではない。ただし `np.histogram` の端の直し方を写すなら BSD-3 の表示を足す（手間は小さいので、足しておくのを勧める）。

## 17. T1（中間値の書き出し）に足してほしいもの

段階ごとの比べで原因を分けるため、§4 の表に加えて次を書き出すと良い（T1 の担当に伝える）。

- `tuning`（スカラー。`librosa.estimate_tuning(y=y_harm, sr=22050, bins_per_octave=36)`）。
- テンポ（スカラー。`librosa.feature.tempo(onset_envelope=env, sr=22050, hop_length=512, start_bpm=120)`）と、可能なら `log1p(1e6·tg) + logprior` の上位 2 つ。
- `beat_track` の生のフレーム（`_refine` の前）。
- CQT の振幅（全体 216 × T、低音 108 × T。クロマに畳む前）。大きいので短い変化形だけでよい。
- テンポの `rule` の出来事の時刻（`tempo.event_times`）と、選ばれた候補。

## 18. 移植の落とし穴（大事な順）

1. **端の詰め方**: STFT の中央寄せは **0 詰め**（reflect ではない）。HPSS の中央値は **scipy の `reflect`**（端の値を含めて折り返す = numpy の `symmetric`）。ここを取り違えると全部の端がずれる。
2. **偶数への丸め**: 拍の DP の `round(fpb/2)` と `frames_per_beat`。fpb はテンポの表の k そのもので、奇数のテンポ（例 k = 21）では必ず .5 になる。`Math.round` だと探す範囲が 1 フレームずれる。
3. **CQT の細かい決まり**: tuning を推定している（§8）。全体と低音で間引きの道が違う（2:1 か 16:1）。スケールに「間引いた後の sr」を 2 か所で使う。カーネルの長さの floor / ceil、L1、× L/n_fft、1 % の間引き、共役なしの積和。どれか 1 つで値が % の桁で変わる。
4. **打撃の強さ**: 80 dB の切りは**曲全体の最大**に対して（流しながらは 2 回に分ける）。結果は **3 フレーム後ろにずれる**（先頭に 0 が 3 つ）。メルは Slaney の式と正規化。
5. **拍の端の決まり**: `localmax` は先頭を決して山にせず、末尾は前より大きければ山。`trim=False` でも前後の `localscore ≤ 0` のフレームは消える。最初の拍は `0.01·max` の決まり、最後の拍は「局所の最大の中央値の半分以上で一番後ろ」。局所の得点は `env[0]` を使わない。DP の同点は近い方。
6. **窓の取り違え**: librosa は周期的なハン窓、私たちの `_refine` と `sections.py` は `np.hanning`（対称）。
7. **float32 で計算している所**: `power_to_db`、`piptrack`、`pitch_tuning`、`softmask`、メル。値の桁は合うが、しきい値の境（tuning のヒストグラム、`mag ≥ median`）で反転しうる。段階ごとの比べは Python の値を差し込んで分ける。
8. **テンポの argmax**: 1 位と 2 位が近い変化形では、浮動小数の差で反転しうる。反転したら拍の並び全体が変わる（通しの点数の差の主な元になるはず）。
