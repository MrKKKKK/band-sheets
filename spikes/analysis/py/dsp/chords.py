"""Chord estimation from per-beat chroma (docs/audio-spike1-plan.md, T3).

Classical templates + hand-set HMM/Viterbi only (no learned models).

    estimate_chords(chroma, cfg) -> list[BeatChord]       one per beat (column)
    chord_name(root, quality) -> 'C', 'Am', 'G7', 'Cmaj7', 'Dm7', 'N'
    chord_text(bc, cfg) -> name, plus '?' when confidence < cfg.chords.low_confidence
    merge_chords(chords, cfg) -> list[ChordSegment]       consecutive beats merged

Rules:
  * score = cosine(beat chroma, binary template). 24 triads; with use_seventh also
    dom7 / maj7 / min7 (36 more) whose score is multiplied by seventh_weight.
  * a seventh state is allowed on a beat only if its weighted score beats the best
    triad score of that beat by seventh_margin (otherwise it is masked out).
  * chroma column sum < no_chord_energy -> no chord (root None, quality 'maj').
  * smoothing: 'viterbi' (stay prob = self_transition, others uniform; emission =
    _BETA * score), 'median' (median filter of the score matrix over median_width
    beats, then argmax), 'none' (argmax).
  * confidence = chosen score - best score among states with a different root, clipped
    to 0-1 (so C vs Cmaj7 closeness does not count as ambiguity).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import Config
from .types import BeatChord

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
_SUFFIX = {'maj': '', 'min': 'm', '7': '7', 'maj7': 'maj7', 'min7': 'm7'}
_QUALITIES = {
    'maj': (0, 4, 7),
    'min': (0, 3, 7),
    '7': (0, 4, 7, 10),
    'maj7': (0, 4, 7, 11),
    'min7': (0, 3, 7, 10),
}
_TRIADS = ('maj', 'min')
_SEVENTHS = ('7', 'maj7', 'min7')
_BETA = 20.0  # emission sharpness for Viterbi (hand-set)


def chord_name(root: int | None, quality: str) -> str:
    if root is None:
        return 'N'
    return NOTE_NAMES[root % 12] + _SUFFIX[quality]


def chord_text(bc: BeatChord, cfg: Config) -> str:
    name = chord_name(bc.root, bc.quality)
    if bc.root is not None and bc.confidence < cfg.chords.low_confidence:
        name += '?'
    return name


def _states(use_seventh: bool) -> list[tuple[int, str]]:
    quals = _TRIADS + (_SEVENTHS if use_seventh else ())
    return [(r, q) for q in quals for r in range(12)]


def _templates(states: list[tuple[int, str]]) -> np.ndarray:
    t = np.zeros((len(states), 12))
    for k, (r, q) in enumerate(states):
        for iv in _QUALITIES[q]:
            t[k, (r + iv) % 12] = 1.0
    return t / np.linalg.norm(t, axis=1, keepdims=True)


def _scores(chroma: np.ndarray, states, cfg: Config) -> np.ndarray:
    """(n_states, N) weighted cosine scores with disallowed sevenths masked to 0."""
    cc = cfg.chords
    tpl = _templates(states)
    norm = np.linalg.norm(chroma, axis=0)
    unit = chroma / np.where(norm > 0, norm, 1.0)
    s = tpl @ unit
    is_seventh = np.array([q in _SEVENTHS for _, q in states])
    if is_seventh.any():
        best_triad = s[~is_seventh].max(axis=0)
        s7 = s[is_seventh] * cc.seventh_weight
        s[is_seventh] = np.where(s7 >= best_triad + cc.seventh_margin, s7, 0.0)
    return s


def _viterbi(emis: np.ndarray, stay: float) -> np.ndarray:
    k, n = emis.shape
    stay = min(max(stay, 1.0 / k + 1e-9), 1 - 1e-9)
    l_stay = np.log(stay)
    l_move = np.log((1 - stay) / (k - 1))
    logp = _BETA * emis
    delta = logp[:, 0].copy()
    back = np.zeros((k, n), dtype=int)
    for t in range(1, n):
        best_prev = int(np.argmax(delta))
        move = delta[best_prev] + l_move
        stay_v = delta + l_stay
        use_stay = stay_v >= move
        back[:, t] = np.where(use_stay, np.arange(k), best_prev)
        delta = np.where(use_stay, stay_v, move) + logp[:, t]
    path = np.zeros(n, dtype=int)
    path[-1] = int(np.argmax(delta))
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[path[t], t]
    return path


def _median_filter(m: np.ndarray, width: int) -> np.ndarray:
    width = max(1, width | 1)
    if width == 1 or m.shape[1] == 0:
        return m
    h = width // 2
    padded = np.pad(m, ((0, 0), (h, h)), mode='edge')
    return np.stack([np.median(padded[:, t : t + width], axis=1) for t in range(m.shape[1])], axis=1)


def estimate_chords(chroma: np.ndarray, cfg: Config) -> list[BeatChord]:
    cc = cfg.chords
    if cc.smoothing not in ('viterbi', 'median', 'none'):
        raise ValueError(f'unknown chord smoothing: {cc.smoothing!r}')
    n = chroma.shape[1]
    if n == 0:
        return []
    states = _states(cc.use_seventh)
    s = _scores(np.asarray(chroma, dtype=float), states, cfg)
    energy = chroma.sum(axis=0)
    silent = energy < cc.no_chord_energy
    s[:, silent] = 0.0
    if cc.smoothing == 'viterbi':
        path = _viterbi(s, cc.self_transition)
    elif cc.smoothing == 'median':
        path = np.argmax(_median_filter(s, cc.median_width), axis=0)
    else:
        path = np.argmax(s, axis=0)
    roots = np.array([r for r, _ in states])
    out: list[BeatChord] = []
    for t in range(n):
        if silent[t]:
            out.append(BeatChord(root=None, quality='maj', confidence=1.0))
            continue
        r, q = states[int(path[t])]
        others = s[roots != r, t]
        gap = float(s[int(path[t]), t] - (others.max() if others.size else 0.0))
        out.append(BeatChord(root=r, quality=q, confidence=float(min(max(gap, 0.0), 1.0))))
    return out


@dataclass(frozen=True)
class ChordSegment:
    start_beat: int
    end_beat: int  # exclusive
    root: int | None
    quality: str
    confidence: float  # mean over the segment's beats
    low_confidence: bool


def merge_chords(chords: list[BeatChord], cfg: Config) -> list[ChordSegment]:
    """Merge consecutive equal chords; runs shorter than merge_min_beats are absorbed
    into the longer neighbour (previous on a tie), then equal neighbours re-merged."""
    if not chords:
        return []
    runs: list[list] = []  # [start, end, key]
    for i, c in enumerate(chords):
        key = (c.root, c.quality if c.root is not None else 'maj')
        if runs and runs[-1][2] == key:
            runs[-1][1] = i + 1
        else:
            runs.append([i, i + 1, key])
    mn = cfg.chords.merge_min_beats
    while len(runs) > 1:
        short = [k for k, r in enumerate(runs) if r[1] - r[0] < mn]
        if not short:
            break
        k = min(short, key=lambda j: (runs[j][1] - runs[j][0], j))
        prev_len = runs[k - 1][1] - runs[k - 1][0] if k > 0 else -1
        next_len = runs[k + 1][1] - runs[k + 1][0] if k + 1 < len(runs) else -1
        tgt = k - 1 if prev_len >= next_len else k + 1
        runs[tgt][0] = min(runs[tgt][0], runs[k][0])
        runs[tgt][1] = max(runs[tgt][1], runs[k][1])
        del runs[k]
        merged: list[list] = []
        for r in runs:
            if merged and merged[-1][2] == r[2]:
                merged[-1][1] = r[1]
            else:
                merged.append(r)
        runs = merged
    out = []
    for a, b, (root, q) in runs:
        conf = float(np.mean([chords[i].confidence for i in range(a, b)]))
        out.append(ChordSegment(a, b, root, q, conf, root is not None and conf < cfg.chords.low_confidence))
    return out
