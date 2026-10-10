"""Beat tracking (stage 2 of dsp-v1): Ellis DP or PLP. No half/double tempo correction."""

from __future__ import annotations

import librosa
import numpy as np

from .config import Config
from .types import BeatGrid, Features


def track_beats(feat: Features, cfg: Config) -> BeatGrid:
    """Beat times in seconds (ascending) and tempo = 60 / median inter-beat interval.

    method 'ellis': librosa.beat.beat_track (trim = cfg.beats.trim, default False so
    the first/last beats are kept). method 'plp': peaks of the predominant local pulse.
    """
    b = cfg.beats
    env = feat.onset_env
    if len(env) == 0 or not np.any(env > 0):
        return BeatGrid(times=np.zeros(0), tempo=0.0, method=b.method)
    if b.method == 'ellis':
        _, frames = librosa.beat.beat_track(
            onset_envelope=env, sr=feat.sr, hop_length=feat.hop,
            start_bpm=b.start_bpm, tightness=b.tightness, trim=b.trim,
        )
    elif b.method == 'plp':
        pulse = librosa.beat.plp(
            onset_envelope=env, sr=feat.sr, hop_length=feat.hop, tempo_min=40, tempo_max=240,
        )
        frames = np.flatnonzero(librosa.util.localmax(pulse) & (pulse > 0.1 * pulse.max()))
    else:
        raise ValueError(f'unknown beats.method: {b.method!r}')
    times = librosa.frames_to_time(np.asarray(frames), sr=feat.sr, hop_length=feat.hop)
    times = _refine(np.asarray(times, dtype=float), feat, cfg)
    tempo = 60.0 / float(np.median(np.diff(times))) if len(times) >= 2 else 0.0
    return BeatGrid(times=times, tempo=tempo, method=b.method)


def _refine(times: np.ndarray, feat: Features, cfg: Config) -> np.ndarray:
    """Snap frame-resolution beats (hop/sr = 23 ms) to the sharpest attack nearby.

    The rectified waveform (percussive part when HPSS is on) is smoothed over ~3 ms;
    each beat moves to the steepest rise within +-max(2 frames, 20 % of the median
    beat interval) (Ellis beats can sit ~0.1 s off a click when the tempo is non-integer in frames). Beats with no clear rise
    in the window (< 5 % of the global steepest rise) keep their frame time, except
    that leading / trailing beats of that kind (silence before / after the music,
    where the DP tracker still places beats) are dropped. Interior beats are never
    dropped so the grid stays regular.
    """
    if len(times) == 0:
        return times
    x = feat.y_perc if cfg.audio.hpss else feat.y
    w = max(int(0.003 * feat.sr), 1)
    env = np.convolve(np.abs(x), np.hanning(2 * w + 1) / np.hanning(2 * w + 1).sum(), mode='same')
    rise = np.zeros_like(env)
    rise[w:] = env[w:] - env[:-w]  # rise[i] = env[i] - env[i - w]
    floor = 0.05 * rise.max()
    ibi = float(np.median(np.diff(times))) if len(times) >= 2 else 0.0
    half = max(2 * feat.hop, int(0.2 * ibi * feat.sr))
    out = times.copy()
    has = np.zeros(len(times), dtype=bool)
    for k, t in enumerate(times):
        c = int(round(t * feat.sr))
        lo, hi = max(c - half, 0), min(c + half + 1, len(rise))
        if hi <= lo:
            continue
        j = lo + int(np.argmax(rise[lo:hi]))
        if rise[j] >= floor:
            out[k] = (j - w / 2) / feat.sr  # centre of the rising edge
            has[k] = True
    if not has.any():
        return out
    idx = np.flatnonzero(has)
    out = out[idx[0]:idx[-1] + 1]
    keep = np.concatenate([[True], np.diff(out) > 0.25 * ibi]) if ibi > 0 else np.ones(len(out), bool)
    return out[keep]  # drop beats that snapped onto the same attack
