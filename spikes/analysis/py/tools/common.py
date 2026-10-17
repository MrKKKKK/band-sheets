"""Shared helpers for the spike 2 evaluation tools in py/tools (T17: moved from gitignored out/ scratch, anonymized).

Privacy: the tools print / write only variant ids (chart-NN, rec-NN-x, synthetic names) and numbers; never titles,
chords, keys or lyrics. Held-out data is excluded through the manifests' `heldOut` flags (and the chart registry's
`heldOut` / `excluded` entries when the private registry is present), never through hardcoded ids.
"""
import json
import os
import sys
from collections import Counter, defaultdict

PY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(PY)  # spikes/analysis
if PY not in sys.path:
    sys.path.insert(0, PY)

import score as S  # noqa: E402

OUT = os.environ.get('BAND_SHEETS_OUT', os.path.join(ROOT, 'out'))
MANIFESTS = ('manifest.json', 'derived/manifest.derived.json', 'derived/manifest.trim.json',
             'rec/manifest.rec.json', 'charts/manifest.charts.json')
CHART_REGISTRY = os.path.join(ROOT, 'recordings', 'charts', 'ids.local.json')


def _entries(out, rel):
    p = os.path.join(out, rel)
    if not os.path.exists(p):
        return []
    d = json.load(open(p))
    return d['variants'] if isinstance(d, dict) else d


def take_of(v):
    """Take / song id a variant belongs to (manifest `take`, else `base`, else its own name)."""
    return v.get('take') or v.get('base') or v['name']


def held_out_takes(out=OUT, registry=CHART_REGISTRY):
    """Ids whose variants must never be used for tuning or dev looks: every take / base / name of a manifest entry
    with heldOut, plus the chart registry's heldOut ids (whether or not they are excluded)."""
    held = set()
    for rel in MANIFESTS:
        for v in _entries(out, rel):
            if v.get('heldOut'):
                held |= {v['name'], take_of(v)}
    if registry and os.path.exists(registry):
        for cid, e in json.load(open(registry, encoding='utf-8')).get('charts', {}).items():
            if e.get('heldOut'):
                held.add(cid)
    return held


def is_held_out(v, held):
    return bool(v.get('heldOut')) or v['name'] in held or take_of(v) in held or \
        any(v['name'].startswith(h + '-') for h in held)


def truth_path(v):
    return v.get('truth') or os.path.splitext(v['wav'])[0] + '.truth.json'


def dev_variants(out=OUT, groups=None):
    """(name, group, song, wav, truth) of every tuning variant: L0-L3, LR, LRhard, M, mod, V, CHblock/CHrec/CHrechard.
    Never held-out, never REC. `groups` (iterable) keeps only those groups."""
    held = held_out_takes(out)
    rows = []
    for rel in MANIFESTS:
        for v in _entries(out, rel):
            lvl = str(v.get('level', 0))
            if lvl == 'REC' or is_held_out(v, held):
                continue
            if lvl == 'CH':
                grp = 'CH' + v['name'].rsplit('-', 1)[1]  # CHblock / CHrec / CHrechard
            elif v.get('private') or lvl not in ('0', '1', '2', '3', 'LR', 'M', 'V'):
                continue
            elif '-mod' in v['name']:
                grp = 'mod'
            elif lvl == 'LR':
                grp = 'LRhard' if v['name'].endswith('rec-hard') else 'LR'
            else:
                grp = 'L' + lvl if lvl.isdigit() else lvl
            rows.append((v['name'], grp, v.get('song', ''), v['wav'], truth_path(v)))
    if groups:
        keep = set(groups)
        rows = [r for r in rows if r[1] in keep]
    return rows


def rec_dev_takes(out=OUT):
    """(name, wav, truth) of the development (non-held-out) recordings, from rec/manifest.rec.json."""
    held = held_out_takes(out)
    return [(v['name'], v['wav'], truth_path(v)) for v in _entries(out, 'rec/manifest.rec.json')
            if not is_held_out(v, held)]


def key_relation(a, b):
    """Relation of two keys (tonic pc, mode) without naming them."""
    if a is None or b is None:
        return 'none'
    (ta, ma), (tb, mb) = a, b
    d = (tb - ta) % 12
    if a == b:
        return 'same'
    if ma != mb and ((ma == 'major' and d == 9) or (ma == 'minor' and d == 3)):
        return 'relative'
    if ma != mb and d == 0:
        return 'parallel'
    if ma == mb and d in (5, 7):
        return 'fifth'
    return 'other'


def classify(tr, tcls, r):
    """Error type of a result chord against a truth (root pc, triad class), by interval only (no names)."""
    if r is None:
        return 'nochord'
    rq = S.map_vocab(r['quality'])
    rr = S.note_to_pc(r['root'])
    rcls = None if rq is None else S.vocab_triad(rq)
    d = (rr - tr) % 12
    if d == 0:
        if rcls == tcls:
            return 'hit'
        return 'power' if rcls == '5' else 'parallel'
    if (tcls == 'maj' and rcls == 'min' and d == 9) or (tcls == 'min' and rcls == 'maj' and d == 3):
        return 'relative'
    if d == 7:
        return 'fifthUp'
    if d == 5:
        return 'fifthDown'
    if d in (3, 4, 8, 9):
        return 'other:third'
    if d in (1, 2, 10, 11):
        return 'other:step'
    return 'other:tritone'


def diagnose(truth, result):
    """-> (error types, error positions, low-confidence split) counted per scoring point (2 per beat, 0.5 each)."""
    tt, rt = S._ChordTrack(truth['chords']), S._ChordTrack(result['chords'])
    wins = S._beat_windows(truth['beats'])
    bi, beat_idx = -1, []
    for w in wins:
        bi = 0 if w[1] else (bi + 1 if bi >= 0 else -1)
        beat_idx.append(bi)
    starts = sorted({c['start'] for c in tt.chords})
    med = S._median_interval([w[0] for w in wins])
    types, pos, q = Counter(), defaultdict(Counter), Counter()

    def key(c):
        return c and S.map_vocab(c['quality']) and (S.note_to_pc(c['root']), S.vocab_triad(S.map_vocab(c['quality'])))

    for i, (t0, _, _, t1) in enumerate(wins):
        for half, f in (('on', 0.25), ('off', 0.75)):
            tm = t0 + f * (t1 - t0)
            t = tt.at(tm)
            if t is None:
                continue
            tq = S.map_vocab(t['quality'])
            if tq is None:
                continue
            tr, tcls = S.note_to_pc(t['root']), S.vocab_triad(tq)
            r = rt.at(tm)
            typ = classify(tr, tcls, r)
            err = typ != 'hit'
            types[typ] += 0.5
            near = any(abs(tm - s) <= med for s in starts if s > tt.chords[0]['start'] + 1e-6)
            lagtag = ''
            if err and r is not None:  # lag / early: the result equals the previous / next truth chord
                rk = (S.note_to_pc(r['root']), S.vocab_triad(S.map_vocab(r['quality']) or 'maj'))
                prev, nxt = tt.at(t['start'] - 1e-3), tt.at(t['end'] + 1e-3)
                if prev is not None and key(prev) == rk:
                    lagtag = 'late'
                elif nxt is not None and key(nxt) == rk:
                    lagtag = 'early'
            pos['near' if near else 'mid']['err' if err else 'ok'] += 0.5
            if err:
                pos['near' if near else 'mid'][typ] += 0.5
                if lagtag:
                    pos['lag'][lagtag] += 0.5
            b = beat_idx[i]
            pos[f'beat{b}{half}' if b >= 0 else 'pickup']['err' if err else 'ok'] += 0.5
            low = r is not None and str(r.get('text', '')).endswith('?')
            q[('low' if low else 'sure', 'err' if err else 'ok')] += 0.5
    return types, pos, q
