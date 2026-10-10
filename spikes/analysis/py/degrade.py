"""Wav degradation for spike 1 (docs/audio-spike1-plan.md, T8).

Adds pink noise (SNR), a synthetic reverb (exp-decaying noise IR), a slow gain envelope and an overall gain
to the base variants. Times are unchanged, so the base truth is copied. Deterministic per seed. No ML.

CLI (from spikes/analysis):
  python py/degrade.py [--out out] [--only GLOB] [--conditions NAME,...] [--seed 1] [--list]

Reads <out>/manifest.json (base variants whose level is absent or 0), writes
<out>/derived/<name>.wav, <out>/derived/<name>.truth.json and <out>/derived/manifest.derived.json.
Order of processing: gain envelope -> reverb -> pink noise (SNR vs. the signal at that point) -> gain.
No per-file normalisation; output is clipped at +-CLIP only as a guard and the peak is reported.
"""
import argparse
import copy
import fnmatch
import json
import os
import sys
import zlib

import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve

SR = 44100
FRAME = 2048
SILENCE_REL_DB = -40.0     # frames more than 40 dB below the loudest frame are "silent"
REVERB_WET = 0.4
ENV_KNOT_SEC = 4.0         # gain-envelope control-point spacing
CLIP = 0.999

# name -> (level, degrade dict). Keys of degrade: noiseSnrDb, reverbRt60, gainEnvDb, gainDb.
CONDITIONS = {
    "l1-noise30": (1, {"noiseSnrDb": 30.0}),
    "l1-dyn6":    (1, {"noiseSnrDb": 30.0, "gainEnvDb": 6.0, "gainDb": -6.0}),
    "l2-room":    (2, {"reverbRt60": 0.6, "noiseSnrDb": 20.0}),
    "l2-rev06":   (2, {"reverbRt60": 0.6}),
    "l3-harsh":   (3, {"reverbRt60": 1.2, "noiseSnrDb": 10.0, "gainEnvDb": 6.0, "gainDb": -6.0}),
}


def _rng(seed, tag):
    return np.random.default_rng([int(seed) & 0xFFFFFFFF, zlib.crc32(tag.encode())])


def active_rms(x, sr=SR):
    """RMS of x over non-silent frames (frame RMS above SILENCE_REL_DB of the loudest frame)."""
    x = np.asarray(x, dtype=np.float64)
    n = len(x) // FRAME
    if n == 0:
        return float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
    fr = x[:n * FRAME].reshape(n, FRAME)
    e = np.mean(fr ** 2, axis=1)
    if e.max() <= 0:
        return 0.0
    keep = e > e.max() * 10 ** (SILENCE_REL_DB / 10)
    return float(np.sqrt(e[keep].mean()))


def pink_noise(n, rng):
    """Pink (1/f power) noise of length n, unit RMS."""
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(len(spec), dtype=np.float64)
    f[0] = 1.0
    spec = spec / np.sqrt(f)
    spec[0] = 0.0
    y = np.fft.irfft(spec, n)
    return y / np.sqrt(np.mean(y ** 2))


def add_noise(x, snr_db, seed=0, sr=SR):
    """Add pink noise so that active_rms(x) / rms(noise) = snr_db."""
    noise = pink_noise(len(x), _rng(seed, "noise"))
    return x + noise * (active_rms(x, sr) / 10 ** (snr_db / 20.0))


def make_ir(rt60, seed=0, sr=SR, wet=REVERB_WET):
    """Reverb IR: (1-wet) direct impulse at sample 0 + wet * unit-energy exp-decaying noise tail
    (-60 dB at rt60). The peak is at sample 0 (asserted)."""
    n = max(2, int(round(rt60 * sr * 1.2)))
    t = np.arange(n) / sr
    tail = _rng(seed, "reverb").standard_normal(n) * 10 ** (-3.0 * t / rt60)
    tail[0] = 0.0
    tail /= np.sqrt(np.sum(tail ** 2))
    ir = wet * tail
    ir[0] = 1.0 - wet
    assert np.argmax(np.abs(ir)) == 0
    return ir


def add_reverb(x, rt60, seed=0, sr=SR, wet=REVERB_WET):
    """Convolve with make_ir; output has the input's length (no delay of the direct sound)."""
    ir = make_ir(rt60, seed, sr, wet)
    return fftconvolve(x, ir)[:len(x)]


def gain_envelope_db(n, depth_db, seed=0, sr=SR):
    """Slow envelope in dB, within [-depth_db, +depth_db]: random knots every ENV_KNOT_SEC, cosine-interpolated."""
    k = int(np.ceil(n / sr / ENV_KNOT_SEC)) + 2
    knots = _rng(seed, "env").uniform(-1.0, 1.0, k) * depth_db
    pos = np.arange(n) / (ENV_KNOT_SEC * sr)
    i = pos.astype(int)
    frac = (1 - np.cos(np.pi * (pos - i))) / 2
    return knots[i] * (1 - frac) + knots[i + 1] * frac


def apply_gain_envelope(x, depth_db, seed=0, sr=SR):
    return x * 10 ** (gain_envelope_db(len(x), depth_db, seed, sr) / 20.0)


def degrade(x, noise_snr_db=None, reverb_rt60=None, gain_env_db=None, gain_db=None, seed=0, sr=SR):
    """Apply the chain to a float mono signal; returns float64 (unclipped)."""
    y = np.asarray(x, dtype=np.float64)
    if gain_env_db:
        y = apply_gain_envelope(y, gain_env_db, seed, sr)
    if reverb_rt60:
        y = add_reverb(y, reverb_rt60, seed, sr)
    if noise_snr_db is not None:
        y = add_noise(y, noise_snr_db, seed, sr)
    if gain_db:
        y = y * 10 ** (gain_db / 20.0)
    return y


def degrade_params(d):
    return dict(noise_snr_db=d.get("noiseSnrDb"), reverb_rt60=d.get("reverbRt60"),
                gain_env_db=d.get("gainEnvDb"), gain_db=d.get("gainDb"))


def derived_truth(truth, name, base, level, d):
    """Copy of the base truth (times unchanged) with degrade info in source and the variant name updated."""
    t = copy.deepcopy(truth)
    t.setdefault("source", {})["degrade"] = dict(d, base=base, level=level)
    if isinstance(t.get("render"), dict):
        t["render"]["variant"] = name
    return t


def select_bases(manifest, only=None):
    out = []
    for v in manifest["variants"]:
        if (v.get("level") or 0) != 0:
            continue
        if only and not fnmatch.fnmatch(v["name"], only):
            continue
        out.append(v)
    return out


def run(out_dir, only=None, conditions=None, seed=1, log=print):
    with open(os.path.join(out_dir, "manifest.json")) as f:
        manifest = json.load(f)
    names = conditions or list(CONDITIONS)
    dd = os.path.join(out_dir, "derived")
    os.makedirs(dd, exist_ok=True)
    entries = []
    for v in select_bases(manifest, only):
        x, sr = sf.read(os.path.join(out_dir, v["wav"]), dtype="float64")
        if x.ndim > 1:
            x = x.mean(axis=1)
        with open(os.path.join(out_dir, v["truth"])) as f:
            truth = json.load(f)
        for cn in names:
            level, d = CONDITIONS[cn]
            held = bool(v.get("heldOut"))
            if held and level > 2:
                continue
            name = f"{v['name']}__{cn}"
            y = degrade(x, seed=seed, sr=sr, **degrade_params(d))
            peak = float(np.max(np.abs(y)))
            sf.write(os.path.join(dd, name + ".wav"), np.clip(y, -CLIP, CLIP), sr, subtype="PCM_16")
            with open(os.path.join(dd, name + ".truth.json"), "w") as f:
                json.dump(derived_truth(truth, name, v["name"], level, d), f, indent=2)
            entries.append({"name": name, "song": v["song"], "base": v["name"], "level": level,
                            "heldOut": held, "degrade": d,
                            "wav": f"derived/{name}.wav", "truth": f"derived/{name}.truth.json"})
            log(f"{name}: peak {peak:.3f}" + ("  CLIPPED" if peak > CLIP else ""))
    with open(os.path.join(dd, "manifest.derived.json"), "w") as f:
        json.dump(entries, f, indent=2)
    return entries


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="out")
    ap.add_argument("--only", help="glob on base variant names")
    ap.add_argument("--conditions", help="comma-separated condition names")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--list", action="store_true", help="print the conditions table and exit")
    a = ap.parse_args(argv)
    if a.list:
        for k, (lv, d) in CONDITIONS.items():
            print(k, "L%d" % lv, d)
        return 0
    conds = a.conditions.split(",") if a.conditions else None
    for c in conds or []:
        if c not in CONDITIONS:
            sys.exit(f"unknown condition {c}")
    run(a.out, a.only, conds, a.seed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
