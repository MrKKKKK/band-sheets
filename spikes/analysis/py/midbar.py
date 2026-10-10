"""Mid-bar-start variants for spike 1 (R2 of docs/audio-spike1-review.md).

In every base variant the first sound is the downbeat, so an analyzer that just calls its first beat "1"
scores perfectly. This cuts the first K beats (K = 1, 2, 3; K = 3 is a one-beat pickup) off a wav and shifts
the truth by the same time, so the music now starts on beat K+1 of its bar. Together with the
"dsp-phase0" baseline (same beats, downbeat phase assumed 0; see run_all.py) it shows whether the
analyzer really finds the bar line. Deterministic, no randomness.

CLI (from spikes/analysis):
  python py/midbar.py [--out out] [--only GLOB] [--beats 1,2,3]

Reads <out>/manifest.json, writes <out>/derived/<base>__mid<K>.wav|.truth.json and
<out>/derived/manifest.trim.json (level "M"). Bases: BASES below, or --only GLOB over the manifest's
non-held-out, non-click, constant-tempo variants (any level); a glob never picks held-out variants (R10).
Spike 2 T7 (Q5): by default the HELD_OUT_BASES (held-out songs) also get M variants, marked
`heldOut: true`, so run_all skips them until the final held-out run.
"""
import argparse
import copy
import fnmatch
import json
import os
import sys

import soundfile as sf

LEVEL = "M"
DEFAULT_BEATS = (1, 2, 3)
# A spread of mixes and accompaniment styles; whole / arp8 give the weakest downbeat evidence.
BASES = (
    "piano-t116-straight",
    "full-t116-straight",
    "drums-t116-straight",
    "etude-piano-t90-straight",
    "etude-full-t90-straight",
    "full-t116-straight-arp8",
    "etude-full-t90-straight-arp8",
    "full-t116-straight-whole",
    "etude-full-t90-straight-whole",
)
# Held-out songs (spike 2 T7, Q5): their M variants are held out too. No pickup songs (a pickup is not a
# cut-off bar) and no tempo curves.
HELD_OUT_BASES = (
    "etude2-full-t90-straight",
    "etude2-full-t90-straight-arp8",
)
EPS = 1e-6


def _r(x):
    return round(float(x), 6)


def trim_truth(truth, cut_sec, name, base, k):
    """Truth for the wav with its first `cut_sec` seconds removed (every time shifted by -cut_sec)."""
    t = copy.deepcopy(truth)
    t["beats"] = [dict(b, t=_r(b["t"] - cut_sec)) for b in truth["beats"] if b["t"] >= cut_sec - EPS]
    for key in ("chords", "sections"):
        out = []
        for x in truth.get(key) or []:
            end = x["end"] - cut_sec
            if end <= EPS:
                continue
            out.append(dict(x, start=_r(max(0.0, x["start"] - cut_sec)), end=_r(end)))
        t[key] = out
    if t.get("melody"):
        t["melody"]["notes"] = [dict(n, start=_r(max(0.0, n["start"] - cut_sec)), end=_r(n["end"] - cut_sec))
                                for n in truth["melody"]["notes"] if n["end"] - cut_sec > EPS]
    if truth.get("drums") is not None:
        t["drums"] = [dict(d, t=_r(d["t"] - cut_sec)) for d in truth["drums"] if d["t"] >= cut_sec - EPS]
    src = t.setdefault("source", {})
    for key in ("durationSec", "audioSec"):
        if src.get(key) is not None:
            src[key] = _r(src[key] - cut_sec)
    src["trim"] = {"base": base, "beats": k, "cutSec": _r(cut_sec)}
    if isinstance(t.get("render"), dict):
        t["render"]["variant"] = name
    return t


def select_bases(manifest, only=None):
    """Base variants to trim. Default: BASES (tuning) + HELD_OUT_BASES (held out); --only: tuning only."""
    out = []
    for v in manifest["variants"]:
        if v.get("click") or v.get("tempoCurve") or v.get("pickupBeats"):
            continue
        if v.get("heldOut"):
            if not only and v["name"] in HELD_OUT_BASES:
                out.append(v)
            continue
        if (fnmatch.fnmatch(v["name"], only) if only else v["name"] in BASES):
            out.append(v)
    return out


def run(out_dir, only=None, beats=DEFAULT_BEATS, log=print):
    with open(os.path.join(out_dir, "manifest.json")) as f:
        manifest = json.load(f)
    dd = os.path.join(out_dir, "derived")
    os.makedirs(dd, exist_ok=True)
    entries = []
    for v in select_bases(manifest, only):
        x, sr = sf.read(os.path.join(out_dir, v["wav"]), dtype="float32")
        with open(os.path.join(out_dir, v["truth"])) as f:
            truth = json.load(f)
        ts = [b["t"] for b in truth["beats"]]
        for k in beats:
            if k >= len(ts):
                continue
            cut = ts[k]
            name = f"{v['name']}__mid{k}"
            sf.write(os.path.join(dd, name + ".wav"), x[int(round(cut * sr)):], sr, subtype="PCM_16")
            with open(os.path.join(dd, name + ".truth.json"), "w") as f:
                json.dump(trim_truth(truth, cut, name, v["name"], k), f, indent=2)
            entries.append({"name": name, "song": v["song"], "base": v["name"], "level": LEVEL, "heldOut": bool(v.get("heldOut")),
                            "trimBeats": k, "wav": f"derived/{name}.wav", "truth": f"derived/{name}.truth.json"})
            log(f"{name}: cut {cut:.3f} s")
    with open(os.path.join(dd, "manifest.trim.json"), "w") as f:
        json.dump(entries, f, indent=2)
    return entries


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="out")
    ap.add_argument("--only", help="glob on base variant names (default: the BASES list)")
    ap.add_argument("--beats", default=",".join(str(k) for k in DEFAULT_BEATS))
    a = ap.parse_args(argv)
    run(a.out, a.only, tuple(int(k) for k in a.beats.split(",")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
