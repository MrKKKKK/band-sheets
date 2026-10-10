"""Run every baseline analyzer on every variant in out/manifest.json and score it.

Usage: python py/run_all.py [--out DIR]     (DIR defaults to <spikes/analysis>/out)

Assumed manifest shape (T6 should match; paths are relative to DIR):
  {"variants": [{"name": "full-t116-shuffle", "song": "saints", "mix": "full",
                 "wav": "saints/full-t116-shuffle.wav",
                 "truth": "saints/full-t116-shuffle.truth.json", ...}]}
Unknown extra fields are ignored. Only "name" and "truth" are required; "name" falls back to the truth file stem,
"truth" falls back to the wav path with .wav -> .truth.json. A bare list is also accepted.

Writes DIR/results/<variant>.<analyzer>.json (result + score), summary.md and summary.csv.
"""
import argparse
import csv
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import baseline  # noqa: E402
import score as S  # noqa: E402

COLUMNS = [
    ("beat F", ("beats", "f")),
    ("downbeat F", ("downbeats", "f")),
    ("chord/beat", ("chords", "perBeat")),
    ("chord/bar", ("chords", "perBar")),
    ("7th recall", ("chords", "seventhRecall")),
    ("7th prec", ("chords", "seventhPrecision")),
    ("7th nTruth", ("chords", "nSeventhTruth")),
    ("7th nResult", ("chords", "nSeventhResult")),
    ("chord unknownQ(result)", ("chords", "nBeatsUnknownQualityResult")),
    ("melody F1", ("melody", "f1")),
    ("section F", ("sections", "f")),
]
NA = "未評価"


def _get(scores, path):
    d = scores.get(path[0])
    if not isinstance(d, dict):
        return None
    return d.get(path[1])


def _fmt(v):
    if v is None:
        return NA
    return str(v) if isinstance(v, int) else f"{v:.3f}"


def load_variants(out_dir):
    with open(os.path.join(out_dir, "manifest.json")) as f:
        m = json.load(f)
    items = m["variants"] if isinstance(m, dict) else m
    variants = []
    for v in items:
        truth = v.get("truth")
        if not truth and v.get("wav"):
            truth = os.path.splitext(v["wav"])[0] + ".truth.json"
        if not truth:
            raise ValueError(f"manifest entry without truth/wav: {v}")
        name = v.get("name") or os.path.basename(truth).replace(".truth.json", "")
        variants.append({"name": name, "truth": truth, "song": v.get("song", "")})
    return variants


def run_all(out_dir):
    results_dir = os.path.join(out_dir, "results")
    os.makedirs(results_dir, exist_ok=True)
    rows = []
    timings = {}
    for v in load_variants(out_dir):
        with open(os.path.join(out_dir, v["truth"])) as f:
            truth = json.load(f)
        for aname, fn in baseline.ANALYZERS.items():
            t0 = time.perf_counter()
            result = fn(truth)
            scores = S.score(truth, result)
            timings[(v["name"], aname)] = time.perf_counter() - t0
            with open(os.path.join(results_dir, f"{v['name']}.{aname}.json"), "w") as f:
                json.dump({"result": result, "score": scores}, f, indent=2, ensure_ascii=False)
            rows.append({"variant": v["name"], "analyzer": aname,
                         "values": [_get(scores, p) for _, p in COLUMNS]})
    header = ["variant", "analyzer"] + [c for c, _ in COLUMNS]
    with open(os.path.join(results_dir, "summary.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            w.writerow([r["variant"], r["analyzer"]] + ["" if x is None else (str(x) if isinstance(x, int) else f"{x:.4f}") for x in r["values"]])
    lines = ["# 採点結果の一覧", "", "| " + " | ".join(header) + " |",
             "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        lines.append("| " + " | ".join([r["variant"], r["analyzer"]] + [_fmt(x) for x in r["values"]]) + " |")
    with open(os.path.join(results_dir, "summary.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    return rows, timings


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    default_out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "out")
    ap.add_argument("--out", default=default_out)
    args = ap.parse_args(argv)
    t0 = time.perf_counter()
    rows, timings = run_all(args.out)
    print(f"scored {len(rows)} (variant x analyzer) in {time.perf_counter() - t0:.2f} s")
    print(f"wrote {os.path.join(args.out, 'results', 'summary.md')}")


if __name__ == "__main__":
    sys.exit(main())
