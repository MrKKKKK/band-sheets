"""Per-bar key tracking (spike 2 T22; cfg.key.track == 'sections'; design decision 10).

    estimate(chords, bar_of_col, section_bars, cfg) -> list[BarKey]

`chords`: first-pass per-column BeatChord list; `bar_of_col`: bar index per column (negative =
pickup); `section_bars`: start bars of the detected sections (key changes are cheaper there:
cfg.key.change_cost_boundary vs change_cost_mid). Returns one BarKey per bar >= 0, ascending.
T0 stub: returns [] (no per-bar keys).
"""

from __future__ import annotations

import numpy as np

from .config import Config
from .types import BarKey, BeatChord


def estimate(chords: list[BeatChord], bar_of_col: np.ndarray, section_bars: list[int], cfg: Config) -> list[BarKey]:
    return []
