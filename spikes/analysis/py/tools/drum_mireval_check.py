"""Spike 5 T3: check that ts/drum/score.ts onsetScores() agrees with mir_eval.onset.f_measure (docs/audio-spike5-plan.md section 5).

mir_eval is dev tooling only (MIT, never shipped); it is in the analysis image (band-sheets-analysis). Three steps
(PY = docker run --rm -u 1000:1000 -e HOME=/tmp -v <repo>/spikes/analysis:/work -w /work band-sheets-analysis;
 BS = docker exec -u node -w /workspaces/band-sheets/<worktree>/spikes/analysis band-sheets):

  $PY python py/tools/drum_mireval_check.py gen     out/drum-check/cases.json
  $BS npx tsx ts/drum/score_check.ts                out/drum-check/cases.json out/drum-check/ts_results.json
  $PY python py/tools/drum_mireval_check.py compare out/drum-check/cases.json out/drum-check/ts_results.json

Cases: hand-made lists (empty sides, exact boundary, duplicates, dense clusters) and seeded random onset sets at the
two tolerances (0.05 / 0.025). Exit code 1 on any |TS - mir_eval| > 1e-9. Prints numbers and case names only.
"""
import json
import os
import sys

import numpy as np

TOLS = [0.05, 0.025]


def gen(path):
    rng = np.random.default_rng(5)
    cases = [
        ("empty-ref", [], [1.0]),
        ("empty-est", [1.0], []),
        ("both-empty", [], []),
        ("exact-boundary", [1.0, 2.0], [1.05, 2.025]),
        ("two-est-one-ref", [1.0], [0.99, 1.01]),
        ("chain", [1.0, 1.04, 1.08], [1.02, 1.06, 1.1]),
        ("dense-cluster", list(np.arange(0, 1, 0.01)), list(np.arange(0.005, 1.005, 0.013))),
    ]
    for k in range(200):
        n = int(rng.integers(0, 40))
        m = int(rng.integers(0, 40))
        span = float(rng.choice([1.0, 5.0, 20.0]))
        ref = np.sort(rng.random(n) * span)
        if rng.random() < 0.5 and n:  # jittered copy of ref, so many matches
            keep = ref[rng.random(n) < 0.8]
            est = np.sort(keep + rng.normal(0, 0.03, len(keep)))
        else:
            est = np.sort(rng.random(m) * span)
        cases.append((f"rand-{k}", [float(x) for x in ref], [float(x) for x in est]))
    out = [{"name": n, "ref": [float(x) for x in r], "est": [float(x) for x in e]} for n, r, e in cases]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump({"tols": TOLS, "cases": out}, f)
    print(f"wrote {len(out)} cases")


def compare(cases_path, ts_path):
    import mir_eval

    cases = json.load(open(cases_path))
    ts = json.load(open(ts_path))
    worst = 0.0
    n = 0
    for c, t in zip(cases["cases"], ts["results"]):
        assert c["name"] == t["name"]
        ref = np.array(c["ref"], dtype=float)
        est = np.array(c["est"], dtype=float)
        for tol, got in zip(cases["tols"], t["scores"]):
            if len(ref) == 0 or len(est) == 0:
                want = (0.0, 0.0, 0.0)  # mir_eval.onset.f_measure returns 0,0,0 for empty input
                if len(ref) == 0 and len(est) == 0:
                    pass
            else:
                f, p, r = mir_eval.onset.f_measure(ref, est, window=tol)
                want = (p, r, f)
            d = max(abs(a - b) for a, b in zip(want, (got["precision"], got["recall"], got["f"])))
            worst = max(worst, d)
            n += 1
            if d > 1e-9:
                print(f"DIFF {c['name']} tol={tol}: mir_eval={want} ts={got}")
    print(f"{n} comparisons, max |TS - mir_eval| = {worst:.3e}")
    sys.exit(1 if worst > 1e-9 else 0)


if __name__ == "__main__":
    if sys.argv[1] == "gen":
        gen(sys.argv[2])
    else:
        compare(sys.argv[2], sys.argv[3])
