"""Music-theory transition prior for the second chord pass (spike 2 T26; design decision 9).

    transition(states, bar_keys, bar_of_col, cfg) -> (n_cols, n_states, n_states)
    resolve_power(segments, bar_keys, bar_of_col, cfg) -> segments   ('5' -> maj / min by key, T27 + T26)
    tier_matrix(mode) -> (12 * len(QUALITIES),) * 2 tier value of each move in degree space (tonic 0)

Entry [t, i, j] is a log-domain bonus added to the move from state i (column t-1) to state j (column t).
Source of every rule: tables/harmony.toml (the user's note 「和声法ノート」 §6.1-6.4). Steps per column t:

1. Key of the column = the BarKey of its bar (pickup columns: the first bar; bars past the end: the last).
2. Raw bonus b[i, j] = theory_prior x key confidence x tier(i -> j), tier from the degrees of i and j
   relative to the key (strongest matching rule, never summed; base = 0, so it never bans a move).
   Staying (i == j) is never touched. At a key change (column t-1 in another key) both keys are tried and
   the stronger product is kept per move (note §6.3, pivot chords / the new key's V).
3. Row normalization (note §6.4): b[i, j] -= log(mean over j != i of exp(b[i, j])), so for each previous
   state the total probability of changing chord is the same as without the prior; the prior only
   redistributes where to go, not whether to change. A row with no bonus stays 0.
Column 0 has no incoming move (all 0). theory_prior <= 0 or no keys -> all zeros (the 1st pass).

Power chords ('5', T27) have no third: as a source or target they count as maj or min, whichever gets the
stronger tier. resolve_power then names the quality of each '5' segment from the key context: the triad
(maj / min) with the larger tier sum of the move in (from the previous segment) and out (to the next one),
ties broken by being diatonic; a full tie keeps '5'. Not in the note (an extension of its rules).

Rules (harmony.toml [generic], degrees relative to the tonic; "diatonic" = [<mode>].diatonic):
  secondary_dominant: D-type chord, not diatonic, root a 5th above x -> any M / m / D chord on root x,
                      x = a diatonic root other than the tonic and the diminished roots (note §3.1).
  two_five:           m / o type a 5th above y -> D-type y, y = the root of a secondary dominant (§3.2).
  tritone_sub:        D-type chord, not diatonic, a semitone above x -> diatonic x (tonic included) (§3.3).
  passing_dim:        dim7 with any tone a semitone below x's root (dim / m7b5: the root) -> diatonic x (§3.5).
  sus4_resolution:    sus4 -> same root M / D type (§3.7).
  diatonic_other:     diatonic -> diatonic with another root (§2.4).
  into_technique:     diatonic -> a non-diatonic source of the rules above or a borrowed chord (same root too:
                      C -> C7) (§3).
  backdoor_two_five:  m type a whole tone above x -> D-type a semitone above x, x a diatonic root (§3.3).
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import replace
from functools import lru_cache

import numpy as np

from .config import Config
from .types import BarKey

TABLE_PATH = os.path.join(os.path.dirname(__file__), 'tables', 'harmony.toml')
MODES = ('major', 'minor')
QUALITIES = ('maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'sus4', 'm7b5', 'dim7', '5')
QI = {q: i for i, q in enumerate(QUALITIES)}
POWER = '5'
NQ = len(QUALITIES)


@lru_cache(maxsize=1)
def load_table() -> dict:
    with open(TABLE_PATH, 'rb') as f:
        return tomllib.load(f)


def _quals(token: str, fam: dict) -> set[str]:
    out: set[str] = set()
    for part in token.split('+'):
        if part in fam:
            out |= set(fam[part])
        elif part in QI and part != POWER:
            out.add(part)
        else:
            raise ValueError(f'harmony.toml: unknown family / quality {part!r}')
    return out


def parse_chords(items: list[str], fam: dict) -> set[tuple[int, str]]:
    """["7 D+s", ...] -> {(7, '7'), (7, 'maj'), (7, 'sus4'), ...}"""
    out = set()
    for item in items:
        deg, tok = item.split()
        d = int(deg)
        if not 0 <= d < 12:
            raise ValueError(f'harmony.toml: degree out of range in {item!r}')
        out |= {(d, q) for q in _quals(tok, fam)}
    return out


def _idx(d: int, q: str) -> int:
    return (d % 12) * NQ + QI[q]


@lru_cache(maxsize=2)
def tier_matrix(mode: str) -> np.ndarray:
    """(12*NQ, 12*NQ) tier value of the move (degree a, quality a) -> (degree b, quality b) for a key with tonic
    0; index = degree * NQ + QI[quality]. Diagonal 0. Power chords take the max over maj / min."""
    t = load_table()
    fam, tv, md = t['family'], t['tier'], t[mode]
    gen = {name: float(tv[g['tier']]) for name, g in t['generic'].items()}
    M, D, m, o = (set(fam[k]) for k in ('M', 'D', 'm', 'o'))
    dia = parse_chords(md['diatonic'], fam)
    borrowed = parse_chords(md['borrowed'], fam)
    n = 12 * NQ
    T = np.zeros((n, n))

    def put(a, b, v):
        if a != b:
            i, j = _idx(*a), _idx(*b)
            T[i, j] = max(T[i, j], v)

    for tier in ('strong', 'medium', 'weak'):
        for rule in md.get(tier, []):
            for a in parse_chords(rule['from'], fam):
                for b in parse_chords(rule['to'], fam):
                    put(a, b, float(tv[tier]))

    stable = M | m | D
    dia_roots = sorted({d for d, q in dia if q in stable})  # roots of diatonic non-diminished chords
    targets = [x for x in dia_roots if x != 0]
    technique: set[tuple[int, str]] = set(borrowed - dia)
    # secondary dominants -> x (root only) ; II-V into them
    for x in targets:
        y = (x + 7) % 12
        srcs = {(y, q) for q in D} - dia
        technique |= srcs
        for s in srcs:
            for q in stable:
                put(s, (x, q), gen['secondary_dominant'])
        for s in {((y + 7) % 12, q) for q in m | o}:
            for d in srcs:
                put(s, d, gen['two_five'])
    for x in dia_roots:
        tgt = {c for c in dia if c[0] == x}
        srcs = {((x + 1) % 12, q) for q in D} - dia  # tritone substitute
        technique |= srcs
        for s in srcs:
            for b in tgt:
                put(s, b, gen['tritone_sub'])
        for d0 in range(12):  # passing diminished
            for q in o:
                tones = {(d0 + k) % 12 for k in (0, 3, 6, 9)} if q == 'dim7' else {d0}
                if (x - 1) % 12 in tones:
                    s = (d0, q)
                    if s not in dia:
                        technique.add(s)
                    for b in tgt:
                        put(s, b, gen['passing_dim'])
        for qa in m:  # back-door II-V: ii/x -> subV/x
            for qb in D:
                put(((x + 2) % 12, qa), ((x + 1) % 12, qb), gen['backdoor_two_five'])
    for d in range(12):
        for q in M | D:
            put((d, 'sus4'), (d, q), gen['sus4_resolution'])
    for a in dia:
        for b in dia:
            if a[0] != b[0]:
                put(a, b, gen['diatonic_other'])
        for b in technique:
            put(a, b, gen['into_technique'])
    # power chords: max over maj / min, as source and as target
    for d in range(12):
        p, mj, mn = _idx(d, POWER), _idx(d, 'maj'), _idx(d, 'min')
        T[p, :] = np.maximum(T[mj, :], T[mn, :])
    for d in range(12):
        p, mj, mn = _idx(d, POWER), _idx(d, 'maj'), _idx(d, 'min')
        T[:, p] = np.maximum(T[:, mj], T[:, mn])
    np.fill_diagonal(T, 0.0)
    return T


def _state_tiers(states: list[tuple[int, str]], tonic: int, mode: str) -> np.ndarray:
    """(k, k) tier values of the moves between `states` in the key (tonic, mode)."""
    idx = np.array([_idx((r - tonic) % 12, q) for r, q in states])
    out = tier_matrix(mode)[np.ix_(idx, idx)].copy()
    np.fill_diagonal(out, 0.0)
    return out


def normalize_rows(b: np.ndarray) -> np.ndarray:
    """Note §6.4: shift each row's off-diagonal entries so that sum_{j != i} exp(b[i, j]) = k - 1 (the total
    change probability of a uniform move row is kept); the diagonal (stay) stays 0."""
    k = b.shape[0]
    if k < 2:
        return np.zeros_like(b)
    e = np.exp(b)
    np.fill_diagonal(e, 0.0)
    shift = np.log(e.sum(axis=1) / (k - 1))
    out = b - shift[:, None]
    np.fill_diagonal(out, 0.0)
    return out


def _col_keys(bar_keys: list[BarKey], bar_of_col: np.ndarray) -> list[BarKey]:
    by_bar = {k.bar: k for k in bar_keys}
    bars = sorted(by_bar)
    out = []
    for b in np.asarray(bar_of_col, dtype=int):
        b = int(b)
        if b in by_bar:
            out.append(by_bar[b])
        else:  # pickup -> first bar; otherwise the nearest earlier bar (or the first)
            prev = [x for x in bars if x <= b]
            out.append(by_bar[prev[-1] if prev else bars[0]])
    return out


def transition(states: list[tuple[int, str]], bar_keys: list[BarKey], bar_of_col: np.ndarray, cfg: Config) -> np.ndarray:
    k, n = len(states), len(bar_of_col)
    out = np.zeros((n, k, k))
    strength = float(cfg.chords.theory_prior)
    if strength <= 0 or not bar_keys or n < 2:
        return out
    keys = _col_keys(bar_keys, bar_of_col)
    tiers: dict[tuple[int, str], np.ndarray] = {}
    done: dict[tuple, np.ndarray] = {}

    def tiers_of(key: BarKey) -> np.ndarray:
        kk = (key.tonic % 12, key.mode)
        if kk not in tiers:
            tiers[kk] = _state_tiers(states, *kk)
        return tiers[kk]

    for t in range(1, n):
        cur, prev = keys[t], keys[t - 1]
        same = (cur.tonic % 12, cur.mode) == (prev.tonic % 12, prev.mode)
        sig = (cur.tonic % 12, cur.mode, cur.confidence) + (() if same else (prev.tonic % 12, prev.mode, prev.confidence))
        if sig not in done:
            b = strength * max(cur.confidence, 0.0) * tiers_of(cur)
            if not same:  # key change: the stronger of both keys (note §6.3)
                b = np.maximum(b, strength * max(prev.confidence, 0.0) * tiers_of(prev))
            done[sig] = normalize_rows(b) if b.any() else np.zeros((k, k))
        out[t] = done[sig]
    return out


def _tier(a: tuple[int, str], b: tuple[int, str], key: BarKey) -> float:
    if a[0] is None or b[0] is None:
        return 0.0
    T = tier_matrix(key.mode)
    return float(T[_idx((a[0] - key.tonic) % 12, a[1]), _idx((b[0] - key.tonic) % 12, b[1])])


def _is_diatonic(root: int, q: str, key: BarKey) -> bool:
    t = load_table()
    return ((root - key.tonic) % 12, q) in parse_chords(t[key.mode]['diatonic'], t['family'])


def resolve_power(segments: list, bar_keys: list[BarKey], bar_of_col: np.ndarray, cfg: Config) -> list:
    """Name the quality of each '5' segment (maj / min) from the key context (see module doc). Needs
    theory_prior > 0, keys and a key confidence > 0 at the segment; neighbours that become equal are merged."""
    if cfg.chords.theory_prior <= 0 or not bar_keys or not segments or len(bar_of_col) == 0:
        return segments
    n = len(bar_of_col)
    keys = _col_keys(bar_keys, bar_of_col)
    out = []
    for i, seg in enumerate(segments):
        if seg.root is None or seg.quality != POWER:
            out.append(seg)
            continue
        a = min(max(seg.start_beat, 0), n - 1)
        key = keys[a]
        if key.confidence <= 0:
            out.append(seg)
            continue
        pkey = keys[a - 1] if a > 0 else key
        prev = segments[i - 1] if i > 0 else None
        nxt = segments[i + 1] if i + 1 < len(segments) else None
        score = {}
        for q in ('maj', 'min'):
            s = 0.0
            if prev is not None and prev.root is not None:
                s += max(_tier((prev.root, prev.quality), (seg.root, q), key),
                         _tier((prev.root, prev.quality), (seg.root, q), pkey))
            if nxt is not None and nxt.root is not None:
                s += _tier((seg.root, q), (nxt.root, nxt.quality), key)
            score[q] = (s, _is_diatonic(seg.root, q, key))
        if score['maj'] == score['min']:
            out.append(seg)
            continue
        out.append(replace(seg, quality=max(score, key=score.get)))
    merged: list = []
    for seg in out:
        p = merged[-1] if merged else None
        if p is not None and p.root is not None and (p.root, p.quality, p.bass) == (seg.root, seg.quality, seg.bass):
            na, nb = p.end_beat - p.start_beat, seg.end_beat - seg.start_beat
            conf = (p.confidence * na + seg.confidence * nb) / max(na + nb, 1)
            merged[-1] = replace(p, end_beat=seg.end_beat, confidence=conf,
                                 low_confidence=conf < cfg.chords.low_confidence)
        else:
            merged.append(seg)
    return merged
