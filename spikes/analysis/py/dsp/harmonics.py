"""Chord templates with harmonics (spike 2 T11).

    templates(states, feat, cfg) -> (n_states, 12) unit-norm template rows

cfg.chords.harmonics: 'none' = binary chord-tone templates (spike 1), 'fixed' = add harmonics
n = 1.. with weight harmonic_decay**(n-1), 'profile' = per-recording harmonic shape from `feat`.
T0 stub: binary templates for every value. 'none' must stay bit-identical to spike 1.
"""

from __future__ import annotations

import numpy as np

from . import vocab
from .config import Config
from .types import Features


def templates(states: list[tuple[int, str]], feat: Features | None, cfg: Config) -> np.ndarray:
    t = np.zeros((len(states), 12))
    for k, (r, q) in enumerate(states):
        for iv in vocab.intervals(q):
            t[k, (r + iv) % 12] = 1.0
    return t / np.linalg.norm(t, axis=1, keepdims=True)
