"""Per-bar key tracking (spike 2 T22; cfg.key.track == 'sections'; design decision 10).

    estimate(chords, bar_of_col, section_bars, cfg, profile='theory') -> list[BarKey]

A 24-state HMM over bars (12 tonics x major/minor), decoded with Viterbi; the confidence of each bar
is the posterior probability (forward-backward) of the chosen key.

- Emission (profile 'theory', the default): how well each first-pass chord fits the key, by the
  music-theory table tables/key_fit.toml (tonic / diatonic / borrowed / secondary / other), averaged
  over the bar's columns (so beat and eighth resolution give the same scale). Profile 'kk' is the
  spike 1 Krumhansl-Kessler correlation (keyest.key_scores) of the bar's chord-tone profile, kept only
  as a comparison (docs/audio-spike2-plan.md §3).
- Transition: staying is free; a change costs key_fit [change] mid inside a section, boundary at a
  detected section start (`section_bars`; a soft preferred change point, not a forced one), times
  near_factor for near keys (dominant, subdominant, relative, parallel). cfg.key.change_cost_mid /
  change_cost_boundary override the table when > 0 (0.0 = use the table).
- [confidence] scale sharpens the posterior (scores are multiplied by it before forward-backward;
  the Viterbi path does not depend on it).

`chords`: first-pass per-column BeatChord list; `bar_of_col`: bar index per column (negative =
pickup, ignored). Returns one BarKey per bar 0..max(bar_of_col), ascending.
"""

from __future__ import annotations

import os
import tomllib
from functools import lru_cache

import numpy as np

from .config import Config
from .keyest import key_scores
from .types import BarKey, BeatChord

TABLE_PATH = os.path.join(os.path.dirname(__file__), 'tables', 'key_fit.toml')
MODES = ('major', 'minor')
STAGES = ('other', 'secondary', 'borrowed', 'diatonic', 'tonic')  # ascending
QUALITIES = ('maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'm7b5', 'dim7', 'sus4')
QUAL_INDEX = {q: i for i, q in enumerate(QUALITIES)}
# Chord tones (semitones above the root), only for the 'kk' comparison profile.
_TONES = {
    'maj': (0, 4, 7), 'min': (0, 3, 7), '7': (0, 4, 7, 10), 'maj7': (0, 4, 7, 11), 'min7': (0, 3, 7, 10),
    'dim': (0, 3, 6), 'aug': (0, 4, 8), 'm7b5': (0, 3, 6, 10), 'dim7': (0, 3, 6, 9), 'sus4': (0, 5, 7),
}


def key_index(tonic: int, mode: str) -> int:
    """Index in keyest.KEYS order: majors 0-11, minors 12-23."""
    return MODES.index(mode) * 12 + tonic % 12


@lru_cache(maxsize=1)
def load_table() -> dict:
    with open(TABLE_PATH, 'rb') as f:
        return tomllib.load(f)


def fit_matrix(table: dict) -> np.ndarray:
    """(24 keys, 12 roots, len(QUALITIES)) fit score; a chord in several lists takes the highest stage."""
    st = table['stage']
    out = np.full((24, 12, len(QUALITIES)), float(st['other']))
    for mode in MODES:
        for stage in STAGES[1:]:
            for item in table[mode][stage]:
                deg, q = item.split()
                for tonic in range(12):
                    k, r, qi = key_index(tonic, mode), (tonic + int(deg)) % 12, QUAL_INDEX[q]
                    out[k, r, qi] = max(out[k, r, qi], float(st[stage]))
    return out


def _near(a: int, b: int) -> bool:
    """Near keys (note §5.2): same mode a fifth up/down, relative, parallel."""
    (ma, ta), (mb, tb) = divmod(a, 12), divmod(b, 12)
    if ma == mb:
        return (tb - ta) % 12 in (5, 7)
    if ma == 0:  # a major, b minor
        return tb in (ta, (ta + 9) % 12)
    return tb in (ta, (ta + 3) % 12)


def _near_matrix() -> np.ndarray:
    return np.array([[_near(a, b) for b in range(24)] for a in range(24)])


def _emissions(chords: list[BeatChord], bar_of_col: np.ndarray, n_bars: int, profile: str,
               table: dict) -> np.ndarray:
    """(n_bars, 24) mean per-column score of each key."""
    em = np.zeros((n_bars, 24))
    cnt = np.zeros(n_bars)
    if profile == 'theory':
        fit = fit_matrix(table)
        for ch, b in zip(chords, bar_of_col):
            if b < 0:
                continue
            cnt[b] += 1
            if ch.root is not None and ch.quality in QUAL_INDEX:
                em[b] += fit[:, ch.root % 12, QUAL_INDEX[ch.quality]]
        return em / np.maximum(cnt, 1)[:, None]
    if profile == 'kk':
        pcp = np.zeros((n_bars, 12))
        for ch, b in zip(chords, bar_of_col):
            if b < 0 or ch.root is None or ch.quality not in _TONES:
                continue
            for iv in _TONES[ch.quality]:
                pcp[b, (ch.root + iv) % 12] += 1.0
        for b in range(n_bars):
            if np.ptp(pcp[b]) > 0:
                em[b] = key_scores(pcp[b])
        return em
    raise ValueError(f'unknown key profile: {profile!r}')


def _logsumexp(x: np.ndarray, axis: int) -> np.ndarray:
    m = np.max(x, axis=axis, keepdims=True)
    return np.squeeze(m, axis=axis) + np.log(np.sum(np.exp(x - m), axis=axis))


def estimate(chords: list[BeatChord], bar_of_col: np.ndarray, section_bars: list[int], cfg: Config,
             profile: str = 'theory') -> list[BarKey]:
    bar_of_col = np.asarray(bar_of_col, dtype=int)
    if len(chords) == 0 or len(bar_of_col) == 0 or int(bar_of_col.max()) < 0:
        return []
    table = load_table()
    n_bars = int(bar_of_col.max()) + 1
    em = _emissions(chords, bar_of_col, n_bars, profile, table)

    ch = table['change']
    mid = cfg.key.change_cost_mid if cfg.key.change_cost_mid > 0 else float(ch['mid'])
    bnd = cfg.key.change_cost_boundary if cfg.key.change_cost_boundary > 0 else float(ch['boundary'])
    near = np.where(_near_matrix(), float(ch['near_factor']), 1.0)
    np.fill_diagonal(near, 0.0)
    boundaries = {int(b) for b in section_bars}
    # trans[b] (24 from, 24 to): log-weight of the move from bar b-1 to bar b (b >= 1)
    def trans(b: int) -> np.ndarray:
        return -(bnd if b in boundaries else mid) * near

    # Viterbi (max-sum) for the key path
    score = em[0].copy()
    back = np.zeros((n_bars, 24), dtype=int)
    for b in range(1, n_bars):
        cand = score[:, None] + trans(b)
        back[b] = np.argmax(cand, axis=0)
        score = cand[back[b], np.arange(24)] + em[b]
    path = np.zeros(n_bars, dtype=int)
    path[-1] = int(np.argmax(score))
    for b in range(n_bars - 1, 0, -1):
        path[b - 1] = back[b, path[b]]

    # forward-backward (sum-product) on the sharpened scores for the per-bar posterior
    s = float(table['confidence']['scale'])
    fwd = np.zeros((n_bars, 24))
    bwd = np.zeros((n_bars, 24))
    fwd[0] = s * em[0]
    for b in range(1, n_bars):
        fwd[b] = _logsumexp(fwd[b - 1][:, None] + s * trans(b), axis=0) + s * em[b]
    for b in range(n_bars - 2, -1, -1):
        bwd[b] = _logsumexp(s * trans(b + 1) + (s * em[b + 1] + bwd[b + 1])[None, :], axis=1)
    post = fwd + bwd
    post = np.exp(post - _logsumexp(post, axis=1)[:, None])

    out = []
    for b in range(n_bars):
        mode, tonic = divmod(int(path[b]), 12)
        out.append(BarKey(b, tonic, MODES[mode], float(np.clip(post[b, path[b]], 0.0, 1.0))))
    return out
