"""Spike 4 T2: check that ts/hum/score.ts agrees with mir_eval (docs/audio-spike4-plan.md section 4).

mir_eval is dev tooling only (MIT, never shipped). It is already in the analysis image (band-sheets-analysis):
mir_eval 0.8.2 (the version of the last check). If it is missing, do NOT touch the image / requirements.lock.txt;
install it into a throwaway dir and run with PYTHONPATH instead:
  docker run --rm -u 1000:1000 -e HOME=/tmp -v $PWD/spikes/analysis:/work -w /work band-sheets-analysis \\
      pip install --target /work/out/pylibs mir_eval==0.8.2     (then add -e PYTHONPATH=/work/out/pylibs below)

Three steps (PY = docker run --rm -u 1000:1000 -e HOME=/tmp -v /home/mrk5/projects/band-sheets/spikes/analysis:/work
-w /work band-sheets-analysis;  BS = docker exec -u node -w /workspaces/band-sheets/spikes/analysis band-sheets):

  $PY python py/tools/hum_mireval_check.py gen     out/hum-check/cases.json
  $BS npx tsx ts/hum/score_check.ts                out/hum-check/cases.json out/hum-check/ts_results.json
  $PY python py/tools/hum_mireval_check.py compare out/hum-check/cases.json out/hum-check/ts_results.json

`gen` writes the cases: hand-made note lists and f0 arrays (offset errors, misses, extras, octave errors, splits /
merges, a pitch-class case, a 50 ms boundary, an f0 estimate on another time base ...) plus 5 seeded synthetic
note lists and f0 arrays. `compare` scores every case with mir_eval (transcription.match_notes / precision_recall_f1_overlap,
melody.to_cent_voicing, raw_pitch_accuracy, raw_chroma_accuracy, voicing_measures) and compares with the TS numbers;
exit code 1 on any difference above 1e-9. The pitch-class variant has no mir_eval function: it uses mir_eval's own
maximum matching (util._bipartite_match) on a hit matrix built the same way as match_notes with the pitch distance
folded to the nearest octave. The edit count has no mir_eval counterpart (checked against hand calculations in score.test.ts).
Prints numbers and case names only.
"""
import json
import os
import sys

import numpy as np

TOL = 1e-9
VARIANTS = {  # name -> kwargs of transcription.match_notes (None offset_ratio = onset only)
    'onset': dict(offset_ratio=None),
    'onsetOffset': dict(),
    'onsetSemitone': dict(offset_ratio=None, pitch_tolerance=100.0),
    'onset100ms': dict(offset_ratio=None, onset_tolerance=0.1),
}


def hz(midi, cents):
    return 440.0 * 2.0 ** ((np.asarray(midi, float) + np.asarray(cents, float) / 100.0 - 69.0) / 12.0)


def N(start, end, midi, cents=0.0):
    return dict(start=start, end=end, midi=midi, cents=cents)


def hand_note_cases():
    ref = [N(0, .5, 60), N(.5, 1, 62), N(1, 1.5, 64), N(1.5, 2, 65)]

    def mod(i, **kw):
        return [dict(x, **kw) if k == i else dict(x) for k, x in enumerate(ref)]

    def shift(i, key, d):
        return [dict(x, **{key: x[key] + d}) if k == i else dict(x) for k, x in enumerate(ref)]

    return [
        ('perfect', ref, [dict(x) for x in ref]),
        ('onset50-boundary', ref, shift(1, 'start', 0.05)),
        ('onset60', ref, shift(1, 'start', 0.06)),
        ('offset+90ms', ref, shift(0, 'end', 0.09)),
        ('offset+120ms', ref, shift(0, 'end', 0.12)),
        ('short-ref-offset', [N(0, .1, 60)], [N(0, .16, 60)]),
        ('pitch+40c', ref, mod(2, cents=40.0)),
        ('pitch+60c', ref, mod(2, cents=60.0)),
        ('pitch-class-octave-up', ref, mod(3, midi=77)),
        ('pitch-class-octave-down-40c', ref, mod(3, midi=53, cents=-40.0)),
        ('octave+70c', ref, mod(3, midi=77, cents=70.0)),
        ('miss', ref, ref[:3]),
        ('extra', ref, ref + [N(2, 2.5, 67)]),
        ('split', [N(0, 1, 60)], [N(0, .5, 60), N(.5, 1, 60)]),
        ('merge', [N(0, .5, 60), N(.5, 1, 60)], [N(0, 1, 60)]),
        ('not-greedy', [N(.05, 1, 60), N(0, 1, 60)], [N(0, 1, 60), N(.1, 1, 60)]),
        ('one-est-two-ref', [N(0, 1, 60), N(.06, 1, 60)], [N(.03, 1, 60)]),
        ('empty-est', ref, []),
        ('empty-ref', [], ref),
    ]


def synth_note_case(seed):
    rng = np.random.default_rng(seed)
    n = int(rng.integers(20, 41))
    t = 0.0
    ref, est = [], []
    midi = int(rng.integers(55, 70))
    for _ in range(n):
        dur = float(rng.choice([0.25, 0.375, 0.5, 0.75, 1.0]))
        gap = float(rng.choice([0.0, 0.0, 0.0, 0.25]))
        t += gap
        midi = int(np.clip(midi + rng.choice([-2, -1, 0, 0, 1, 2, 5, -5]), 48, 80))
        ref.append(N(round(t, 6), round(t + dur, 6), midi, 0.0))
        r = rng.random()
        if r < 0.08:  # missed
            t += dur
            continue
        on = max(t + float(rng.normal(0, 0.04)), 0.0)
        off = t + dur + float(rng.normal(0, 0.06))
        off = max(off, on + 0.05)
        m, c = midi, float(rng.normal(0, 30))
        if r < 0.16:
            m += 12 * int(rng.choice([-1, 1]))  # octave error
        elif r < 0.24:
            m += int(rng.choice([-1, 1]))  # semitone error
        if 0.24 <= r < 0.32 and dur >= 0.5:  # split into two
            mid = on + (off - on) / 2
            est += [N(on, mid, m, c), N(mid, off, m, c)]
        else:
            est.append(N(on, off, m, c))
        if rng.random() < 0.06:  # extra note
            est.append(N(t + dur / 2, t + dur, midi + 3, 0.0))
        t += dur
    est.sort(key=lambda x: x['start'])
    return f'synthetic-notes-{seed}', ref, est


def hand_f0_cases():
    t = [round(i * 0.01, 6) for i in range(6)]
    ref = [220.0, 220.0, 220.0, 0.0, 0.0, 0.0]
    f = lambda c: 220.0 * 2 ** (c / 1200)
    return [
        ('f0-perfect-voicing-everywhere', t, ref, t, [220.0] * 6),
        ('f0-octave', t, ref, t, [440.0, 440.0, 440.0, 0, 0, 0]),
        ('f0-wrong-and-guess', t, ref, t, [220.0, f(100), -220.0, 0, 0, 0]),
        ('f0-49c-51c', t, ref, t, [f(49), f(-51), 220.0, 0, 0, 0]),
        ('f0-no-voiced-ref', t, [0.0] * 6, t, [220.0, 0, 0, 0, 0, 0]),
        ('f0-other-timebase', t, ref, [0, .02, .04, .06], [220.0] * 4),
        ('f0-est-starts-late', t, ref, t[2:], [220.0, 0, 0, 0]),
        ('f0-est-shorter', t, ref, t[:4], [220.0, 220.0, -220.0, 0.0]),
    ]


def synth_f0_case(seed):
    rng = np.random.default_rng(1000 + seed)
    n = 300
    hop = 0.01
    t = np.arange(n) * hop
    ref = np.zeros(n)
    i = 0
    while i < n:
        i += int(rng.integers(5, 25))  # silence
        L = int(rng.integers(20, 60))
        ref[i:i + L] = 440.0 * 2 ** ((int(rng.integers(55, 75)) - 69) / 12)
        i += L
    est = ref.copy()
    voiced = ref > 0
    est[voiced] *= 2 ** (rng.normal(0, 25, voiced.sum()) / 1200)
    octv = rng.random(n) < 0.08
    est[octv & voiced] *= rng.choice([0.5, 2.0], (octv & voiced).sum())
    est[rng.random(n) < 0.1] = 0.0  # dropped frames
    spur = (~voiced) & (rng.random(n) < 0.1)
    est[spur] = 300.0  # false alarms
    guess = voiced & (rng.random(n) < 0.1)
    est[guess] *= -1  # unvoiced with pitch guess
    et = t
    if seed % 2 == 1:  # other hop and an offset start, so resampling happens
        et = np.arange(0, t[-1] + 0.02, 0.0137)
        est = np.interp(et, t, est)
        est[est == 0] = 0.0
    return f'synthetic-f0-{seed}', t.round(10).tolist(), ref.tolist(), et.round(10).tolist(), est.tolist()


def gen(path):
    notes = [dict(name=n, ref=r, est=e) for n, r, e in hand_note_cases()] + [dict(name=n, ref=r, est=e) for n, r, e in (synth_note_case(s) for s in range(1, 6))]
    f0 = [dict(name=n, refTime=a, refHz=b, estTime=c, estHz=d) for n, a, b, c, d in hand_f0_cases()] + [
        dict(name=n, refTime=a, refHz=b, estTime=c, estHz=d) for n, a, b, c, d in (synth_f0_case(s) for s in range(1, 6))]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    json.dump(dict(notes=notes, f0=f0), open(path, 'w'))
    print(f'wrote {len(notes)} note cases and {len(f0)} f0 cases -> {path}')


def mir_note_scores(ref, est):
    import mir_eval.transcription as tr
    from mir_eval import util
    out = {}
    if not ref or not est:
        z = dict(precision=0.0, recall=0.0, f=0.0, matched=0, nRef=len(ref), nEst=len(est))
        return {k: dict(z) for k in list(VARIANTS) + ['onsetPitchClass']}
    ri = np.array([[x['start'], x['end']] for x in ref])
    ei = np.array([[x['start'], x['end']] for x in est])
    rp = hz([x['midi'] for x in ref], [x['cents'] for x in ref])
    ep = hz([x['midi'] for x in est], [x['cents'] for x in est])
    for name, kw in VARIANTS.items():
        p, r, f, _ = tr.precision_recall_f1_overlap(ri, rp, ei, ep, **kw)
        m = len(tr.match_notes(ri, rp, ei, ep, **kw))
        out[name] = dict(precision=p, recall=r, f=f, matched=m, nRef=len(ref), nEst=len(est))
    # pitch class: mir_eval hit-matrix recipe with the pitch distance folded to the nearest octave
    on = np.around(np.abs(np.subtract.outer(ri[:, 0], ei[:, 0])), decimals=tr.N_DECIMALS) <= 0.05
    pd = np.abs(1200 * np.subtract.outer(np.log2(rp), np.log2(ep)))
    pd = np.abs(pd - 1200 * np.rint(pd / 1200))
    hit = on * (pd <= 50.0)
    G = {}
    for r_i, e_i in zip(*np.where(hit)):
        G.setdefault(e_i, []).append(r_i)
    m = len(util._bipartite_match(G))
    p, r = m / len(est), m / len(ref)
    out['onsetPitchClass'] = dict(precision=p, recall=r, f=util.f_measure(p, r), matched=m, nRef=len(ref), nEst=len(est))
    return out


def mir_f0_scores(c):
    import mir_eval.melody as me
    rt, rf = np.array(c['refTime'], float), np.array(c['refHz'], float)
    et, ef = np.array(c['estTime'], float), np.array(c['estHz'], float)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        rv, rc, ev, ec = me.to_cent_voicing(rt, rf, et, ef)
        rpa = me.raw_pitch_accuracy(rv, rc, ev, ec)
        rca = me.raw_chroma_accuracy(rv, rc, ev, ec)
        rec, fa = me.voicing_measures(rv, ev)
    return dict(rawPitchAccuracy=float(rpa), rawChromaAccuracy=float(rca), voicingRecall=float(rec), voicingFalseAlarm=float(fa), octaveErrorRate=float(rca) - float(rpa))


def compare(cases_path, ts_path):
    cases = json.load(open(cases_path))
    ts = json.load(open(ts_path))
    worst, n, bad = 0.0, 0, []
    for c in cases['notes']:
        mine = mir_note_scores(c['ref'], c['est'])
        for v, d in mine.items():
            for k, x in d.items():
                diff = abs(x - ts['notes'][c['name']][v][k])
                worst, n = max(worst, diff), n + 1
                if diff > TOL:
                    bad.append((c['name'], v, k, x, ts['notes'][c['name']][v][k]))
    for c in cases['f0']:
        mine = mir_f0_scores(c)
        for k, x in mine.items():
            diff = abs(x - ts['f0'][c['name']][k])
            worst, n = max(worst, diff), n + 1
            if diff > TOL:
                bad.append((c['name'], 'f0', k, x, ts['f0'][c['name']][k]))
    import mir_eval
    print(f'mir_eval {mir_eval.__version__}: {len(cases["notes"])} note cases, {len(cases["f0"])} f0 cases, {n} numbers compared, max abs diff {worst:.3e}')
    for b in bad:
        print('MISMATCH', *b)
    print('AGREE (<= 1e-9)' if not bad else f'{len(bad)} MISMATCHES')
    return 0 if not bad else 1


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'gen':
        gen(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == 'compare':
        sys.exit(compare(sys.argv[2], sys.argv[3]))
    else:
        print(__doc__)
        sys.exit(2)
