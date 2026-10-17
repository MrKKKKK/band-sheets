"""Wav degradation for spike 1 (docs/audio-spike1-plan.md, T8).

Adds pink noise (SNR), a synthetic reverb (exp-decaying noise IR), a slow gain envelope and an overall gain
to the base variants. Times are unchanged, so the base truth is copied. Deterministic per seed. No ML.

CLI (from spikes/analysis):
  python py/degrade.py [--out out] [--only GLOB] [--conditions NAME,...] [--seed 1] [--keep-existing] [--list]

Reads <out>/manifest.json (base variants whose level is absent or 0, plus spike 2's level "LR" variants of
lrGrade 0), writes <out>/derived/<name>.wav, <out>/derived/<name>.truth.json and
<out>/derived/manifest.derived.json. Level-0 bases get CONDITIONS; level-LR bases get LR_CONDITIONS
(entries level "LR" with that lrGrade). With --only / --conditions the manifest keeps the other entries
(merged by name); --keep-existing does not rewrite a wav + truth that already exist (other readers of out/).
Order of processing: gain envelope -> reverb -> pink noise (SNR vs. the signal at that point) -> gain
-> maximizer (spike 2: make-up gain to a target active RMS, then a lookahead brickwall limiter).
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

# Spike 2 (T4): extra conditions used only for level LR, and which LR grade (L0/L1/L2-like) each gives.
# "lr-max" imitates a DAW maximizer on the master (the user's recordings are exported through one):
# fixed parameters, deterministic, no ML.
EXTRA_CONDITIONS = {
    "lr-max": (1, {"maxTargetRmsDb": -12.0, "maxCeilingDb": -0.3}),
}
LR_CONDITIONS = {"l1-noise30": 1, "l2-room": 2, "lr-max": 1}
LR_LEVEL = "LR"
MAX_LOOKAHEAD_SEC = 0.005
MAX_RELEASE_SEC = 0.05
MAX_BLOCK = 64


def _params(cn):
    return {**CONDITIONS, **EXTRA_CONDITIONS}[cn]


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


def maximize(x, target_rms_db, ceiling_db=-0.3, sr=SR, lookahead_sec=MAX_LOOKAHEAD_SEC,
             release_sec=MAX_RELEASE_SEC, block=MAX_BLOCK):
    """Maximizer: gain so that active_rms = target_rms_db dBFS, then a lookahead brickwall limiter.

    The limiter gain is computed per block of `block` samples: the gain each block needs (ceiling / peak,
    at most 1), its minimum over the next `lookahead_sec` (the gain is already down when the peak arrives),
    an exponential release back towards 1 (`release_sec`), linearly interpolated between block starts.
    Interpolating between g[k] <= need[k] and g[k+1] <= g[k] never exceeds a block's need, so the output
    stays at or below the ceiling; a final clip at the ceiling only guards rounding. Deterministic.
    """
    y = np.asarray(x, dtype=np.float64)
    rms = active_rms(y, sr)
    if rms <= 0 or len(y) == 0:
        return y.copy()
    y = y * (10 ** (target_rms_db / 20.0) / rms)
    ceiling = 10 ** (ceiling_db / 20.0)
    nb = int(np.ceil(len(y) / block))
    pad = np.zeros(nb * block)
    pad[:len(y)] = np.abs(y)
    peak = pad.reshape(nb, block).max(axis=1)
    need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-12))
    la = int(np.ceil(lookahead_sec * sr / block))
    ahead = np.concatenate([need, np.ones(la)])
    m = np.min(np.lib.stride_tricks.sliding_window_view(ahead, la + 1), axis=1)[:nb]
    rel = 1.0 - np.exp(-block / (release_sec * sr))
    g = np.empty(nb + 1)
    prev = 1.0
    for k in range(nb):
        prev = min(m[k], prev + (1.0 - prev) * rel)
        g[k] = prev
    g[nb] = g[nb - 1]
    gain = np.interp(np.arange(len(y)), np.arange(nb + 1) * block, g)
    return np.clip(y * gain, -ceiling, ceiling)


def degrade(x, noise_snr_db=None, reverb_rt60=None, gain_env_db=None, gain_db=None, max_target_rms_db=None,
            max_ceiling_db=-0.3, seed=0, sr=SR):
    """Apply the chain to a float mono signal; returns float64 (unclipped unless the maximizer is on)."""
    y = np.asarray(x, dtype=np.float64)
    if gain_env_db:
        y = apply_gain_envelope(y, gain_env_db, seed, sr)
    if reverb_rt60:
        y = add_reverb(y, reverb_rt60, seed, sr)
    if noise_snr_db is not None:
        y = add_noise(y, noise_snr_db, seed, sr)
    if gain_db:
        y = y * 10 ** (gain_db / 20.0)
    if max_target_rms_db is not None:
        y = maximize(y, max_target_rms_db, max_ceiling_db, sr)
    return y


def degrade_params(d):
    out = dict(noise_snr_db=d.get("noiseSnrDb"), reverb_rt60=d.get("reverbRt60"),
               gain_env_db=d.get("gainEnvDb"), gain_db=d.get("gainDb"))
    if d.get("maxTargetRmsDb") is not None:
        out.update(max_target_rms_db=d["maxTargetRmsDb"], max_ceiling_db=d.get("maxCeilingDb", -0.3))
    return out


def derived_truth(truth, name, base, level, d):
    """Copy of the base truth (times unchanged) with degrade info in source and the variant name updated."""
    t = copy.deepcopy(truth)
    t.setdefault("source", {})["degrade"] = dict(d, base=base, level=level)
    if isinstance(t.get("render"), dict):
        t["render"]["variant"] = name
    return t


def is_lr_base(v):
    return v.get("level") == LR_LEVEL and (v.get("lrGrade") or 0) == 0


def select_bases(manifest, only=None):
    out = []
    for v in manifest["variants"]:
        if (v.get("level") or 0) != 0 and not is_lr_base(v):
            continue
        if only and not fnmatch.fnmatch(v["name"], only):
            continue
        out.append(v)
    return out


def jobs_for(v, conditions=None):
    """[(condition name, level, lrGrade or None, degrade dict)] for one base variant."""
    if is_lr_base(v):
        return [(cn, LR_LEVEL, grade, _params(cn)[1]) for cn, grade in LR_CONDITIONS.items()
                if conditions is None or cn in conditions]
    out = []
    for cn in conditions or list(CONDITIONS):
        if cn not in CONDITIONS:
            continue
        level, d = CONDITIONS[cn]
        if v.get("heldOut") and level > 2:
            continue
        out.append((cn, level, None, d))
    return out


def run(out_dir, only=None, conditions=None, seed=1, log=print, keep_existing=False):
    with open(os.path.join(out_dir, "manifest.json")) as f:
        manifest = json.load(f)
    dd = os.path.join(out_dir, "derived")
    os.makedirs(dd, exist_ok=True)
    entries = []
    for v in select_bases(manifest, only):
        x = sr = truth = None
        held = bool(v.get("heldOut"))
        for cn, level, grade, d in jobs_for(v, conditions):
            name = f"{v['name']}__{cn}"
            wav, tr = os.path.join(dd, name + ".wav"), os.path.join(dd, name + ".truth.json")
            if not (keep_existing and os.path.exists(wav) and os.path.exists(tr)):
                if x is None:
                    x, sr = sf.read(os.path.join(out_dir, v["wav"]), dtype="float64")
                    if x.ndim > 1:
                        x = x.mean(axis=1)
                    with open(os.path.join(out_dir, v["truth"])) as f:
                        truth = json.load(f)
                y = degrade(x, seed=seed, sr=sr, **degrade_params(d))
                peak = float(np.max(np.abs(y)))
                sf.write(wav, np.clip(y, -CLIP, CLIP), sr, subtype="PCM_16")
                t = derived_truth(truth, name, v["name"], level, d)
                if grade is not None:
                    t["source"]["degrade"]["lrGrade"] = grade
                with open(tr, "w") as f:
                    json.dump(t, f, indent=2)
                log(f"{name}: peak {peak:.3f}" + ("  CLIPPED" if peak > CLIP else ""))
            else:
                log(f"{name}: kept")
            e = {"name": name, "song": v["song"], "base": v["name"], "level": level}
            if grade is not None:
                e["lrGrade"] = grade
            e.update({"heldOut": held, "degrade": d, "wav": f"derived/{name}.wav", "truth": f"derived/{name}.truth.json"})
            entries.append(e)
    path = os.path.join(dd, "manifest.derived.json")
    if (only or conditions) and os.path.exists(path):
        with open(path) as f:
            old = json.load(f)
        fresh = {e["name"] for e in entries}
        entries = [e for e in old if e["name"] not in fresh] + entries
    with open(path, "w") as f:
        json.dump(entries, f, indent=2)
    return entries


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="out")
    ap.add_argument("--only", help="glob on base variant names")
    ap.add_argument("--conditions", help="comma-separated condition names")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--list", action="store_true", help="print the conditions table and exit")
    ap.add_argument("--keep-existing", action="store_true", help="do not rewrite outputs that already exist")
    a = ap.parse_args(argv)
    if a.list:
        for k, (lv, d) in CONDITIONS.items():
            print(k, "L%d" % lv, d)
        for k, grade in LR_CONDITIONS.items():
            print(k, "LR grade %d (level LR bases only)" % grade, _params(k)[1])
        return 0
    conds = a.conditions.split(",") if a.conditions else None
    for c in conds or []:
        if c not in CONDITIONS and c not in EXTRA_CONDITIONS:
            sys.exit(f"unknown condition {c}")
    run(a.out, a.only, conds, a.seed, keep_existing=a.keep_existing)
    return 0


if __name__ == "__main__":
    sys.exit(main())
