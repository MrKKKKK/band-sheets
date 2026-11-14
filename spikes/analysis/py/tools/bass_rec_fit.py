"""Spike 6 R2 / R3: one logged look at the DEV piano recordings, step 1 = truth timing (docs/audio-spike6-plan.md
section 4 "時刻の合わせ", docs/audio-spike6-r2.md).

bass_intake.py writes the truth on the NOMINAL grid (`開始:` + bpm from the .txt). For scoring only, this fits spike 2's
grid (rec_truth.fit_grid: t0 within +-60 ms of `開始:`, tempo within +-1 %, librosa onsets) to every dev take and
writes the fitted truth to out/bass-rec/fit/<id>.truth.json plus out/bass-rec/fit/fit.json (per take: t0 shift ms,
tempo change %, onset residual median ms, whether the fit sat on its search bound). The analyzer never sees it.

Held-out: the takes are the ids NOT held out in BOTH recordings/bas-ids.local.json and out/rec/manifest.bass.json
(a take missing from either is refused); the held-out takes' files are never opened. The look is logged here, ONCE,
BEFORE any audio is opened: one line (kind 'look', input 'bass', lookPoint, task, takes, configHashes, commit, reason)
in out/results/heldout-log.jsonl; a second run for the same task is refused. ts/bass/rec_eval.ts (step 2) requires
that line and scores the configs it names.

  docker run --rm -u 1000:1000 -e HOME=/tmp -e NUMBA_CACHE_DIR=/work/out/.numba-cache -v <worktree>/spikes/analysis:/work \
    -w /work band-sheets-analysis python py/tools/bass_rec_fit.py --task R2 --look-point 1 --commit SHA \
    --config-hashes H1,H2 --reason "..." [--input-gain tuning-median-rms]
Prints timing numbers per anonymous id only (no chords, no notes).
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import bass_intake as B  # noqa: E402
import rec_truth as RT  # noqa: E402

LOG = "out/results/heldout-log.jsonl"
IDS = os.path.join("recordings", B.IDS_FILE)
MANIFEST = "out/rec/manifest.bass.json"
FIT_DIR = "out/bass-rec/fit"


def dev_takes(ids, manifest):
    """Ids that are dev in both registries (pure). Raises when the registries disagree or a take is unlisted."""
    man = {v["name"]: v for v in manifest["variants"]}
    out = []
    for rid, e in sorted(ids["recordings"].items()):
        if rid not in man:
            raise SystemExit(f"{rid}: not in {MANIFEST}, held-out flag unverifiable: refusing")
        if bool(e.get("heldOut")) != bool(man[rid].get("heldOut")):
            raise SystemExit(f"{rid}: held-out flags disagree: refusing")
        if not e.get("heldOut") and B.held_out_of(e["letter"]):
            raise SystemExit(f"{rid}: letter is a held-out letter but the flag says dev: refusing")
        if not e.get("heldOut"):
            out.append(rid)
    return out


def read_log():
    """The parsed lines of the heldout log (empty when there is no file)."""
    return [json.loads(x) for x in open(LOG, encoding="utf-8") if x.strip()] if os.path.exists(LOG) else []


def append_log(line):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")


def logged(lines, task):
    return [d for d in lines if d.get("kind") == "look" and d.get("input") == "bass" and d.get("task") == task]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--look-point", type=int, required=True, choices=(1, 2))
    ap.add_argument("--commit", required=True)
    ap.add_argument("--config-hashes", required=True)
    ap.add_argument("--reason", required=True)
    ap.add_argument("--input-gain", help="how the scoring step scales the input (recorded in the line; rec_eval.ts checks it), "
                    "e.g. tuning-median-rms")
    a = ap.parse_args(argv)
    ids = json.load(open(IDS, encoding="utf-8"))
    manifest = json.load(open(MANIFEST, encoding="utf-8"))
    takes = dev_takes(ids, manifest)
    lines = read_log()
    if logged(lines, a.task):
        raise SystemExit(f"a look for task {a.task} is already logged: refusing a second one")
    prior = [d for d in lines if d.get("kind") == "look" and d.get("input") == "bass" and not d.get("heldOut")]
    line = {"time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "kind": "look",
            "input": "bass", "lookPoint": a.look_point, "split": "dev", "heldOut": False, "task": a.task, "takes": takes,
            "configHashes": a.config_hashes.split(","), "commit": a.commit, "reason": a.reason}
    if a.input_gain:
        line["inputGain"] = a.input_gain
    append_log(line)
    print(f"look logged: recordings dev look #{len(prior) + 1}, {len(takes)} takes, task {a.task}")

    fit_takes(takes, ids, False, FIT_DIR, a.task)


def fit_takes(takes, ids, held_out, fit_dir, task):
    """Fits spike 2's grid to each take (opens its audio) and writes <fit_dir>/<id>.truth.json + fit.json. Every take's
    registry entry and nominal truth must carry `held_out` (else nothing more is opened). Prints timing per id only."""
    os.makedirs(fit_dir, exist_ok=True)
    summary = {"task": task, "takes": {}}
    for rid in takes:
        assert bool(ids["recordings"][rid]["heldOut"]) == held_out
        letter = ids["recordings"][rid]["letter"]
        ann = B.parse_bass_txt(open(os.path.join("recordings", "bas-originals", rid + ".txt"), encoding="utf-8").read(), letter)
        nominal = json.load(open(os.path.join("out", "rec", rid + ".truth.json"), encoding="utf-8"))
        if bool(nominal["heldOut"]) != held_out or nominal["name"] != rid:
            raise SystemExit(f"{rid}: truth flag mismatch: refusing")
        ann["firstSoundSec"] = ann["startSec"]
        fit = RT.fit_grid(os.path.join("recordings", rid + ".wav"), ann)
        fitted = dict(ann, startSec=fit["t0"], tempo=fit["tempo"])
        truth = B.build_truth(fitted, rid, held_out, nominal["source"]["audioSec"], nominal["startCheck"])
        truth["fit"] = {"t0": fit["t0"], "tempo": fit["tempo"], "nominalStartSec": ann["startSec"], "nominalTempo": ann["tempo"]}
        with open(os.path.join(fit_dir, rid + ".truth.json"), "w", encoding="utf-8") as f:
            json.dump(truth, f, indent=1, ensure_ascii=False)
        dt0 = (fit["t0"] - ann["startSec"]) * 1000
        dtempo = (fit["tempo"] / ann["tempo"] - 1) * 100
        end_shift = dt0 + len(ann["bars"]) * ann["eighthsPerBar"] * (30.0 / fit["tempo"] - 30.0 / ann["tempo"]) * 1000
        s = {"t0ShiftMs": round(dt0, 1), "tempoChangePct": round(dtempo, 3), "endShiftMs": round(end_shift, 1),
             "residualMedianMs": round(fit["residualMedianMs"], 1), "nOnsets": fit["nOnsets"],
             "onBound": abs(dt0) >= RT.T0_RANGE_S * 1000 - 1 or abs(dtempo) >= RT.TEMPO_RANGE * 100 - 0.01}
        summary["takes"][rid] = s
        print(f"{rid}: t0 {s['t0ShiftMs']:+.1f} ms, tempo {s['tempoChangePct']:+.3f} %, last bar end {s['endShiftMs']:+.1f} ms, "
              f"onset residual median {s['residualMedianMs']:.1f} ms ({s['nOnsets']} onsets){', ON THE SEARCH BOUND' if s['onBound'] else ''}")
    with open(os.path.join(fit_dir, "fit.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)


if __name__ == "__main__":
    main()
