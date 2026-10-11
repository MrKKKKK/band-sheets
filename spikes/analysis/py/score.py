"""Scoring for band-sheets audio analysis spike 0 (docs/audio-spike0-plan.md, decision 8).

Usage: python py/score.py <truth.json> <result.json> [-o out.json]
Importable: score(truth: dict, result: dict) -> dict

A metric whose input is missing in truth or result is None ("not evaluated").
Downbeats are None when no result beat carries a "downbeat" key at all (analyzer does not estimate them).

Chord rules (decision 8):
- Per beat (R6, eighth-note resolution): each truth beat is sampled at two points, 1/4 and 3/4 of the way
  through it (the middle of each eighth note), each worth half a beat; "perBeat" and the n* counts are in
  beats (so they can end in .5). A chord boundary exactly at a beat's midpoint (anticipations) is therefore
  not ambiguous. The legacy single midpoint sample is kept as "perBeatMidpoint". Per sample: root (enharmonic-equal) + maj/min class
  (maj/7/maj7 -> maj, min/min7 -> min). Beats without a truth chord are not counted. Truth chords of
  class None (dim/aug/sus4) or of a quality outside KNOWN_QUALITIES are excluded (counted in
  nBeatsExcluded / nBeatsUnknownQualityTruth). A result chord with a quality outside KNOWN_QUALITIES
  is a miss and is counted in nBeatsUnknownQualityResult. Root "N" (or an empty root) = no chord.
- Per bar (R1, tie rule): per bar, every (root, class) whose covered time is within TIE_BEAT_FRACTION
  of a beat (0.25 beat) of the bar's maximum is a "top" chord. The bar is a hit if the truth's top set and
  the result's top set share at least one chord. So a 2+2 bar whose boundary is off by 10 ms is a hit
  on either side, instead of flipping on dict order. Bars whose truth maximum is an excluded class are skipped.
- Seventh (R3): recall = of truth beats with a 7th (7/maj7/min7) among scored beats, the share where the
  result has root+class right AND a 7th; precision = of scored beats where the result has a 7th, the share
  where root+class is right AND the truth has a 7th. 7 vs maj7 is not distinguished. A constant triad
  analyzer gets recall 0.0 and precision None (no result 7ths).
- Split (T27, chords.split, record only): root per beat, quality (triad class) per beat over samples whose result is
  not a power chord '5' (nBeatsPower / powerShare report those), and top-k (truth root + triad class among the
  result chord's `candidates`). See _score_split. A '5' result stays a miss in every metric above.
"""
import argparse
import bisect
import json
import re
import sys

import numpy as np
import mir_eval

BEAT_TOLERANCE = 0.07  # seconds
ONSET_TOLERANCE = 0.05  # seconds
PITCH_TOLERANCE_CENTS = 50.0
TIE_BEAT_FRACTION = 0.25  # per-bar tie tolerance, in beats
SEVENTH_QUALITIES = ("7", "maj7", "min7")
# NOTE (R13): duplicates ChordQuality in render/types.ts, render/chordSymbol.ts and render/pianoPart.ts;
# note-name parsing duplicates render/chordSymbol.ts (TS accepts a single accidental, this accepts more).
# Keep them in sync by hand (no shared file yet).
KNOWN_QUALITIES = ("maj", "min", "7", "maj7", "min7", "dim", "aug", "sus4")
_NOTE_BASE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_to_pc(name):
    """Note name (C, C#, Db, B#, Cb, ...) -> pitch class 0-11. Raises ValueError."""
    m = re.fullmatch(r"([A-G])([#b]*)", str(name).strip())
    if not m:
        raise ValueError(f"bad note name: {name!r}")
    acc = m.group(2).count("#") - m.group(2).count("b")
    return (_NOTE_BASE[m.group(1)] + acc) % 12


def quality_class(quality):
    """The single place mapping a quality name to a class: 'maj', 'min' or None (not counted)."""
    if quality in ("maj", "7", "maj7"):
        return "maj"
    if quality in ("min", "min7"):
        return "min"
    return None


def is_no_chord(c):
    root = c.get("root")
    return root is None or str(root).strip() in ("", "N")


def has_seventh(quality):
    return quality in SEVENTH_QUALITIES


POWER = "5"  # T27: power chord (root + 5th, no 3rd); its own triad class, so it never matches maj / min
VOCAB_QUALITIES = ("maj", "min", "7", "maj7", "min7", "dim", "aug", "sus4", "m7b5", "dim7", POWER)
_TRIAD_OF = {"maj": "maj", "7": "maj", "maj7": "maj", "min": "min", "min7": "min",
             "dim": "dim", "m7b5": "dim", "dim7": "dim", "aug": "aug", "sus4": "sus4", POWER: POWER}
_ALTERED_FIFTH = re.compile(r"b5|#5|\+5|-5|aug|\+")
_HAS_EXT = re.compile(r"(7|9|11|13)")


def map_vocab(quality):
    """The single place for the vocabulary mapping rule (plan decision 8; applied to the truth side only).

    Returns one of VOCAB_QUALITIES, or None for a form outside the vocabulary that is dropped and counted
    (7(b5), 7(#5), aug7, mM7, sus2, or anything unparseable). Tensions (9 11 13 and their alterations), 6 and
    add9 are dropped down to the underlying chord (C6, Cadd9 -> maj; G7(#9), G9, G13 -> 7; CM9 -> maj7;
    Dm9, Dm11 -> min7; Dm6 -> min); 7sus4 -> sus4; m7b5 / m9b5 -> m7b5.
    '5' (power chord, T27) stays '5': a result '5' is root-only (quality unknown), so it is a vocab miss against
    any truth triad; a truth '5' (rare in charts) is matched only by a result '5'."""
    if quality is None:
        return None
    q = str(quality).strip()
    if q in VOCAB_QUALITIES:
        return q
    s = re.sub(r"[(),\s]", "", q)
    if "sus2" in s:
        return None
    if "sus" in s:
        return "sus4"
    if re.match(r"(mM|mmaj|minmaj|minM|m\^|m\u0394)", s):
        return None  # minor-major seventh
    if s[:3] == "dim" or s[:1] == "\u00b0":
        rest = s[3:] if s[:3] == "dim" else s[1:]
        return "dim7" if _HAS_EXT.match(rest) else "dim"
    if s[:1] == "\u00f8":
        return "m7b5"
    if s[:3] == "aug" or s[:1] == "+":
        rest = s[3:] if s[:3] == "aug" else s[1:]
        return "aug" if rest == "" else None  # aug7 etc.
    if s[:3] in ("maj", "Maj") or s[:1] in ("M", "\u0394", "^"):
        rest = re.sub(r"^(maj|Maj|M|\u0394|\^)", "", s)
        if _ALTERED_FIFTH.search(rest):
            return None
        return "maj7" if _HAS_EXT.match(rest) else "maj"
    if s[:3] == "min" or s[:1] in ("m", "-"):
        rest = re.sub(r"^(min|m|-)", "", s)
        if "b5" in rest:
            return "m7b5" if _HAS_EXT.match(rest) else "dim"
        if "#5" in rest:
            return None
        return "min7" if _HAS_EXT.match(rest) else "min"
    if s == "" or re.match(r"add\d+", s):
        return "maj"
    m = re.match(r"(\d+)", s)
    if m:
        if _ALTERED_FIFTH.search(s):
            return None
        n = int(m.group(1))
        if n in (7, 9, 11, 13):
            return "7"
        if n in (2, 5, 6):
            return "maj"
    return None


def vocab_triad(vq):
    """Triad class of a vocabulary quality: maj/min/dim/aug/sus4 (7, maj7 -> maj; min7 -> min; m7b5, dim7 -> dim)."""
    return _TRIAD_OF[vq]


def _f(x):
    return None if x is None else float(x)


def _median_interval(times):
    if len(times) < 2:
        return None
    return float(np.median(np.diff(times)))


# ---------------- beats ----------------

def _beats(truth, result):
    tb, rb = truth.get("beats"), result.get("beats")
    if not tb or rb is None:
        return None, None
    ref = np.array(sorted(b["t"] for b in tb), dtype=float)
    lo, hi = _beat_window(ref)
    clip = lambda ts: np.array([t for t in sorted(ts) if lo <= t <= hi], dtype=float)
    est = clip(b["t"] for b in rb)
    out = {"f": _beat_f(ref, est), "nRef": int(len(ref)), "nEst": int(len(est)),
           # Q7: beats outside the scored window are not errors in `f`, but they are visible to the user
           "nEstOutsideBefore": int(sum(1 for b in rb if b["t"] < lo)),
           "nEstOutsideAfter": int(sum(1 for b in rb if b["t"] > hi))}
    ref_d = np.array(sorted(b["t"] for b in tb if b.get("downbeat")), dtype=float)
    if len(ref_d) == 0:
        return out, None
    if not any("downbeat" in b for b in rb):
        return out, None  # analyzer does not estimate downbeats: not evaluated
    est_d = clip(b["t"] for b in rb if b.get("downbeat"))
    down = {"f": _beat_f(ref_d, est_d), "nRef": int(len(ref_d)), "nEst": int(len(est_d))}
    return out, down


def _beat_window(ref):
    """(lo, hi): analyzer beats outside [first truth beat - tolerance, last truth beat + half an interval]
    are not scored (R5): the truth ends at the last annotated bar while the audio may ring on."""
    med = _median_interval(ref) or 0.0
    return float(ref[0]) - BEAT_TOLERANCE, float(ref[-1]) + med / 2


def _beat_f(ref, est):
    # Called directly: mir_eval.beat.evaluate would trim the first 5 s.
    if len(est) == 0:
        return 0.0
    return float(mir_eval.beat.f_measure(ref, est, f_measure_threshold=BEAT_TOLERANCE))


# ---------------- chords ----------------

class _ChordTrack:
    def __init__(self, chords):
        self.chords = sorted((c for c in chords if not is_no_chord(c)), key=lambda c: c["start"])
        self.starts = [c["start"] for c in self.chords]

    def at(self, t):
        i = bisect.bisect_right(self.starts, t) - 1
        if i >= 0 and t < self.chords[i]["end"]:
            return self.chords[i]
        return None

    def overlaps(self, t0, t1):
        """{(root_pc, class): seconds} within [t0, t1). Unknown qualities have class None."""
        acc = {}
        for c in self.chords:
            d = min(c["end"], t1) - max(c["start"], t0)
            if d > 0:
                key = (note_to_pc(c["root"]), quality_class(c["quality"]))
                acc[key] = acc.get(key, 0.0) + d
        return acc


def _beat_windows(beats):
    """[(t, downbeat, midpoint, end)] per truth beat; last beat extended by the median interval."""
    bs = sorted(beats, key=lambda b: b["t"])
    ts = [b["t"] for b in bs]
    med = _median_interval(ts)
    out = []
    for i, b in enumerate(bs):
        nxt = ts[i + 1] if i + 1 < len(ts) else ts[i] + med
        out.append((ts[i], bool(b.get("downbeat")), (ts[i] + nxt) / 2, nxt))
    return out


def _score_points(points, ttrack, rtrack):
    """Score chords at [(time, weight)] sample points; counts are weighted sums."""
    acc = dict(scored=0.0, hit=0.0, excluded=0.0, unknown_truth=0.0, unknown_result=0.0,
               seventh_truth=0.0, seventh_result=0.0, seventh_hit=0.0)
    for tm, w in points:
        t = ttrack.at(tm)
        if t is None:
            continue  # truth has no chord: not counted
        if t["quality"] not in KNOWN_QUALITIES:
            acc["unknown_truth"] += w
            acc["excluded"] += w
            continue
        tcls = quality_class(t["quality"])
        if tcls is None:
            acc["excluded"] += w  # dim / aug / sus4 in truth: excluded
            continue
        acc["scored"] += w
        r = rtrack.at(tm)  # a result with no chord here (N / gap, e.g. the last beat, R8) is a miss
        t7 = has_seventh(t["quality"])
        r_known = r is not None and r["quality"] in KNOWN_QUALITIES
        if r is not None and not r_known:
            acc["unknown_result"] += w
        r7 = r_known and has_seventh(r["quality"])
        is_hit = r_known and note_to_pc(r["root"]) == note_to_pc(t["root"]) and quality_class(r["quality"]) == tcls
        if is_hit:
            acc["hit"] += w
        acc["seventh_truth"] += w * t7
        acc["seventh_result"] += w * r7
        if is_hit and r7 and t7:
            acc["seventh_hit"] += w
    return {k: (int(v) if float(v).is_integer() else v) for k, v in acc.items()}


def _chords(truth, result):
    tc, rc = truth.get("chords"), result.get("chords")
    tb = truth.get("beats")
    if not tc or rc is None or not tb or len(tb) < 2:
        return None
    ttrack, rtrack = _ChordTrack(tc), _ChordTrack(rc)
    wins = _beat_windows(tb)

    # R6: eighth-note resolution (two samples per beat, weight 1/2 each); the midpoint scan is kept as a reference
    eighth_pts = [(w[0] + f * (w[3] - w[0]), 0.5) for w in wins for f in (0.25, 0.75)]
    main = _score_points(eighth_pts, ttrack, rtrack)
    legacy = _score_points([(w[2], 1.0) for w in wins], ttrack, rtrack)
    scored, hit = main["scored"], main["hit"]
    excluded, unknown_truth, unknown_result = main["excluded"], main["unknown_truth"], main["unknown_result"]
    seventh_truth, seventh_result, seventh_hit_r = main["seventh_truth"], main["seventh_result"], main["seventh_hit"]

    bar_acc, bars_scored, bars_hit = _per_bar(wins, ttrack, rtrack)
    return {
        "perBeat": hit / scored if scored else None,
        "perBeatMidpoint": legacy["hit"] / legacy["scored"] if legacy["scored"] else None,
        "perBar": bar_acc,
        "seventhRecall": seventh_hit_r / seventh_truth if seventh_truth else None,
        "seventhPrecision": seventh_hit_r / seventh_result if seventh_result else None,
        "nSeventhTruth": seventh_truth,
        "nSeventhResult": seventh_result,
        "nSeventhHit": seventh_hit_r,
        "majminWeighted": _majmin_weighted(tc, rc),
        "vocab": _score_vocab(eighth_pts, ttrack, rtrack),
        "split": _score_split(eighth_pts, ttrack, rtrack),
        "nBeatsScored": scored,
        "nBeatsHit": hit,
        "nBeatsExcluded": excluded,
        "nBeatsUnknownQualityTruth": unknown_truth,
        "nBeatsUnknownQualityResult": unknown_result,
        "nBarsScored": bars_scored,
        "nBarsHit": bars_hit,
    }


def _bass_pc(c):
    b = c.get("bass")
    if b is None or str(b).strip() == "":
        return None
    try:
        return note_to_pc(b)
    except ValueError:
        return None


def _score_vocab(points, ttrack, rtrack):
    """Vocabulary scoring at [(time, weight)] points (T20). Truth quality goes through map_vocab; a truth form it
    drops is counted in nBeatsDropped, not scored. Result qualities go through map_vocab too (the identity on
    vocabulary names; an unmappable result quality is a miss).
    Slash-chord bass (record only): of scored samples whose truth chord has a bass, the share where the result's bass
    pitch class is equal (a result with no bass is a miss); independent of the chord hit."""
    acc = dict(scored=0.0, hit=0.0, triadHit=0.0, dropped=0.0, bassScored=0.0, bassHit=0.0)
    for tm, w in points:
        t = ttrack.at(tm)
        if t is None:
            continue
        tq = map_vocab(t["quality"])
        if tq is None:
            acc["dropped"] += w
            continue
        acc["scored"] += w
        r = rtrack.at(tm)
        rq = None if r is None else map_vocab(r["quality"])
        root_ok = rq is not None and note_to_pc(r["root"]) == note_to_pc(t["root"])
        if root_ok and rq == tq:
            acc["hit"] += w
        if root_ok and vocab_triad(rq) == vocab_triad(tq):
            acc["triadHit"] += w
        tb = _bass_pc(t)
        if tb is not None:
            acc["bassScored"] += w
            if r is not None and _bass_pc(r) == tb:
                acc["bassHit"] += w
    n = {k: (int(v) if float(v).is_integer() else v) for k, v in acc.items()}
    return {
        "perBeat": acc["hit"] / acc["scored"] if acc["scored"] else None,
        "triadPerBeat": acc["triadHit"] / acc["scored"] if acc["scored"] else None,
        "bassPerBeat": acc["bassHit"] / acc["bassScored"] if acc["bassScored"] else None,
        "nBeatsScored": n["scored"], "nBeatsHit": n["hit"], "nBeatsTriadHit": n["triadHit"],
        "nBeatsDropped": n["dropped"], "nBassScored": n["bassScored"], "nBassHit": n["bassHit"],
    }


def _cand_keys(r):
    """[(root_pc, triad class)] of a result chord's candidates (T27); the chord itself when it has none.
    A candidate whose quality is outside the vocabulary has class None (never matches)."""
    cands = r.get("candidates")
    if not cands:
        cands = [r]
    out = []
    for c in cands:
        vq = map_vocab(c.get("quality"))
        out.append((note_to_pc(c["root"]), None if vq is None else vocab_triad(vq)))
    return out


def _score_split(points, ttrack, rtrack):
    """Root / quality split and top-k at [(time, weight)] points (T27). Truth goes through map_vocab (dropped forms
    are not scored), like _score_vocab.
    - root: result root pitch class == truth root (any result quality, '5' included); no result chord = miss.
    - quality: triad class equal (vocab_triad, so C vs Cmaj7 counts; root not required), counted only where the
      result quality is not '5' (nBeatsPower = scored samples whose result is '5'; a missing result is a miss).
    - top-k: the truth (root, triad class) is among the result chord's candidates (the chord itself when it has
      no candidates); topKPerBeat is None when no result chord carries candidates."""
    acc = dict(scored=0.0, rootHit=0.0, power=0.0, qualScored=0.0, qualHit=0.0, topkHit=0.0)
    has_cands = any(c.get("candidates") for c in rtrack.chords)
    for tm, w in points:
        t = ttrack.at(tm)
        if t is None:
            continue
        tq = map_vocab(t["quality"])
        if tq is None:
            continue
        tr, tcls = note_to_pc(t["root"]), vocab_triad(tq)
        acc["scored"] += w
        r = rtrack.at(tm)
        if r is not None and note_to_pc(r["root"]) == tr:
            acc["rootHit"] += w
        rq = None if r is None else map_vocab(r["quality"])
        if rq == POWER:
            acc["power"] += w
        else:
            acc["qualScored"] += w
            if rq is not None and vocab_triad(rq) == tcls:
                acc["qualHit"] += w
        if r is not None and (tr, tcls) in _cand_keys(r):
            acc["topkHit"] += w
    n = {k: (int(v) if float(v).is_integer() else v) for k, v in acc.items()}
    sc = acc["scored"]
    return {
        "rootPerBeat": acc["rootHit"] / sc if sc else None,
        "qualityPerBeat": acc["qualHit"] / acc["qualScored"] if acc["qualScored"] else None,
        "topKPerBeat": (acc["topkHit"] / sc if sc else None) if has_cands else None,
        "powerShare": acc["power"] / sc if sc else None,
        "nBeatsScored": n["scored"], "nBeatsRootHit": n["rootHit"], "nBeatsPower": n["power"],
        "nBeatsQualityScored": n["qualScored"], "nBeatsQualityHit": n["qualHit"],
        "nBeatsTopKHit": n["topkHit"] if has_cands else None,
    }


def _top_set(overlaps, tol):
    """Keys whose time is within tol of the maximum (the maximum itself is always included)."""
    m = max(overlaps.values())
    return {k for k, v in overlaps.items() if v >= m - tol - 1e-9}, max(overlaps, key=overlaps.get)


def _per_bar(wins, ttrack, rtrack):
    starts = [i for i, w in enumerate(wins) if w[1]]
    if not starts:
        return None, 0, 0
    if starts[0] != 0:
        starts.insert(0, 0)
    tol = TIE_BEAT_FRACTION * (_median_interval([w[0] for w in wins]) or 0.0)
    scored = hit = 0
    for k, s in enumerate(starts):
        t0 = wins[s][0]
        t1 = wins[starts[k + 1]][0] if k + 1 < len(starts) else wins[-1][3]
        to = ttrack.overlaps(t0, t1)
        if not to:
            continue
        tset, tmax = _top_set(to, tol)
        if tmax[1] is None:
            continue
        tset = {k_ for k_ in tset if k_[1] is not None}
        scored += 1
        ro = {k_: v for k_, v in rtrack.overlaps(t0, t1).items() if k_[1] is not None}
        if ro and tset & _top_set(ro, tol)[0]:
            hit += 1
    return (hit / scored if scored else None), scored, hit


def _mir_label(c, is_result=False):
    root = _SHARP_NAMES[note_to_pc(c["root"])]
    q = c["quality"]
    if q not in KNOWN_QUALITIES:
        # unknown truth quality: excluded like dim; unknown result quality: never matches
        return mir_eval.chord.NO_CHORD if is_result else f"{root}:dim"
    cls = quality_class(q)
    return f"{root}:{cls}" if cls else f"{root}:{q}"


def _majmin_weighted(tc, rc):
    tc = sorted((c for c in tc if not is_no_chord(c)), key=lambda c: c["start"])
    rc = sorted((c for c in rc if not is_no_chord(c)), key=lambda c: c["start"])
    if not tc:
        return None
    ref_i = np.array([[c["start"], c["end"]] for c in tc], dtype=float)
    ref_l = [_mir_label(c) for c in tc]
    t_min, t_max = float(ref_i.min()), float(ref_i.max())
    if rc:
        est_i = np.array([[c["start"], c["end"]] for c in rc], dtype=float)
        est_l = [_mir_label(c, True) for c in rc]
    else:
        est_i, est_l = np.array([[t_min, t_max]]), ["N"]
    est_i, est_l = mir_eval.util.adjust_intervals(
        est_i, est_l, t_min, t_max, mir_eval.chord.NO_CHORD, mir_eval.chord.NO_CHORD)
    ivs, ref_l2, est_l2 = mir_eval.util.merge_labeled_intervals(ref_i, ref_l, est_i, est_l)
    comp = mir_eval.chord.majmin(ref_l2, est_l2)
    dur = mir_eval.util.intervals_to_durations(ivs)
    return float(mir_eval.chord.weighted_accuracy(comp, dur))


# ---------------- melody ----------------

def _melody(truth, result, beat_interval):
    tm, rm = (truth.get("melody") or {}).get("notes"), (result.get("melody") or {}).get("notes")
    if tm is None or rm is None or beat_interval is None:
        return None
    min_dur = beat_interval / 4  # a 16th note
    keep = lambda notes: [n for n in notes if n["end"] - n["start"] >= min_dur - 1e-6]
    ref, est = keep(tm), keep(rm)
    if not ref:
        return None
    out = {"nRef": len(ref), "nEst": len(est), "minNoteSec": min_dur}
    if not est:
        out.update(precision=0.0, recall=0.0, f1=0.0)
        return out
    hz = lambda ns: 440.0 * 2.0 ** ((np.array([n["midi"] for n in ns], dtype=float) - 69) / 12)
    iv = lambda ns: np.array([[n["start"], n["end"]] for n in ns], dtype=float)
    p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
        iv(ref), hz(ref), iv(est), hz(est),
        onset_tolerance=ONSET_TOLERANCE, pitch_tolerance=PITCH_TOLERANCE_CENTS, offset_ratio=None)
    out.update(precision=float(p), recall=float(r), f1=float(f))
    return out


# ---------------- sections ----------------

def _bar_seconds(truth):
    beats = sorted(truth.get("beats") or [], key=lambda b: b["t"])
    downs = [b["t"] for b in beats if b.get("downbeat")]
    if len(downs) >= 2:
        return _median_interval(downs)
    med = _median_interval([b["t"] for b in beats])
    if med is None:
        return None
    return med * (truth.get("timeSignature") or {}).get("num", 4)


def _sections(truth, result):
    ts, rs = truth.get("sections"), result.get("sections")
    window = _bar_seconds(truth)
    if not ts or rs is None or window is None or len(ts) < 2:
        return None  # one section has no inner boundary to detect
    iv = lambda xs: np.array([[s["start"], s["end"]] for s in sorted(xs, key=lambda s: s["start"])], dtype=float)
    out = {"nRef": len(ts), "nEst": len(rs), "windowSec": window}
    if len(rs) < 2:
        out.update(precision=0.0, recall=0.0, f=0.0)
        return out
    p, r, f = mir_eval.segment.detection(iv(ts), iv(rs), window=window, trim=True)
    out.update(precision=float(p), recall=float(r), f=float(f))
    return out


# ---------------- keys (T20) ----------------

def parse_key(text):
    """'G' -> (7, 'major'); 'F#m' -> (6, 'minor'). Raises ValueError."""
    m = re.fullmatch(r"([A-G][#b]?)(m?)", str(text).strip())
    if not m:
        raise ValueError(f"bad key: {text!r}")
    return note_to_pc(m.group(1)), "minor" if m.group(2) else "major"


def keys_near(a, b):
    """True when key b is closely related to key a: equal, relative, parallel, or a fifth away in the same mode.
    Keys are (tonic_pc, mode)."""
    (ta, ma), (tb, mb) = a, b
    if ma == mb:
        return (tb - ta) % 12 in (0, 5, 7)
    major_t, minor_t = (ta, tb) if ma == "major" else (tb, ta)
    return minor_t == major_t or minor_t == (major_t + 9) % 12


def _bar_spans(beats):
    """[(start, end)] per bar, bars delimited by truth downbeats (bar 0 = first downbeat; pickup beats are not a bar)."""
    bs = sorted(beats, key=lambda b: b["t"])
    ts = [b["t"] for b in bs]
    med = _median_interval(ts)
    downs = [b["t"] for b in bs if b.get("downbeat")]
    if med is None or not downs:
        return []
    end = ts[-1] + med
    return [(d, downs[i + 1] if i + 1 < len(downs) else end) for i, d in enumerate(downs)]


def _run_at(runs, i):
    """The entry of `runs` (sorted by startBar) in force at bar i, or None before the first."""
    cur = None
    for r in runs:
        if r["startBar"] <= i:
            cur = r
    return cur


def _key_entry(k):
    """(startBar, tonic_pc, mode) from a result entry {startBar, tonic, mode} or a truth-style {startBar, key: "Am"}."""
    if "tonic" in k:
        return int(k["startBar"]), note_to_pc(k["tonic"]), k["mode"]
    tonic, mode = parse_key(k["key"])
    return int(k["startBar"]), tonic, mode


def _result_key_runs(result):
    ks = result.get("keys")
    if ks:
        return sorted(_key_entry(k) for k in ks)
    k = result.get("key")
    if k:
        return [(0, note_to_pc(k["tonic"]), k["mode"])]
    return None


def _match_changes(ref, est, tol=1):
    """One-to-one greedy match of change bars within +-tol; returns the number of matches."""
    free = sorted(est)
    n = 0
    for r in sorted(ref):
        for e in free:
            if abs(e - r) <= tol:
                free.remove(e)
                n += 1
                break
    return n


def _score_keys(truth, result):
    """Per-bar key scoring when the truth has `keys` (optional): key per bar (tonic + mode equal), near key per
    bar (record), and key-change F (+-1 bar). Result bars are placed in time by the result's own downbeats
    (bar index when it has none). None when the truth has no keys or the result has no key at all."""
    tk, tb = truth.get("keys"), truth.get("beats")
    if not tk or not tb:
        return None
    rk = _result_key_runs(result)
    spans = _bar_spans(tb)
    if rk is None or not spans:
        return None
    truns = sorted(({"startBar": int(k["startBar"]), "key": parse_key(k["key"])} for k in tk),
                   key=lambda r: r["startBar"])
    rdowns = sorted(b["t"] for b in result.get("beats") or [] if b.get("downbeat"))

    def result_key(i, t0, t1):
        j = max(bisect.bisect_right(rdowns, (t0 + t1) / 2) - 1, 0) if rdowns else i
        cur = (rk[0][1], rk[0][2])
        for s, tonic, mode in rk:
            if s <= j:
                cur = (tonic, mode)
        return cur

    scored = hit = near = 0
    tkeys, rkeys = [], []
    for i, (t0, t1) in enumerate(spans):
        run = _run_at(truns, i)
        if run is None:
            tkeys.append(None)
            rkeys.append(None)
            continue
        tkey, rkey = run["key"], result_key(i, t0, t1)
        tkeys.append(tkey)
        rkeys.append(rkey)
        scored += 1
        hit += tkey == rkey
        near += keys_near(tkey, rkey)

    def changes(ks):
        return [i for i in range(1, len(ks)) if ks[i] is not None and ks[i - 1] is not None and ks[i] != ks[i - 1]]

    cref, cest = changes(tkeys), changes(rkeys)
    cm = _match_changes(cref, cest)
    f = None
    if cref:
        f = 0.0 if not cm else 2 * cm / (len(cref) + len(cest))  # = 2PR/(P+R) with P = cm/|est|, R = cm/|ref|
    return {"perBar": hit / scored if scored else None, "nearPerBar": near / scored if scored else None,
            "changeF": f, "nBars": scored, "nBarsHit": hit, "nBarsNear": near,
            "nChangeRef": len(cref), "nChangeEst": len(cest), "nChangeHit": cm}


# ---------------- sequence-only truth (no timing) ----------------

def _collapse(seq):
    out = []
    for x in seq:
        if not out or out[-1] != x:
            out.append(x)
    return out


def _lcs(a, b):
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if x == y else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1]


def _edit(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def _seq_stats(t, r):
    n, m = len(t), len(r)
    lcs = _lcs(t, r)
    lev = _edit(t, r)
    d = max(n, m)
    return {"nTruth": n, "nResult": m, "lcs": lcs, "edit": lev,
            "lcsRecall": lcs / n if n else None, "lcsPrecision": lcs / m if m else None,
            "similarity": 1.0 - lev / d if d else None}


def _sequence(truth, result):
    """Chord-order accuracy for a truth with "timing": "sequence" (T3: lyric charts without bar timing), else None.
    Both sequences go through map_vocab (a truth form it drops is skipped and counted), no-chord entries are skipped,
    consecutive duplicates collapse; the result is ordered by start. Exact roots (no transposition). `full` compares
    (root, vocab quality); `root` compares roots only. similarity = 1 - editDistance / max(len)."""
    if truth.get("timing") != "sequence" or result.get("chords") is None:
        return None
    tfull, troot, dropped = [], [], 0
    for c in truth.get("chordSequence") or []:
        if is_no_chord(c):
            continue
        q = map_vocab(c.get("quality"))
        if q is None:
            dropped += 1
            continue
        tfull.append((note_to_pc(c["root"]), q))
        troot.append(note_to_pc(c["root"]))
    rfull, rroot = [], []
    for c in sorted(result["chords"], key=lambda c: c.get("start", 0)):
        if is_no_chord(c):
            continue
        try:
            pc = note_to_pc(c["root"])
        except ValueError:
            continue
        rfull.append((pc, map_vocab(c.get("quality"))))
        rroot.append(pc)
    out = {"full": _seq_stats(_collapse(tfull), _collapse(rfull)),
           "root": _seq_stats(_collapse(troot), _collapse(rroot)), "nDropped": dropped}
    return out


# ---------------- entry points ----------------

def score(truth, result):
    beats, downbeats = _beats(truth, result)
    tbeats = [b["t"] for b in truth.get("beats") or []]
    return {
        "beats": beats,
        "downbeats": downbeats,
        "chords": _chords(truth, result),
        "melody": _melody(truth, result, _median_interval(sorted(tbeats))),
        "sections": _sections(truth, result),
        "keys": _score_keys(truth, result),
        "sequence": _sequence(truth, result),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("truth")
    ap.add_argument("result")
    ap.add_argument("-o", "--output")
    args = ap.parse_args(argv)
    with open(args.truth) as f:
        truth = json.load(f)
    with open(args.result) as f:
        result = json.load(f)
    text = json.dumps(score(truth, result), indent=2, ensure_ascii=False)
    if args.output:
        with open(args.output, "w") as f:
            f.write(text + "\n")
    else:
        print(text)


if __name__ == "__main__":
    sys.exit(main())
