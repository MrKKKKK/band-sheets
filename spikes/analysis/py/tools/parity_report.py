"""Spike 3 T15/T19: compare two result sets (Python vs TS analyzer): direct JSON comparison + score.py table.

Usage (from spikes/analysis; imports score.py / common.py, which need numpy, so run it in the analysis image):
    python3 py/tools/parity_report.py [--py out/results] [--ts out/ts-results] [-o out/parity-report.md]
                                      [--py-label Python] [--ts-label TS] [--only GLOB[,GLOB...]]
                                      [--time-tol 1e-6] [--float-tol 1e-4] [--allow VARIANT=REASON ...]
Exit code 1 if any (non-allowed) variant exceeds a tolerance, in the direct comparison or in the score table.

Inputs: a result directory holds one JSON per variant, `<variant>.dsp-v1.json` (run_all.py; {"result", "score"}) or
`<variant>.json` (ts/cli.ts; the bare result). Both sides are RE-SCORED here with score.py against the truth, so the
scorer is identical. Variants = the tuning (dev) variants of tools/common.dev_variants (no held-out, no REC) that
exist on both sides.

Direct comparison (T19): the two result JSONs of each variant are compared field by field, everything except
`analyzer.timingsSec`. Structure, strings, booleans and integers must be equal; times (t / start / end / durationSec)
within --time-tol seconds; every other float (confidences, probabilities, ...) within --float-tol. This covers fields
the scorer never sees (e.g. per-bar keys where there is no truth). Reported per variant: the first differing path.
For CH variants only the path (no values) is printed. --allow VARIANT=REASON waives one variant (the reason is
printed; nothing is waived silently).

Output: per-level means (Python / TS / diff) of the metrics, the §4 tolerance check per variant (docs/audio-spike3-plan.md),
the number of variants whose tempo differs, and a per-variant table. CH variants (private charts) are reported as
aggregates only: per-variant rows are left out and exceeding ones are listed by chart-NN id with the metric name only.

Tempo-bin proxy: the result JSON has no tempo bin, so "tempo differs" = the median beat interval (BPM) differs by more
than TEMPO_REL (0.5 %) or the beat counts differ. Exact bins come from the stage dumps (tools/dump_stages.py).
`?` agreement: share of 10 ms grid points where both sides agree on "chord text ends with ?"; a disagreement counts
as explained when both confidences are inside LOWCONF +- 0.02 (plan §4).
"""
import argparse
import bisect
import fnmatch
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import score as S  # noqa: E402

TEMPO_REL = 0.005
LOWCONF = 0.93
LOWCONF_BAND = 0.02
GRID = 0.01

# (key, label, getter(score), per-variant tolerance or None = record only)
METRICS = [
    ('chord_beat', 'chord/beat', lambda s: _g(s, 'chords', 'perBeat'), 0.02),
    ('top3', 'top-3', lambda s: _g(s, 'chords', 'split', 'topKPerBeat'), None),
    ('vocab', 'vocab chord', lambda s: _g(s, 'chords', 'vocab', 'perBeat'), 0.02),
    ('beat_f', 'beat F', lambda s: _g(s, 'beats', 'f'), 0.01),
    ('down_f', 'downbeat F', lambda s: _g(s, 'downbeats', 'f'), 0.01),
    ('section_f', 'section F', lambda s: _g(s, 'sections', 'f'), None),
    ('key_bar', 'key/bar', lambda s: _g(s, 'keys', 'perBar'), 0.03),
    ('key_reg', 'key regions', lambda s: _g(s, 'keys', 'changeF'), None),
]
TIME_TOL = 1e-6
TIME_TOL_USED = [TIME_TOL]  # set by main() for the report header
FLOAT_TOL_USED = [1e-4]
FLOAT_TOL = 1e-4
TIME_KEYS = ('t', 'start', 'end', 'durationSec')
IGNORED_PATHS = ('.analyzer.timingsSec',)
AVG_TOL = {'chord_beat': 0.005, 'vocab': 0.005, 'section_f': 0.05}


def _g(d, *path):
    for p in path:
        if not isinstance(d, dict):
            return None
        d = d.get(p)
    return d


def _isint(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _isnum(x):
    return (_isint(x) or isinstance(x, float))


def compare_results(a, b, time_tol=TIME_TOL, float_tol=FLOAT_TOL):
    """Direct deep comparison of two result dicts. Returns {'diffs': [(path, kind, a, b)], 'maxTime', 'maxFloat'}.

    kind: 'type' | 'keys' | 'length' | 'value' (exact mismatch) | 'time' | 'float' (over tolerance).
    diffs are in document order, so diffs[0] is the first differing path."""
    diffs = []
    mx = {'maxTime': 0.0, 'maxFloat': 0.0}

    def walk(x, y, path, key):
        if path in IGNORED_PATHS:
            return
        if _isnum(x) and _isnum(y):
            if _isint(x) and _isint(y) and key not in TIME_KEYS:
                if x != y:
                    diffs.append((path, 'value', x, y))
                return
            if x != x and y != y:
                return
            d = abs(x - y)
            if key in TIME_KEYS:
                mx['maxTime'] = max(mx['maxTime'], d)
                if not d <= time_tol:
                    diffs.append((path, 'time', x, y))
            else:
                mx['maxFloat'] = max(mx['maxFloat'], d)
                if not d <= float_tol:
                    diffs.append((path, 'float', x, y))
            return
        if isinstance(x, dict) and isinstance(y, dict):
            if set(x) != set(y):
                diffs.append((path, 'keys', sorted(set(x) ^ set(y)), None))
            for k in x:
                if k in y:
                    walk(x[k], y[k], f'{path}.{k}', k)
            return
        if isinstance(x, list) and isinstance(y, list):
            if len(x) != len(y):
                diffs.append((path, 'length', len(x), len(y)))
                return  # elements would be misaligned
            for i, (u, v) in enumerate(zip(x, y)):
                walk(u, v, f'{path}[{i}]', key)
            return
        if type(x) is not type(y) and not (_isnum(x) and _isnum(y)):
            diffs.append((path, 'type', type(x).__name__, type(y).__name__))
        elif x != y:
            diffs.append((path, 'value', x, y))

    walk(a, b, '', None)
    return {'diffs': diffs, **mx}


def load_result(dirpath, name):
    for fn in (f'{name}.dsp-v1.json', f'{name}.json'):
        p = os.path.join(dirpath, fn)
        if os.path.exists(p):
            with open(p) as f:
                d = json.load(f)
            return d['result'] if isinstance(d, dict) and 'result' in d else d
    return None


def median_bpm(result):
    ts = sorted(b['t'] for b in result.get('beats') or [])
    if len(ts) < 2:
        return None
    iv = sorted(b - a for a, b in zip(ts, ts[1:]))
    return 60.0 / iv[len(iv) // 2]


def tempo_differs(a, b):
    ba, bb = median_bpm(a), median_bpm(b)
    if ba is None or bb is None:
        return ba != bb
    return abs(ba - bb) / ba > TEMPO_REL or len(a['beats']) != len(b['beats'])


def beat_match(a, b, tol=0.005):
    """Share of a's beats with a b beat within tol seconds; downbeats equal in count and within 50 ms."""
    ta = [x['t'] for x in a.get('beats') or []]
    tb = sorted(x['t'] for x in b.get('beats') or [])
    hit = 0
    for t in ta:
        i = bisect.bisect_left(tb, t)
        d = min((abs(tb[j] - t) for j in (i - 1, i) if 0 <= j < len(tb)), default=1e9)
        hit += d <= tol
    da = [x['t'] for x in a.get('beats') or [] if x.get('downbeat')]
    db = [x['t'] for x in b.get('beats') or [] if x.get('downbeat')]
    phase = len(da) == len(db) and all(abs(x - y) < 0.05 for x, y in zip(da, db))
    return (hit / len(ta) if ta else None), phase


def _q_track(chords):
    return [(c['start'], c['end'], str(c.get('text', '')).endswith('?'), c.get('confidence')) for c in chords]


def _at(track, starts, t):
    i = bisect.bisect_right(starts, t) - 1
    if i >= 0 and t < track[i][1]:
        return track[i]
    return None


def question_stats(a, b):
    """(ratio_a, ratio_b, agreement, unexplained) over a 10 ms grid of the chord time; `?` = low-confidence mark."""
    ta, tb = _q_track(a.get('chords') or []), _q_track(b.get('chords') or [])
    if not ta or not tb:
        return None, None, None, None
    sa, sb = [x[0] for x in ta], [x[0] for x in tb]
    end = max(ta[-1][1], tb[-1][1])
    n = int(end / GRID)
    qa = qb = same = unexpl = 0
    for k in range(n):
        t = (k + 0.5) * GRID
        ca, cb = _at(ta, sa, t), _at(tb, sb, t)
        fa, fb = bool(ca and ca[2]), bool(cb and cb[2])
        qa += fa
        qb += fb
        if fa == fb:
            same += 1
        else:
            near = all(c is not None and c[3] is not None and abs(c[3] - LOWCONF) <= LOWCONF_BAND for c in (ca, cb))
            unexpl += not near
    return qa / n, qb / n, same / n, unexpl / n


def row_for(name, truth, ra, rb, time_tol=TIME_TOL, float_tol=FLOAT_TOL):
    sa, sb = S.score(truth, ra), S.score(truth, rb)
    row = {'name': name, 'm': {k: (g(sa), g(sb)) for k, _, g, _ in METRICS}}
    row['q'] = question_stats(ra, rb)
    row['beat5'], row['phase'] = beat_match(ra, rb)
    row['tempo'] = tempo_differs(ra, rb)
    row['direct'] = compare_results(ra, rb, time_tol, float_tol)
    return row


def exceeded(row):
    """List of exceeded §4 tolerances of one variant (metric names only)."""
    out = []
    for k, label, _, tol in METRICS:
        a, b = row['m'][k]
        if tol is not None and a is not None and b is not None and abs(a - b) > tol + 1e-9:
            out.append(label)
        elif tol is not None and (a is None) != (b is None):
            out.append(label + ' (one side missing)')
    dd = row.get('direct')
    if dd and dd['diffs']:
        out.append(f'direct: {len(dd["diffs"])} differing fields, first {dd["diffs"][0][0]} ({dd["diffs"][0][1]})')
    if not row['phase']:
        out.append('downbeat phase')
    if row['beat5'] is not None and row['beat5'] < 0.99:
        out.append('beat +-5 ms < 99 %')
    q = row['q']
    if q[2] is not None and q[2] < 0.95:
        out.append('? agreement < 95 %')
    elif q[3] is not None and q[3] > 1e-9:
        out.append('? differs outside 0.93+-.02')
    return out


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def f3(x):
    return '-' if x is None else f'{x:.3f}'


def fd(a, b):
    return '-' if a is None or b is None else f'{b - a:+.3f}'


def group_of(g):
    if g.startswith('CH'):
        return 'CH'
    return g


def level_key(g):
    order = ['L0', 'L1', 'L2', 'L3', 'LR', 'LRhard', 'M', 'V', 'mod', 'CH']
    return order.index(g) if g in order else len(order)


def build(out_dir, py_dir, ts_dir, only=None, time_tol=TIME_TOL, float_tol=FLOAT_TOL):
    rows, missing = [], []
    for name, grp, _song, _wav, truth in common.dev_variants(out_dir):
        if only and not any(fnmatch.fnmatch(name, g) for g in only):
            continue
        ra, rb = load_result(py_dir, name), load_result(ts_dir, name)
        if ra is None or rb is None:
            missing.append(anon(name, grp))
            continue
        with open(os.path.join(out_dir, truth)) as f:
            tr = json.load(f)
        r = row_for(name, tr, ra, rb, time_tol, float_tol)
        r['group'] = group_of(grp)
        rows.append(r)
    return rows, missing


def anon(name, grp):
    if grp.startswith('CH'):
        m = re.match(r'(chart-\d+)', name)
        return m.group(1) if m else 'chart'
    return name


def fmt_diff(d, private):
    path, kind, x, y = d
    if private:
        return f'{path} ({kind})'
    return f'{path} ({kind}: {x!r} vs {y!r})'


def render(rows, missing, la, lb, allow=None):
    allow = allow or {}
    L = []
    groups = sorted({r['group'] for r in rows}, key=level_key)
    L += [f'# Parity: {la} vs {lb}', '',
          f'variants compared: {len(rows)}; missing on a side: {len(missing)}', '',
          '## Per level (means; diff = ' + f'{lb} - {la})', '']
    head = ['level', 'n', 'metric', la, lb, 'diff']
    L += ['| ' + ' | '.join(head) + ' |', '|' + '|'.join(['---'] * len(head)) + '|']
    for g in groups + ['ALL']:
        rs = rows if g == 'ALL' else [r for r in rows if r['group'] == g]
        for k, label, _, _ in METRICS:
            a, b = mean(r['m'][k][0] for r in rs), mean(r['m'][k][1] for r in rs)
            L.append(f'| {g} | {len(rs)} | {label} | {f3(a)} | {f3(b)} | {fd(a, b)} |')
        qa, qb = mean(r['q'][0] for r in rs), mean(r['q'][1] for r in rs)
        L.append(f'| {g} | {len(rs)} | ? ratio | {f3(qa)} | {f3(qb)} | {fd(qa, qb)} |')
        L.append(f'| {g} | {len(rs)} | ? agreement | - | {f3(mean(r["q"][2] for r in rs))} | - |')
        L.append(f'| {g} | {len(rs)} | tempo differs | - | {sum(r["tempo"] for r in rs)} | - |')
    L += ['', f'## Tempo differs (proxy: median beat BPM > {TEMPO_REL * 100:.1f} % or beat counts differ)', '']
    td = [r for r in rows if r['tempo']]
    L.append(f'{len(td)} of {len(rows)} variants: ' +
             (', '.join(anon(r['name'], r['group']) if r['group'] == 'CH' else r['name'] for r in td) or 'none'))
    L += ['', '## Beat grid', '',
          f'beats within 5 ms (min over variants): {f3(min((r["beat5"] for r in rows if r["beat5"] is not None), default=None))}; '
          f'downbeat phase differs in {sum(not r["phase"] for r in rows)} variants', '']
    L += ['## Tolerance check (plan §4, per variant; record-only metrics are not checked)', '']
    avg_bad = []
    for k, tol in AVG_TOL.items():
        a, b = mean(r['m'][k][0] for r in rows), mean(r['m'][k][1] for r in rows)
        if a is not None and b is not None and abs(a - b) > tol + 1e-9:
            avg_bad.append(f'{k}: {f3(a)} vs {f3(b)} (tol {tol})')
    L.append('overall-mean tolerance: ' + ('; '.join(avg_bad) or 'all within'))
    L.append('')
    bad = [(r, exceeded(r)) for r in rows]
    bad = [(r, e) for r, e in bad if e]
    waived = [(r, e) for r, e in bad if r['name'] in allow]
    bad = [(r, e) for r, e in bad if r['name'] not in allow]
    L.append(f'variants over tolerance: {len(bad)} of {len(rows)}' + (f' (+{len(waived)} waived by --allow)' if waived else ''))
    L.append('')
    for r, e in bad:
        nm = anon(r['name'], r['group']) if r['group'] == 'CH' else r['name']
        det = ', '.join(f'{x}' for x in e)
        L.append(f'- {nm} [{r["group"]}]: {det}')
    for r, e in waived:
        L.append(f'- WAIVED {r["name"]} [{r["group"]}]: {", ".join(e)} -- reason: {allow[r["name"]]}')
    L += ['', f'## Direct comparison of the result JSONs (all fields except analyzer.timingsSec; times +-{TIME_TOL_USED[0]:g} s, '
          f'other floats +-{FLOAT_TOL_USED[0]:g})', '']
    dbad = [r for r in rows if r['direct']['diffs']]
    L.append(f'variants compared: {len(rows)}; identical within tolerance: {len(rows) - len(dbad)}; differing: {len(dbad)}')
    L.append(f'max time diff {max((r["direct"]["maxTime"] for r in rows), default=0):.3g} s; '
             f'max other float diff {max((r["direct"]["maxFloat"] for r in rows), default=0):.3g}')
    L.append('')
    for r in dbad:
        nm = anon(r['name'], r['group']) if r['group'] == 'CH' else r['name']
        dd = r['direct']['diffs']
        tag = f' [WAIVED: {allow[r["name"]]}]' if r['name'] in allow else ''
        L.append(f'- {nm} [{r["group"]}]{tag}: {len(dd)} fields; first {fmt_diff(dd[0], r["group"] == "CH")}')
    L += ['', '## Per variant (non-CH; cells are Python / TS)', '']
    head = ['variant', 'level'] + [lbl for _, lbl, _, _ in METRICS] + ['? ratio', '? agree', 'tempo']
    L += ['| ' + ' | '.join(head) + ' |', '|' + '|'.join(['---'] * len(head)) + '|']
    for r in sorted((r for r in rows if r['group'] != 'CH'), key=lambda r: (level_key(r['group']), r['name'])):
        cells = [f'{f3(r["m"][k][0])} / {f3(r["m"][k][1])}' for k, *_ in METRICS]
        L.append('| ' + ' | '.join([r['name'], r['group']] + cells +
                                    [f'{f3(r["q"][0])} / {f3(r["q"][1])}', f3(r['q'][2]), 'DIFF' if r['tempo'] else '=']) + ' |')
    L.append('')
    return '\n'.join(L)


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    out_default = os.path.join(os.path.dirname(os.path.dirname(here)), 'out')
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--out-dir', default=out_default, help='spikes/analysis/out (manifests + truth)')
    ap.add_argument('--py', help='Python results dir (default <out>/results)')
    ap.add_argument('--ts', help='TS results dir (default <out>/ts-results)')
    ap.add_argument('--py-label', default='Python')
    ap.add_argument('--ts-label', default='TS')
    ap.add_argument('--only', help='comma list of globs on variant names')
    ap.add_argument('--time-tol', type=float, default=TIME_TOL, help='direct comparison: seconds for t/start/end/durationSec')
    ap.add_argument('--float-tol', type=float, default=FLOAT_TOL, help='direct comparison: other floats')
    ap.add_argument('--allow', action='append', default=[], metavar='VARIANT=REASON',
                    help='waive one variant (repeatable); the reason is printed in the report')
    ap.add_argument('-o', '--output', help='write the full report here (default stdout)')
    a = ap.parse_args(argv)
    py_dir = a.py or os.path.join(a.out_dir, 'results')
    ts_dir = a.ts or os.path.join(a.out_dir, 'ts-results')
    allow = {}
    for item in a.allow:
        name, _, reason = item.partition('=')
        if not reason:
            ap.error(f'--allow {item!r}: a reason is required (VARIANT=REASON)')
        allow[name] = reason
    TIME_TOL_USED[0], FLOAT_TOL_USED[0] = a.time_tol, a.float_tol
    rows, missing = build(a.out_dir, py_dir, ts_dir, a.only.split(',') if a.only else None, a.time_tol, a.float_tol)
    text = render(rows, missing, a.py_label, a.ts_label, allow)
    failing = [r for r in rows if r['name'] not in allow and (r['direct']['diffs'] or exceeded(r))]
    if a.output:
        with open(a.output, 'w') as f:
            f.write(text)
        print(text.split('## Per variant')[0])
    else:
        print(text)
    if failing:
        print(f'FAIL: {len(failing)} of {len(rows)} variants exceed a tolerance', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
