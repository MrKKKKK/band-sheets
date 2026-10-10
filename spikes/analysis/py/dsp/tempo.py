"""Tempo octave (half / double) choice (spike 2 T6, review item R7).

    choose_octave(feat, grid, cfg) -> BeatGrid

Called when cfg.beats.tempo_octave != 'none' or cfg.beats.tempo_hint > 0 (the click tempo the
user knows, `analyze.py --tempo`; never taken from truth).

Candidates: the tracked grid (T), its double (2T: midpoints inserted) and its half (T/2: every
other beat, both phases). With a hint, the candidate whose tempo is nearest (in log) to the
hint wins; the half-grid phase is still chosen by the event score. Without a hint
(tempo_octave == 'rule'), each candidate is scored by

    F(recall, precision) * prior(tempo)

where the events are onset peaks of the percussive envelope plus changes of the harmonic chroma
(chord changes) and of the low-band chroma (bass); recall = share of events within a tolerance
of a grid beat, precision = share of grid beats with an event nearby. A denser grid keeps recall
but loses precision, a sparser one the reverse, so only the true pulse scores high on both.
The prior is flat over PREF_LO..PREF_HI BPM and decays by PRIOR_K per octave outside. Fixed
formulas and values; no learning.
"""

from __future__ import annotations

import librosa
import numpy as np

from .config import Config
from .types import BeatGrid, Features

PREF_LO, PREF_HI = 70.0, 150.0
PRIOR_K = 2.0  # exp(-PRIOR_K * octaves outside the preferred range)
TOL = 0.06  # seconds; capped at 0.25 * the candidate's beat interval
BASS_FMAX = 250.0


def _peaks(x: np.ndarray, rel: float) -> np.ndarray:
    if len(x) == 0 or x.max() <= 0:
        return np.zeros(0, dtype=int)
    return np.flatnonzero(librosa.util.localmax(x) & (x > rel * x.max()))


def _novelty(chroma: np.ndarray) -> np.ndarray:
    # chroma: (12, frames); 1 - cosine of consecutive 3-frame-smoothed frames
    k = np.ones(3) / 3
    c = np.apply_along_axis(lambda r: np.convolve(r, k, mode='same'), 1, chroma)
    n = np.linalg.norm(c, axis=0)
    n[n == 0] = 1.0
    c = c / n
    nov = np.zeros(c.shape[1])
    if c.shape[1] > 1:
        nov[1:] = 1.0 - np.sum(c[:, 1:] * c[:, :-1], axis=0)
    return nov


def event_times(feat: Features) -> np.ndarray:
    """Seconds of onsets, chord changes and bass changes (sorted, de-duplicated within 30 ms)."""
    ev = [_peaks(feat.onset_env, 0.3)]
    if len(feat.y_harm) > 0:
        n_fft = 4096
        S = np.abs(librosa.stft(feat.y_harm, n_fft=n_fft, hop_length=feat.hop)) ** 2
        for fmax in (None, BASS_FMAX):
            Sx = S
            if fmax is not None:
                freqs = librosa.fft_frequencies(sr=feat.sr, n_fft=n_fft)
                Sx = S * (freqs < fmax)[:, None]
            if Sx.max() <= 0:
                continue
            ch = librosa.feature.chroma_stft(S=Sx, sr=feat.sr, n_fft=n_fft, tuning=0.0)
            ev.append(_peaks(_novelty(ch), 0.3))
    frames = np.unique(np.concatenate(ev)) if ev else np.zeros(0, dtype=int)
    t = librosa.frames_to_time(frames, sr=feat.sr, hop_length=feat.hop)
    if len(t) == 0:
        return t
    keep = np.concatenate([[True], np.diff(t) > 0.03])
    return t[keep]


def _prior(bpm: float) -> float:
    if bpm <= 0:
        return 0.0
    if bpm < PREF_LO:
        octs = np.log2(PREF_LO / bpm)
    elif bpm > PREF_HI:
        octs = np.log2(bpm / PREF_HI)
    else:
        octs = 0.0
    return float(np.exp(-PRIOR_K * octs))


def _bpm(times: np.ndarray) -> float:
    return 60.0 / float(np.median(np.diff(times))) if len(times) >= 2 else 0.0


def _near(a: np.ndarray, b: np.ndarray, tol: float) -> np.ndarray:
    """For each a[i]: is there a b[j] within tol?  (b sorted)"""
    if len(b) == 0:
        return np.zeros(len(a), dtype=bool)
    j = np.searchsorted(b, a)
    lo = b[np.clip(j - 1, 0, len(b) - 1)]
    hi = b[np.clip(j, 0, len(b) - 1)]
    return np.minimum(np.abs(a - lo), np.abs(a - hi)) <= tol


def _fit(times: np.ndarray, events: np.ndarray) -> float:
    """F-measure of events vs grid beats (0 when either is empty)."""
    if len(times) < 2 or len(events) == 0:
        return 0.0
    tol = min(TOL, 0.25 * float(np.median(np.diff(times))))
    lo, hi = times[0] - tol, times[-1] + tol
    ev = events[(events >= lo) & (events <= hi)]  # events outside the grid span are not its fault
    if len(ev) == 0:
        return 0.0
    r = float(np.mean(_near(ev, times, tol)))
    p = float(np.mean(_near(times, ev, tol)))
    return 0.0 if r + p == 0 else 2 * r * p / (r + p)


def candidates(times: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """(label, beat times) for T, 2T and the two T/2 phases."""
    out = [('T', times)]
    if len(times) >= 2:
        mid = (times[:-1] + times[1:]) / 2
        dbl = np.sort(np.concatenate([times, mid]))
        out.append(('2T', dbl))
    if len(times) >= 4:
        out.append(('T/2a', times[0::2]))
        out.append(('T/2b', times[1::2]))
    return out


def choose_octave(feat: Features, grid: BeatGrid, cfg: Config) -> BeatGrid:
    times = np.asarray(grid.times, dtype=float)
    if len(times) < 2:
        return grid
    events = event_times(feat)
    cands = candidates(times)
    hint = cfg.beats.tempo_hint
    if hint > 0:
        # nearest tempo to the hint; both half phases share a tempo, so the event fit breaks the tie
        best_d = min(abs(np.log2(_bpm(t) / hint)) for _, t in cands if _bpm(t) > 0)
        pool = [(n, t) for n, t in cands if _bpm(t) > 0 and abs(np.log2(_bpm(t) / hint)) <= best_d + 1e-9]
        score = lambda t: _fit(t, events)  # noqa: E731
    else:
        pool = cands
        score = lambda t: _fit(t, events) * _prior(_bpm(t))  # noqa: E731
    best = pool[0]
    best_s = score(best[1])
    for c in pool[1:]:
        s = score(c[1])
        if s > best_s + 1e-12:
            best, best_s = c, s
    if best[0] == 'T':
        return grid
    return BeatGrid(times=best[1], tempo=_bpm(best[1]), method=grid.method)
