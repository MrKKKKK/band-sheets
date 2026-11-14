"""Spike 6 T13: the ONE held-out look (look point 3), step 1 = the guard, the log line and the truth timing
(docs/audio-spike6-plan.md section 4 "見る時点（録音）", section 7 row T13; docs/audio-spike6-r2.md "T13 への申し送り").

  --final-heldout  Refuses unless the commit is given (--commit or BAND_SHEETS_COMMIT) and the log has no look-3 / T13 /
                   held-out bass look yet. Then writes ONE line to out/results/heldout-log.jsonl BEFORE any held-out
                   file is opened (task T13, lookPoint 3,
                   held-out takes e/f, the synthetic held-out split by count, both config hashes, commit, input gains raw
                   and tuning-median-rms), and only then fits spike 2's grid (rec_truth.fit_grid) to the held-out takes:
                   out/bass-rec/heldout-fit/<id>.truth.json (scoring only; the analyzer never sees it).
                   ts/bass/heldout_eval.ts --final-heldout (step 2) requires that line and scores everything.
  --selftest       The same fit on the DEV takes into out/bass-rec/selftest-fit/ (pipeline check before the real run;
                   it must reproduce out/bass-rec/fit from R2). Appends one 'selftest' line (not a look), never a
                   look-3 line; held-out takes are never opened.

  docker run --rm -u 1000:1000 -e HOME=/tmp -e NUMBA_CACHE_DIR=/work/out/.numba-cache -e BAND_SHEETS_COMMIT=SHA \
    -v <worktree>/spikes/analysis:/work -w /work band-sheets-analysis python py/tools/bass_heldout_fit.py --final-heldout
Prints timing numbers per anonymous id only (no chords, no notes).
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import bass_intake as B  # noqa: E402
from bass_rec_fit import IDS, MANIFEST, append_log, dev_takes, fit_takes, read_log  # noqa: E402

TASK = "T13"
# T8-equivalent (bass on, weakMinConfidence 0, split / redecide off) and the G2 default (enabledBassConfig()); the same
# pair R2 / R3 scored. ts/bass/heldout_eval.ts pins the same values against the computed hashes.
FROZEN_HASHES = ["3f11c4c58c5a", "e5b432a11e3c"]
INPUT_GAINS = ["raw", "tuning-median-rms"]
SYN_MANIFEST = "out/bass/manifest.json"
FIT_DIR = {"final": "out/bass-rec/heldout-fit", "selftest": "out/bass-rec/selftest-fit"}
BASS_INPUTS = ("bass", "bass-synth-dev", "bass-synth-heldout")


def held_takes(ids, manifest):
    """Ids held out in both registries (pure). Raises when the registries disagree or a take is unlisted."""
    dev = set(dev_takes(ids, manifest))  # also checks the flags agree and every id is in the manifest
    out = [rid for rid in sorted(ids["recordings"]) if rid not in dev]
    for rid in out:
        if not B.held_out_of(ids["recordings"][rid]["letter"]):
            raise SystemExit(f"{rid}: flagged held-out but its letter is not a held-out letter: refusing")
    return out


def held_synthetic(variants):
    """Names of the synthetic held-out split (timbre C, split heldOut, flag true); metadata only, no audio (pure)."""
    held = [v for v in variants if v.get("heldOut") is True or v.get("split") == "heldOut" or v.get("timbre") == "C"]
    for v in held:
        if not (v.get("heldOut") is True and v.get("split") == "heldOut" and v.get("timbre") == "C"):
            raise SystemExit(f"{v['name']}: held-out flags disagree in {SYN_MANIFEST}: refusing")
    return sorted(v["name"] for v in held)


def final_block(lines, commit):
    """Reason to refuse the final run, or None (pure)."""
    if not commit:
        return "the commit is required: pass --commit or BAND_SHEETS_COMMIT"
    for d in lines:
        if d.get("kind") == "look" and d.get("input") in BASS_INPUTS and (
                d.get("lookPoint") == 3 or d.get("task") == TASK or d.get("heldOut") is True):
            return "a bass look-3 / T13 / held-out look line already exists in the heldout log: refusing to run again"
    return None


def final_line(time, takes, synthetic, commit):
    return {"time": time, "kind": "look", "input": "bass", "lookPoint": 3, "split": "heldOut", "heldOut": True,
            "task": TASK, "takes": takes, "synthetic": {"split": "heldOut", "timbre": "C", "files": len(synthetic)},
            "configHashes": FROZEN_HASHES, "commit": commit, "inputGain": INPUT_GAINS,
            "reason": "T13 look point 3, the one held-out look: recordings e/f (raw and loudness-normalized to the "
                      "synthetic tuning median RMS, user decision 2026-11-14) and the synthetic held-out split "
                      "(timbre C, seeds 6-7); T8-equivalent and G2 configs; fit_grid truth timing; frozen, no tuning after"}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def main(argv=None):
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--final-heldout", action="store_true")
    mode.add_argument("--selftest", action="store_true")
    ap.add_argument("--commit", default=os.environ.get("BAND_SHEETS_COMMIT"))
    a = ap.parse_args(argv)
    ids = json.load(open(IDS, encoding="utf-8"))
    manifest = json.load(open(MANIFEST, encoding="utf-8"))
    if a.selftest:
        takes = dev_takes(ids, manifest)
        append_log({"time": now(), "kind": "selftest", "input": "bass", "task": TASK, "split": "dev", "heldOut": False,
                    "takes": takes, "commit": a.commit,
                    "reason": "T13 pipeline check before the held-out look: dev a-d with the R2/R3 configs and input "
                              "gains (must reproduce R2/R3 exactly; no new information) + synthetic tuning"})
        fit_takes(takes, ids, False, FIT_DIR["selftest"], TASK + "-selftest")
        return
    takes = held_takes(ids, manifest)
    if not takes:
        raise SystemExit("no held-out recordings registered: refusing")
    synthetic = held_synthetic(json.load(open(SYN_MANIFEST, encoding="utf-8"))["variants"])
    block = final_block(read_log(), a.commit)
    if block:
        raise SystemExit(block)
    line = final_line(now(), takes, synthetic, a.commit)
    append_log(line)  # BEFORE any held-out file (audio, .txt, truth) is opened
    print(f"look-3 line logged: task {TASK}, {len(takes)} held-out takes, {len(synthetic)} synthetic held-out files, "
          f"commit {a.commit}")
    fit_takes(takes, ids, True, FIT_DIR["final"], TASK)


if __name__ == "__main__":
    main()
