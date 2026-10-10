"""Per-beat chroma (docs/audio-spike1-plan.md, T3).

beat_chroma(feat, grid, cfg) -> (chroma, bass), both shape (12, len(grid.times)).
Column i covers [times[i], times[i+1]); the last column runs to the end of the audio.
Frames before the first beat are dropped. Built by hand from frame indexes instead of
librosa.util.sync, which returns an extra leading column for the pre-first-beat region.

Scale: chroma values are NOT per-frame normalized, so the column sum is a usable energy
(a full-scale sine gives roughly 1 in its pitch class); chords.py uses it for the
no-chord decision.
"""

from __future__ import annotations

import librosa
import numpy as np

from .config import Config
from .types import BeatGrid, Features

_SCALE = 1.0 / 80.0  # empirical: librosa CQT chroma (norm=None) of a unit-amplitude sine sums to ~80


def _frame_chroma(y: np.ndarray, sr: int, hop: int, fmin: float, n_octaves: int, bpo: int, kind: str) -> np.ndarray:
    if kind == 'cens':
        c = librosa.feature.chroma_cens(
            y=y, sr=sr, hop_length=hop, fmin=fmin, n_octaves=n_octaves, bins_per_octave=bpo, norm=None
        )
    elif kind == 'cqt':
        c = librosa.feature.chroma_cqt(
            y=y, sr=sr, hop_length=hop, fmin=fmin, n_octaves=n_octaves, bins_per_octave=bpo, norm=None
        )
    else:
        raise ValueError(f'unknown chroma kind: {kind!r}')
    return np.asarray(c, dtype=float) * _SCALE


def _aggregate(frames: np.ndarray, bounds: np.ndarray, how: str) -> np.ndarray:
    n_frames = frames.shape[1]
    out = np.zeros((12, len(bounds) - 1))
    for i in range(len(bounds) - 1):
        a = min(int(bounds[i]), n_frames - 1)
        b = min(int(bounds[i + 1]), n_frames)
        if b <= a:
            b = a + 1  # always at least one frame
        seg = frames[:, a:b]
        out[:, i] = np.median(seg, axis=1) if how == 'median' else np.mean(seg, axis=1)
    return out


def last_beat_end(times, duration: float) -> float:
    """End of the last beat span: last beat + median beat interval, capped at the audio end (R8).

    Ending the last span at the audio end would fold the decay/silence after the music into the
    last beat (median chroma ~ silence -> 'no chord'; RMS diluted).
    """
    times = np.asarray(times, dtype=float)
    if len(times) == 0:
        return float(duration)
    if len(times) < 2:
        return max(float(duration), float(times[-1]))
    end = float(times[-1] + np.median(np.diff(times)))
    return min(max(end, float(times[-1])), max(float(duration), float(times[-1])))


def beat_chroma(feat: Features, grid: BeatGrid, cfg: Config) -> tuple[np.ndarray, np.ndarray]:
    cc = cfg.chroma
    n = len(grid.times)
    if n == 0:
        return np.zeros((12, 0)), np.zeros((12, 0))
    if cc.aggregate not in ('median', 'mean'):
        raise ValueError(f'unknown chroma aggregate: {cc.aggregate!r}')
    y = feat.y_harm
    full = _frame_chroma(y, feat.sr, feat.hop, cc.fmin_hz, cc.n_octaves, cc.bins_per_octave, cc.kind)
    bass = _frame_chroma(y, feat.sr, feat.hop, cc.bass_fmin_hz, cc.bass_octaves, cc.bins_per_octave, cc.kind)
    n_frames = full.shape[1]
    starts = librosa.time_to_frames(np.asarray(grid.times, dtype=float), sr=feat.sr, hop_length=feat.hop)
    end_frame = int(librosa.time_to_frames(last_beat_end(grid.times, feat.duration), sr=feat.sr, hop_length=feat.hop))
    bounds = np.append(np.clip(starts, 0, n_frames), min(max(end_frame, 0), n_frames))
    return _aggregate(full, bounds, cc.aggregate), _aggregate(bass, bounds, cc.aggregate)
