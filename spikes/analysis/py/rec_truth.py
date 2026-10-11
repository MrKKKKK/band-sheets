"""Answer JSON for a real recording from a hand-written chord annotation (task TR).

Usage: python py/rec_truth.py recordings/<name>.chords.json [--out DIR]
Writes DIR/rec/<name>.truth.json and (re)writes DIR/rec/manifest.rec.json (default DIR = out), merging
with entries for other recordings. Importable: build_truth(ann, audio_sec, t0, tempo) -> dict,
fit_grid(wav_path, ann) -> dict, parse_chord(text) -> (root, quality, bass).

Annotation: tempo, timeSignature [n, d], click, firstSoundSec, eighthsPerBar, sections [{label,startBar,bars,key?}],
bars [[[chordText, eighths], ...], ...] (each bar sums to eighthsPerBar). The last chord rings to the end of the file.
Optional: pickupBeats (anacrusis: beats before bar 0; firstSoundSec is then the first pickup beat; those beats get
bar -1), pickupChords ([[chordText, eighths], ...] summing to the pickup length), tempoHint (BPM the player knows,
e.g. the click; goes to the manifest only), sections[].key ("G", "F#m"; optional, becomes truth "keys").
Chord text: root + suffix + optional /bass. Suffixes outside the scorer's vocabulary (7(#9), m7b5, 13 ...) are accepted
when they are well-formed and kept verbatim as quality; a wrong root (Hm7) is an error.
Beats are evenly spaced from t0 (60/tempo apart). t0/tempo are fitted to librosa onsets (percussive part):
t0 within +-60 ms of firstSoundSec, tempo within +-1 %, maximizing onsets near eighth-note grid points.

Intake (anonymous names; held-out decided BEFORE any analysis):
  python py/rec_truth.py register <audio file> (--dev | --held-out) [--style a..e] [--recordings DIR]
copies/moves the file to recordings/rec-NN.<ext> (and <stem>.chords.json next to it to rec-NN.chords.json) and records
original name + heldOut in recordings/ids.local.json (gitignored). Then run this script on rec-NN.chords.json.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sys

import numpy as np

NO_CHORD = ("N.C.", "N")
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


# well-formed suffix outside the table: a sequence of quality / extension / alteration tokens
_SUFFIX_RE = re.compile(r"(?:maj|min|dim|aug|sus[24]?|add\d+|[mM]|[+\-\u00b0\u00f8^]|[#b]?\d+|\([#b+\-]?\d+(?:[,#b]?\d*)*\))+")


def parse_chord(text):
    """'Dm7/G' -> ('D', 'min7', 'G'). Known suffixes map to the scorer's qualities; other well-formed suffixes
    ('7(#9)', 'm7b5', '13') are kept verbatim as quality. Raises ValueError for a bad root/bass or a malformed suffix."""
    m = re.fullmatch(r"([A-G][#b]?)([^/]*)(?:/([A-G][#b]?))?", text.strip())
    if not m:
        raise ValueError(f"unknown chord text: {text!r}")
    suffix = m.group(2)
    if suffix in SUFFIX_QUALITY:
        quality = SUFFIX_QUALITY[suffix]
    elif _SUFFIX_RE.fullmatch(suffix):
        quality = suffix
    else:
        raise ValueError(f"unknown chord text: {text!r}")
    return m.group(1), quality, m.group(3)


def _r(x):
    return round(float(x), 4)


def _key_text(key):
    return key if re.fullmatch(r"[A-G][#b]?m?", key) else None


def build_truth(ann, audio_sec, t0, tempo, name="rec"):
    """t0 = time of the first beat (the first pickup beat when pickupBeats > 0, else bar 0 beat 0)."""
    num, den = ann["timeSignature"]
    eps = ann["eighthsPerBar"]
    eighth = 30.0 / tempo
    if ann.get("timing") == "sequence":  # chord order only (no bar timing): no beats, no timed chords
        seq = []
        for text in ann["sequence"]:
            root, quality, bass = parse_chord(text)
            seq.append({"root": root, "quality": quality, "bass": bass, "text": text})
        out = {"format": "band-sheets-analysis", "version": 1, "timing": "sequence",
               "source": {"kind": "recording", "durationSec": None if audio_sec is None else _r(audio_sec),
                          "click": bool(ann.get("click", False)),
                          "audioSec": None if audio_sec is None else _r(audio_sec), "leadInSec": _r(t0)},
               "analyzer": {"name": "ground-truth", "version": "0.1.0", "methods": []},
               "beats": [], "timeSignature": {"num": num, "den": den, "confidence": 1}, "sections": [],
               "chords": [], "chordSequence": seq}
        for k in ("maximizer", "hasMidi"):
            if ann.get(k) is not None:
                out["source"][k] = ann[k]
        if ann.get("key") is not None:
            if _key_text(ann["key"]) is None:
                raise ValueError(f"bad key: {ann['key']!r}")
            out["keys"] = [{"startBar": 0, "key": ann["key"]}]
        return out
    bars = ann["bars"]
    nbars = len(bars)
    beat_eighths = eps // num
    pickup = int(ann.get("pickupBeats", 0))
    if not 0 <= pickup < num:
        raise ValueError(f"pickupBeats must be in [0, {num - 1}]")
    pe = pickup * beat_eighths  # pickup length in eighths; bar 0 starts at eighth index pe
    beats = []
    for i in range(pickup):
        beats.append({"t": _r(t0 + i * beat_eighths * eighth), "downbeat": False, "bar": -1, "beat": num - pickup + i})
    for bar in range(nbars):
        for b in range(num):
            beats.append({"t": _r(t0 + (pe + bar * eps + b * beat_eighths) * eighth), "downbeat": b == 0, "bar": bar, "beat": b})
    end = t0 + (pe + nbars * eps) * eighth
    chords = []

    def add_chords(seq, pos):
        for text, n in seq:
            if text in NO_CHORD:  # N.C.: a gap in the chord list
                pos += n
                continue
            root, quality, bass = parse_chord(text)
            chords.append({"start": _r(t0 + pos * eighth), "end": _r(t0 + (pos + n) * eighth), "root": root,
                           "quality": quality, "bass": bass, "text": text, "confidence": 1})
            pos += n
        return pos

    if ann.get("pickupChords"):
        if sum(n for _, n in ann["pickupChords"]) != pe:
            raise ValueError(f"pickupChords must sum to {pe} eighths")
        add_chords(ann["pickupChords"], 0)
    pos = pe
    for bi, bar in enumerate(bars):
        if sum(n for _, n in bar) != eps:
            raise ValueError(f"bar {bi} does not sum to {eps} eighths")
        pos = add_chords(bar, pos)
    if chords and audio_sec is not None:
        chords[-1]["end"] = _r(max(audio_sec, chords[-1]["end"]))
    bar0 = t0 + pe * eighth
    sections = [{"start": _r(bar0 + s["startBar"] * eps * eighth), "end": _r(bar0 + (s["startBar"] + s["bars"]) * eps * eighth),
                 "label": s["label"]} for s in ann.get("sections", [])]
    keys = []
    for s_ in sorted(ann.get("sections", []), key=lambda x: x["startBar"]):
        if s_.get("key") is not None:
            if _key_text(s_["key"]) is None:
                raise ValueError(f"bad section key: {s_['key']!r}")
            keys.append({"startBar": s_["startBar"], "key": s_["key"]})
    source = {"kind": "recording", "durationSec": _r(end), "click": bool(ann.get("click", False)),
              "audioSec": None if audio_sec is None else _r(audio_sec), "leadInSec": _r(t0)}
    if pickup:
        source["pickupBeats"] = pickup
    for k in ("maximizer", "hasMidi"):
        if ann.get(k) is not None:
            source[k] = ann[k]
    out = {
        "format": "band-sheets-analysis", "version": 1,
        "source": source,
        "analyzer": {"name": "ground-truth", "version": "0.1.0", "methods": []},
        "beats": beats,
        "timeSignature": {"num": num, "den": den, "confidence": 1},
        "sections": sections,
        "chords": chords,
    }
    if not keys and ann.get("keys"):  # key changes written in the .txt body (T28)
        for k in sorted(ann["keys"], key=lambda x: x["startBar"]):
            if _key_text(k["key"]) is None:
                raise ValueError(f"bad key: {k['key']!r}")
            keys.append({"startBar": int(k["startBar"]), "key": k["key"]})
    if not keys and ann.get("key"):
        if _key_text(ann["key"]) is None:
            raise ValueError(f"bad key: {ann['key']!r}")
        keys.append({"startBar": 0, "key": ann["key"]})
    if keys:
        out["keys"] = keys
    return out


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
    n8 = len(ann["bars"]) * ann["eighthsPerBar"] + int(ann.get("pickupBeats", 0)) * (ann["eighthsPerBar"] // ann.get("timeSignature", [4, 4])[0])
    fit = fit_onsets(times, env[frames], ann["firstSoundSec"], ann["tempo"], n8, ann["eighthsPerBar"])
    fit["audioSec"] = float(len(y) / sr)
    return fit


IDS_FILE = "ids.local.json"
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac"}


def _load_ids(rec_dir):
    p = os.path.join(rec_dir, IDS_FILE)
    if os.path.exists(p):
        return json.load(open(p))
    return {"version": 1, "recordings": {}}


def _save_ids(rec_dir, ids):
    with open(os.path.join(rec_dir, IDS_FILE), "w") as f:
        json.dump(ids, f, indent=1, ensure_ascii=False)


def allocate_id(rec_dir, original, held_out, style=None, now=None, file=None):
    """Next anonymous id rec-NN for a take; stores original name + heldOut in ids.local.json. The decision is final:
    registering the same original again is an error."""
    os.makedirs(rec_dir, exist_ok=True)
    ids = _load_ids(rec_dir)
    for rid, e in ids["recordings"].items():
        if e["original"] == original:
            raise ValueError(f"already registered as {rid} (heldOut={e['heldOut']}); it cannot be changed")
    n = 1
    while f"rec-{n:02d}" in ids["recordings"]:
        n += 1
    rid = f"rec-{n:02d}"
    stamp = now or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    ids["recordings"][rid] = {"original": original, "heldOut": bool(held_out), "style": style, "file": file,
                              "registeredAt": stamp}
    _save_ids(rec_dir, ids)
    return rid


def register_recording(rec_dir, src, held_out, style=None, now=None):
    """Give `src` the next anonymous name rec-NN, store it as rec_dir/rec-NN.<ext> (+ its <stem>.chords.json as
    rec-NN.chords.json) and record original name + heldOut in rec_dir/ids.local.json. heldOut is fixed here,
    before any analysis, and cannot be changed by registering again. Returns the id."""
    ext = os.path.splitext(src)[1].lower()
    if ext not in AUDIO_EXT:
        raise ValueError(f"not an audio file: {os.path.basename(src)}")
    if not os.path.isfile(src):
        raise FileNotFoundError(src)
    os.makedirs(rec_dir, exist_ok=True)
    original = os.path.basename(src)
    rid = allocate_id(rec_dir, original, held_out, style, now=now, file=None)
    dst = os.path.join(rec_dir, rid + ext)
    ann_src = os.path.splitext(src)[0] + ".chords.json"
    ann_dst = os.path.join(rec_dir, rid + ".chords.json")
    inside = os.path.abspath(os.path.dirname(src)) == os.path.abspath(rec_dir)
    (shutil.move if inside else shutil.copy2)(src, dst)
    if os.path.exists(ann_src):
        (shutil.move if inside else shutil.copy2)(ann_src, ann_dst)
        ann = json.load(open(ann_dst))
        if "wav" in ann:
            ann["wav"] = rid + ext
            with open(ann_dst, "w") as f:
                json.dump(ann, f, indent=1, ensure_ascii=False)
    ids = _load_ids(rec_dir)
    ids["recordings"][rid]["file"] = rid + ext
    _save_ids(rec_dir, ids)
    return rid


def emit(ann, wav, name, out, fit, held_out, take=None):
    """Write out/rec/<name>.truth.json and merge the entry into out/rec/manifest.rec.json. Returns both paths."""
    truth = build_truth(ann, fit["audioSec"], fit["t0"], fit["tempo"], name)
    outdir = os.path.join(out, "rec")
    os.makedirs(outdir, exist_ok=True)
    tpath = os.path.join(outdir, f"{name}.truth.json")
    with open(tpath, "w") as f:
        json.dump(truth, f, indent=1)
    mpath = os.path.join(outdir, "manifest.rec.json")
    man = {"variants": []}
    if os.path.exists(mpath):
        man = json.load(open(mpath))
    entry = {"name": name if name.startswith("rec-") else f"rec-{name}", "song": "rec", "level": "REC",
             "heldOut": bool(held_out),
             "wav": os.path.relpath(wav, out), "truth": f"rec/{name}.truth.json",
             "fit": {"t0": round(fit["t0"], 4), "tempo": round(fit["tempo"], 3),
                     "residualMedianMs": round(fit["residualMedianMs"], 1)}}
    if take:
        entry["take"] = take
    if ann.get("maximizer") is not None:
        entry["maximizer"] = bool(ann["maximizer"])
    if ann.get("tempoHint") is not None:
        entry["tempoHint"] = float(ann["tempoHint"])
    man["variants"] = [v for v in man["variants"] if v["name"] != entry["name"]] + [entry]
    with open(mpath, "w") as f:
        json.dump(man, f, indent=1)
    return tpath, mpath


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "register":
        ap = argparse.ArgumentParser(prog="rec_truth.py register")
        ap.add_argument("audio")
        g = ap.add_mutually_exclusive_group(required=True)
        g.add_argument("--dev", action="store_true", help="development recording (may be looked at at the fixed points)")
        g.add_argument("--held-out", action="store_true", help="held-out recording (analysed once, at T15)")
        ap.add_argument("--style", choices=list("abcde"), help="recording style (a)-(e) of the plan")
        ap.add_argument("--recordings", default="recordings")
        a = ap.parse_args(argv[1:])
        rid = register_recording(a.recordings, a.audio, a.held_out, a.style)
        print(f"registered as {rid} ({'held-out' if a.held_out else 'dev'}); write recordings/{rid}.chords.json next")
        return 0
    ap = argparse.ArgumentParser()
    ap.add_argument("annotation")
    ap.add_argument("--out", default="out")
    ap.add_argument("--no-fit", action="store_true", help="use firstSoundSec / tempo as annotated")
    a = ap.parse_args(argv)
    ann = json.load(open(a.annotation))
    base = os.path.basename(a.annotation)
    name = base[:-len(".chords.json")] if base.endswith(".chords.json") else os.path.splitext(base)[0]
    recdir = os.path.dirname(os.path.abspath(a.annotation))
    reg = _load_ids(recdir)["recordings"].get(re.sub(r"-max$", "", name))
    if re.fullmatch(r"rec-\d+(-max)?", name) and reg is None:
        sys.exit(f"{name} is not registered: run 'register' first so that heldOut is decided before analysis")
    wav = os.path.join(recdir, ann.get("wav") or (reg or {}).get("file") or name + ".wav")
    fit = fit_grid(wav, ann)
    if a.no_fit:
        fit.update(t0=ann["firstSoundSec"], tempo=ann["tempo"])
    held = bool(reg["heldOut"]) if reg else False
    tpath, mpath = emit(ann, wav, name, a.out, fit, held)
    print(f"wrote {tpath}, {mpath}")
    print(f"fit: t0={fit['t0']:.4f}s (annotated {ann['firstSoundSec']}) tempo={fit['tempo']:.3f} (annotated {ann['tempo']}) "
          f"residualMedian={fit['residualMedianMs']:.1f}ms onsets={fit['nOnsets']}")


if __name__ == "__main__":
    sys.exit(main())
