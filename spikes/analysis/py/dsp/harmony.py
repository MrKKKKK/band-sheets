"""Music-theory transition prior for the second chord pass (spike 2 T26; design decision 9).

    transition(states, bar_keys, bar_of_col, cfg) -> (n_cols, n_states, n_states)

Entry [t, i, j] is a log-domain bonus added to the move from state i (column t-1) to state j
(column t); 0 = no prior. Strength = cfg.chords.theory_prior x the bar's key confidence. Never a
ban (every move keeps a floor). Tables go in tables/harmony.toml (tables/README.md).
T0 stub: all zeros.
"""

from __future__ import annotations

import numpy as np

from .config import Config
from .types import BarKey


def transition(states: list[tuple[int, str]], bar_keys: list[BarKey], bar_of_col: np.ndarray, cfg: Config) -> np.ndarray:
    k = len(states)
    return np.zeros((len(bar_of_col), k, k))
