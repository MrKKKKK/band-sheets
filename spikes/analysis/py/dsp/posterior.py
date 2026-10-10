"""Chord posterior probabilities for confidence (spike 2 T9; cfg.chords.confidence == 'posterior').

    chord_posterior(emis, stay) -> (n_states, n_cols) posterior P(state | all columns), or None

`emis`: (n_states, n_cols) log emission scores as the Viterbi uses them; `stay`: self-transition
probability. T0 stub returns None, which tells chords.py to keep the 'margin' confidence.
"""

from __future__ import annotations

import numpy as np


def chord_posterior(emis: np.ndarray, stay: float) -> np.ndarray | None:
    return None
