"""Tempo octave (half / double) choice (spike 2 T6).

    choose_octave(feat, grid, cfg) -> BeatGrid

Called when cfg.beats.tempo_octave != 'none' or cfg.beats.tempo_hint > 0 (the click tempo the
user knows, `analyze.py --tempo`; never taken from truth). T0 stub: returns `grid` unchanged.
"""

from __future__ import annotations

from .config import Config
from .types import BeatGrid, Features


def choose_octave(feat: Features, grid: BeatGrid, cfg: Config) -> BeatGrid:
    return grid
