"""Spike 5 T5: librosa.onset.onset_detect on the synthetic drum tuning + dev variants, for the comparison table.

librosa is dev tooling only (ISC, never shipped); it is in the analysis image (band-sheets-analysis). Two steps
(PY = docker run --rm -u 1000:1000 -e HOME=/tmp -e NUMBA_CACHE_DIR=/work/out/.numba-cache -v <repo>/spikes/analysis:/work -w /work band-sheets-analysis;
 BS = docker exec -u node -w /workspaces/band-sheets/<worktree>/spikes/analysis band-sheets):

  $PY python py/tools/drum_librosa_onsets.py out/drum-results/onset/librosa.json
  $BS npx tsx ts/drum/onset_eval.ts --est-json out/drum-results/onset/librosa.json --est-key default
  $BS npx tsx ts/drum/onset_eval.ts --est-json out/drum-results/onset/librosa.json --est-key backtrack

Modes: 'default' = librosa.load(sr=22050) + onset_detect(units='time') with every default; 'backtrack' = the same with
backtrack=True (onsets moved back to the preceding energy minimum). Scoring is the TS scorer (ts/drum/onset_eval.ts),
so both analyzers are judged by the same code. HELD-OUT: only variants with split tuning / dev and heldOut false are
read; the script exits before opening any file if a held-out entry would be selected. Prints counts and seconds only.
"""
import json
import os
import sys
import time

import librosa

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # spikes/analysis
DRUM = os.path.join(ROOT, 'out', 'drum')


def select(variants):
    sel = [v for v in variants if v.get('split') in ('tuning', 'dev') and v.get('heldOut') is False]
    if any(v.get('heldOut') or v.get('split') == 'heldOut' for v in sel):
        raise SystemExit('refusing held-out variants')
    return sel


def main(out_path):
    manifest = json.load(open(os.path.join(DRUM, 'manifest.json')))
    sel = select(manifest['variants'])
    res = {'default': {}, 'backtrack': {}}
    audio = 0.0
    t_detect = 0.0
    for v in sel:
        y, sr = librosa.load(os.path.join(DRUM, v['wav']), sr=22050, mono=True)
        audio += len(y) / sr
        t0 = time.perf_counter()
        res['default'][v['name']] = [round(float(t), 6) for t in librosa.onset.onset_detect(y=y, sr=sr, units='time')]
        t_detect += time.perf_counter() - t0
        res['backtrack'][v['name']] = [round(float(t), 6) for t in librosa.onset.onset_detect(y=y, sr=sr, units='time', backtrack=True)]
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    json.dump(res, open(out_path, 'w'))
    print(f'{len(sel)} variants, {audio / 60:.1f} audio min; onset_detect (default, after load) {1000 * t_detect / (audio / 60):.0f} ms per audio minute')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
