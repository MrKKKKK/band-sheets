"""Section boundaries and labels (dsp-v1, docs/audio-spike1-plan.md T5).

Rule-based, no learned models. Works on per-bar features so tests can build them
by hand:

    find_sections(chroma, grid, downbeats, feat, cfg, bass=None) -> list[Section]
        beat-level entry point used by the analyzer (bars counted from
        `downbeats.phase`; beats before it are a pickup and belong to no bar).
    bar_features(chroma, bass, beat_loudness_db, phase, beats_per_bar, pickup_bar=False)
        -> (bar_chroma (n,12), bar_bass (n,12) | None, bar_loudness_db (n,) | None)
    segment_bars(bar_chroma, bar_bass, bar_loudness_db, sc: SectionsConfig, bar_perc=None, pickup=False)
        -> list[Section]  (the whole algorithm, on plain arrays)
    bar_percussive(y_perc, sr, times, duration, phase, beats_per_bar, pickup_bar)
        -> (bar_bands_db (n, len(PERC_BANDS_HZ)-1), bar_head_db (n,))
    percussive_novelty(bar_bands_db, bar_head_db, kernel_bars) -> (n,) 0..1

Pickup (spike 2 T7, Q5 of docs/audio-spike1-t15-review.md): when the downbeat phase is > 0 the beats
before it form a partial bar. It is analyzed as bar 0 of an extended grid (it may be the cut-off
rest of a real bar, as in level M, or a real anacrusis), and the snap grid's origin is chosen between
the partial bar and the first full bar by where the strongest candidates of the harmony (chord-set,
loudness and repetition novelty; not the drums) lie (ties: the first full bar, the spike 1 grid). Spike 1 dropped the partial bar and always snapped from the first full bar,
so level M boundaries landed one bar late. With phase 0 nothing changes. Section bars returned by
find_sections are still counted from the phase (the partial bar is folded into the first section).

Percussive novelty (spike 2 T7, R14 of docs/audio-spike1-review.md; on only when
sections.percussive_weight > 0): per bar, from the HPSS percussive part, the strongest of three cues
in 0..1: a cymbal attack on the downbeat (peak of the >= 5 kHz band, in robust SDs over the bars),
an unusual bar just before (a fill: band levels below the cymbal bands far from the median bar), and a block change of the
drum band levels (median of the k bars before vs after). percussive_weight x that is added to the homogeneity
novelty, so drums can confirm a boundary that chord-set novelty alone cannot single out.

Algorithm (segment_bars):
 1. Silent bars at the start/end (lead-in, tail; >= 30 dB below the loudest bar)
    are left out of the analysis and merged into the first/last section; the
    snapping grid starts at the first non-silent bar.
 2. Bar feature = row-normalized (chroma, 0.5 * bass chroma); self-similarity
    matrix S = cosine of those (used for repetition and labels).
 3. Homogeneity novelty (Foote-style checkerboard on BLOCK MEANS): at bar i,
    chroma_weight * (1 - cos(mean of the k bars before, mean of the k after))
    + loudness_weight * (1 - exp(-|dB difference of the block means| / 3 dB)),
    k = kernel_bars, computed at k and 2k and the minimum taken. Comparing block
    means (chord SETS) instead of bar pairs is the main guard against the
    prototype's over-segmentation: a bar-by-bar kernel fires at every chord
    change. Blocks shorter than k are never compared (edges are 0).
 4. Repetition novelty: diagonal stripes in S (contrast-normalized, smoothed
    along the diagonal) of length >= 2 * min_section_bars at a lag
    >= 2 * min_section_bars vote at their start/end bars (e.g. A1 B1 | A2 B2 ->
    bar 16). A stripe that a shorter lag already explains (a looped progression)
    is ignored, so a looped single section does not split.
 5. Candidates = local maxima of homog + repetition_weight * rep. One is kept
    when homog >= max(min_novelty, peak_threshold * max, noise_factor * median
    of the curve's valleys) (x1.5 if it would leave a section < 2k bars at the
    song's start/end), or when a long repeat starts/ends there. Strongest first,
    every section >= min_section_bars.
 6. Snap: a candidate <= snap_bars // 4 (>= 1) bars off a multiple of snap_bars
    (counted from the grid origin, see "Pickup" below) is moved onto it, unless a clear loudness step (>= 3 dB, 2-bar blocks) pins
    it (step at the grid bar < snap_min_ratio x step at the candidate) -- so a
    real 9-bar first part stays 9.
 7. Labels: a section gets the label of the most similar earlier section when
    their mean bar-by-bar similarity in S (best alignment within the length
    difference +-1 bar) is >= same_label_similarity, else the next letter.
"""

from __future__ import annotations

import math
import string

import numpy as np

from .config import Config, SectionsConfig
from .chroma import last_beat_end
from .types import BeatGrid, Downbeats, Features, Section

LOUDNESS_SCALE_DB = 3.0  # loudness novelty 1 - exp(-|dL| / this)
SILENCE_DB = 30.0  # a bar this far below the loudest bar counts as silent
BASS_WEIGHT = 0.5  # bass chroma weight inside the chroma feature
STRIPE_ON = 0.5  # normalized similarity where a diagonal stripe starts to count
STRIPE_FULL = 0.8  # ... and counts fully
EDGE_FACTOR = 1.5  # threshold multiplier for a boundary < 2 * kernel_bars from the song's start/end
LOUDNESS_PIN_DB = 3.0  # a loudness step this big can keep a boundary off the snap grid
DIVISOR_COVERAGE = 0.8  # a stripe explained by a shorter lag over this share of rows is ignored
PERC_BANDS_HZ = (0.0, 200.0, 500.0, 1200.0, 3000.0, 6000.0, 11025.0)  # percussive band edges
PERC_FILL_BANDS = 4  # bands below this index (< 3 kHz: snare, toms, kick) show a fill
PERC_HEAD_HZ = 5000.0  # cymbal attack band (>= this) at the downbeat
PERC_HEAD_WINDOW = (-0.03, 0.10)  # seconds around the downbeat searched for the attack peak
PERC_SCALE_DB = 6.0  # level cues: 1 - exp(-max(0, dB difference - PERC_TOL_DB) / this)
PERC_TOL_DB = 2.0  # bar-to-bar drum level wobble below this is no evidence
PERC_Z_TOL = 3.0  # accent cue: 1 - exp(-max(0, z - PERC_Z_TOL) / PERC_Z_SCALE), z in robust SDs
PERC_Z_SCALE = 3.0
PERC_NFFT = 1024


# ---------------------------------------------------------------- entry point


def find_sections(
    chroma: np.ndarray,
    grid: BeatGrid,
    downbeats: Downbeats,
    feat: Features | None,
    cfg: Config,
    bass: np.ndarray | None = None,
) -> list[Section]:
    """Sections in bars counted from `downbeats.phase` (end_bar exclusive)."""
    sc = cfg.sections
    if not sc.enabled:
        return []
    phase, bpb = downbeats.phase, downbeats.beats_per_bar
    pickup = phase > 0 and np.asarray(chroma).shape[1] > 0
    loud = None
    if feat is not None and len(grid.times) > 0:
        loud = beat_loudness_db(feat.y, feat.sr, np.asarray(grid.times), feat.duration)
    bc, bb, bl = bar_features(chroma, bass, loud, phase, bpb, pickup_bar=pickup)
    perc = None
    if sc.percussive_weight > 0 and feat is not None and len(grid.times) > 0:
        bands, head = bar_percussive(feat.y_perc, feat.sr, np.asarray(grid.times), feat.duration, phase, bpb, pickup)
        perc = percussive_novelty(bands, head, sc.kernel_bars)
    secs = segment_bars(bc, bb, bl, sc, bar_perc=perc, pickup=pickup)
    return unpickup(secs) if pickup else secs


def unpickup(secs: list[Section]) -> list[Section]:
    """Sections on the extended grid (bar 0 = partial pickup bar) -> bars counted from the phase.

    The pickup bar folds into the first section; a section left with no full bar is dropped.
    """
    out: list[Section] = []
    for s in secs:
        a, b = max(0, s.start_bar - 1), s.end_bar - 1
        if b <= a:
            continue
        out.append(Section(a if out else 0, b, s.label))
    return out


def beat_loudness_db(y: np.ndarray, sr: int, times: np.ndarray, duration: float) -> np.ndarray:
    """RMS level in dB of each beat span [times[i], times[i+1]) (last one: one median beat interval, R8)."""
    y = np.asarray(y, dtype=float)
    edges = np.append(np.asarray(times, dtype=float), last_beat_end(times, duration) if len(times) else 0.0)
    idx = np.clip(np.round(edges * sr).astype(int), 0, len(y))
    out = np.empty(len(times))
    for i in range(len(times)):
        seg = y[idx[i] : idx[i + 1]]
        p = float(np.mean(seg**2)) if len(seg) else 0.0
        out[i] = 10.0 * math.log10(p + 1e-12)
    return out


def bar_features(
    chroma: np.ndarray,
    bass: np.ndarray | None,
    beat_loudness_db: np.ndarray | None,
    phase: int,
    beats_per_bar: int,
    pickup_bar: bool = False,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    """Per-beat (12, n_beats) arrays -> per-bar (n_bars, 12) means; loudness as power mean in dB.

    Bar b = beats [phase + b*bpb, phase + (b+1)*bpb); a trailing partial bar counts. With
    pickup_bar and phase > 0, the beats [0, phase) come first as an extra (partial) bar.
    """
    chroma = np.asarray(chroma, dtype=float)
    nb = chroma.shape[1]
    spans = bar_spans(nb, phase, beats_per_bar, pickup_bar)
    n = len(spans)
    bc = np.zeros((n, 12))
    bb = np.zeros((n, 12)) if bass is not None else None
    bl = np.zeros(n) if beat_loudness_db is not None else None
    for b, (lo, hi) in enumerate(spans):
        bc[b] = chroma[:, lo:hi].mean(axis=1)
        if bb is not None:
            bb[b] = np.asarray(bass, dtype=float)[:, lo:hi].mean(axis=1)
        if bl is not None:
            p = np.mean(10.0 ** (np.asarray(beat_loudness_db[lo:hi], dtype=float) / 10.0))
            bl[b] = 10.0 * math.log10(p + 1e-12)
    return bc, bb, bl


def bar_spans(n_beats: int, phase: int, beats_per_bar: int, pickup_bar: bool = False) -> list[tuple[int, int]]:
    """Beat index ranges [lo, hi) of the bars (see bar_features)."""
    bpb = max(1, int(beats_per_bar))
    phase = max(0, int(phase))
    n = max(0, math.ceil((n_beats - phase) / bpb))
    spans = [(phase + b * bpb, min(phase + (b + 1) * bpb, n_beats)) for b in range(n)]
    if pickup_bar and 0 < phase <= n_beats:
        spans.insert(0, (0, phase))
    return spans


# ---------------------------------------------------------------- percussive cues (T7)


def bar_percussive(
    y_perc: np.ndarray,
    sr: int,
    times: np.ndarray,
    duration: float,
    phase: int,
    beats_per_bar: int,
    pickup_bar: bool = False,
) -> tuple[np.ndarray, np.ndarray]:
    """Per bar: dB of the percussive part's power in PERC_BANDS_HZ bands (mean over the bar), and the
    peak dB of the >= PERC_HEAD_HZ band in PERC_HEAD_WINDOW around the downbeat (a crash's attack;
    NaN for a pickup bar, whose first beat is not a downbeat)."""
    y = np.asarray(y_perc, dtype=float)
    times = np.asarray(times, dtype=float)
    nb = len(times)
    edges_t = np.append(times, last_beat_end(times, duration) if nb else 0.0)
    hop = PERC_NFFT // 4
    nband = len(PERC_BANDS_HZ) - 1
    if len(y) == 0:
        spec, head_f, centers = np.zeros((0, nband)), np.zeros(0), np.zeros(0)
    else:
        yy = np.pad(y, (0, max(0, PERC_NFFT - len(y))))
        n_fr = 1 + (len(yy) - PERC_NFFT) // hop
        idx = np.arange(PERC_NFFT)[None, :] + hop * np.arange(n_fr)[:, None]
        pw = np.abs(np.fft.rfft(yy[idx] * np.hanning(PERC_NFFT)[None, :], axis=1)) ** 2
        freqs = np.fft.rfftfreq(PERC_NFFT, 1.0 / sr)
        spec = np.stack(
            [pw[:, (freqs >= lo) & (freqs < hi)].sum(axis=1) for lo, hi in zip(PERC_BANDS_HZ[:-1], PERC_BANDS_HZ[1:])],
            axis=1,
        )
        head_f = 10.0 * np.log10(pw[:, freqs >= PERC_HEAD_HZ].sum(axis=1) + 1e-12)
        centers = (np.arange(n_fr) * hop + PERC_NFFT / 2) / sr

    spans = bar_spans(nb, phase, beats_per_bar, pickup_bar)
    bands = np.zeros((len(spans), nband))
    head = np.full(len(spans), np.nan)
    for b, (lo, hi) in enumerate(spans):
        m = (centers >= edges_t[lo]) & (centers < edges_t[hi])
        bands[b] = 10.0 * np.log10((spec[m].mean(axis=0) if m.any() else np.zeros(nband)) + 1e-12)
        if pickup_bar and b == 0 and phase > 0:
            continue
        t0 = edges_t[lo]
        m = (centers >= t0 + PERC_HEAD_WINDOW[0]) & (centers < t0 + PERC_HEAD_WINDOW[1])
        if m.any():
            head[b] = float(head_f[m].max())
    return bands, head


def percussive_novelty(bar_bands_db: np.ndarray, bar_head_db: np.ndarray, kernel_bars: int) -> np.ndarray:
    """Boundary evidence per bar (0..1): the strongest of a cymbal attack on the downbeat of b, an
    unusual bar b-1 (fill) and a block change of the drum band levels.

    The attack is judged in robust SDs (median / MAD over the bars of this recording), the fill and
    block change in dB above PERC_TOL_DB. Medians are taken over bars with drum sound (band power
    within SILENCE_DB of the loudest bar), so silence or a drum-less part does not set the reference.
    """
    bands = np.asarray(bar_bands_db, dtype=float)
    head = np.asarray(bar_head_db, dtype=float)
    n = len(bands)
    out = np.zeros(n)
    if n < 2:
        return out
    level = 10.0 * np.log10(np.sum(10.0 ** (bands / 10.0), axis=1) + 1e-12)
    active = level >= level.max() - SILENCE_DB
    if not active.any():
        return out
    ref = np.median(bands[active], axis=0)
    hv = active & ~np.isnan(head)
    if hv.sum() >= 3:
        h_med = float(np.median(head[hv]))
        h_sd = max(1.4826 * float(np.median(np.abs(head[hv] - h_med))), 0.1)  # >= 0.1 dB: no zero spread
    else:
        hv[:] = False
    # dB away from the typical bar below the cymbal bands (snare/tom fills; a crash bar is not a fill)
    dev = np.mean(np.abs(bands[:, :PERC_FILL_BANDS] - ref[:PERC_FILL_BANDS]), axis=1)
    k = max(2, int(kernel_bars))
    for b in range(1, n):
        accent = 0.0
        if hv[b]:
            z = (float(head[b]) - h_med) / h_sd
            accent = 1.0 - math.exp(-max(0.0, z - PERC_Z_TOL) / PERC_Z_SCALE)
        fill = _cue(float(dev[b - 1])) if active[b - 1] else 0.0
        kk = min(k, b, n - b)
        # medians: one fill bar inside a block is not a change of the drum pattern
        block = _cue(float(np.mean(np.abs(np.median(bands[b - kk : b], axis=0) - np.median(bands[b : b + kk], axis=0)))))
        out[b] = max(accent, fill, block)
    return out


def _cue(db: float) -> float:
    return 1.0 - math.exp(-max(0.0, db - PERC_TOL_DB) / PERC_SCALE_DB)


# ---------------------------------------------------------------- algorithm


def segment_bars(
    bar_chroma: np.ndarray,
    bar_bass: np.ndarray | None,
    bar_loudness_db: np.ndarray | None,
    sc: SectionsConfig,
    bar_perc: np.ndarray | None = None,
    pickup: bool = False,
) -> list[Section]:
    """bar_perc: percussive_novelty per bar (used when sc.percussive_weight > 0). pickup: bar 0 is a
    partial pickup bar, so the snap grid may start at bar 0 or bar 1 (see the module docstring)."""
    bar_chroma = np.asarray(bar_chroma, dtype=float)
    n_all = bar_chroma.shape[0]
    if n_all == 0:
        return []
    lo, hi = active_range(bar_chroma, bar_loudness_db)
    n = hi - lo
    min_len = max(1, sc.min_section_bars)
    if n < 2 * min_len:
        return [Section(0, n_all, 'A')]

    x = chroma_features(bar_chroma[lo:hi], None if bar_bass is None else np.asarray(bar_bass)[lo:hi])
    s_chroma = np.clip(x @ x.T, 0.0, 1.0)
    loud = None if bar_loudness_db is None else np.asarray(bar_loudness_db, dtype=float)[lo:hi]

    k = max(2, sc.kernel_bars)
    homog = block_novelty(x, loud, k, sc.chroma_weight, sc.loudness_weight)
    rep = repetition_novelty(s_chroma, min_len)
    step = None if loud is None or sc.loudness_weight <= 0 else loudness_step(loud, 2)
    origins = (1, 0) if pickup and lo == 0 else (0,)
    origin = None
    if len(origins) > 1:  # the grid origin from the harmony only: a crash may sit a bar off the section line
        origin = pick_boundaries(homog, rep, step, sc, min_len, valid=slice(k, n - k + 1), origins=origins, origin_only=True)
    if bar_perc is not None and sc.percussive_weight > 0:
        homog = homog + sc.percussive_weight * np.asarray(bar_perc, dtype=float)[lo:hi]
    bounds = pick_boundaries(
        homog, rep, step, sc, min_len, valid=slice(k, n - k + 1), origins=origins if origin is None else (origin,)
    )

    edges = [0] + [b + lo for b in bounds] + [n_all]
    # labels from the active part only
    act = [(max(a, lo) - lo, min(b, hi) - lo) for a, b in zip(edges[:-1], edges[1:])]
    labels = label_sections(s_chroma, act, sc.same_label_similarity)
    return [Section(a, b, lab) for a, b, lab in zip(edges[:-1], edges[1:], labels)]


def active_range(bar_chroma: np.ndarray, bar_loudness_db: np.ndarray | None) -> tuple[int, int]:
    """[lo, hi) of bars between leading and trailing silence (whole range if none found)."""
    energy = bar_chroma.sum(axis=1)
    active = energy > 1e-6 * max(float(energy.max()), 1e-12)
    if bar_loudness_db is not None:
        loud = np.asarray(bar_loudness_db, dtype=float)
        active &= loud >= loud.max() - SILENCE_DB
    idx = np.flatnonzero(active)
    if len(idx) == 0:
        return 0, len(bar_chroma)
    return int(idx[0]), int(idx[-1]) + 1


def chroma_features(bar_chroma: np.ndarray, bar_bass: np.ndarray | None) -> np.ndarray:
    """Row-normalized (chroma, BASS_WEIGHT * bass) per bar; silent rows stay zero."""

    def norm(m: np.ndarray) -> np.ndarray:
        d = np.linalg.norm(m, axis=1, keepdims=True)
        return np.divide(m, d, out=np.zeros_like(m), where=d > 1e-12)

    x = norm(np.asarray(bar_chroma, dtype=float))
    if bar_bass is not None:
        x = norm(np.hstack([x, BASS_WEIGHT * norm(np.asarray(bar_bass, dtype=float))]))
    return x


def block_novelty(
    x: np.ndarray,
    loud: np.ndarray | None,
    kernel_bars: int,
    chroma_weight: float,
    loudness_weight: float,
) -> np.ndarray:
    """Checkerboard on block-averaged features, at two scales (k and 2k), taking the minimum.

    Per scale: chroma part = 1 - cos(mean of bars [i-k, i), mean of bars [i, i+k)) (the
    chord SET changes), loudness part = 1 - exp(-|mean dB difference| / 3 dB). Averaging over
    the block first is what makes bars of a cycling chord progression look alike (a
    bar-by-bar Foote kernel fires at every chord change). The minimum over two scales keeps
    a long (8-bar) progression inside one section from looking like a change at its middle.
    """
    n = x.shape[0]
    wc = max(0.0, chroma_weight)
    wl = max(0.0, loudness_weight) if loud is not None else 0.0
    if wc + wl == 0:
        return np.zeros(n)
    k1 = max(2, int(kernel_bars))
    out = np.full(n, np.inf)
    for k_max in (k1, 2 * k1):
        nov = np.zeros(n)
        for i in range(1, n):
            k = min(k_max, i, n - i)
            if k < k1:  # never compare blocks shorter than the kernel (edge artifacts)
                continue
            v = 0.0
            if wc > 0:
                a, b = x[i - k : i].mean(axis=0), x[i : i + k].mean(axis=0)
                den = float(np.linalg.norm(a) * np.linalg.norm(b))
                v += wc * (1.0 - (float(a @ b) / den if den > 1e-12 else 1.0))
            if wl > 0:
                d = abs(float(loud[i - k : i].mean() - loud[i : i + k].mean()))
                v += wl * (1.0 - math.exp(-d / LOUDNESS_SCALE_DB))
            nov[i] = v
        out = np.minimum(out, nov)
    return out


def stripe_strength(s_chroma: np.ndarray) -> np.ndarray:
    """0..1 'bar i repeats bar j' map: contrast-normalized and smoothed along diagonals."""
    n = s_chroma.shape[0]
    off = s_chroma[~np.eye(n, dtype=bool)]
    base = float(np.median(off)) if len(off) else 0.0
    q = np.clip((s_chroma - base) / max(1.0 - base, 1e-6), 0.0, 1.0)
    acc = q.copy()
    cnt = np.ones_like(q)
    acc[1:, 1:] += q[:-1, :-1]
    cnt[1:, 1:] += 1
    acc[:-1, :-1] += q[1:, 1:]
    cnt[:-1, :-1] += 1
    qs = acc / cnt
    return np.clip((qs - STRIPE_ON) / (STRIPE_FULL - STRIPE_ON), 0.0, 1.0)


def repetition_novelty(s_chroma: np.ndarray, min_len: int) -> np.ndarray:
    """Votes (0..1) at the ends of long repeated blocks (lag and length >= 2 * min_len)."""
    n = s_chroma.shape[0]
    p = stripe_strength(s_chroma)
    long_len = 2 * min_len
    on = p >= 0.5
    votes = np.zeros(n + 1)
    for lag in range(long_len, n - long_len + 1):
        rows = np.array([on[i, i + lag] for i in range(n - lag)])
        divisors = [d for d in range(1, lag) if lag % d == 0]
        for i0, i1 in _runs(rows):
            if i1 - i0 < long_len:
                continue
            explained = False
            for d in divisors:
                cov = np.mean([on[i, i + d] for i in range(i0, i1)])
                if cov >= DIVISOR_COVERAGE:
                    explained = True
                    break
            if explained:
                continue
            for b in (i0, i1, i0 + lag, i1 + lag):
                if 0 < b < n:
                    votes[b] += 1.0
                    votes[b - 1] += 0.25
                    votes[b + 1] += 0.25
    return np.minimum(votes[:n], 1.0)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    out, start = [], None
    for i, v in enumerate(list(mask) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i))
            start = None
    return out


def pick_boundaries(
    homog: np.ndarray,
    rep: np.ndarray,
    step: np.ndarray | None,
    sc: SectionsConfig,
    min_len: int,
    valid: slice | None = None,
    origins: tuple[int, ...] = (0,),
    origin_only: bool = False,
) -> list[int] | int:
    """Bars (in the analyzed range) where a new section starts, ascending.

    A bar is a candidate when it is a local maximum of homog + repetition_weight * rep and
    either homog clears the adaptive threshold or a long repeated block starts/ends there
    (rep >= 0.5). Candidates are snapped, then taken strongest first while every section
    stays >= min_len bars. The snap grid's origin is the one of `origins` on which the
    qualifying candidates' summed strength is largest (ties: the first listed); with
    origin_only, that origin is returned instead of the boundaries.
    """
    n = len(homog)
    nov = homog + sc.repetition_weight * rep
    inner = homog[valid] if valid is not None else homog[1:]
    if len(inner) == 0:
        inner = homog[1:]
    # noise floor = median of the curve's valleys (between real boundaries they fall to ~0;
    # with random chord changes everywhere they stay up)
    valleys = [
        float(inner[j])
        for j in range(len(inner))
        if (j == 0 or inner[j] <= inner[j - 1]) and (j + 1 == len(inner) or inner[j] <= inner[j + 1])
    ]
    floor = float(np.median(valleys)) if valleys else 0.0
    thr = max(sc.min_novelty, sc.peak_threshold * float(homog.max()), sc.noise_factor * floor)
    k2 = 2 * max(2, sc.kernel_bars)
    peaks = [
        i
        for i in range(1, n)
        if nov[i] > 0 and nov[i] >= nov[i - 1] and (i + 1 >= n or nov[i] >= nov[i + 1])
    ]
    peaks.sort(key=lambda i: (-nov[i], i))
    origin = grid_origin(
        [i for i in peaks if homog[i] >= thr or (sc.repetition_weight > 0 and rep[i] >= 0.5)], nov, sc, origins
    )
    if origin_only:
        return origin
    chosen: list[int] = []
    for i in peaks:
        b = snap(i, step, sc, origin)
        # a short section at the song's start/end is judged by the small kernel only: ask more
        need = thr * EDGE_FACTOR if min(b, n - b) < k2 else thr
        if homog[i] < need and not (sc.repetition_weight > 0 and rep[i] >= 0.5):
            continue
        if b < min_len or n - b < min_len:
            continue
        if any(abs(b - c) < min_len for c in chosen):
            continue
        chosen.append(b)
    return sorted(chosen)


def loudness_step(loud: np.ndarray, k: int) -> np.ndarray:
    """|mean dB of bars [i-k, i) - mean dB of bars [i, i+k)| (truncated at the edges)."""
    n = len(loud)
    out = np.zeros(n)
    for i in range(1, n):
        kk = min(k, i, n - i)
        out[i] = abs(float(loud[i - kk : i].mean() - loud[i : i + kk].mean()))
    return out


def grid_origin(cands: list[int], nov: np.ndarray, sc: SectionsConfig, origins: tuple[int, ...]) -> int:
    """The origin o in `origins` whose grid (o + multiples of snap_bars) holds the most candidate strength."""
    size = sc.snap_bars
    if len(origins) == 1 or size <= 0:
        return origins[0]
    score = [sum(float(nov[i]) for i in cands if (i - o) % size == 0) for o in origins]
    return origins[int(np.argmax(score))]  # argmax: first of equal scores


def snap(i: int, step: np.ndarray | None, sc: SectionsConfig, origin: int = 0) -> int:
    """Move i to the nearest bar origin + multiple of snap_bars when it is <= snap_bars // 4 (>= 1) bars away.

    Chord-set novelty cannot place a boundary to the exact bar, so near-grid peaks are moved.
    The exception is a clear loudness step (>= LOUDNESS_PIN_DB) that is sharper at i than at
    the grid bar (grid step < snap_min_ratio x step at i): that pins the boundary (a real
    9-bar intro stays 9).
    """
    size = sc.snap_bars
    if size <= 0:
        return i
    g = int(round((i - origin) / size)) * size + origin
    if g == i or not 0 < g < (len(step) if step is not None else g + 1):
        return i
    if abs(g - i) > max(1, size // 4):
        return i
    if step is not None and step[i] >= LOUDNESS_PIN_DB and step[g] < sc.snap_min_ratio * step[i]:
        return i
    return g


def section_similarity(s: np.ndarray, a: tuple[int, int], b: tuple[int, int]) -> float:
    """Best mean bar-by-bar similarity of two spans over alignments (length difference, +-1 bar)."""
    (a0, a1), (b0, b1) = a, b
    la, lb = a1 - a0, b1 - b0
    if la <= 0 or lb <= 0:
        return 0.0
    best = 0.0
    for shift in range(min(0, la - lb) - 1, max(0, la - lb) + 2):  # bar a0+shift+t <-> b0+t
        ts = [t for t in range(lb) if 0 <= shift + t < la]
        if len(ts) < max(1, min(la, lb) - 1):
            continue
        v = float(np.mean([s[a0 + shift + t, b0 + t] for t in ts]))
        best = max(best, v)
    return best


def label_sections(s_chroma: np.ndarray, spans: list[tuple[int, int]], same: float) -> list[str]:
    labels: list[str] = []
    letters = 0
    for k, span in enumerate(spans):
        best, best_k = -1.0, -1
        for j in range(k):
            v = section_similarity(s_chroma, spans[j], span)
            if v > best:
                best, best_k = v, j
        if best_k >= 0 and best >= same:
            labels.append(labels[best_k])
        else:
            labels.append(_letter(letters))
            letters += 1
    return labels


def _letter(i: int) -> str:
    return string.ascii_uppercase[i] if i < 26 else f'S{i + 1}'
