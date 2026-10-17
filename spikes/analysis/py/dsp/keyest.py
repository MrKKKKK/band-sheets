"""Key estimation: Krumhansl-Schmuckler profile correlation.

Profiles: Krumhansl & Kessler (1982) probe-tone ratings, as popularised by
Krumhansl, "Cognitive Foundations of Musical Pitch" (1990). Hand-set classic values, no training.

    estimate_key(chroma, cfg) -> (tonic name, mode, confidence)   whole-song key (spike 1)
    key_scores(pcp) -> (24,) correlations, order KEYS                for per-bar tracking (spike 2 T22)
"""

from __future__ import annotations

import numpy as np

from .config import Config

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


KEYS: list[tuple[int, str]] = [(t, 'major') for t in range(12)] + [(t, 'minor') for t in range(12)]


def _corr(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    d = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b / d) if d > 0 else 0.0


def estimate_key(chroma: np.ndarray, cfg: Config) -> tuple[str, str, float]:
    """chroma: (12, N) (per-beat or per-frame). Returns (tonic, 'major'|'minor', confidence 0-1).

    Confidence = gap between the best and the second-best of the 24 correlations (clipped to 0-1);
    silent / flat input gives ('C', 'major', 0.0).
    """
    c = np.asarray(chroma, dtype=float)
    pcp = np.clip(c, 0.0, None).sum(axis=1) if c.ndim == 2 else np.clip(c, 0.0, None)
    if pcp.shape != (12,) or pcp.sum() <= 0 or np.ptp(pcp) <= 0:
        return 'C', 'major', 0.0
    scores = [(float(v), tonic, mode) for v, (tonic, mode) in zip(key_scores(pcp), KEYS)]
    scores.sort(key=lambda s: -s[0])
    best, second = scores[0], scores[1]
    return NOTE_NAMES[best[1]], best[2], float(np.clip(best[0] - second[0], 0.0, 1.0))


def key_scores(pcp: np.ndarray) -> np.ndarray:
    """Correlation of a 12-bin pitch-class profile with each of the 24 key profiles (order KEYS)."""
    pcp = np.asarray(pcp, dtype=float)
    out = []
    for mode, prof in (('major', MAJOR_PROFILE), ('minor', MINOR_PROFILE)):
        for tonic in range(12):
            out.append(_corr(pcp, np.roll(prof, tonic)))
    return np.array(out)
