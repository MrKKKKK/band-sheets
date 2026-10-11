"""Chord estimation from per-beat chroma (docs/audio-spike1-plan.md, T3).

Classical templates + hand-set HMM/Viterbi only (no learned models).

    estimate_chords(chroma, cfg, feat=None, bounds=None, prior=None, per_beat=1) -> list[BeatChord]   one per column
    beat_level(chords, per_beat) -> list[BeatChord]      the on-beat column of each beat (T13)
    chord_name(root, quality, bass=None) -> 'C', 'Am', 'G7', 'Cmaj7', 'Dm7', 'C/E', 'N'
    chord_text(bc, cfg) -> name, plus '?' when confidence < cfg.chords.low_confidence
    merge_chords(chords, cfg, per_beat=1) -> list[ChordSegment]       consecutive columns merged

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

Spike 2 hooks (docs/audio-spike2-plan.md §5; every default = spike 1 behaviour, bit-identical):
  * states from vocab.states(cfg), templates from harmonics.templates(states, feat, cfg); a quality
    with 4 tones counts as a seventh. vocab.gate_scores weights / gates the 'v2'-only qualities first.
  * bass_root != 'none': scores += bass_root_weight x bassroot.root_evidence (masked sevenths stay 0).
  * slash: BeatChord.bass from bassroot.bass_notes (None when equal to the root).
  * confidence == 'posterior': posterior.chord_posterior(_BETA * scores, stay, n_move=vocab.move_states);
    None keeps 'margin'.
  * power (T27): '5' states gated by vocab.gate_power (after gate_scores); on columns read as a power chord
    (vocab.power_columns) the bass root evidence is ignored (a 4th with no 3rd: the upper note is the root).
  * candidates (T27): the posterior is computed and each BeatChord carries its column (BeatChord.posterior);
    posterior.attach_candidates turns them into segment candidates.
  * prior (n_cols, n_states, n_states), log bonus per move (harmony.transition, 2nd pass): Viterbi
    with full per-column transition matrices; an all-zero prior takes the spike 1 fast path.
  * per_beat (T13, chords.resolution 'eighth' -> 2; chroma.chord_columns): columns are half beats, so a
    chord may change on the beat or on its "and". The HMM is matched to the half beat: stay probability
    sqrt(self_transition) per column (same chance to keep the chord over a whole beat) and emissions
    x _EIGHTH_EMIS (0.5 would weigh a beat like one beat column; that let a short 2-beat chord be
    swallowed, 1.0 let half-beat arpeggio fragments win; T13 sweep). A beat-level prior
    (n_beats rows) is repeated per column. merge_chords(per_beat=2) gives segments in half-beat
    columns (ChordSegment.per_beat; result.py turns them into times); beat_level() picks the on-beat
    half for the beat-level consumers (downbeat, keytrack). per_beat 1 = the spike 1 code path.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import bassroot, harmonics, posterior, vocab
from .config import Config
from .types import BeatChord, Features

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
_BETA = 20.0  # emission sharpness for Viterbi (hand-set)
_EIGHTH_EMIS = 0.75  # T13: emission weight per half-beat column (sweep 0.5 / 0.75 / 1 on L0-L3, LR, M: 0.75 best, no level drops)

_CHOICES = {
    'resolution': ('beat', 'eighth'),
    'confidence': ('margin', 'posterior'),
    'harmonics': ('none', 'fixed', 'profile'),
    'bass_root': ('none', 'lowest', 'first', 'octave'),
    'seventh_mode': ('beat', 'segment'),
    'vocab': ('v1', 'v2'),
}


def check_config(cfg: Config) -> None:
    """ValueError for an unknown value of a spike 2 switch (typos never pass silently)."""
    for key, allowed in _CHOICES.items():
        v = getattr(cfg.chords, key)
        if v not in allowed:
            raise ValueError(f'unknown chords.{key}: {v!r} (expected one of {allowed})')
    if cfg.chords.candidates_k < 1:
        raise ValueError(f'chords.candidates_k must be >= 1, got {cfg.chords.candidates_k}')
    if cfg.chords.power_third_max < 0:
        raise ValueError(f'chords.power_third_max must be >= 0, got {cfg.chords.power_third_max}')


def chord_name(root: int | None, quality: str, bass: int | None = None) -> str:
    if root is None:
        return 'N'
    name = NOTE_NAMES[root % 12] + vocab.suffix(quality)
    if bass is not None and bass % 12 != root % 12:
        name += '/' + NOTE_NAMES[bass % 12]
    return name


def chord_text(bc: BeatChord, cfg: Config) -> str:
    name = chord_name(bc.root, bc.quality, bc.bass)
    if bc.root is not None and bc.confidence < cfg.chords.low_confidence:
        name += '?'
    return name


def _is_seventh(quality: str) -> bool:
    return len(vocab.intervals(quality)) == 4


def _scores(chroma: np.ndarray, states, cfg: Config, feat: Features | None = None) -> tuple[np.ndarray, np.ndarray]:
    """(n_states, N) weighted cosine scores with disallowed sevenths masked to 0, and that mask."""
    cc = cfg.chords
    tpl = harmonics.templates(states, feat, cfg)
    norm = np.linalg.norm(chroma, axis=0)
    unit = chroma / np.where(norm > 0, norm, 1.0)
    s = tpl @ unit
    s, masked = vocab.gate_scores(s, unit, states, cfg)  # 'v1': s untouched, nothing masked
    if cc.power:
        s, pm = vocab.gate_power(s, unit, states, cfg)
        masked |= pm
    is_seventh = np.array([_is_seventh(q) for _, q in states])
    if is_seventh.any():
        best_triad = s[~is_seventh].max(axis=0)
        s7 = s[is_seventh] * cc.seventh_weight
        ok = s7 >= best_triad + cc.seventh_margin
        s[is_seventh] = np.where(ok, s7, 0.0)
        masked[is_seventh] = ~ok
    return s, masked


def _viterbi(emis: np.ndarray, stay: float, prior: np.ndarray | None = None, n_move: int | None = None) -> np.ndarray:
    """Best path. `prior` (n, k, k): log bonus per move; None / all zero -> spike 1 fast path.
    `n_move`: the state count the move probability is split over (None = k; vocab.move_states keeps
    the v1 count for 'v2', so extra states do not make every chord change dearer)."""
    if prior is not None and np.any(prior):
        return _viterbi_full(emis, stay, prior, n_move)
    k, n = emis.shape
    m = k if n_move is None else n_move
    stay = min(max(stay, 1.0 / m + 1e-9), 1 - 1e-9)
    l_stay = np.log(stay)
    l_move = np.log((1 - stay) / (m - 1))
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


def _viterbi_full(emis: np.ndarray, stay: float, prior: np.ndarray, n_move: int | None = None) -> np.ndarray:
    """Viterbi with a full transition matrix per column (uniform move + prior[t]).

    Ties are broken like the fast path (stay first, then the lowest previous state), so a zero
    prior gives the same path as _viterbi.
    """
    k, n = emis.shape
    if prior.shape != (n, k, k):
        raise ValueError(f'prior shape {prior.shape} != {(n, k, k)}')
    m = k if n_move is None else n_move
    stay = min(max(stay, 1.0 / m + 1e-9), 1 - 1e-9)
    trans = np.full((k, k), np.log((1 - stay) / (m - 1)))
    np.fill_diagonal(trans, np.log(stay))
    logp = _BETA * emis
    delta = logp[:, 0].copy()
    back = np.zeros((k, n), dtype=int)
    cols = np.arange(k)
    for t in range(1, n):
        cand = delta[:, None] + trans + prior[t]  # [i, j]: from i to j
        best_i = np.argmax(cand, axis=0)
        use_stay = cand[cols, cols] >= cand[best_i, cols]
        back[:, t] = np.where(use_stay, cols, best_i)
        delta = cand[back[:, t], cols] + logp[:, t]
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


def estimate_chords(
    chroma: np.ndarray,
    cfg: Config,
    feat: Features | None = None,
    bounds: np.ndarray | None = None,
    prior: np.ndarray | None = None,
    per_beat: int = 1,
) -> list[BeatChord]:
    """One BeatChord per chroma column. `feat` / `bounds` (column frame boundaries, length n + 1)
    feed the spike 2 hooks (harmonics, bassroot); `prior` is the 2nd-pass theory prior (Viterbi only)."""
    cc = cfg.chords
    if cc.smoothing not in ('viterbi', 'median', 'none'):
        raise ValueError(f'unknown chord smoothing: {cc.smoothing!r}')
    check_config(cfg)
    n = chroma.shape[1]
    if n == 0:
        return []
    if bounds is None:
        bounds = np.arange(n + 1)
    if per_beat < 1 or n % per_beat:
        raise ValueError(f'{n} columns is not a multiple of per_beat {per_beat}')
    stay = cc.self_transition if per_beat == 1 else cc.self_transition ** (1.0 / per_beat)
    emis_w = 1.0 if per_beat == 1 else _EIGHTH_EMIS
    if prior is not None and per_beat > 1 and prior.shape[0] * per_beat == n:
        prior = np.repeat(prior, per_beat, axis=0)  # beat-level prior: the bar's bonus on every column
    states = vocab.states(cfg)
    s, masked = _scores(np.asarray(chroma, dtype=float), states, cfg, feat)
    roots = np.array([r for r, _ in states])
    if cc.bass_root != 'none':
        ev = bassroot.root_evidence(feat, bounds, cfg)
        if cc.power:  # rule C: no 3rd -> the bass does not name the root (G under C is C5's 5th)
            ev = np.where(vocab.power_columns(s, states)[None, :], 0.0, ev)
        s = np.where(masked, 0.0, s + cc.bass_root_weight * ev[roots])
    energy = chroma.sum(axis=0)
    silent = energy < cc.no_chord_energy
    s[:, silent] = 0.0
    if cc.smoothing == 'viterbi':
        path = _viterbi(s * emis_w if per_beat > 1 else s, stay, prior, vocab.move_states(cfg))
    elif cc.smoothing == 'median':
        path = np.argmax(_median_filter(s, cc.median_width), axis=0)
    else:
        path = np.argmax(s, axis=0)
    want_post = cc.confidence == 'posterior' or cc.candidates
    post = posterior.chord_posterior(_BETA * emis_w * s if per_beat > 1 else _BETA * s, stay,
                                     n_move=vocab.move_states(cfg)) if want_post else None
    basses = bassroot.bass_notes(feat, bounds, cfg) if cc.slash else [None] * n
    out: list[BeatChord] = []
    for t in range(n):
        if silent[t]:
            out.append(BeatChord(root=None, quality='maj', confidence=1.0,
                                 posterior=post[:, t] if cc.candidates else None))
            continue
        r, q = states[int(path[t])]
        if post is not None and cc.confidence == 'posterior':
            conf = float(post[int(path[t]), t])
        else:
            others = s[roots != r, t]
            conf = float(s[int(path[t]), t] - (others.max() if others.size else 0.0))
        b = basses[t]
        bass = None if b is None or b % 12 == r else int(b) % 12
        out.append(BeatChord(root=r, quality=q, confidence=float(min(max(conf, 0.0), 1.0)), bass=bass,
                             posterior=post[:, t] if cc.candidates else None))
    return out


@dataclass(frozen=True)
class ChordSegment:
    start_beat: int
    end_beat: int  # exclusive
    root: int | None
    quality: str
    confidence: float  # mean over the segment's beats
    low_confidence: bool
    bass: int | None = None  # slash-chord bass (only with chords.slash)
    candidates: tuple = ()  # T27: ((root, quality, prob), ...) top-k of the posterior (chords.candidates)
    per_beat: int = 1  # T13: columns per beat of start_beat / end_beat (2 = half-beat columns, chords.resolution 'eighth')


def beat_level(chords: list[BeatChord], per_beat: int = 1) -> list[BeatChord]:
    """One chord per beat from per-column chords: the on-beat column of each beat (T13). per_beat 1 -> as is."""
    if per_beat == 1:
        return chords
    if len(chords) % per_beat:
        raise ValueError(f'{len(chords)} columns is not a multiple of per_beat {per_beat}')
    return list(chords[::per_beat])


def merge_chords(chords: list[BeatChord], cfg: Config, per_beat: int = 1) -> list[ChordSegment]:
    """Merge consecutive equal chords; runs shorter than merge_min_beats are absorbed
    into the longer neighbour (previous on a tie), then equal neighbours re-merged.
    With chords.slash the bass is part of the chord identity (C and C/E are different runs)."""
    if not chords:
        return []
    runs: list[list] = []  # [start, end, key]
    for i, c in enumerate(chords):
        key = (c.root, c.quality if c.root is not None else 'maj')
        if cfg.chords.slash:
            key += (c.bass if c.root is not None else None,)
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
    for a, b, key in runs:
        root, q = key[0], key[1]
        bass = key[2] if len(key) > 2 else None
        conf = float(np.mean([chords[i].confidence for i in range(a, b)]))
        out.append(ChordSegment(a, b, root, q, conf, root is not None and conf < cfg.chords.low_confidence, bass,
                                per_beat=per_beat))
    return out
