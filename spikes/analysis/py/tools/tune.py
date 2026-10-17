"""Tuning eval over the development variants (T14 / T14b / T14c tune.py, moved here in T17 and anonymized).

Tuning variants only: L0-L3, LR, LR-hard, M, mod, V, CH (dev charts) — never held-out (manifest / registry
heldOut, see common.dev_variants) and never REC. Prints chart-NN ids and numbers only.

Usage (in the band-sheets-analysis image, from spikes/analysis):
  CONFIGS=configs.json [GROUPS=L0,L1,CHblock] [JOBS=8] [TAG=run] [TUNE_DIR=out/tune] python py/tools/tune.py
CONFIGS is a JSON file {tag: {"cfg": overrides, "tables": {"key_fit": {...}, "harmony": {...},
"eighth_emis": 0.75, "base": {"key_fit": path, "harmony": path}}}}: table entries are deep-merged into the
repository tables (or into the toml files named in "base"). The prefix (everything up to the global key) is
computed once per variant and prefix-equal config; keytrack / the 2nd chord pass are re-run per config.
REAGG=1 aggregates the saved rows of TAG again without analysis. One line per config goes to TUNE_DIR/log.jsonl.
"""
import copy
import hashlib
import json
import os
import sys
import time
import tomllib
from collections import Counter, defaultdict
from multiprocessing import Pool
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402  (puts py/ on sys.path)
import numpy as np  # noqa: E402
import analyze as A  # noqa: E402
import score as S  # noqa: E402
from dsp import chords as CH  # noqa: E402
from dsp import harmony, keytrack, vocab  # noqa: E402
from dsp.config import Config, apply_overrides, config_hash  # noqa: E402

OUT = C.OUT
TUNE_DIR = os.environ.get('TUNE_DIR', os.path.join(OUT, 'tune'))
KT0 = keytrack.load_table()
HT0 = harmony.load_table()
SUFFIX_KEYS = {('chords', 'theory_prior'), ('key', 'change_cost_mid'), ('key', 'change_cost_boundary')}
GROUPS = ('L0', 'L1', 'L2', 'L3', 'LR', 'LRhard', 'M', 'mod', 'V', 'CHblock', 'CHrec', 'CHrechard')
CONFIGS = {}


def deep_update(d, u):
    for k, v in u.items():
        if isinstance(v, dict):
            deep_update(d.setdefault(k, {}), v)
        else:
            d[k] = v
    return d


def set_tables(spec):
    base = spec.get('base', {})
    k0 = tomllib.load(open(base['key_fit'], 'rb')) if 'key_fit' in base else KT0
    h0 = tomllib.load(open(base['harmony'], 'rb')) if 'harmony' in base else HT0
    kt = deep_update(copy.deepcopy(k0), spec.get('key_fit', {}))
    ht = deep_update(copy.deepcopy(h0), spec.get('harmony', {}))
    keytrack.load_table = lambda: kt
    harmony.load_table = lambda: ht
    harmony.tier_matrix.cache_clear()
    CH._EIGHTH_EMIS = float(spec.get('eighth_emis', 0.75))


def prefix_key(ov):
    d = copy.deepcopy(ov)
    for g, k in SUFFIX_KEYS:
        d.get(g, {}).pop(k, None)
    return json.dumps(d, sort_keys=True)


def run_prefix(cfg, feat):
    with mock.patch.object(A, 'load_features', return_value=feat):
        grid = A.track_beats(feat, cfg)
        chroma, bass, bounds, cc, cb, pb = A.chord_columns(feat, grid, cfg)
        col = A.estimate_chords(cc, cfg, feat, cb, per_beat=pb)
        beat_chords = A.beat_level(col, pb)
        downbeats = A.choose_downbeats(feat, grid, A.downbeat_chords(col, chroma, cfg, pb, feat, bounds), bass, cfg)
        segments = A._merge(col, cc, cfg, pb)
        sections = A.find_sections(chroma, grid, downbeats, feat, cfg, bass)
        key = A.estimate_key(chroma, cfg) if cfg.key.enabled else None
    return dict(grid=grid, chroma=chroma, cc=cc, cb=cb, pb=pb, beat_chords=beat_chords, downbeats=downbeats,
                segments=segments, sections=sections, key=key)


def run_suffix(feat, cfg, p):
    bar_of_col = (np.arange(p['chroma'].shape[1]) - p['downbeats'].phase) // p['downbeats'].beats_per_bar
    bar_keys, segments = None, p['segments']
    if cfg.key.track == 'sections':
        bar_keys = keytrack.estimate(p['beat_chords'], bar_of_col, [s.start_bar for s in p['sections']], cfg)
    if cfg.chords.theory_prior > 0:
        pk = bar_keys if bar_keys is not None else A._global_bar_keys(p['key'], bar_of_col)
        prior = harmony.transition(vocab.states(cfg), pk, bar_of_col, cfg)
        col = A.estimate_chords(p['cc'], cfg, feat, p['cb'], prior, per_beat=p['pb'])
        segments = A._merge(col, p['cc'], cfg, p['pb'])
    return A.build_result(feat, p['grid'], segments, p['downbeats'], p['sections'], p['key'], cfg, {'total': 0},
                          bar_keys)


def metrics(t, r, keyed):
    sc = S.score(t, r)
    c, sp = sc['chords'], sc['chords']['split']
    ks = (sc.get('keys') or {}) if keyed else {}  # the etude has no real key: saints / charts only
    nreg = len(r.get('keys') or []) if keyed else 0
    return {'scored': c['nBeatsScored'], 'hit': c['nBeatsHit'],
            **{x: sp[x] for x in ('nBeatsScored', 'nBeatsRootHit', 'nBeatsQualityScored', 'nBeatsQualityHit',
                                  'nBeatsTopKHit')},
            'dbf': sc['downbeats']['f'] or 0, 'secf': (sc['sections'] or {}).get('f'),
            'keyBars': ks.get('nBars', 0), 'keyHit': ks.get('nBarsHit', 0),
            'chRef': ks.get('nChangeRef', 0), 'chEst': ks.get('nChangeEst', 0), 'chHit': ks.get('nChangeHit', 0),
            'nKeyRegions': nreg, 'keyed': int(keyed)}


def run(item):
    name, grp, song, wav, truth = item
    keyed = song in ('saints', 'chart')
    t = json.load(open(os.path.join(OUT, truth)))
    feat = A.load_features(os.path.join(OUT, wav), Config())
    res, pre = {}, {}
    for tag, spec in CONFIGS.items():
        set_tables(spec.get('tables', {}))
        cfg = apply_overrides(Config(), spec['cfg'])
        pk = prefix_key(spec['cfg']) + json.dumps(spec.get('tables', {}).get('eighth_emis'))
        if pk not in pre:
            pre[pk] = run_prefix(cfg, feat)
        res[tag] = metrics(t, run_suffix(feat, cfg, pre[pk]), keyed)
    return name, grp, res


def aggregate(rows):
    agg, fl, nvar = defaultdict(Counter), defaultdict(lambda: defaultdict(list)), Counter()
    for name, grp, res in rows:
        nvar[grp] += 1
        for k, m in res.items():
            agg[(grp, k)].update({x: (v or 0) for x, v in m.items() if x not in ('dbf', 'secf')})
            for x in ('dbf', 'secf'):
                if m[x] is not None:
                    fl[(grp, k)][x].append(m[x])
    out = {}
    for (grp, k), m in agg.items():
        f = fl[(grp, k)]

        def q(a, b):
            return m[a] / m[b] if m[b] else None
        out.setdefault(k, {})[grp] = {
            'n': nvar[grp], 'chord': q('hit', 'scored'), 'root': q('nBeatsRootHit', 'nBeatsScored'),
            'quality': q('nBeatsQualityHit', 'nBeatsQualityScored'), 'top3': q('nBeatsTopKHit', 'nBeatsScored'),
            'keybar': q('keyHit', 'keyBars'), 'dbf': float(np.mean(f['dbf'])) if f['dbf'] else None,
            'secf': float(np.mean(f['secf'])) if f['secf'] else None,
            'keyChangeF': (2 * m['chHit'] / (m['chRef'] + m['chEst'])) if (m['chRef'] + m['chEst']) else None,
            'keyChEst': m['chEst'], 'keyChRef': m['chRef'],
            'keyRegionsPerSong': m['nKeyRegions'] / m['keyed'] if m['keyed'] else None}
    return out


def objective(g):
    terms = [g[x][y] for x in ('CHrec', 'CHrechard', 'LRhard') for y in ('chord', 'top3') if x in g]
    terms += [g['CH']['keybar'] if 'CH' in g else None, g['mod']['keybar'] if 'mod' in g else None]
    terms = [x for x in terms if x is not None]
    return float(np.mean(terms)) if terms else None


def main():
    global CONFIGS
    CONFIGS.update(json.load(open(os.environ['CONFIGS'])))
    groups = os.environ['GROUPS'].split(',') if os.environ.get('GROUPS') else None
    items = C.dev_variants(OUT, groups)
    os.makedirs(TUNE_DIR, exist_ok=True)
    t0 = time.time()
    tag = os.environ.get('TAG', 'run')
    rows_path = os.path.join(TUNE_DIR, tag + '.rows.json')
    if os.environ.get('REAGG'):
        rows = json.load(open(rows_path))
    else:
        with Pool(int(os.environ.get('JOBS', '8'))) as p:
            rows = p.map(run, items, chunksize=1)
        json.dump(rows, open(rows_path, 'w'))
    rows_ch = [(n, 'CH', r) for n, g, r in rows if g.startswith('CH')]  # pooled CH key/bar over all dev CH
    agg = aggregate(rows + rows_ch)
    with open(os.path.join(TUNE_DIR, 'log.jsonl'), 'a') as log:
        for k, spec in CONFIGS.items():
            cfg = apply_overrides(Config(), spec['cfg'])
            h = config_hash(cfg) + '+' + hashlib.sha256(
                json.dumps(spec.get('tables', {}), sort_keys=True).encode()).hexdigest()[:6]
            log.write(json.dumps({'run': tag, 'tag': k, 'configHash': h, 'cfg': spec['cfg'],
                                  'tables': spec.get('tables', {}), 'objective': objective(agg.get(k, {})),
                                  'groups': agg.get(k, {}), 'heldOut': 0, 'rec': 0, 'nVariants': len(items)}) + '\n')
    print(f'{len(items)} variants, {time.time() - t0:.0f}s')
    cols = ('chord', 'root', 'quality', 'top3', 'keybar', 'dbf', 'secf', 'keyChangeF', 'keyRegionsPerSong')

    def f(v):
        return '-' if v is None else f'{v:.3f}'
    print('| config | obj | group | n | ' + ' | '.join(cols) + ' |')
    for k in CONFIGS:
        for grp in GROUPS + ('CH',):
            if grp in agg.get(k, {}):
                g = agg[k][grp]
                print(f"| {k} | {f(objective(agg[k]))} | {grp} | {g['n']} | "
                      + ' | '.join(f(g[c]) for c in cols) + ' |')


if __name__ == '__main__':
    main()
