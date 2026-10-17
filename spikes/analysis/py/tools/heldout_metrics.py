"""Metrics from the stored results of a run_all run (T15 metrics.py, moved here in T17 and anonymized).

No analysis here: reads out/results/<variant>.dsp-v1.json and HELDOUT_DIR/timings.json (heldout_eval.py), writes
numbers only to HELDOUT_DIR/metrics.json and prints group means (dev / held x level) and the REC / held-out CH rows
by anonymous id.

Usage (in the band-sheets-analysis image, from spikes/analysis):  python py/tools/heldout_metrics.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import run_all as R  # noqa: E402

KEYS = ['chordBeat', 'vocab', 'root', 'top3', 'beatF', 'downbeatF', 'sectionF', 'keyPerBar', 'keyNearPerBar',
        'nKeyRegions', 'nKeyRegionsTruth', 'lowShare', 'lowErr', 'sureErr', 'secPerMin']


def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 3) if xs else None


def collect(out, tim):
    rows = {}
    for v in R.load_variants(out):
        p = os.path.join(out, 'results', f"{v['name']}.dsp-v1.json")
        if not os.path.exists(p):
            continue
        d = json.load(open(p))
        res, sc = d['result'], d['score']
        truth = json.load(open(os.path.join(out, v['truth'])))
        c = sc.get('chords') or {}
        sp, vo = c.get('split') or {}, c.get('vocab') or {}
        _, _, q = C.diagnose(truth, res)
        lo = q.get(('low', 'ok'), 0) + q.get(('low', 'err'), 0)
        su = q.get(('sure', 'ok'), 0) + q.get(('sure', 'err'), 0)
        k = sc.get('keys') or {}
        t = tim.get('timings', {}).get(f"{v['name']}|dsp-v1")
        du = tim.get('durations', {}).get(v['name'])
        rows[v['name']] = {
            'level': v['level'], 'heldOut': v['heldOut'],
            'chordBeat': c.get('perBeat'), 'vocab': vo.get('perBeat'), 'root': sp.get('rootPerBeat'),
            'top3': sp.get('topKPerBeat'), 'beatF': (sc.get('beats') or {}).get('f'),
            'downbeatF': (sc.get('downbeats') or {}).get('f'), 'sectionF': (sc.get('sections') or {}).get('f'),
            'keyPerBar': k.get('perBar'), 'keyNearPerBar': k.get('nearPerBar'),
            'nKeyRegions': len(res.get('keys') or []), 'nKeyRegionsTruth': len(truth.get('keys') or []) or None,
            'lowShare': lo / (lo + su) if lo + su else None,
            'lowErr': q.get(('low', 'err'), 0) / lo if lo else None,
            'sureErr': q.get(('sure', 'err'), 0) / su if su else None,
            'secPerMin': t / (du / 60) if t and du else None}
    return rows


def main():
    out = C.OUT
    d = os.environ.get('HELDOUT_DIR', os.path.join(out, 'heldout-eval'))
    tp = os.path.join(d, 'timings.json')
    tim = json.load(open(tp)) if os.path.exists(tp) else {}
    rows = collect(out, tim)
    os.makedirs(d, exist_ok=True)
    json.dump(rows, open(os.path.join(d, 'metrics.json'), 'w'), indent=1)
    groups = {}
    for r in rows.values():
        groups.setdefault(('held' if r['heldOut'] else 'dev', r['level']), []).append(r)
    print('group n ' + ' '.join(KEYS))
    for g in sorted(groups):
        print(g, len(groups[g]), [mean([r[x] for r in groups[g]]) for x in KEYS])
    for n in sorted(rows):
        if rows[n]['level'] in ('REC', 'CH') and (rows[n]['heldOut'] or rows[n]['level'] == 'REC'):
            print(n, [None if rows[n][x] is None else round(rows[n][x], 3) for x in KEYS])


if __name__ == '__main__':
    main()
