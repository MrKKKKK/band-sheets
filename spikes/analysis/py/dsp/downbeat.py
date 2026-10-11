"""Downbeat phase by rule (no learned model). docs/audio-spike1-plan.md T4.

For each of `beats_per_bar` phase offsets p (beats i with i % B == p start a
bar) we ask how much of three kinds of per-beat evidence lands on beat 1:

  chord   chord-label changes (weighted by chord confidence; a quality-only
          change such as C -> C7 counts less; anticipated changes are moved
          to the next beat, see `chord_change_strength`)
  bass    bass-chroma change (cosine distance) + rise in bass energy
  onset   onset strength at the beat

Per feature f: S_f(p) = mean of evidence over the *active* beats of phase p
(mean, not sum, so a pickup's extra beats don't bias a phase; silent beats in
a lead-in are not active and are ignored). share_f(p) = S_f(p) / sum_p S_f(p)
(the fraction of that feature's evidence on phase p; uniform = 1/B), and
score(p) = sum_f w_f * (share_f(p) - 1/B) / sum_f w_f.
A feature with no evidence contributes 0, so with no evidence at all every
score is 0. Confidence = best - second best (in [0, 1]); a tie gives 0 and
the phase is `tie_break_phase` if it is among the tied phases, else the
lowest tied phase.

All scoring takes plain arrays (`estimate_downbeats`) so it is testable with
synthetic inputs; `choose_downbeats` is the adapter for the pipeline.

Chord evidence comes from `downbeat_chords`: beat-level chords with margin
confidence, whatever chords.resolution / confidence / candidates say (R2 fix).
Posterior confidences sit near 1 almost everywhere, so they stop discounting
unsure (spurious) changes; together with the half-beat HMM that flipped a
near-tie half-bar phase on an LR-hard synthetic and a real take. Default
config (beat, margin): the 1st-pass chords as they are (bit-identical).
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from .chords import estimate_chords
from .config import Config, DownbeatConfig, apply_overrides
from .types import BeatChord, BeatGrid, Downbeats, Features

_EPS = 1e-12
_TIE = 1e-9
_BASS_SILENT = 0.05  # bass columns below this fraction of the max energy are silent


def chord_change_strength(
    roots: Sequence[int | None],
    qualities: Sequence[str] | None = None,
    confidences: Sequence[float] | None = None,
    cfg: DownbeatConfig | None = None,
) -> np.ndarray:
    """Per-beat chord-change evidence (length n, entry i = change from beat i-1 to i).

    - Changes from / to "no chord" (None) count 0 (lead-in silence, gaps).
    - Weight = floor + (1-floor) * min(old_conf, new_conf), where old_conf is the
      best confidence over the last (up to) 2 beats of the old chord and new_conf
      over the first (up to) 2 beats of the new chord: a change into or out of a
      single blended beat is judged by the cleaner neighbour.
    - Anticipation: when the first beat of the new chord is weaker than the
      second (a beat column half old / half new chord, e.g. a change on the
      and-of-4), the fraction `anticipation_shift * (1 - c_i / c_{i+1})` of the
      credit moves to beat i+1, where the chord is fully sounding.
    """
    cfg = cfg or DownbeatConfig()
    n = len(roots)
    q = list(qualities) if qualities is not None else ['maj'] * n
    c = np.ones(n) if confidences is None else np.clip(np.asarray(confidences, float), 0.0, 1.0)
    out = np.zeros(n)
    floor = cfg.chord_conf_floor

    def same(a: int, b: int) -> bool:
        return roots[a] == roots[b] and q[a] == q[b]

    for i in range(1, n):
        a, b = roots[i - 1], roots[i]
        if a is None or b is None or (a == b and q[i - 1] == q[i]):
            continue
        kind = cfg.same_root_change if a == b else 1.0
        old_conf = c[i - 1]
        if i >= 2 and same(i - 2, i - 1):
            old_conf = max(old_conf, c[i - 2])
        new_conf = c[i]
        nxt = i + 1 < n and same(i, i + 1)
        if nxt:
            new_conf = max(new_conf, c[i + 1])
        w = kind * (floor + (1.0 - floor) * min(old_conf, new_conf))
        frac = 0.0
        if nxt and cfg.anticipation_shift > 0 and c[i + 1] > c[i]:
            frac = min(1.0, cfg.anticipation_shift * (1.0 - c[i] / max(c[i + 1], _EPS)))
        out[i] += w * (1.0 - frac)
        if frac > 0:
            out[i + 1] += w * frac
    return out


def bass_change_strength(bass: np.ndarray | None) -> np.ndarray | None:
    """Per-beat bass evidence from bass chroma (12, n): 0.5 * cosine distance to the
    previous beat (both beats sounding) + 0.5 * rise in bass energy / max energy.
    A bass note held through the bar gives evidence only where it starts."""
    if bass is None:
        return None
    b = np.asarray(bass, float)
    if b.ndim != 2 or b.shape[1] == 0:
        return None
    n = b.shape[1]
    energy = b.sum(axis=0)
    emax = float(energy.max())
    out = np.zeros(n)
    if emax <= _EPS:
        return out
    norm = b / np.maximum(np.linalg.norm(b, axis=0, keepdims=True), _EPS)
    sounding = energy > _BASS_SILENT * emax
    for i in range(1, n):
        cosdist = 0.0
        if sounding[i] and sounding[i - 1]:
            cosdist = float(np.clip(1.0 - norm[:, i] @ norm[:, i - 1], 0.0, 1.0))
        rise = max(0.0, float(energy[i] - energy[i - 1])) / emax
        out[i] = 0.5 * cosdist + 0.5 * rise
    return out


def beat_onset_strength(
    onset_env: np.ndarray | None, times: np.ndarray, sr: int, hop: int, radius: int = 2
) -> np.ndarray | None:
    """Max of the onset envelope within +-radius frames of each beat time."""
    if onset_env is None or len(onset_env) == 0:
        return None
    env = np.asarray(onset_env, float)
    frames = np.floor(np.asarray(times, float) * sr / hop + 0.5).astype(int)
    out = np.zeros(len(frames))
    for k, f in enumerate(frames):
        lo, hi = max(0, f - radius), min(len(env), f + radius + 1)
        if lo < hi:
            out[k] = float(env[lo:hi].max())
    return out


def _phase_share(x: np.ndarray, active: np.ndarray, bpb: int) -> np.ndarray | None:
    """Fraction of the feature's per-phase mean evidence on each phase, or None."""
    means = np.zeros(bpb)
    for p in range(bpb):
        sel = active[p::bpb]
        if sel.any():
            means[p] = float(np.mean(np.maximum(x[p::bpb][sel], 0.0)))
    total = means.sum()
    if total <= _EPS:
        return None
    return means / total


def estimate_downbeats(
    n_beats: int,
    chord_change: np.ndarray | None = None,
    bass_change: np.ndarray | None = None,
    onset: np.ndarray | None = None,
    cfg: DownbeatConfig | None = None,
    active: np.ndarray | None = None,
) -> Downbeats:
    """Score every phase from plain per-beat arrays (each length n_beats or None).

    `active` (bool, length n) marks beats that carry any sound (only those count
    in the per-phase means); by default every beat from just before the first to
    the last beat with any evidence.
    """
    cfg = cfg or DownbeatConfig()
    bpb = max(1, int(cfg.beats_per_bar))
    tie_phase = cfg.tie_break_phase if 0 <= cfg.tie_break_phase < bpb else 0
    feats: list[tuple[float, np.ndarray]] = []
    for w, x in ((cfg.w_chord_change, chord_change), (cfg.w_bass, bass_change), (cfg.w_onset, onset)):
        if x is None:
            continue
        arr = np.asarray(x, float)
        if arr.shape != (n_beats,):
            raise ValueError(f'feature length {arr.shape} != n_beats {n_beats}')
        feats.append((float(w), np.nan_to_num(arr)))
    w_total = cfg.w_chord_change + cfg.w_bass + cfg.w_onset
    scores = np.zeros(bpb)
    if n_beats >= bpb and feats and w_total > 0:
        if active is None:
            # Every beat from the first to the last one carrying any evidence
            # (drops lead-in / trailing silence, keeps evidence-free beats inside).
            any_ev = np.zeros(n_beats, bool)
            for _, x in feats:
                any_ev |= x > 0
            act = np.zeros(n_beats, bool)
            if any_ev.any():
                idx = np.flatnonzero(any_ev)
                act[max(0, idx[0] - 1) : idx[-1] + 1] = True
        else:
            act = np.asarray(active, bool)
        for w, x in feats:
            share = _phase_share(x, act, bpb)
            if share is not None and w > 0:
                scores += w * (share - 1.0 / bpb)
        scores /= w_total
    phase, conf = _pick(scores, tie_phase)
    return Downbeats(phase=phase, beats_per_bar=bpb, confidence=conf, scores=[float(s) for s in scores])


def _pick(scores: np.ndarray, tie_phase: int) -> tuple[int, float]:
    best = float(scores.max())
    tied = [p for p in range(len(scores)) if best - scores[p] <= _TIE]
    if len(tied) > 1:
        return (tie_phase if tie_phase in tied else tied[0]), 0.0
    phase = tied[0]
    second = max((float(s) for p, s in enumerate(scores) if p != phase), default=best)
    return phase, float(np.clip(best - second, 0.0, 1.0))


def downbeat_chords(
    col_chords: list[BeatChord],
    beat_chroma: np.ndarray,
    cfg: Config,
    per_beat: int = 1,
    feat: Features | None = None,
    beat_bounds: np.ndarray | None = None,
) -> list[BeatChord]:
    """One chord per beat for the downbeat rule, independent of chords.resolution / confidence / candidates:
    the 1st-pass chords when they already are beat-level with margin confidence, otherwise a beat-level margin
    pass over `beat_chroma` (the per-beat chroma, `beat_bounds` its frame bounds) with the other chord
    settings unchanged."""
    cc = cfg.chords
    if per_beat == 1 and cc.confidence == 'margin':
        return col_chords  # candidates only add a posterior field; labels and margins are the same
    bcfg = apply_overrides(cfg, {'chords': {'resolution': 'beat', 'confidence': 'margin', 'candidates': False}})
    return estimate_chords(np.asarray(beat_chroma, float), bcfg, feat, beat_bounds)


def choose_downbeats(
    feat: Features | None,
    grid: BeatGrid,
    chords: Sequence[BeatChord] | None,
    bass: np.ndarray | None,
    cfg: Config,
) -> Downbeats:
    """Pipeline adapter: BeatChord list + bass chroma (12, n) + feat.onset_env."""
    n = len(grid.times)
    dcfg = cfg.downbeat
    chord_change = None
    if chords is not None and len(chords) > 0:
        if len(chords) != n:
            raise ValueError(f'{len(chords)} chords for {n} beats')
        chord_change = chord_change_strength(
            [c.root for c in chords], [c.quality for c in chords], [c.confidence for c in chords], dcfg
        )
    bass_change = bass_change_strength(bass)
    if bass_change is not None and len(bass_change) != n:
        raise ValueError(f'bass has {len(bass_change)} columns for {n} beats')
    onset = None
    if feat is not None:
        onset = beat_onset_strength(feat.onset_env, grid.times, feat.sr, feat.hop)
    # A beat is active when it has a chord, sounding bass or an onset.
    active = np.zeros(n, bool)
    if chords is not None and len(chords) == n:
        active |= np.array([c.root is not None for c in chords], bool)
    if bass is not None:
        e = np.asarray(bass, float).sum(axis=0)
        if e.size == n and e.max() > _EPS:
            active |= e > _BASS_SILENT * e.max()
    if onset is not None and onset.max() > _EPS:
        active |= onset > _BASS_SILENT * onset.max()
    return estimate_downbeats(n, chord_change, bass_change, onset, dcfg, active)
