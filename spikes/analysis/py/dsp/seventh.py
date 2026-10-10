"""Seventh decided per merged segment instead of per beat (spike 2 T8; cfg.chords.seventh_mode == 'segment').

    decide_segments(segments, chroma, cfg) -> segments

`segments`: chords.merge_chords output; `chroma`: the per-column chroma (12, n_cols).
T0 stub: returns `segments` unchanged.
"""

from __future__ import annotations

import numpy as np

from .config import Config


def decide_segments(segments: list, chroma: np.ndarray, cfg: Config) -> list:
    return segments
