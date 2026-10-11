"""Seventh decided per merged segment instead of per beat (spike 2 T8; cfg.chords.seventh_mode == 'segment').

    decide_segments(segments, chroma, cfg) -> segments

`segments`: chords.merge_chords output; `chroma`: the per-column chroma (12, n_cols).

Rule (R13): the segment's root and triad are kept from the beat-level decision (the triad is the
first three tones of the segment's quality, so 7 / maj7 / min7 count as maj / maj / min and
dim / m7b5 / dim7 as dim). The chroma is averaged over the segment (or only its back half: BACK_HALF, off by default,
it raises recall but lowers precision on L0) and

    ratio(candidate) = strength of the candidate's 4th tone / mean strength of the triad tones.

The candidate with the largest ratio becomes the segment's quality if ratio >= SEVENTH_RATIO,
otherwise the segment is the plain triad. Candidates are the 4-tone qualities of the vocabulary
(vocab.states(cfg)) that share the triad, so m7b5 / dim7 follow the same rule. Neighbouring segments
that become the same chord are merged again.

Module constants (not in Config: config.py belongs to T0); tune them from a scratch script.
Tuned on the tuning variants (L0 / L2 / L3 / LR / V, 7th precision / recall): see the T8 commit message.
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np

from . import vocab
from .chords import ChordSegment
from .config import Config

SEVENTH_RATIO = 0.5  # 4th tone must be at least this share of the mean triad tone
BACK_HALF = False  # use only the back half of a segment (the front half carries the previous chord's tail)
AGGREGATE = 'mean'  # 'mean' | 'median' of the segment's columns (the median ignores a one-beat tail)
NOISE_FACTOR = 0.0  # 4th tone must also be >= this x the mean of the 8 pitch classes outside the 4 chord tones


def _triad(quality: str) -> tuple[int, ...]:
    return vocab.intervals(quality)[:3]


def _decide(seg: ChordSegment, chroma: np.ndarray, qualities: list[str]) -> str:
    n = chroma.shape[1]
    a, b = max(seg.start_beat, 0), min(seg.end_beat, n)
    if b <= a:
        return seg.quality
    if BACK_HALF and b - a >= 2:
        a = a + (b - a) // 2
    seg_c = chroma[:, a:b]
    m = np.median(seg_c, axis=1) if AGGREGATE == 'median' else seg_c.mean(axis=1)
    tri = _triad(seg.quality)
    base = float(np.mean([m[(seg.root + i) % 12] for i in tri]))
    if base <= 0:
        return seg.quality
    best, best_r = None, SEVENTH_RATIO
    for q in qualities:
        iv = vocab.intervals(q)
        if len(iv) != 4 or iv[:3] != tri:
            continue
        r = float(m[(seg.root + iv[3]) % 12]) / base
        if NOISE_FACTOR > 0:
            rest = [m[(seg.root + k) % 12] for k in range(12) if k not in iv]
            if m[(seg.root + iv[3]) % 12] < NOISE_FACTOR * float(np.mean(rest)):
                continue
        if r >= best_r:
            best, best_r = q, r
    if best is not None:
        return best
    for q in qualities:  # plain triad of this family
        if vocab.intervals(q) == tri:
            return q
    return seg.quality


def decide_segments(segments: list, chroma: np.ndarray, cfg: Config) -> list:
    if not segments or not cfg.chords.use_seventh:
        return segments
    qualities = []
    for _, q in vocab.states(cfg):
        if q not in qualities:
            qualities.append(q)
    chroma = np.asarray(chroma, dtype=float)
    decided = []
    for s in segments:
        if s.root is None:
            decided.append(s)
            continue
        q = _decide(s, chroma, qualities)
        decided.append(s if q == s.quality else replace(s, quality=q))  # replace keeps per_beat (T13)
    out: list[ChordSegment] = []
    for s in decided:
        p = out[-1] if out else None
        if p is not None and p.root is not None and p.root == s.root and p.quality == s.quality and p.bass == s.bass:
            na, nb = p.end_beat - p.start_beat, s.end_beat - s.start_beat
            conf = (p.confidence * na + s.confidence * nb) / (na + nb)
            out[-1] = replace(p, end_beat=s.end_beat, confidence=conf,
                              low_confidence=conf < cfg.chords.low_confidence)
        else:
            out.append(s)
    return out
