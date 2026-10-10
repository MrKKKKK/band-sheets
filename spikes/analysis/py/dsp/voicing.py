"""Discount of the top voice (melody notes) in frame chroma (spike 2 T12).

    discount_top_voice(frame_chroma, feat, cfg) -> frame_chroma   (12, n_frames)

Called on the full-range frame chroma before per-beat aggregation when
cfg.chroma.top_voice_discount > 0. T0 stub: returns `frame_chroma` unchanged.
"""

from __future__ import annotations

import numpy as np

from .config import Config
from .types import Features


def discount_top_voice(frame_chroma: np.ndarray, feat: Features, cfg: Config) -> np.ndarray:
    return frame_chroma
