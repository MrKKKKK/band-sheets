"""Spike 6 T3: check ts/bass/score.ts against the references (docs/audio-spike6-plan.md section 7, T3).

Three comparisons, all to 1e-9 (exit 1 on any difference):
  - slashRecall / truthSlash / hit  vs  py/score.py `_score_vocab` at the points `_chords` uses (bassPerBeat, nBassScored, nBassHit)
  - mapVocab  vs  py/score.py `map_vocab` on a list of quality strings
  - bass note F (octave / pitch class)  vs  mir_eval.transcription (the matching and the pitch-class recipe are the
    ones of py/tools/hum_mireval_check.py, imported, not copied).
mir_eval is dev tooling only (already in the band-sheets-analysis image; see hum_mireval_check.py if it is missing).
Steps (PY = docker run --rm -u 1000:1000 -e HOME=/tmp -v <repo>/spikes/analysis:/work -w /work band-sheets-analysis;
BS = docker exec -u node -w /workspaces/band-sheets/spikes/analysis band-sheets; in a worktree use its path):

  $PY python py/tools/bass_mireval_check.py gen     out/bass-check/cases.json
  $BS npx tsx ts/bass/score_check.ts                out/bass-check/cases.json out/bass-check/ts_results.json
  $PY python py/tools/bass_mireval_check.py compare out/bass-check/cases.json out/bass-check/ts_results.json
Prints numbers and case names only.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import hum_mireval_check as H  # noqa: E402
import score as S  # noqa: E402

TOL = 1e-9
QUALITIES = ["maj", "min", "7", "maj7", "min7", "dim", "aug", "sus4", "m7b5", "dim7", "5", "6", "m6", "add9", "9", "m9", "maj9",
             "M7", "M9", "7sus4", "sus2", "sus", "7(b5)", "7(#5)", "aug7", "+", "mM7", "mmaj7", "dim7", "dim(7)", "\u00b0", "\u00b07",
             "\u00f8", "m7b5", "m9b5", "m(b5)", "m7(#5)", "m7-5", "13", "7(#9)", "G", "", " maj ", "min7(11)", "\u0394", "\u03947", "^7", "-7", "-", "2",
             "add11", "11", "xyz", "Maj7", "maj7#5", "M7b5", "m11", "13(b9)", "6/9", "69"]
ROOTS = ["C", "D", "E", "F", "G", "A", "B", "C#", "Db", "F#", "Bb", "Ab"]
BQ = ["maj", "min", "7", "maj7", "min7", "dim", "sus4", "6", "9", "7(b5)", "sus2", "m9"]


def chart_case(seed):
    rng = np.random.default_rng(seed)
    n_beats = int(rng.integers(16, 40))
    t0 = float(rng.uniform(0, 0.3))
    bi = float(rng.uniform(0.35, 0.7))
    beats = [dict(t=round(t0 + i * bi + float(rng.normal(0, 0.004)), 6), downbeat=i % 4 == 0) for i in range(n_beats)]

    def chords(noisy):
        out, t = [], t0 - 0.01
        end = round(t0 + (n_beats + 1) * bi, 6)
        while t < end:
            d = float(rng.choice([1, 2, 2, 4])) * bi + (float(rng.normal(0, 0.05)) if noisy else 0.0)
            c = dict(start=round(t, 6), end=round(min(t + max(d, 0.1), end), 6), root=str(rng.choice(ROOTS)),
                     quality=str(rng.choice(BQ)), bass=None if rng.random() < 0.55 else str(rng.choice(ROOTS)))
            out.append(c)
            t = c["end"] + (float(rng.choice([0, 0, 0.2])) if noisy else 0.0)
        if rng.random() < 0.3:
            out.insert(int(rng.integers(0, len(out))), dict(start=-5, end=-4, root="N", quality="maj", bass=None))
        return out
    return f"chart-{seed}", beats, chords(False), chords(True)


def gen(path):
    notes = [dict(name=n, ref=r, est=e) for n, r, e in H.hand_note_cases()] + [dict(name=n, ref=r, est=e) for n, r, e in (H.synth_note_case(s) for s in range(1, 6))]
    charts = [dict(name=n, beats=b, truth=t, result=r) for n, b, t, r in (chart_case(s) for s in range(1, 31))]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    json.dump(dict(qualities=QUALITIES, notes=notes, charts=charts), open(path, "w"))
    print(f"wrote {len(QUALITIES)} qualities, {len(notes)} note cases, {len(charts)} chart cases -> {path}")


def compare(cases_path, ts_path):
    cases = json.load(open(cases_path))
    ts = json.load(open(ts_path))
    worst, n, bad = 0.0, 0, []

    def chk(name, k, a, b):
        nonlocal worst, n
        if a is None or b is None:
            ok = a is None and b is None
            diff = 0.0 if ok else 1.0
        else:
            diff = abs(a - b)
        worst, n = max(worst, diff), n + 1
        if diff > TOL:
            bad.append((name, k, a, b))

    for q in cases["qualities"]:
        a, b = S.map_vocab(q), ts["vocab"][q]
        n += 1
        if a != b:
            bad.append((q, "map_vocab", a, b))
    for c in cases["charts"]:
        wins = S._beat_windows(c["beats"])  # the same points _chords feeds _score_vocab (_chords also runs majmin, unrelated)
        pts = [(w[0] + f * (w[3] - w[0]), 0.5) for w in wins for f in (0.25, 0.75)]
        v = S._score_vocab(pts, S._ChordTrack(c["truth"]), S._ChordTrack(c["result"]))
        t = ts["charts"][c["name"]]
        chk(c["name"], "bassPerBeat", v["bassPerBeat"], t["slashRecall"])
        chk(c["name"], "nBassScored", float(v["nBassScored"]), t["truthSlash"])
        chk(c["name"], "nBassHit", float(v["nBassHit"]), t["hit"])
    for c in cases["notes"]:
        mine = H.mir_note_scores(c["ref"], c["est"])
        for ours, theirs in (("octave", "onset"), ("pitchClass", "onsetPitchClass")):
            for k, x in mine[theirs].items():
                chk(c["name"], f"{ours}.{k}", x, ts["notes"][c["name"]][ours][k])
    import mir_eval
    print(f'mir_eval {mir_eval.__version__}: {len(cases["qualities"])} qualities, {len(cases["charts"])} chart cases, {len(cases["notes"])} note cases, {n} numbers compared, max abs diff {worst:.3e}')
    for b in bad:
        print("MISMATCH", *b)
    print("AGREE (<= 1e-9)" if not bad else f"{len(bad)} MISMATCHES")
    return 0 if not bad else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "gen":
        gen(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "compare":
        sys.exit(compare(sys.argv[2], sys.argv[3]))
    else:
        print(__doc__)
        sys.exit(2)
