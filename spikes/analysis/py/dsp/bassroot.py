"""Bass evidence for the chord root and slash-chord bass notes (spike 2 T10).

    root_evidence(feat, bounds, cfg) -> (12, n_cols)   bonus per root pitch class, added to the
                                                       chord scores x cfg.chords.bass_root_weight
    bass_notes(feat, bounds, cfg) -> list[int | None]  bass pitch class per column (cfg.chords.slash)

`bounds`: column frame boundaries, length n_cols + 1 (chroma.beat_chroma_bounds).
cfg.chords.bass_root: 'none' | 'lowest' | 'first' | 'octave'.
T0 stub: no evidence (zeros) and no bass notes (all None).
"""

from __future__ import annotations

import numpy as np

from .config import Config
from .types import Features


def root_evidence(feat: Features | None, bounds: np.ndarray, cfg: Config) -> np.ndarray:
    return np.zeros((12, max(len(bounds) - 1, 0)))


def bass_notes(feat: Features | None, bounds: np.ndarray, cfg: Config) -> list[int | None]:
    return [None] * max(len(bounds) - 1, 0)
