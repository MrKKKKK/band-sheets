"""Spike 6 T8: score the root regression pairs with py/score.py (docs/audio-spike6-t8.md, plan section 5).

Reads out/bass-results/regression/pairs.json (written by ts/bass/root_regression.ts: v1a and bass-ON results of the
same signal) and prints, per level, the mean chords.perBeat / majminWeighted of v1a and of the bass result and the
largest per-file difference, plus vocab.bassPerBeat (slash recall, record only) and the wrong-/X rate (of the eighth
points whose truth chord has no /X and a vocabulary quality, the share where the bass result has a /X; pooled like
ts/bass/score.ts wrongSlash). Exit 1 when a chord metric moves.
  docker run --rm -u 1000:1000 -e HOME=/tmp -v <worktree>/spikes/analysis:/work -w /work band-sheets-analysis \
    python py/tools/bass_root_regression.py [out/bass-results/regression/pairs.json]
Prints numbers and level names only.
"""
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import score as S  # noqa: E402

METRICS = ("perBeat", "majminWeighted")


def load(p):
    with open(p) as f:
        return json.load(f)


def wrong_slash(truth, result):
    """(points whose truth has no /X, of them with a result /X), weight 0.5 per eighth point (ts/bass/score.ts rule)."""
    tt, rt = S._ChordTrack(truth["chords"]), S._ChordTrack(result["chords"])
    no, false = 0.0, 0.0
    for w in S._beat_windows(truth["beats"]):
        for f in (0.25, 0.75):
            tc = tt.at(w[0] + f * (w[3] - w[0]))
            if tc is None or S.map_vocab(tc.get("quality")) is None:
                continue
            tb = S._bass_pc(tc)
            if tb is not None and tb != S.note_to_pc(tc["root"]):
                continue
            no += 0.5
            rc = rt.at(w[0] + f * (w[3] - w[0]))
            if rc is not None and S._bass_pc(rc) is not None:
                false += 0.5
    return no, false


def main(argv):
    pairs = load(argv[1] if len(argv) > 1 else "out/bass-results/regression/pairs.json")["pairs"]
    acc = defaultdict(lambda: defaultdict(list))
    worst = 0.0
    for p in pairs:
        truth = load(p["truth"])
        c0 = S.score(truth, load(p["v1a"]))["chords"]
        c1 = S.score(truth, load(p["bass"]))["chords"]
        for lv in (p["level"], "ALL"):
            a = acc[lv]
            for m in METRICS:
                a[m + "0"].append(c0[m])
                a[m + "1"].append(c1[m])
                worst = max(worst, abs(c1[m] - c0[m]))
            a["bpb1"].append(c1["vocab"]["bassPerBeat"])
            no, false = wrong_slash(truth, load(p["bass"]))
            a["no"].append(no)
            a["false"].append(false)
    mean = lambda xs: sum(x for x in xs if x is not None) / max(1, sum(x is not None for x in xs))
    print("level\tn\tperBeat v1a\tperBeat bass\tdiff\tmajminW v1a\tmajminW bass\tdiff\tbassPerBeat(bass)\twrong /X (bass)")
    for lv in sorted(acc, key=lambda k: (k == "ALL", k)):
        a = acc[lv]
        pb0, pb1, mm0, mm1 = mean(a["perBeat0"]), mean(a["perBeat1"]), mean(a["majminWeighted0"]), mean(a["majminWeighted1"])
        bpb = [x for x in a["bpb1"] if x is not None]
        print(f"{lv}\t{len(a['perBeat0'])}\t{pb0:.4f}\t{pb1:.4f}\t{pb1 - pb0:+.4f}\t{mm0:.4f}\t{mm1:.4f}\t{mm1 - mm0:+.4f}\t"
              f"{(sum(bpb) / len(bpb)) if bpb else float('nan'):.3f} ({len(bpb)} files with truth /X)\t"
              f"{sum(a['false']) / sum(a['no']) if sum(a['no']) else float('nan'):.3f}")
    print(f"largest per-file difference of {', '.join(METRICS)}: {worst:.2e}")
    return 1 if worst > 1e-12 else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
