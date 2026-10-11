"""Chord posterior probabilities for confidence (spike 2 T9; cfg.chords.confidence == 'posterior').

    chord_posterior(emis, stay, trans=None) -> (n_states, n_cols) posterior P(state_t | all columns)

`emis`: (n_states, n_cols) log emission scores exactly as the Viterbi uses them (chords.py passes
_BETA * scores). `stay`: self-transition probability; the default transition matrix is the same as the
Viterbi's (stay with `stay`, every other state uniform). `trans`: optional (n, n) log transition matrix
[from, to] (the 2nd-pass theory transition, T26); when given it replaces `stay`.

NOTE: chords.py calls this WITHOUT the theory prior (pass-1 model), so the posterior describes the
acoustic HMM only, even when the Viterbi path itself used the 2nd-pass prior. Whether the posterior
should include the theory prior is an open question (T0).

Plain scaled forward-backward in probability space (no learned parameters). Each column sums to 1.
"""

from __future__ import annotations

import numpy as np


def chord_posterior(emis: np.ndarray, stay: float, trans: np.ndarray | None = None) -> np.ndarray | None:
    emis = np.asarray(emis, dtype=float)
    k, n = emis.shape
    if n == 0 or k == 0:
        return np.zeros((k, n))
    if trans is None:
        if k == 1:
            return np.ones((1, n))
        stay = min(max(stay, 1.0 / k + 1e-9), 1 - 1e-9)
        a = np.full((k, k), (1 - stay) / (k - 1))
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
