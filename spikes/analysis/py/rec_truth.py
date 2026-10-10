"""Answer JSON for a real recording from a hand-written chord annotation (task TR).

Usage: python py/rec_truth.py recordings/<name>.chords.json [--out DIR]
Writes DIR/rec/<name>.truth.json and (re)writes DIR/rec/manifest.rec.json (default DIR = out), merging
with entries for other recordings. Importable: build_truth(ann, audio_sec, t0, tempo) -> dict,
fit_grid(wav_path, ann) -> dict, parse_chord(text) -> (root, quality, bass).

Annotation: tempo, timeSignature [n, d], click, firstSoundSec, eighthsPerBar, sections [{label,startBar,bars}],
bars [[[chordText, eighths], ...], ...] (each bar sums to eighthsPerBar). The last chord rings to the end of the file.
Beats are evenly spaced from t0 (60/tempo apart). t0/tempo are fitted to librosa onsets (percussive part):
t0 within +-60 ms of firstSoundSec, tempo within +-1 %, maximizing onsets near eighth-note grid points.
"""
import argparse
import json
import os
import re
import sys

import numpy as np

T0_RANGE_S = 0.060
TEMPO_RANGE = 0.01
SIGMA_S = 0.020

# suffix -> quality (the scorer's KNOWN_QUALITIES; aug/sus4 are excluded by the scorer)
SUFFIX_QUALITY = {
    "": "maj", "maj": "maj", "M": "maj", "add9": "maj", "add2": "maj", "6": "maj", "2": "maj", "5": "maj",
    "m": "min", "min": "min", "-": "min", "m6": "min", "madd9": "min", "madd2": "min", "m9": "min",
    "7": "7", "9": "7", "dom7": "7",
    "maj7": "maj7", "M7": "maj7", "maj9": "maj7",
    "m7": "min7", "min7": "min7", "-7": "min7",
    "sus4": "sus4", "sus": "sus4", "7sus4": "sus4",
    "aug": "aug", "+": "aug", "aug7": "aug", "+7": "aug",
    "dim": "dim", "dim7": "dim",
}


def parse_chord(text):
    """'Dm7/G' -> ('D', 'min7', 'G'). Raises ValueError for unknown text."""
    m = re.fullmatch(r"([A-G][#b]?)([^/]*)(?:/([A-G][#b]?))?", text.strip())
    if not m or m.group(2) not in SUFFIX_QUALITY:
        raise ValueError(f"unknown chord text: {text!r}")
    return m.group(1), SUFFIX_QUALITY[m.group(2)], m.group(3)


def _r(x):
    return round(float(x), 4)


def build_truth(ann, audio_sec, t0, tempo, name="rec"):
    num, den = ann["timeSignature"]
    eps = ann["eighthsPerBar"]
    eighth = 30.0 / tempo
    bars = ann["bars"]
    nbars = len(bars)
    beat_eighths = eps // num
    beats = []
    for bar in range(nbars):
        for b in range(num):
            beats.append({"t": _r(t0 + (bar * eps + b * beat_eighths) * eighth), "downbeat": b == 0, "bar": bar, "beat": b})
    end = t0 + nbars * eps * eighth
    chords = []
    pos = 0
    for bi, bar in enumerate(bars):
        if sum(n for _, n in bar) != eps:
            raise ValueError(f"bar {bi} does not sum to {eps} eighths")
        for text, n in bar:
            root, quality, bass = parse_chord(text)
            chords.append({"start": _r(t0 + pos * eighth), "end": _r(t0 + (pos + n) * eighth), "root": root,
                           "quality": quality, "bass": bass, "text": text, "confidence": 1})
            pos += n
    if chords and audio_sec is not None:
        chords[-1]["end"] = _r(max(audio_sec, chords[-1]["end"]))
    sections = [{"start": _r(t0 + s["startBar"] * eps * eighth), "end": _r(t0 + (s["startBar"] + s["bars"]) * eps * eighth),
                 "label": s["label"]} for s in ann.get("sections", [])]
    return {
        "format": "band-sheets-analysis", "version": 1,
        "source": {"kind": "recording", "durationSec": _r(end), "click": bool(ann.get("click", False)),
                   "audioSec": None if audio_sec is None else _r(audio_sec), "leadInSec": _r(t0)},
        "analyzer": {"name": "ground-truth", "version": "0.1.0", "methods": []},
        "beats": beats,
        "timeSignature": {"num": num, "den": den, "confidence": 1},
        "sections": sections,
        "chords": chords,
    }


def fit_onsets(onsets, strengths, t0_nom, tempo_nom, n_eighths, eps=8):
    """Grid search over t0/tempo. Returns {t0, tempo, residualMedianMs, nOnsets}."""
    onsets = np.asarray(onsets, float)
    w = np.asarray(strengths, float)
    w = w / (w.max() if w.size and w.max() > 0 else 1.0)
    k = np.arange(n_eighths + 1)
    best = None
    for tempo in tempo_nom * (1 + np.arange(-TEMPO_RANGE, TEMPO_RANGE + 1e-9, 0.0005)):
        eighth = 30.0 / tempo
        for t0 in t0_nom + np.arange(-T0_RANGE_S, T0_RANGE_S + 1e-9, 0.002):
            grid = t0 + k * eighth
            d = np.abs(onsets[:, None] - grid[None, :]).min(axis=1)
            inside = (onsets > t0 - 0.05) & (onsets < grid[-1] + 0.05)
            s = float(np.sum(w * np.exp(-(d / SIGMA_S) ** 2) * inside))
            # tiny prior toward the nominal values to break ties
            s -= 1e-3 * (abs(t0 - t0_nom) / T0_RANGE_S + abs(tempo / tempo_nom - 1) / TEMPO_RANGE)
            if best is None or s > best[0]:
                best = (s, t0, tempo)
    _, t0, tempo = best
    grid = t0 + k * (30.0 / tempo)
    sel = onsets[(onsets > t0 - 0.05) & (onsets < grid[-1] + 0.05)]
    d = np.abs(sel[:, None] - grid[None, :]).min(axis=1) if sel.size else np.array([np.nan])
    return {"t0": float(t0), "tempo": float(tempo), "residualMedianMs": float(np.median(d) * 1000), "nOnsets": int(sel.size)}


def fit_grid(wav_path, ann):
    import librosa
    y, sr = librosa.load(wav_path, sr=22050, mono=True)
    yp = librosa.effects.percussive(y)
    hop = 128
    env = librosa.onset.onset_strength(y=yp, sr=sr, hop_length=hop)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=False)
    times = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
    n8 = len(ann["bars"]) * ann["eighthsPerBar"]
    fit = fit_onsets(times, env[frames], ann["firstSoundSec"], ann["tempo"], n8, ann["eighthsPerBar"])
    fit["audioSec"] = float(len(y) / sr)
    return fit


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("annotation")
    ap.add_argument("--out", default="out")
    ap.add_argument("--no-fit", action="store_true", help="use firstSoundSec / tempo as annotated")
    a = ap.parse_args(argv)
    ann = json.load(open(a.annotation))
    base = os.path.basename(a.annotation)
    name = base[:-len(".chords.json")] if base.endswith(".chords.json") else os.path.splitext(base)[0]
    wav = os.path.join(os.path.dirname(os.path.abspath(a.annotation)), ann["wav"])
    fit = fit_grid(wav, ann)
    if a.no_fit:
        fit.update(t0=ann["firstSoundSec"], tempo=ann["tempo"])
    truth = build_truth(ann, fit["audioSec"], fit["t0"], fit["tempo"], name)
    outdir = os.path.join(a.out, "rec")
    os.makedirs(outdir, exist_ok=True)
    tpath = os.path.join(outdir, f"{name}.truth.json")
    with open(tpath, "w") as f:
        json.dump(truth, f, indent=1)
    mpath = os.path.join(outdir, "manifest.rec.json")
    man = {"variants": []}
    if os.path.exists(mpath):
        man = json.load(open(mpath))
    entry = {"name": f"rec-{name}", "song": "rec", "level": "REC", "heldOut": False,
             "wav": os.path.relpath(wav, a.out), "truth": f"rec/{name}.truth.json",
             "fit": {"t0": round(fit["t0"], 4), "tempo": round(fit["tempo"], 3),
                     "residualMedianMs": round(fit["residualMedianMs"], 1)}}
    man["variants"] = [v for v in man["variants"] if v["name"] != entry["name"]] + [entry]
    with open(mpath, "w") as f:
        json.dump(man, f, indent=1)
    print(f"wrote {tpath}, {mpath}")
    print(f"fit: t0={fit['t0']:.4f}s (annotated {ann['firstSoundSec']}) tempo={fit['tempo']:.3f} (annotated {ann['tempo']}) "
          f"residualMedian={fit['residualMedianMs']:.1f}ms onsets={fit['nOnsets']}")


if __name__ == "__main__":
    sys.exit(main())
