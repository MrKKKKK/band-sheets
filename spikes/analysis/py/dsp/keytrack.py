"""Per-bar key tracking (spike 2 T22; cfg.key.track == 'sections'; design decision 10).

    estimate(chords, bar_of_col, section_bars, cfg, profile='theory') -> list[BarKey]

A 24-state HMM over bars (12 tonics x major/minor), decoded with Viterbi; the confidence of each bar
is the posterior probability (forward-backward) of the chosen key.

- Emission (profile 'theory', the default): how well each first-pass chord fits the key, by the
  music-theory table tables/key_fit.toml (tonic / diatonic / borrowed / secondary / other), averaged
  over the bar's columns (so beat and eighth resolution give the same scale). The harmonic-minor V / vii°
  ([minor] dominant) scores the same in the minor key and its relative major (V/vi there), and never
  places a bar in either of them: only its resolution tells them apart (note §5.0, v3). Profile 'kk' is the
  spike 1 Krumhansl-Kessler correlation (keyest.key_scores) of the bar's chord-tone profile, kept only
  as a comparison (docs/audio-spike2-plan.md §3).
- Transition: staying is free; a change costs key_fit [change] mid inside a section, boundary at a
  detected section start (`section_bars`; a soft preferred change point, not a forced one), times
  near_factor for near keys (dominant, subdominant, relative, parallel). cfg.key.change_cost_mid /
  change_cost_boundary override the table when > 0 (0.0 = use the table).
- Resolutions (primary criterion, user decision 2026-10-11 「解決先で決める」): a dominant-function chord
  followed by its target (resolutions()) adds [resolution] bonus to the target key on both bars. An HMM
  pass gives the key just before the dominant (first pass with every dominant-7th-type resolution's bonus, then
  repeated up to _MAX_PASSES times until the path is stable). When the target key differs from it, the bonus counts
  only if min_bars bars diatonic to the target key follow before the music returns to the old key
  (resolves to it, or is diatonic to it only: _modulates) = modulation; otherwise it is a tonicization
  and is ignored. Profile 'kk' gets no bonuses (comparison of key profiles only).
- [confidence] scale sharpens the posterior (scores are multiplied by it before forward-backward;
  the Viterbi path does not depend on it).

`chords`: first-pass per-column BeatChord list; `bar_of_col`: bar index per column (negative =
pickup, ignored). Returns one BarKey per bar 0..max(bar_of_col), ascending.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .config import Config
from .keyest import key_scores
from .types import BarKey, BeatChord

TABLE_PATH = os.path.join(os.path.dirname(__file__), 'tables', 'key_fit.toml')
MODES = ('major', 'minor')
STAGES = ('other', 'secondary', 'borrowed', 'diatonic', 'tonic')  # ascending
QUALITIES = ('maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'm7b5', 'dim7', 'sus4')
QUAL_INDEX = {q: i for i, q in enumerate(QUALITIES)}
# Chord tones (semitones above the root), only for the 'kk' comparison profile.
_TONES = {
    'maj': (0, 4, 7), 'min': (0, 3, 7), '7': (0, 4, 7, 10), 'maj7': (0, 4, 7, 11), 'min7': (0, 3, 7, 10),
    'dim': (0, 3, 6), 'aug': (0, 4, 8), 'm7b5': (0, 3, 6, 10), 'dim7': (0, 3, 6, 9), 'sus4': (0, 5, 7),
}


def key_index(tonic: int, mode: str) -> int:
    """Index in keyest.KEYS order: majors 0-11, minors 12-23."""
    return MODES.index(mode) * 12 + tonic % 12


@lru_cache(maxsize=1)
def load_table() -> dict:
    with open(TABLE_PATH, 'rb') as f:
        return tomllib.load(f)


def _relative_dominants(table: dict):
    """(minor key, relative major key, root, quality index) for every chord of [minor] dominant (the harmonic-minor
    V / vii° with the raised leading tone) in every key: in the relative major it is V/vi (E7 in C major)."""
    for item in table['minor'].get('dominant', []):
        deg, q = item.split()
        for tonic in range(12):
            yield (key_index(tonic, 'minor'), key_index(tonic + 3, 'major'), (tonic + int(deg)) % 12, QUAL_INDEX[q])


def fit_matrix(table: dict) -> np.ndarray:
    """(24 keys, 12 roots, len(QUALITIES)) fit score; a chord in several lists takes the highest stage.

    The chords of [minor] dominant (harmonic-minor V / vii°) get the same score in the minor key and in its
    relative major (where they are V/vi): max([stage] dominant, the relative major's own stage). So E7 alone
    never tells A minor from C major (note §5.0: the key is decided by where the dominant resolves)."""
    st = table['stage']
    out = np.full((24, 12, len(QUALITIES)), float(st['other']))
    for mode in MODES:
        for stage in STAGES[1:]:
            for item in table[mode][stage]:
                deg, q = item.split()
                for tonic in range(12):
                    k, r, qi = key_index(tonic, mode), (tonic + int(deg)) % 12, QUAL_INDEX[q]
                    out[k, r, qi] = max(out[k, r, qi], float(st[stage]))
    if 'dominant' in st:
        for km, kr, r, qi in _relative_dominants(table):
            out[km, r, qi] = out[kr, r, qi] = max(float(st['dominant']), out[kr, r, qi])
    return out


def neutral_matrix(table: dict) -> np.ndarray:
    """(24, 12, len(QUALITIES)) bool: the chord is the harmonic-minor V / vii° of the minor key or V/vi of the
    major key, so it never places a bar in that key or in its relative key (_bar_diatonic)."""
    out = np.zeros((24, 12, len(QUALITIES)), dtype=bool)
    for km, kr, r, qi in _relative_dominants(table):
        out[km, r, qi] = out[kr, r, qi] = True
    return out


def _near(a: int, b: int) -> bool:
    """Near keys (note §5.2): same mode a fifth up/down, relative, parallel."""
    (ma, ta), (mb, tb) = divmod(a, 12), divmod(b, 12)
    if ma == mb:
        return (tb - ta) % 12 in (5, 7)
    if ma == 0:  # a major, b minor
        return tb in (ta, (ta + 9) % 12)
    return tb in (ta, (ta + 3) % 12)


def _near_matrix() -> np.ndarray:
    return np.array([[_near(a, b) for b in range(24)] for a in range(24)])


def _emissions(chords: list[BeatChord], bar_of_col: np.ndarray, n_bars: int, profile: str,
               table: dict) -> np.ndarray:
    """(n_bars, 24) mean per-column score of each key."""
    em = np.zeros((n_bars, 24))
    cnt = np.zeros(n_bars)
    if profile == 'theory':
        fit = fit_matrix(table)
        for ch, b in zip(chords, bar_of_col):
            if b < 0:
                continue
            cnt[b] += 1
            if ch.root is not None and ch.quality in QUAL_INDEX:
                em[b] += fit[:, ch.root % 12, QUAL_INDEX[ch.quality]]
        return em / np.maximum(cnt, 1)[:, None]
    if profile == 'kk':
        pcp = np.zeros((n_bars, 12))
        for ch, b in zip(chords, bar_of_col):
            if b < 0 or ch.root is None or ch.quality not in _TONES:
                continue
            for iv in _TONES[ch.quality]:
                pcp[b, (ch.root + iv) % 12] += 1.0
        for b in range(n_bars):
            if np.ptp(pcp[b]) > 0:
                em[b] = key_scores(pcp[b])
        return em
    raise ValueError(f'unknown key profile: {profile!r}')


@dataclass(frozen=True)
class Resolution:
    dom_bar: int  # bar of the dominant chord's first column
    target_bar: int  # bar of the target chord's first column
    tonic: int  # target root = tonic of the key it points to
    mode: str  # 'major' | 'minor' (from the target chord's quality)
    kind: str  # 'dominant7' | 'triad' ([resolution] weight name)
    target_cols: tuple[int, int] = (0, 0)  # columns [start, end) of the target chord segment


_MAX_PASSES = 4
_TARGET_MODE = {'maj': 'major', 'maj7': 'major', 'min': 'minor', 'min7': 'minor'}


def _resolution_kind(dom: BeatChord, tgt: BeatChord) -> str | None:
    step = (tgt.root - dom.root) % 12
    if dom.quality == '7' and step in (5, 11):  # V7 -> a 5th down; tritone substitute -> a semitone down
        return 'dominant7'
    if dom.quality == 'maj' and step == 5:  # plain V triad
        return 'triad'
    if dom.quality in ('dim', 'm7b5') and step == 1:  # vii°
        return 'dominant7'
    if dom.quality == 'dim7' and step % 3 == 1:  # a semitone above any of its 4 tones
        return 'dominant7'
    return None


def resolutions(chords: list[BeatChord], bar_of_col: np.ndarray) -> list[Resolution]:
    """Dominant -> target pairs between consecutive chord segments (no-chord columns break the chain)."""
    segs: list[tuple[BeatChord, int, int]] = []  # (chord, bar of its first column, first column)
    prev_key = None
    for c, (ch, b) in enumerate(zip(chords, np.asarray(bar_of_col, dtype=int))):
        key = (ch.root, ch.quality)
        if key != prev_key:
            segs.append((ch, int(b), c))
            prev_key = key
    ends = [s[2] for s in segs[1:]] + [len(chords)]
    out = []
    for i, ((dom, db, _), (tgt, tb, tc)) in enumerate(zip(segs, segs[1:])):
        if dom.root is None or tgt.root is None or tgt.quality not in _TARGET_MODE or tb < 0:
            continue
        kind = _resolution_kind(dom, tgt)
        if kind:
            out.append(Resolution(max(db, 0), tb, tgt.root % 12, _TARGET_MODE[tgt.quality], kind, (tc, ends[i + 1])))
    return out


def phrases(bar_of_col: np.ndarray, section_bars: list[int], n_bars: int, length: int,
            voiced: np.ndarray | None = None) -> list[tuple[int, int]]:
    """Phrase units [first column, last column] (inclusive): `length`-bar groups counted from bar 0 and restarted at
    every detected section start (note §5.0 phrase framing). length <= 0 -> [] (framing off).

    `voiced` (bool per column, optional): only columns with a chord count as a phrase's first / last column, so a
    rest at a phrase start or silence / decay at the end of the recording does not hide the chord the phrase really
    starts or ends on (note §5.0: the resolution target is the phrase's first or last *chord*). A unit with no voiced
    column is dropped."""
    if length <= 0 or n_bars <= 0:
        return []
    bar_of_col = np.asarray(bar_of_col, dtype=int)
    mask = np.ones(len(bar_of_col), dtype=bool) if voiced is None else np.asarray(voiced, dtype=bool)
    starts = sorted({0} | {int(b) for b in section_bars if 0 < int(b) < n_bars})
    bounds: list[int] = []
    for a, z in zip(starts, starts[1:] + [n_bars]):
        bounds += list(range(a, z, length))
    out = []
    for a, z in zip(bounds, bounds[1:] + [n_bars]):
        cols = np.flatnonzero((bar_of_col >= a) & (bar_of_col < z) & mask)
        if len(cols):
            out.append((int(cols[0]), int(cols[-1])))
    return out


def frames_phrase(r: Resolution, units: list[tuple[int, int]]) -> bool:
    """True when the resolution's target chord frames a phrase: it covers the phrase's first or last column (the
    chord a phrase / loop starts or ends on). A target in the middle of a phrase that starts and ends elsewhere (C E7
    Am F) is a tonicization of that chord, not evidence for its key (note §5.0, T14c). No phrases -> True."""
    if not units:
        return True
    a, z = r.target_cols
    return any(a <= p0 < z or a <= p1 < z for p0, p1 in units)


def _bar_diatonic(chords: list[BeatChord], bar_of_col: np.ndarray, n_bars: int, fit: np.ndarray,
                  diatonic: float, neutral: np.ndarray) -> np.ndarray:
    """(n_bars, 24) bool: the bar has stable chords (maj, maj7, min, min7) and all of them are diatonic (or
    tonic) to the key. Dominant-function chords point at another chord, so they never place a bar in a key
    (they act through resolutions); bars without stable chords are False for every key. The same holds for a
    plain triad that is the harmonic-minor V of the key or V/vi of the major key (`neutral`: E in C major /
    A minor) — it is skipped for those two keys only (in E major it is still the tonic)."""
    ok = np.ones((n_bars, 24), dtype=bool)
    seen = np.zeros((n_bars, 24), dtype=bool)
    for ch, b in zip(chords, bar_of_col):
        if b < 0 or ch.root is None or ch.quality not in _TARGET_MODE:
            continue
        q = QUAL_INDEX[ch.quality]
        skip = neutral[:, ch.root % 12, q]
        seen[b] |= ~skip
        ok[b] &= (fit[:, ch.root % 12, q] >= diatonic) | skip
    return ok & seen


def _modulates(dia: np.ndarray, target_bar: int, new: int, prev: int, n_need: int, back_home: set[int],
               end_counts: bool = True) -> bool:
    """After the target bar: n_need bars diatonic to the new key only, before the music returns to the previous
    key -> modulation. A return is a bar that resolves to the previous key (`back_home`: target bars of its
    resolutions; the only cue between relative keys) or is diatonic to the previous key only. Bars diatonic
    to both keys (common chords prove nothing: e.g. C and F after C7 -> F in C) or to neither are neutral;
    reaching the song's end without a return counts as staying when `end_counts` (not for a plain triad
    dominant, which needs positive evidence because I -> IV looks the same)."""
    count = 0
    for b in range(target_bar + 1, dia.shape[0]):
        if b in back_home:
            return False
        in_new, in_prev = dia[b, new], dia[b, prev]
        if in_new and not in_prev:
            count += 1
            if count >= n_need:
                return True
        elif in_prev and not in_new:
            return False
    return end_counts


def _resolution_bonus(chords, bar_of_col, n_bars, path0, table, units=()) -> np.ndarray:
    """(n_bars, 24) bonus from the resolutions; path0 = None applies every 'dominant7' resolution without the
    tonicization test (the first guess: plain triads are left out, since I -> IV looks like V -> I). Only resolutions
    whose target frames a phrase (`units`, frames_phrase) count, in every pass."""
    res = table['resolution']
    n_need = int(res['min_bars'])
    dia = _bar_diatonic(chords, bar_of_col, n_bars, fit_matrix(table), float(table['stage']['diatonic']),
                        neutral_matrix(table))
    bonus = np.zeros((n_bars, 24))
    res_list = [r for r in resolutions(chords, bar_of_col) if frames_phrase(r, list(units))]
    for r in res_list:
        k = key_index(r.tonic, r.mode)
        if path0 is None:
            if r.kind != 'dominant7':
                continue
            for b in {r.dom_bar, r.target_bar}:
                bonus[b, k] += float(res[r.kind])
            continue
        prev = int(path0[max(r.dom_bar - 1, 0)])  # the key just before the cadence
        back_home = {q.target_bar for q in res_list if key_index(q.tonic, q.mode) == prev}
        if k != prev and not _modulates(dia, r.target_bar, k, prev, n_need, back_home, r.kind == 'dominant7'):
            continue  # tonicization: the key stays
        for b in {r.dom_bar, r.target_bar}:
            bonus[b, k] += float(res[r.kind])
    return bonus


def _logsumexp(x: np.ndarray, axis: int) -> np.ndarray:
    m = np.max(x, axis=axis, keepdims=True)
    return np.squeeze(m, axis=axis) + np.log(np.sum(np.exp(x - m), axis=axis))


def _viterbi(em: np.ndarray, trans) -> np.ndarray:
    n_bars = em.shape[0]
    score = em[0].copy()
    back = np.zeros((n_bars, 24), dtype=int)
    for b in range(1, n_bars):
        cand = score[:, None] + trans(b)
        back[b] = np.argmax(cand, axis=0)
        score = cand[back[b], np.arange(24)] + em[b]
    path = np.zeros(n_bars, dtype=int)
    path[-1] = int(np.argmax(score))
    for b in range(n_bars - 1, 0, -1):
        path[b - 1] = back[b, path[b]]
    return path


def estimate(chords: list[BeatChord], bar_of_col: np.ndarray, section_bars: list[int], cfg: Config,
             profile: str = 'theory', info: dict | None = None) -> list[BarKey]:
    """`info` (optional dict) receives 'passes' (resolution re-passes run) and 'converged' (False when the path
    still changed after _MAX_PASSES re-passes: the last path is used; analyze records a warning)."""
    info = {} if info is None else info
    info.update(passes=0, converged=True)
    bar_of_col = np.asarray(bar_of_col, dtype=int)
    if len(chords) == 0 or len(bar_of_col) == 0 or int(bar_of_col.max()) < 0:
        return []
    table = load_table()
    n_bars = int(bar_of_col.max()) + 1
    em = _emissions(chords, bar_of_col, n_bars, profile, table)

    ch = table['change']
    mid = cfg.key.change_cost_mid if cfg.key.change_cost_mid > 0 else float(ch['mid'])
    bnd = cfg.key.change_cost_boundary if cfg.key.change_cost_boundary > 0 else float(ch['boundary'])
    near = np.where(_near_matrix(), float(ch['near_factor']), 1.0)
    np.fill_diagonal(near, 0.0)
    boundaries = {int(b) for b in section_bars}
    # trans[b] (24 from, 24 to): log-weight of the move from bar b-1 to bar b (b >= 1)
    def trans(b: int) -> np.ndarray:
        return -(bnd if b in boundaries else mid) * near

    if profile == 'theory':
        ph = table.get('phrase', {})
        edge = ph.get('edge', 'column')
        if edge not in ('chord', 'column'):
            raise ValueError(f'key_fit [phrase] edge must be "chord" or "column": {edge!r}')
        voiced = np.array([c.root is not None for c in chords], dtype=bool) if edge == 'chord' else None
        units = phrases(bar_of_col, section_bars, n_bars, int(ph.get('bars', 0)), voiced)
        # first guess: every dominant-7th-type resolution counts (relative keys share all chords, so the
        # bonus-free path is no guide to "the key before the cadence"); then test each one against the latest path
        base = em
        path = _viterbi(base + _resolution_bonus(chords, bar_of_col, n_bars, None, table, units), trans)
        for i in range(_MAX_PASSES):  # the "key before the cadence" comes from the previous pass
            em = base + _resolution_bonus(chords, bar_of_col, n_bars, path, table, units)
            new = _viterbi(em, trans)
            info['passes'] = i + 1
            if np.array_equal(new, path):
                break
            path = new
        else:
            info['converged'] = False
    else:
        path = _viterbi(em, trans)

    # forward-backward (sum-product) on the sharpened scores for the per-bar posterior
    s = float(table['confidence']['scale'])
    fwd = np.zeros((n_bars, 24))
    bwd = np.zeros((n_bars, 24))
    fwd[0] = s * em[0]
    for b in range(1, n_bars):
        fwd[b] = _logsumexp(fwd[b - 1][:, None] + s * trans(b), axis=0) + s * em[b]
    for b in range(n_bars - 2, -1, -1):
        bwd[b] = _logsumexp(s * trans(b + 1) + (s * em[b + 1] + bwd[b + 1])[None, :], axis=1)
    post = fwd + bwd
    post = np.exp(post - _logsumexp(post, axis=1)[:, None])

    out = []
    for b in range(n_bars):
        mode, tonic = divmod(int(path[b]), 12)
        out.append(BarKey(b, tonic, MODES[mode], float(np.clip(post[b, path[b]], 0.0, 1.0))))
    return out
