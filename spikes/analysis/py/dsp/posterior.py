"""Chord posterior probabilities for confidence (spike 2 T9; cfg.chords.confidence == 'posterior').

    chord_posterior(emis, stay, trans=None, n_move=None) -> (n_states, n_cols) posterior P(state_t | all columns)
    segment_candidates(post, states, start, end, k) -> [(root, quality, prob)]   top-k of a segment (T27)
    attach_candidates(segments, beat_chords, cfg) -> segments with .candidates     (cfg.chords.candidates)

`emis`: (n_states, n_cols) log emission scores exactly as the Viterbi uses them (chords.py passes
_BETA * scores). `stay`: self-transition probability; the default transition matrix is the same as the
Viterbi's (stay with `stay`, every other state (1 - stay) / (n_move - 1); `n_move` = vocab.move_states(cfg)
as in the Viterbi, None = all states (T27: before, the posterior split the move over every state while the
'v2' Viterbi used the v1 count; with n_move == n_states nothing changes). `trans`: optional (n, n) log transition matrix
[from, to] (the 2nd-pass theory transition, T26); when given it replaces `stay`.

NOTE: chords.py calls this WITHOUT the theory prior (pass-1 model), so the posterior describes the
acoustic HMM only, even when the Viterbi path itself used the 2nd-pass prior. Whether the posterior
should include the theory prior is an open question (T0).

Plain scaled forward-backward in probability space (no learned parameters). Each column sums to 1.
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np

from . import vocab


def chord_posterior(emis: np.ndarray, stay: float, trans: np.ndarray | None = None,
                    n_move: int | None = None) -> np.ndarray | None:
    emis = np.asarray(emis, dtype=float)
    k, n = emis.shape
    if n == 0 or k == 0:
        return np.zeros((k, n))
    if trans is None:
        if k == 1:
            return np.ones((1, n))
        m = k if n_move is None else n_move
        stay = min(max(stay, 1.0 / m + 1e-9), 1 - 1e-9)
        a = np.full((k, k), (1 - stay) / (m - 1))
        np.fill_diagonal(a, stay)
    else:
        lt = np.asarray(trans, dtype=float)
        a = np.exp(lt - lt.max(axis=1, keepdims=True))
        a /= a.sum(axis=1, keepdims=True)
    b = np.exp(emis - emis.max(axis=0, keepdims=True))  # per-column scaling cancels in the posterior
    alpha = np.empty((k, n))
    beta = np.ones((k, n))
    v = b[:, 0] / k
    alpha[:, 0] = v / v.sum()
    for t in range(1, n):
        v = (a.T @ alpha[:, t - 1]) * b[:, t]
        alpha[:, t] = v / v.sum()
    for t in range(n - 2, -1, -1):
        v = a @ (b[:, t + 1] * beta[:, t + 1])
        beta[:, t] = v / v.sum()
    post = alpha * beta
    return post / post.sum(axis=0, keepdims=True)


def segment_candidates(post: np.ndarray, states: list[tuple[int, str]], start: int, end: int, k: int
                       ) -> list[tuple[int, str, float]]:
    """Top-k states by the mean posterior over columns [start, end): [(root, quality, prob)], prob descending
    (ties: state order). Probabilities are shares of the segment (they sum to <= 1 over the k shown)."""
    n = post.shape[1]
    a, b = max(start, 0), min(end, n)
    if b <= a or k < 1:
        return []
    mean = post[:, a:b].mean(axis=1)
    order = sorted(range(len(states)), key=lambda i: (-mean[i], i))[:k]
    return [(states[i][0], states[i][1], float(mean[i])) for i in order]


def attach_candidates(segments: list, beat_chords: list, cfg) -> list:
    """Segments with `.candidates` from the per-beat posteriors on the BeatChords (chords.estimate_chords stores
    them when cfg.chords.candidates). Segments with no chord, or beats without a posterior, get ()."""
    if not segments or not cfg.chords.candidates:
        return segments
    if not beat_chords or any(bc.posterior is None for bc in beat_chords):
        return segments
    post = np.stack([np.asarray(bc.posterior, dtype=float) for bc in beat_chords], axis=1)
    states = vocab.states(cfg)
    out = []
    for seg in segments:
        if seg.root is None:
            out.append(seg)
            continue
        cands = segment_candidates(post, states, seg.start_beat, seg.end_beat, cfg.chords.candidates_k)
        out.append(replace(seg, candidates=tuple(cands)))
    return out
