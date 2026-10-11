"""Chord vocabulary (spike 2 T21; docs/audio-spike2-plan.md design decision 8).

    states(cfg) -> list[(root 0-11, quality)]   the chord states the decoder chooses from
    intervals(quality) -> tuple[int, ...]       chord tones as semitones above the root
    suffix(quality) -> str                      chord-name suffix ('' for maj, 'm', '7', ...)
    gate_scores(s, unit, states, cfg) -> (s, masked)   v2 weighting / "clear win only" gate

cfg.chords.vocab:
  'v1' (spike 1): maj / min, plus 7 / maj7 / min7 with chords.use_seventh. Unchanged order.
  'v2' (decision 8): v1 + dim / aug / sus4 (+ m7b5 / dim7 with use_seventh), appended after the
       v1 states. Quality names are score.VOCAB_QUALITIES (the scorer's map_vocab is the identity on
       them). No tension chords: 9 / 11 / 13 / 6 / add9 tones are not in any template, so they are
       left as passing / neighbour tones of the base chord (C + D stays C, never Csus2 or a D chord).

A quality with 4 tones counts as a seventh (chords.py applies seventh_weight / seventh_margin), so
m7b5 / dim7 also pass the seventh gate. On top of that, every v2-only quality ("extra") is gated by
gate_scores (called from chords._scores before the seventh gate):
  * its score is multiplied by chords.vocab_weight,
  * it is kept only if it beats the best v1 state on that column by chords.vocab_margin
    (chords.vocab_sus4_margin for sus4, where a passing 4th on a chord change makes false sus4s;
    dim / aug / sus4 have few tones and are easily confused; values tuned in T14),
  * aug and dim7 are symmetric (Caug = Eaug = G#aug as binary templates), so their score gets a tiny
    bonus _ROOT_TIE x (chroma share of the root): the strongest chroma bin of the set (in practice
    the doubled bass) names the root. Slash / bass detection itself is T10 (bassroot.py).
'v1' returns the score matrix untouched (bit-identical to spike 1). move_states keeps the v1 cost of a
chord change in the Viterbi for 'v2' (measured: without it short 7th segments vanished on L3 / LR).
"""

from __future__ import annotations

import numpy as np

from .config import Config

_INTERVALS: dict[str, tuple[int, ...]] = {
    'maj': (0, 4, 7),
    'min': (0, 3, 7),
    '7': (0, 4, 7, 10),
    'maj7': (0, 4, 7, 11),
    'min7': (0, 3, 7, 10),
    'dim': (0, 3, 6),
    'aug': (0, 4, 8),
    'sus4': (0, 5, 7),
    'm7b5': (0, 3, 6, 10),
    'dim7': (0, 3, 6, 9),
}
_SUFFIX = {
    'maj': '', 'min': 'm', '7': '7', 'maj7': 'maj7', 'min7': 'm7',
    'dim': 'dim', 'aug': 'aug', 'sus4': 'sus4', 'm7b5': 'm7b5', 'dim7': 'dim7',
}
_TRIADS = ('maj', 'min')
_SEVENTHS = ('7', 'maj7', 'min7')
_EXTRA_TRIADS = ('dim', 'aug', 'sus4')
_EXTRA_SEVENTHS = ('m7b5', 'dim7')
_EXTRA = frozenset(_EXTRA_TRIADS + _EXTRA_SEVENTHS)
_SYMMETRIC = frozenset(('aug', 'dim7'))
_ROOT_TIE = 1e-3  # far below any real score difference; only breaks exact template ties
VOCABS = ('v1', 'v2')


def states(cfg: Config) -> list[tuple[int, str]]:
    cc = cfg.chords
    if cc.vocab not in VOCABS:
        raise ValueError(f'unknown chords.vocab: {cc.vocab!r} (expected one of {VOCABS})')
    quals = _TRIADS + (_SEVENTHS if cc.use_seventh else ())
    if cc.vocab == 'v2':
        quals += _EXTRA_TRIADS + (_EXTRA_SEVENTHS if cc.use_seventh else ())
    return [(r, q) for q in quals for r in range(12)]


def intervals(quality: str) -> tuple[int, ...]:
    return _INTERVALS[quality]


def suffix(quality: str) -> str:
    return _SUFFIX[quality]


def move_states(cfg: Config) -> int:
    """State count the Viterbi move probability is split over: the v1 count for every vocab, so 'v2'
    keeps the spike 1 cost of a chord change (with 120 states every move would cost log 2 more)."""
    return 12 * (len(_TRIADS) + (len(_SEVENTHS) if cfg.chords.use_seventh else 0))


def is_extra(quality: str) -> bool:
    """True for a quality only 'v2' has (dim / aug / sus4 / m7b5 / dim7)."""
    return quality in _EXTRA


def gate_scores(s: np.ndarray, unit: np.ndarray, states: list[tuple[int, str]], cfg: Config
                ) -> tuple[np.ndarray, np.ndarray]:
    """(scores, masked) for the extra v2 qualities; `unit` is the (12, N) unit-norm chroma.

    'v1' (or no extra state): returns `s` itself and an all-False mask."""
    masked = np.zeros(s.shape, dtype=bool)
    extra = np.array([q in _EXTRA for _, q in states], dtype=bool)
    if cfg.chords.vocab == 'v1' or not extra.any() or extra.all():
        return s, masked
    cc = cfg.chords
    s = s.copy()
    sym = np.array([q in _SYMMETRIC for _, q in states], dtype=bool)
    if sym.any():
        roots = np.array([r for r, _ in states])
        s[sym] += _ROOT_TIE * unit[roots[sym]]
    best_base = s[~extra].max(axis=0)
    se = s[extra] * cc.vocab_weight
    margin = np.array([cc.vocab_sus4_margin if q == 'sus4' else cc.vocab_margin
                       for _, q in states if q in _EXTRA])[:, None]
    ok = se >= best_base + margin
    s[extra] = np.where(ok, se, 0.0)
    masked[extra] = ~ok
    return s, masked
