"""Spike 4 T4: librosa pyin reference f0 for the DEV synthetic humming only (docs/audio-spike4-plan.md section 7 T4).

librosa (ISC) is used only as a comparison partner here, never shipped. For each dev variant of out/hum/manifest.json
(split 'dev', heldOut false; held-out and tuning variants are refused) it runs

    librosa.pyin(y, fmin=65, fmax=1050, sr=22050, frame_length=1024, hop_length=256, center=True, fill_na=None)

on librosa.load(sr=22050, mono=True) -- the same frame grid as ts/hum/f0.ts (frame i centred on sample i * 256, i.e.
t = i * 256 / 22050) and the same frame length (1024) -- and writes out/hum/pyin-ref/<name>.json:
    {"name", "hopSec", "params", "hz": [...], "voiced": [0|1 ...], "prob": [...]}
hz is the best pitch guess for every frame (fill_na=None: unvoiced frames carry a guess, like the TS track).
ts/hum/f0_eval.ts then reports the agreement (share of frames voiced in both within +-50 cents).

    PY python py/tools/pyin_ref.py                 # all dev variants
    PY python py/tools/pyin_ref.py syn-h3-rand-s4  # selected dev variants

(PY = docker run --rm -u 1000:1000 -e HOME=/tmp -e NUMBA_CACHE_DIR=/work/out/.numba-cache
       -v <repo>/spikes/analysis:/work -w /work band-sheets-analysis)
Prints variant names and numbers only. Synthetic audio only: it never reads recordings/.
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # spikes/analysis
HUM = os.path.join(ROOT, 'out', 'hum')
PARAMS = dict(fmin=65.0, fmax=1050.0, sr=22050, frame_length=1024, hop_length=256, center=True)


def dev_variants(manifest, names):
    by_name = {v['name']: v for v in manifest['variants']}
    if names:
        out = []
        for n in names:
            v = by_name.get(n)
            if v is None:
                raise SystemExit(f'unknown variant {n}')
            if v.get('heldOut') or v.get('split') != 'dev':
                raise SystemExit(f'{n}: only dev variants (split dev, not held out) may be used here')
            out.append(v)
        return out
    return [v for v in manifest['variants'] if v.get('split') == 'dev' and not v.get('heldOut')]


def main(argv):
    import librosa
    import numpy as np

    manifest = json.load(open(os.path.join(HUM, 'manifest.json')))
    variants = dev_variants(manifest, argv)
    os.makedirs(os.path.join(HUM, 'pyin-ref'), exist_ok=True)
    for v in variants:
        y, _ = librosa.load(os.path.join(HUM, v['wav']), sr=PARAMS['sr'], mono=True)
        t0 = time.perf_counter()
        f0, flag, prob = librosa.pyin(y, fill_na=None, **PARAMS)
        ms = (time.perf_counter() - t0) * 1000
        hz = np.where(np.isfinite(f0), f0, 0.0)
        out = {
            'name': v['name'],
            'hopSec': PARAMS['hop_length'] / PARAMS['sr'],
            'params': {**PARAMS, 'librosa': librosa.__version__},
            'hz': [round(float(x), 4) for x in hz],
            'voiced': [int(bool(x)) for x in flag],
            'prob': [round(float(x), 4) for x in prob],
        }
        with open(os.path.join(HUM, 'pyin-ref', v['name'] + '.json'), 'w') as fh:
            json.dump(out, fh)
        print(f"{v['name']}: {len(hz)} frames, voiced {np.mean(flag):.3f}, {ms / v['audioSec']:.1f} ms per audio second")


if __name__ == '__main__':
    main(sys.argv[1:])
