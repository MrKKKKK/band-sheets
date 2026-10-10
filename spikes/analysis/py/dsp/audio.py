"""Audio loading, HPSS and onset strength (stage 1 of dsp-v1)."""

from __future__ import annotations

import librosa
import numpy as np

from .config import Config
from .types import Features


def load_features(src, cfg: Config) -> Features:
    """Load `src` (a path, or a `(y, sr)` tuple) into `Features`.

    Mono mix, resampled to cfg.audio.sr. If cfg.audio.hpss, y is split into
    harmonic / percussive parts (y_harm / y_perc); otherwise both equal y.
    Onset strength is computed on the percussive part when HPSS is enabled
    (drum/attack-dominated, less affected by sustained chords), else on the
    full signal. Frames use hop = cfg.audio.hop.
    """
    a = cfg.audio
    if isinstance(src, tuple):
        y, sr0 = src
        y = np.asarray(y, dtype=np.float32)
        if y.ndim > 1:  # (channels, n) as in librosa
            y = librosa.to_mono(y)
        if sr0 != a.sr:
            y = librosa.resample(y, orig_sr=sr0, target_sr=a.sr)
    else:
        y, _ = librosa.load(str(src), sr=a.sr, mono=True)
    y = np.ascontiguousarray(y, dtype=np.float32)
    if a.hpss and len(y) > 0:
        y_harm, y_perc = librosa.effects.hpss(y, margin=a.hpss_margin)
    else:
        y_harm, y_perc = y, y
    if len(y) > 0:
        onset_env = librosa.onset.onset_strength(y=y_perc, sr=a.sr, hop_length=a.hop)
    else:
        onset_env = np.zeros(0, dtype=np.float32)
    return Features(
        sr=a.sr, hop=a.hop, duration=len(y) / a.sr,
        y=y, y_harm=y_harm, y_perc=y_perc, onset_env=onset_env,
    )
