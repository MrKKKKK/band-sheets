"""Check that truth times line up with the audio (R4 of docs/audio-spike0-review.md).

Usage: python py/check_alignment.py [--out DIR]
Reads DIR/manifest.json (shape: see run_all.py; uses "name", "mix", "click", "wav", "truth";
unknown fields are ignored). Truth times already include any leading-silence offset. Signed
differences are (audio - truth) in ms; every threshold is on the absolute value (symmetric).

Checks (ENFORCED ones set the exit code; the rest are only reported):
  click   click variants: click track = click wav - the same variant without click (pair found by name
          minus "-click", else by song/mix/tempo/swing). Per truth beat, the first sample above
          2 % of the click peak within +-50 ms is the onset. |signed median| < 5 ms and max |diff| < 5 ms,
          all beats found. ENFORCED. A missing partner/wav is SKIPped, not failed.
  onset   non-click variants: librosa onset_detect vs the nearest truth beat: |signed median| < 20 ms.
          ENFORCED for mix == "piano", reported for others. comp == "whole" (one chord per bar, so most beats
          have no onset) is compared on the truth STRIKE times instead (spike 2 T4, Q4): every downbeat and
          every truth chord start is a struck chord, each is compared with its nearest detected onset. Unlike
          the spike 1 rule (each onset vs its nearest beat), this also catches a whole-beat offset.
          comp == "rec" uses backtracked onsets (librosa backtrack=True, the energy minimum before the
          peak): most of its beats start with one soft left-hand note, whose onset-strength peak comes
          late. Measured on the LR wavs (T4): peak-picked median +16..+21 ms, backtracked -6..-10 ms,
          sample-level first sound +0.1..+7 ms (the truth is aligned; the detector lags). Only for this
          median: 'edge' keeps the peak-picked onsets.
  edge    first sound (first sample above 2 % of the peak) vs the first truth event, and the last
          librosa onset vs the nearest truth event (beat, melody note start, chord start, drum hit): |diff| < 30 ms. ENFORCED for piano, reported for others.
  chord   chroma_cqt averaged over the central 80 % of each truth beat; the share of beats whose truth
          chord (maj/min class of 7/maj7/min7 too) is the best of the 24 triad templates >= 90 %.
          ENFORCED for piano, reported for others. dim/aug/sus4/no-chord beats are skipped.
          comp == "arp8" / "rec" (broken chords: one beat holds only part of the chord; "rec" also moves
          changes to eighth positions) is compared over the whole truth chord span instead of per beat; a
          variant with pianoGainDb < 0 uses the lower limit CHORD_MIN_SHARE_QUIET (R9; see its comment).
Exit code policy (R9): only ENFORCED checks (mix == "piano") turn into FAIL and exit 1; everything else
is WARN (printed, exit 0), so a chained `&&` is safe unless a piano variant is really off.
Exit 1 if an enforced check fails, a piano wav is missing, or there is no piano variant.
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score as S  # noqa: E402

ONSET_MEDIAN_MS = 20.0
EDGE_MS = 30.0
CLICK_MS = 5.0
CHORD_MIN_SHARE = 0.90
# pianoGainDb < 0 variants (piano -9 dB under drums + bass, mix "full", never ENFORCED): the drums and
# bass leak into the chroma, so the share is lower by nature. Observed 89.8 % and 100 % (spike 1 T15);
# 0.85 keeps ~5 points of margin below the lowest observed value while still noticing a drop to the low
# 80s (spike 2 T4, Q4: was 0.80 with no stated reason).
CHORD_MIN_SHARE_QUIET = 0.85
CLICK_WINDOW_S = 0.05
CLICK_LEVEL = 0.02
FIRST_LEVEL = 0.02


def _load(path):
    import librosa
    return librosa.load(path, sr=None, mono=True)


def _items(out_dir):
    with open(os.path.join(out_dir, "manifest.json")) as f:
        m = json.load(f)
    return m["variants"] if isinstance(m, dict) else m


def _truth_path(v):
    return v.get("truth") or os.path.splitext(v["wav"])[0] + ".truth.json"


def onset_times(y, sr, backtrack=False):
    import librosa
    return np.sort(librosa.onset.onset_detect(y=y, sr=sr, backtrack=backtrack, units="time"))


BROKEN_COMPS = ("arp8", "rec")


def strike_times(truth):
    """Times a 'whole' accompaniment strikes a chord: every downbeat and every truth chord start."""
    t = {b["t"] for b in truth.get("beats") or [] if b.get("downbeat")}
    t |= {c["start"] for c in truth.get("chords") or [] if not S.is_no_chord(c)}
    return np.array(sorted(t))


def onset_offsets(onsets, beats, comp=None, truth=None):
    """Signed (onset - truth time) in seconds used by the 'onset' check.

    Normally per truth beat (nearest onset). For comp == 'whole' the onsets are sparser than the
    beats, so it is per truth strike time (downbeats + chord starts, `strike_times(truth)`), nearest
    onset (Q4); a whole-beat offset of the audio then shows up as a full beat. Without `truth` it falls
    back to the spike 1 rule (each detected onset vs its nearest truth beat; misses whole-beat offsets).
    """
    if comp == "whole":
        if truth is None:
            return -signed_nearest(np.asarray(beats, dtype=float), onsets)
        return signed_nearest(onsets, strike_times(truth))
    return signed_nearest(onsets, beats)


def chord_min_share(v):
    return CHORD_MIN_SHARE_QUIET if (v.get("pianoGainDb") or 0) < 0 else CHORD_MIN_SHARE


def signed_nearest(onsets, times):
    """Signed (onset - time) in seconds to the nearest onset, per time."""
    out = []
    for t in times:
        i = int(np.searchsorted(onsets, t))
        cands = onsets[max(0, i - 1):i + 1]
        d = cands - t
        out.append(float(d[np.argmin(np.abs(d))]))
    return np.array(out)


def click_diffs(y_click, y_base, sr, beat_times):
    """Signed (detected click onset - truth beat) in seconds; NaN where no click is found."""
    n = min(len(y_click), len(y_base))
    c = np.abs(y_click[:n].astype(np.float64) - y_base[:n].astype(np.float64))
    peak = c.max() if n else 0.0
    out = []
    for t in beat_times:
        if peak <= 0:
            out.append(float("nan"))
            continue
        a = max(0, int(round((t - CLICK_WINDOW_S) * sr)))
        b = min(n, int(round((t + CLICK_WINDOW_S) * sr)))
        idx = np.nonzero(c[a:b] > CLICK_LEVEL * peak)[0] if b > a else []
        out.append(float((a + idx[0]) / sr - t) if len(idx) else float("nan"))
    return np.array(out)


def _triad_templates():
    T = np.zeros((24, 12))
    for r in range(12):
        T[r, [r, (r + 4) % 12, (r + 7) % 12]] = 1
        T[12 + r, [r, (r + 3) % 12, (r + 7) % 12]] = 1
    return T / np.linalg.norm(T, axis=1, keepdims=True)


def chord_share(y, sr, truth, by_span=False):
    """(matching units, scored units) of chroma-best triad vs the truth chord.

    Unit = a truth beat (central 80 % of the beat, chord at its midpoint), or with by_span a whole truth
    chord span (central 80 %), for arpeggiated styles where one beat holds only part of the chord (R9).
    """
    import librosa
    hop = 512
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=hop)
    beats = sorted(b["t"] for b in truth["beats"])
    med = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5
    chords = sorted((c for c in truth.get("chords") or [] if not S.is_no_chord(c)), key=lambda c: c["start"])
    if by_span:
        units = [(c["start"], c["end"], c) for c in chords]
    else:
        units = []
        for i, t in enumerate(beats):
            nxt = beats[i + 1] if i + 1 < len(beats) else t + med
            mid = (t + nxt) / 2
            units.append((t, nxt, next((c for c in chords if c["start"] <= mid < c["end"]), None)))
    T = _triad_templates()
    ok = scored = 0
    for t, nxt, c in units:
        if c is None or c["quality"] not in S.KNOWN_QUALITIES:
            continue
        cls = S.quality_class(c["quality"])
        if cls is None:
            continue
        lo, hi = t + 0.1 * (nxt - t), t + 0.9 * (nxt - t)
        sel = (times >= lo) & (times < hi)
        if not sel.any():
            continue
        v = chroma[:, sel].mean(axis=1)
        if np.linalg.norm(v) == 0:
            scored += 1
            continue
        best = int(np.argmax(T @ v))
        want = S.note_to_pc(c["root"]) + (0 if cls == "maj" else 12)
        scored += 1
        ok += best == want
    return ok, scored


def _chk(label, value, limit, ok, enforced, text):
    return {"label": label, "value": value, "limit": limit, "ok": ok, "enforced": enforced, "text": text}


def _find_base(v, items):
    name = v.get("name", "")
    base_name = name[:-len("-click")] if name.endswith("-click") else None
    for o in items:
        if o is v or o.get("click"):
            continue
        if base_name is not None and o.get("name") == base_name:
            return o
    keys = ("song", "mix", "tempo", "swing")
    for o in items:
        if o is not v and not o.get("click") and all(o.get(k) == v.get(k) for k in keys):
            return o
    return None


def _ms(x):
    return f"{x * 1000:+.1f}"


def check_variant(out_dir, v, items):
    """Returns (name, [check dicts], failed_hard). failed_hard: a required file is missing."""
    name = v.get("name", v.get("wav"))
    enforced = v.get("mix") == "piano"
    wav = os.path.join(out_dir, v["wav"])
    try:
        with open(os.path.join(out_dir, _truth_path(v))) as f:
            truth = json.load(f)
    except OSError:
        return name, [_chk("truth", None, None, False, enforced, "SKIP truth file missing")], enforced
    if not os.path.exists(wav):
        return name, [_chk("wav", None, None, False, enforced, "SKIP wav missing")], enforced
    beats = sorted(b["t"] for b in truth["beats"])
    checks = []
    if v.get("click"):
        base = _find_base(v, items)
        base_wav = os.path.join(out_dir, base["wav"]) if base else None
        if not base_wav or not os.path.exists(base_wav):
            return name, [_chk("click", None, None, True, False, "SKIP no click-less partner variant")], False
        yc, sr = _load(wav)
        yb, sr2 = _load(base_wav)
        d = click_diffs(yc, yb, sr, beats) if sr == sr2 else np.full(len(beats), np.nan)
        found = d[~np.isnan(d)]
        if len(found) < len(beats) or len(found) == 0:
            checks.append(_chk("click", len(found), len(beats), False, True,
                               f"click onsets found {len(found)}/{len(beats)}"))
        else:
            med, mx = float(np.median(d)), float(np.max(np.abs(d)))
            ok = abs(med) * 1000 < CLICK_MS and mx * 1000 < CLICK_MS
            checks.append(_chk("click", med, CLICK_MS, ok, True,
                               f"click-track signed median {_ms(med)} ms, max |diff| {mx * 1000:.1f} ms "
                               f"(limit {CLICK_MS} ms), n={len(d)}"))
        return name, checks, False
    y, sr = _load(wav)
    onsets = onset_times(y, sr)
    if len(onsets) == 0 or not beats:
        return name, [_chk("onset", None, None, False, enforced, "no onsets detected")], False
    # comp 'rec': backtracked onsets for the median only; 'edge' keeps the peak-picked ones (backtracking
    # the final chord lands in the previous note's decay, ~45 ms early).
    d = onset_offsets(onset_times(y, sr, backtrack=True) if v.get("comp") == "rec" else onsets,
                      beats, v.get("comp"), truth)
    med = float(np.median(d))
    checks.append(_chk("onset", med, ONSET_MEDIAN_MS, abs(med) * 1000 < ONSET_MEDIAN_MS, enforced,
                       f"onset signed median {_ms(med)} ms (|median abs| {np.median(np.abs(d)) * 1000:.1f}, "
                       f"limit {ONSET_MEDIAN_MS} ms)"))
    events = np.array(sorted(set(beats)
                             | {n["start"] for n in (truth.get("melody") or {}).get("notes", [])}
                             | {c["start"] for c in truth.get("chords") or []}
                             | {n["t"] for n in truth.get("drums") or []}))
    if v.get("comp") in BROKEN_COMPS:  # arpeggio notes sit on every eighth, not only on beats / chord starts
        med_b = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5
        events = np.array(sorted(set(events) | {b + med_b / 2 for b in beats}))
    # first: sample-level (librosa onset_detect is biased at the very start of a file)
    loud = np.nonzero(np.abs(y) > FIRST_LEVEL * np.abs(y).max())[0]
    first = float(loud[0] / sr - events[0])
    last = signed_nearest(events, [onsets[-1]])[0] * -1  # (onset - event)
    ok = abs(first) * 1000 < EDGE_MS and abs(last) * 1000 < EDGE_MS
    checks.append(_chk("edge", max(abs(first), abs(last)), EDGE_MS, ok, enforced,
                       f"first onset {_ms(first)} ms, last onset {_ms(last)} ms vs nearest truth event "
                       f"(limit {EDGE_MS} ms)"))
    by_span = v.get("comp") in BROKEN_COMPS
    min_share = chord_min_share(v)
    n_ok, n = chord_share(y, sr, truth, by_span=by_span)
    share = n_ok / n if n else None
    checks.append(_chk("chord", share, min_share, share is not None and share >= min_share, enforced,
                       f"chroma best triad = truth chord {n_ok}/{n}" + (f" = {share:.1%}" if n else "")
                       + f" (min {min_share:.0%}{', per chord span' if by_span else ''})"))
    return name, checks, False


def check(out_dir):
    """Returns list of (name, mix, checks, hard_failure)."""
    items = _items(out_dir)
    rows = []
    for v in items:
        name, checks, hard = check_variant(out_dir, v, items)
        rows.append((name, v.get("mix"), checks, hard))
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    default_out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "out")
    ap.add_argument("--out", default=default_out)
    args = ap.parse_args(argv)
    rows = check(args.out)
    if not any(mix == "piano" for _, mix, _, _ in rows):
        print("no piano-only variants in manifest")
        return 1
    failed = False
    for name, mix, checks, hard in rows:
        for c in checks:
            if c["text"].startswith("SKIP"):
                tag = "FAIL" if hard else "SKIP"
            elif c["ok"]:
                tag = "OK  "
            else:
                tag = "FAIL" if c["enforced"] else "WARN"
            failed |= tag == "FAIL"
            print(f"{tag} {name} [{c['label']}]: {c['text']}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
