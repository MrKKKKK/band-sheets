"""The single held-out evaluation (T15 look point 3 t15.py, moved here in T17 and anonymized).

ONE run of run_all.run_all(out, include_held_out=True) with the frozen default config (= `python py/run_all.py
--include-held-out --commit <sha>`), plus per-variant timings and audio durations (speed). Never re-run for the
same config: the held-out data may be looked at once per frozen config (results/heldout-log.jsonl warns).
Numbers only -> HELDOUT_DIR/timings.json; then heldout_metrics.py summarizes the stored results.

Usage (in the band-sheets-analysis image, from spikes/analysis):
  python py/tools/heldout_eval.py --expect-hash <config hash> --commit <sha>[-dirty]
--expect-hash guards against evaluating a config other than the frozen one.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import soundfile as sf  # noqa: E402
import run_all as R  # noqa: E402
from dsp.config import Config, config_hash  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--expect-hash', required=True, help='config_hash(Config()) of the frozen defaults')
    ap.add_argument('--commit', default=None, help='commit of the code (passed to run_all; required without .git)')
    ap.add_argument('--out', default=C.OUT)
    a = ap.parse_args(argv)
    h = config_hash(Config())
    if h != a.expect_hash:
        print(f'config hash {h} != expected {a.expect_hash}: refusing to run')
        return 2
    d = os.environ.get('HELDOUT_DIR', os.path.join(a.out, 'heldout-eval'))
    os.makedirs(d, exist_ok=True)
    t0 = time.perf_counter()
    rows, timings = R.run_all(a.out, include_held_out=True, commit=a.commit)
    total = time.perf_counter() - t0
    dur = {}
    for v in R.load_variants(a.out):
        p = os.path.join(a.out, v['wav'])
        if os.path.exists(p):
            dur[v['name']] = sf.info(p).duration
    json.dump({'totalSec': total, 'configHash': h, 'timings': {f'{x}|{y}': t for (x, y), t in timings.items()},
               'durations': dur}, open(os.path.join(d, 'timings.json'), 'w'), indent=1)
    print('done rows', len(rows), 'total', round(total, 1), 'hash', h)
    return 0


if __name__ == '__main__':
    sys.exit(main())
