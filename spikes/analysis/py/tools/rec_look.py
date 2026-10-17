"""Look at the development recordings (R3 look point 2 r3.py, moved here in T17 and anonymized).

Runs the default config (Config()) on every NON-held-out take of rec/manifest.rec.json and writes numbers only
(no chord / key names) to REC_LOOK_DIR/<TAG>.json. Held-out takes are never loaded (manifest heldOut,
common.rec_dev_takes; asserted again per take). Extra diagnostic runs on the same audio (key phrase grid only):
'oracle' = phrase grid from the truth's bar 0 (phrase-bars groups, no section restarts); 'nophrase' = phrase
framing off (T14b behaviour). Not tuning: the code is unchanged.

Every run is a look at the private recordings: log it (run_all-style "rec" line) when LOG=1, with COMMIT=<sha>.
Usage (in the band-sheets-analysis image, from spikes/analysis):
  [TAG=look] [JOBS=3] [LOG=1 COMMIT=<sha>] python py/tools/rec_look.py
"""
import datetime
import json
import os
import sys
import time
from multiprocessing import Pool
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import numpy as np  # noqa: E402
import analyze as A  # noqa: E402
import score as S  # noqa: E402
from dsp import keytrack  # noqa: E402
from dsp.config import Config, config_hash  # noqa: E402

OUT = C.OUT
LOOK_DIR = os.environ.get('REC_LOOK_DIR', os.path.join(OUT, 'rec-look'))
RUNS = ('default', 'oracle', 'nophrase')
_orig_phrases = keytrack.phrases


def bar_offset(truth, result):
    """Result bar index at the truth's first downbeat (result bar j = j-th result downbeat)."""
    td = [b['t'] for b in truth['beats'] if b.get('downbeat')]
    rd = [b['t'] for b in result['beats'] if b.get('downbeat')]
    if not td or not rd:
        return None, None
    j = int(np.argmin([abs(t - td[0]) for t in rd]))
    return j, rd[j] - td[0]


def key_by_bar(result, n):
    runs = S._result_key_runs(result)
    out = []
    for j in range(n):
        cur = None
        for s, tonic, mode in runs:
            if s <= j:
                cur = (tonic, mode)
        out.append(cur)
    return out


def _oracle_phrases(off):
    def ph(bar_of_col, section_bars, n_bars, length, voiced=None):
        if length <= 0 or n_bars <= 0 or off is None:
            return _orig_phrases(bar_of_col, section_bars, n_bars, length, voiced)
        s = off % length
        starts = sorted({0} | set(range(s, n_bars, length)))
        bar_of_col = np.asarray(bar_of_col, dtype=int)
        mask = np.ones(len(bar_of_col), dtype=bool) if voiced is None else np.asarray(voiced, dtype=bool)
        out = []
        for a, z in zip(starts, starts[1:] + [n_bars]):
            cols = np.flatnonzero((bar_of_col >= a) & (bar_of_col < z) & mask)
            if len(cols):
                out.append((int(cols[0]), int(cols[-1])))
        return out
    return ph


def run(item):
    name, wav, truth_rel = item
    assert name not in C.held_out_takes(OUT), 'held-out take requested'
    truth = json.load(open(os.path.join(OUT, truth_rel)))
    t0 = time.perf_counter()
    feat = A.load_features(os.path.join(OUT, wav), Config())
    load = time.perf_counter() - t0
    cfg = Config()
    res, base_off = {}, None
    for k in RUNS:
        tm = {}
        patches = [mock.patch.object(A, 'load_features', return_value=feat)]
        if k == 'oracle':
            patches.append(mock.patch.object(keytrack, 'phrases', _oracle_phrases(base_off)))
        if k == 'nophrase':
            patches.append(mock.patch.object(keytrack, 'phrases',
                                             lambda b, s, n, L, v=None: _orig_phrases(b, s, n, 0, v)))
        for p in patches:
            p.start()
        try:
            r = A.analyze(os.path.join(OUT, wav), cfg, tm)
        finally:
            for p in patches:
                p.stop()
        sc = S.score(truth, r)
        off, dt = bar_offset(truth, r)
        if k == 'default':
            base_off = off
        c, sp, vo = sc['chords'], sc['chords']['split'], sc['chords']['vocab']
        types, pos, q = C.diagnose(truth, r)
        nb = max(int(s['startBar']) for s in r['keys']) + 1 if r.get('keys') else 0
        kb = key_by_bar(r, nb + 64)
        tkeys = [S.parse_key(x['key']) for x in truth.get('keys') or []]
        rds = [b['t'] for b in r['beats'] if b.get('downbeat')]
        res[k] = {'chordBeat': c['perBeat'], 'vocab': vo['perBeat'], 'root': sp['rootPerBeat'],
                  'quality': sp['qualityPerBeat'], 'top3': sp['topKPerBeat'], 'power': sp['powerShare'],
                  'beatF': sc['beats']['f'], 'downF': sc['downbeats']['f'],
                  'keys': sc.get('keys'), 'sectionF': (sc.get('sections') or {}).get('f'),
                  'nKeyRegions': len(r.get('keys') or []),
                  'keyRegionStarts': [int(x['startBar']) for x in r.get('keys') or []],
                  'keyRelToTruth': ([C.key_relation(tkeys[0], tuple(x) if x else None) for x in kb[:nb]]
                                    if len(tkeys) == 1 else None),
                  '_kb': [None if x is None else list(x) for x in kb],
                  'sectionStartBars': ([int(np.argmin([abs(t - x['start']) for t in rds])) for x in r.get('sections') or []]
                                       if rds else []),
                  'barOffset': off, 'barOffsetDt': dt,
                  'nResultDownbeats': sum(1 for b in r['beats'] if b.get('downbeat')),
                  'nTruthDownbeats': sum(1 for b in truth['beats'] if b.get('downbeat')),
                  'types': dict(types), 'pos': {a: dict(b) for a, b in pos.items()},
                  'q': {f'{a}/{b}': v for (a, b), v in q.items()},
                  'nScored': sp['nBeatsScored'], 'estTempo': 60.0 / S._median_interval([b['t'] for b in r['beats']]),
                  'secPerMin': (load + tm['total'] - tm.get('load', 0)) / (float(feat.duration) / 60)}
    for k in RUNS[1:]:  # key output differences per bar (no names)
        a, b = res['default']['_kb'], res[k]['_kb']
        res[k]['nBarsKeyDiffVsDefault'] = sum(1 for x, y in zip(a, b) if x != y)
    for k in res:
        res[k].pop('_kb')
    return name, 'REC', res


def main():
    its = C.rec_dev_takes(OUT)
    os.makedirs(LOOK_DIR, exist_ok=True)
    tag = os.environ.get('TAG', 'look')
    with Pool(int(os.environ.get('JOBS', '3'))) as p:
        rows = p.map(run, its, chunksize=1)
    json.dump(rows, open(os.path.join(LOOK_DIR, tag + '.json'), 'w'), indent=1)
    h = config_hash(Config())
    if os.environ.get('LOG') == '1':
        now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
        with open(os.path.join(OUT, 'results', 'heldout-log.jsonl'), 'a') as f:
            f.write(json.dumps({'time': now, 'kind': 'rec', 'status': 'finished', 'variants': [i[0] for i in its],
                                'commit': os.environ.get('COMMIT'), 'dirty': None, 'diffHash': None,
                                'configHash': h, 'dspName': 'rec-look', 'dspConfig': None, 'includeHeldOut': False,
                                'note': f'py/tools/rec_look.py TAG={tag} (numbers only)'}) + '\n')
    print('done', len(rows), 'hash', h)


if __name__ == '__main__':
    main()
