"""Per-beat chroma (docs/audio-spike1-plan.md, T3).

beat_chroma(feat, grid, cfg) -> (chroma, bass), both shape (12, len(grid.times)).
beat_chroma_bounds(feat, grid, cfg) -> (chroma, bass, bounds): also the column frame boundaries
  (length n + 1) for the spike 2 hooks (bassroot). With chroma.top_voice_discount > 0 the full-range
  frame chroma first goes through voicing.discount_top_voice (spike 2 T12).
chord_columns(feat, grid, cfg) -> (chroma, bass, bounds, c_chroma, c_bounds, per_beat): the beat columns
  above plus the columns the chord stage runs on (spike 2 T13). chords.resolution 'beat': the same arrays,
  per_beat 1; 'eighth': two columns per beat (on-beat half, off-beat half), per_beat 2, from the same frame
  chroma. Downbeat / sections / key keep the beat columns.
column_times(times, duration, per_beat) -> start time of every column (half-beat midpoints for per_beat 2).
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

from . import voicing
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
    chroma, bass, _ = beat_chroma_bounds(feat, grid, cfg)
    return chroma, bass


def per_beat(cfg: Config) -> int:
    """Chord columns per beat: 1 ('beat') or 2 ('eighth')."""
    r = cfg.chords.resolution
    if r not in _PER_BEAT:
        raise ValueError(f'unknown chords.resolution: {r!r} (expected one of {tuple(_PER_BEAT)})')
    return _PER_BEAT[r]


_PER_BEAT = {'beat': 1, 'eighth': 2}


def column_times(times, duration: float, per_beat: int = 1) -> np.ndarray:
    """Start time of each column: beat k of beat i starts at times[i] + k/per_beat of the beat span
    (the last beat ends at last_beat_end). per_beat 1 -> the beat times themselves."""
    times = np.asarray(times, dtype=float)
    if per_beat == 1 or len(times) == 0:
        return times.copy()
    ends = np.append(times[1:], last_beat_end(times, duration))
    frac = np.arange(per_beat) / per_beat
    return (times[:, None] + frac[None, :] * (ends - times)[:, None]).reshape(-1)


def beat_chroma_bounds(feat: Features, grid: BeatGrid, cfg: Config) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    chroma, bass, bounds, _, _, _ = _columns(feat, grid, cfg, 1)
    return chroma, bass, bounds


def chord_columns(feat: Features, grid: BeatGrid, cfg: Config):
    """(chroma, bass, bounds) per beat + (c_chroma, c_bounds, per_beat) for the chord stage (T13)."""
    return _columns(feat, grid, cfg, per_beat(cfg))


def _columns(feat: Features, grid: BeatGrid, cfg: Config, pb: int):
    cc = cfg.chroma
    n = len(grid.times)
    if n == 0:
        z, b0 = np.zeros((12, 0)), np.zeros(1, dtype=int)
        return z, z, b0, z, b0, pb
    if cc.aggregate not in ('median', 'mean'):
        raise ValueError(f'unknown chroma aggregate: {cc.aggregate!r}')
    y = feat.y_harm
    full = _frame_chroma(y, feat.sr, feat.hop, cc.fmin_hz, cc.n_octaves, cc.bins_per_octave, cc.kind)
    if cc.top_voice_discount > 0:
        full = voicing.discount_top_voice(full, feat, cfg)
    bass = _frame_chroma(y, feat.sr, feat.hop, cc.bass_fmin_hz, cc.bass_octaves, cc.bins_per_octave, cc.kind)
    n_frames = full.shape[1]
    starts = librosa.time_to_frames(np.asarray(grid.times, dtype=float), sr=feat.sr, hop_length=feat.hop)
    end_frame = int(librosa.time_to_frames(last_beat_end(grid.times, feat.duration), sr=feat.sr, hop_length=feat.hop))
    bounds = np.append(np.clip(starts, 0, n_frames), min(max(end_frame, 0), n_frames))
    chroma, bchroma = _aggregate(full, bounds, cc.aggregate), _aggregate(bass, bounds, cc.aggregate)
    if pb == 1:
        return chroma, bchroma, bounds, chroma, bounds, 1
    ct = column_times(grid.times, feat.duration, pb)
    cstarts = np.clip(librosa.time_to_frames(ct, sr=feat.sr, hop_length=feat.hop), 0, n_frames)
    cstarts[::pb] = bounds[:-1]  # on-beat columns start exactly where the beat columns do
    c_bounds = np.append(cstarts, bounds[-1])
    return chroma, bchroma, bounds, _aggregate(full, c_bounds, cc.aggregate), c_bounds, pb
