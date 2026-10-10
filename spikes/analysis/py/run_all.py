"""Run every baseline analyzer on every variant in out/manifest.json and score it.

Usage: python py/run_all.py [--out DIR] [--analyzers constant,oracle,mode-chord,dsp-v1] [--only GLOB]
                            [--dsp-config x.json] [--dsp-name dsp-v1]
(DIR defaults to <spikes/analysis>/out). Analyzers get (truth, wav_path); dsp-v1 is given ONLY the wav path.

Three manifests are read (only manifest.json is required; paths relative to DIR):
  manifest.json                 base variants (level 0 unless an entry has "level")
  derived/manifest.derived.json bare list of {name, song, base, level, heldOut, degrade, wav, truth}
  rec/manifest.rec.json         {"variants": [{name, song:"rec", level:"REC", heldOut, wav, truth}]}

Assumed manifest shape (T6 should match; paths are relative to DIR):
  {"variants": [{"name": "full-t116-shuffle", "song": "saints", "mix": "full",
                 "wav": "saints/full-t116-shuffle.wav",
                 "truth": "saints/full-t116-shuffle.truth.json", ...}]}
Unknown extra fields are ignored. Only "name" and "truth" are required; "name" falls back to the truth file stem,
"truth" falls back to the wav path with .wav -> .truth.json. A bare list is also accepted.

Writes DIR/results/<variant>.<analyzer>.json (result + score), summary.md, summary.csv, summary.levels.md.
"""
import argparse
import csv
import fnmatch
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


MANIFESTS = [("manifest.json", 0), ("derived/manifest.derived.json", None), ("rec/manifest.rec.json", None)]
DEFAULT_ANALYZERS = ["constant", "oracle", "mode-chord", "dsp-v1"]
DEFAULT_LEVEL = 0


def _parse_manifest(path, default_level):
    with open(path) as f:
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
        wav = v.get("wav") or truth.replace(".truth.json", ".wav")
        level = v.get("level", default_level if default_level is not None else DEFAULT_LEVEL)
        variants.append({"name": name, "truth": truth, "wav": wav, "song": v.get("song", ""),
                         "level": str(level), "heldOut": bool(v.get("heldOut", False))})
    return variants


def load_variants(out_dir):
    """Base manifest (required) + derived + rec manifests (optional)."""
    variants = []
    for rel, lvl in MANIFESTS:
        p = os.path.join(out_dir, rel)
        if not os.path.exists(p):
            if rel == "manifest.json":
                raise FileNotFoundError(p)
            continue
        variants += _parse_manifest(p, lvl)
    return variants


def _level_key(l):
    return (0, int(l), "") if str(l).isdigit() else (1, 0, str(l))


class DspAnalyzer:
    """dsp-v1: lazy import of py/analyze.py; gets only the wav path."""

    def __init__(self, config_path=None):
        self.cfg = None
        self.config_path = config_path
        self.fn = None
        self.error = None
        try:
            from analyze import analyze  # noqa: E402 (py/ is on sys.path)
            from dsp.config import load_config
            self.fn = analyze
            self.cfg = load_config(config_path)
        except ImportError as e:
            self.error = f"{type(e).__name__}: {e}"

    def __call__(self, wav_path):
        return self.fn(wav_path, self.cfg)


def run_all(out_dir, analyzers=None, only=None, dsp_config=None, dsp_name="dsp-v1", log=print):
    results_dir = os.path.join(out_dir, "results")
    os.makedirs(results_dir, exist_ok=True)
    names = list(analyzers) if analyzers else list(DEFAULT_ANALYZERS)
    dsp = None
    active = []
    for a in names:
        if a == "dsp-v1":
            dsp = DspAnalyzer(dsp_config)
            if dsp.fn is None:
                log(f"SKIP dsp-v1: py/analyze.py not available ({dsp.error})")
                continue
            active.append((dsp_name, "dsp"))
        elif a in baseline.ANALYZERS2:
            active.append((a, a))
        else:
            raise ValueError(f"unknown analyzer {a!r}")
    rows = []
    timings = {}
    for v in load_variants(out_dir):
        if only and not fnmatch.fnmatch(v["name"], only):
            continue
        tpath = os.path.join(out_dir, v["truth"])
        if not os.path.exists(tpath):
            log(f"SKIP {v['name']}: truth not found ({tpath})")
            continue
        with open(tpath) as f:
            truth = json.load(f)
        wav = os.path.join(out_dir, v["wav"])
        have_wav = os.path.exists(wav)
        for aname, kind in active:
            if (kind == "dsp" or kind in baseline.NEEDS_WAV) and not have_wav:
                log(f"SKIP {v['name']} x {aname}: wav not found ({wav})")
                continue
            t0 = time.perf_counter()
            if kind == "dsp":
                result = dsp(wav)  # never sees the truth
            else:
                result = baseline.ANALYZERS2[kind](truth, wav)
            scores = S.score(truth, result)
            timings[(v["name"], aname)] = time.perf_counter() - t0
            with open(os.path.join(results_dir, f"{v['name']}.{aname}.json"), "w") as f:
                json.dump({"result": result, "score": scores}, f, indent=2, ensure_ascii=False)
            rows.append({"variant": v["name"], "analyzer": aname, "song": v["song"], "level": v["level"],
                         "heldOut": v["heldOut"], "values": [_get(scores, p) for _, p in COLUMNS]})
    header = ["variant", "analyzer"] + [c for c, _ in COLUMNS]
    with open(os.path.join(results_dir, "summary.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header + ["song", "level", "heldOut"])
        for r in rows:
            w.writerow([r["variant"], r["analyzer"]]
                       + ["" if x is None else (str(x) if isinstance(x, int) else f"{x:.4f}") for x in r["values"]]
                       + [r["song"], r["level"], int(r["heldOut"])])
    lines = ["# 採点結果の一覧", "", "| " + " | ".join(header) + " |",
             "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        lines.append("| " + " | ".join([r["variant"], r["analyzer"]] + [_fmt(x) for x in r["values"]]) + " |")
    with open(os.path.join(results_dir, "summary.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(results_dir, "summary.levels.md"), "w") as f:
        f.write(levels_markdown(rows))
    return rows, timings


def group_means(rows, keyfn):
    """{key: (n_variants, [mean per COLUMN or None])}; None values are ignored in each mean."""
    groups = {}
    for r in rows:
        groups.setdefault(keyfn(r), []).append(r)
    out = {}
    for k, rs in groups.items():
        means = []
        for i in range(len(COLUMNS)):
            vals = [r["values"][i] for r in rs if r["values"][i] is not None]
            means.append(sum(vals) / len(vals) if vals else None)
        out[k] = (len(rs), means)
    return out


def _table(title, label, groups, sortkey):
    header = [label, "analyzer", "n"] + [c for c, _ in COLUMNS]
    lines = [f"### {title}", "", "| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for k in sorted(groups, key=sortkey):
        n, means = groups[k]
        lines.append("| " + " | ".join([str(k[0]), k[1], str(n)] + [_fmt(x) for x in means]) + " |")
    return lines + [""]


def levels_markdown(rows):
    tuned = [r for r in rows if not r["heldOut"]]
    held = [r for r in rows if r["heldOut"]]
    lk = lambda k: (_level_key(k[0]), k[1])
    sk = lambda k: (k[0], k[1])
    lines = ["# レベル別・曲別の平均", "",
             "調整に使う変化形のみの平均（ホールドアウトは除く）。n は変化形の数。値が無い項目は平均から除く。", ""]
    lines += _table("レベル別（調整用）", "level", group_means(tuned, lambda r: (r["level"], r["analyzer"])), lk)
    lines += _table("曲ごと（調整用）", "song", group_means(tuned, lambda r: (r["song"], r["analyzer"])), sk)
    lines += ["## ホールドアウト（平均に含めない）", ""]
    if not held:
        lines += ["なし", ""]
    else:
        lines += _table("レベル別", "level", group_means(held, lambda r: (r["level"], r["analyzer"])), lk)
        header = ["variant", "analyzer", "level"] + [c for c, _ in COLUMNS]
        lines += ["### 変化形ごと", "", "| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
        for r in sorted(held, key=lambda r: (r["variant"], r["analyzer"])):
            lines.append("| " + " | ".join([r["variant"], r["analyzer"], r["level"]] + [_fmt(x) for x in r["values"]]) + " |")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    default_out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "out")
    ap.add_argument("--out", default=default_out)
    ap.add_argument("--analyzers", default=",".join(DEFAULT_ANALYZERS),
                    help="comma list from constant,oracle,mode-chord,dsp-v1")
    ap.add_argument("--only", help="glob on the variant name")
    ap.add_argument("--dsp-config", help="JSON file with (partial) dsp Config overrides")
    ap.add_argument("--dsp-name", default="dsp-v1", help="analyzer name used in the output files/tables")
    args = ap.parse_args(argv)
    t0 = time.perf_counter()
    rows, timings = run_all(args.out, [a for a in args.analyzers.split(",") if a], args.only,
                            args.dsp_config, args.dsp_name)
    print(f"scored {len(rows)} (variant x analyzer) in {time.perf_counter() - t0:.2f} s")
    print(f"wrote {os.path.join(args.out, 'results', 'summary.md')} (+ summary.csv, summary.levels.md)")


if __name__ == "__main__":
    sys.exit(main())
