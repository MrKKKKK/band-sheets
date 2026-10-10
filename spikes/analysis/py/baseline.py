"""Baseline analyzers for spike 0 (docs/audio-spike0-plan.md, decision 9).

Usage:
  python py/baseline.py constant <truth.json> [-o result.json]   # reads only durationSec
  python py/baseline.py oracle   <truth.json> [-o result.json]
  python py/baseline.py constant --wav x.wav [-o result.json]    # duration from the wav header

Importable: constant(duration_sec) -> dict, constant_from_truth(truth) -> dict, oracle(truth) -> dict.
"""
import argparse
import copy
import json
import sys

BPM = 120
BEAT_SEC = 60.0 / BPM
BEATS_PER_BAR = 4


def constant(duration_sec):
    """120 BPM grid, downbeat every 4 beats, C major over the whole duration, one section, no melody."""
    duration_sec = float(duration_sec)
    beats = []
    i = 0
    while i * BEAT_SEC < duration_sec - 1e-9:
        beats.append({"t": round(i * BEAT_SEC, 6), "downbeat": i % BEATS_PER_BAR == 0,
                      "bar": i // BEATS_PER_BAR, "beat": i % BEATS_PER_BAR})
        i += 1
    return {
        "format": "band-sheets-analysis",
        "version": 1,
        "source": {"kind": "synthetic", "durationSec": duration_sec},
        "analyzer": {"name": "constant", "version": "0.1.0", "methods": ["constant-120bpm"]},
        "beats": beats,
        "timeSignature": {"num": 4, "den": 4, "confidence": 0},
        "key": {"tonic": "C", "mode": "major", "confidence": 0},
        "sections": [{"start": 0.0, "end": duration_sec, "label": "A"}],
        "chords": [{"start": 0.0, "end": duration_sec, "root": "C", "quality": "maj",
                    "bass": None, "text": "C", "confidence": 0}],
    }


def constant_from_truth(truth):
    """Uses only truth['source']['durationSec'] (never the answers)."""
    return constant(truth["source"]["durationSec"])


def wav_duration(path):
    import soundfile as sf
    info = sf.info(path)
    return info.frames / float(info.samplerate)


def oracle(truth):
    """Returns the truth itself with the analyzer name changed."""
    out = copy.deepcopy(truth)
    analyzer = dict(out.get("analyzer") or {})
    analyzer["name"] = "oracle"
    out["analyzer"] = analyzer
    return out


def phase0_from(result):
    """The analyzer's own beats with the downbeat phase fixed to 0: beat i is a downbeat iff i % beats_per_bar == 0.

    The trivial rival of a real downbeat finder (R2): in every base variant the first sound is the downbeat,
    so this scores ~1.0 there; on mid-bar-start variants (py/midbar.py) it shows what the analyzer adds.
    Only the beat / downbeat columns of this row are meaningful; chords and sections are copied from the
    input result unchanged.
    """
    out = copy.deepcopy(result)
    bpb = int((out.get("timeSignature") or {}).get("num") or BEATS_PER_BAR)
    for i, b in enumerate(out["beats"]):
        b["downbeat"] = i % bpb == 0
        b["bar"], b["beat"] = i // bpb, i % bpb
    analyzer = dict(out.get("analyzer") or {})
    analyzer["name"] = "dsp-phase0"
    out["analyzer"] = analyzer
    return out


_PC_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def mode_chord_from_wav(wav_path):
    """Constant analyzer: one chord for the whole wav (best major/minor triad template against the mean chroma)
    plus the fixed 120 BPM grid. Reads only the wav, never a truth."""
    import librosa
    import numpy as np
    y, sr = librosa.load(wav_path, sr=22050, mono=True)
    duration = len(y) / float(sr)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1) if len(y) else np.zeros(12)
    best, best_score = (0, "maj"), -1.0
    for root in range(12):
        for q, third in (("maj", 4), ("min", 3)):
            sc = sum(chroma[(root + i) % 12] for i in (0, third, 7))
            if sc > best_score + 1e-12:
                best, best_score = (root, q), sc
    root, q = best
    r = constant(duration)
    name = _PC_NAMES[root]
    r["analyzer"] = {"name": "mode-chord", "version": "0.1.0", "methods": ["mean-chroma-triad", "constant-120bpm"]}
    r["chords"] = [{"start": 0.0, "end": duration, "root": name, "quality": q, "bass": None,
                    "text": name + ("m" if q == "min" else ""), "confidence": 0}]
    return r


def _mode_chord(truth, wav_path):
    return mode_chord_from_wav(wav_path)


# Truth-only analyzers (constant/oracle) keep their one-argument form in ANALYZERS (importable as before);
# ANALYZERS2 uniformly takes (truth, wav_path). Wav-only ones must never look at `truth`.
ANALYZERS = {"constant": constant_from_truth, "oracle": oracle}
ANALYZERS2 = {"constant": lambda truth, wav: constant_from_truth(truth),
              "oracle": lambda truth, wav: oracle(truth),
              "mode-chord": _mode_chord}
NEEDS_WAV = {"mode-chord"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("analyzer", choices=sorted(ANALYZERS))
    ap.add_argument("truth", nargs="?")
    ap.add_argument("--wav", help="constant only: take the duration from this wav")
    ap.add_argument("-o", "--output")
    args = ap.parse_args(argv)
    if args.analyzer == "constant" and args.wav:
        result = constant(wav_duration(args.wav))
    elif args.truth:
        with open(args.truth) as f:
            result = ANALYZERS[args.analyzer](json.load(f))
    else:
        ap.error("truth.json is required")
    text = json.dumps(result, indent=2, ensure_ascii=False)
    if args.output:
        with open(args.output, "w") as f:
            f.write(text + "\n")
    else:
        print(text)


if __name__ == "__main__":
    sys.exit(main())
