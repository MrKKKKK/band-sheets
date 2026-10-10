"""Section boundaries and labels (dsp-v1, docs/audio-spike1-plan.md T5).

Rule-based, no learned models. Works on per-bar features so tests can build them
by hand:

    find_sections(chroma, grid, downbeats, feat, cfg, bass=None) -> list[Section]
        beat-level entry point used by the analyzer (bars counted from
        `downbeats.phase`; beats before it are a pickup and belong to no bar).
    bar_features(chroma, bass, beat_loudness_db, phase, beats_per_bar)
        -> (bar_chroma (n,12), bar_bass (n,12) | None, bar_loudness_db (n,) | None)
    segment_bars(bar_chroma, bar_bass, bar_loudness_db, sc: SectionsConfig)
        -> list[Section]  (the whole algorithm, on plain arrays)

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
    is moved onto it, unless a clear loudness step (>= 3 dB, 2-bar blocks) pins
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
    loud = None
    if feat is not None and len(grid.times) > 0:
        loud = beat_loudness_db(feat.y, feat.sr, np.asarray(grid.times), feat.duration)
    bc, bb, bl = bar_features(chroma, bass, loud, downbeats.phase, downbeats.beats_per_bar)
    return segment_bars(bc, bb, bl, sc)


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
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    """Per-beat (12, n_beats) arrays -> per-bar (n_bars, 12) means; loudness as power mean in dB.

    Bar b = beats [phase + b*bpb, phase + (b+1)*bpb); a trailing partial bar counts.
    """
    chroma = np.asarray(chroma, dtype=float)
    nb = chroma.shape[1]
    bpb = max(1, int(beats_per_bar))
    phase = max(0, int(phase))
    n = max(0, math.ceil((nb - phase) / bpb))
    bc = np.zeros((n, 12))
    bb = np.zeros((n, 12)) if bass is not None else None
    bl = np.zeros(n) if beat_loudness_db is not None else None
    for b in range(n):
        lo, hi = phase + b * bpb, min(phase + (b + 1) * bpb, nb)
        bc[b] = chroma[:, lo:hi].mean(axis=1)
        if bb is not None:
            bb[b] = np.asarray(bass, dtype=float)[:, lo:hi].mean(axis=1)
        if bl is not None:
            p = np.mean(10.0 ** (np.asarray(beat_loudness_db[lo:hi], dtype=float) / 10.0))
            bl[b] = 10.0 * math.log10(p + 1e-12)
    return bc, bb, bl


# ---------------------------------------------------------------- algorithm


def segment_bars(
    bar_chroma: np.ndarray,
    bar_bass: np.ndarray | None,
    bar_loudness_db: np.ndarray | None,
    sc: SectionsConfig,
) -> list[Section]:
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
    bounds = pick_boundaries(homog, rep, step, sc, min_len, valid=slice(k, n - k + 1))

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
) -> list[int]:
    """Bars (in the analyzed range) where a new section starts, ascending.

    A bar is a candidate when it is a local maximum of homog + repetition_weight * rep and
    either homog clears the adaptive threshold or a long repeated block starts/ends there
    (rep >= 0.5). Candidates are snapped, then taken strongest first while every section
    stays >= min_len bars.
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
    chosen: list[int] = []
    for i in peaks:
        b = snap(i, step, sc)
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


def snap(i: int, step: np.ndarray | None, sc: SectionsConfig) -> int:
    """Move i to the nearest multiple of snap_bars when it is <= snap_bars // 4 (>= 1) bars away.

    Chord-set novelty cannot place a boundary to the exact bar, so near-grid peaks are moved.
    The exception is a clear loudness step (>= LOUDNESS_PIN_DB) that is sharper at i than at
    the grid bar (grid step < snap_min_ratio x step at i): that pins the boundary (a real
    9-bar intro stays 9).
    """
    size = sc.snap_bars
    if size <= 0:
        return i
    g = int(round(i / size)) * size
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
