"""Run every baseline analyzer on every variant in out/manifest.json and score it.

Usage: python py/run_all.py [--out DIR] [--analyzers constant,oracle,mode-chord,dsp-v1] [--only GLOB]
                            [--dsp-config x.json] [--dsp-name dsp-v1] [--include-held-out]
Held-out variants (manifest "heldOut": true) are SKIPPED unless --include-held-out is given, and that flag is
refused together with --dsp-config: held-out data may only be run with the default (frozen) config, never in a
tuning / selection loop (R10).
(DIR defaults to <spikes/analysis>/out). Analyzers get (truth, wav_path); dsp-v1 is given ONLY the wav path.

Three manifests are read (only manifest.json is required; paths relative to DIR):
  manifest.json                 base variants (level 0 unless an entry has "level")
  derived/manifest.derived.json bare list of {name, song, base, level, heldOut, degrade, wav, truth}
  derived/manifest.trim.json    bare list, mid-bar-start variants from py/midbar.py (level "M")
  rec/manifest.rec.json         {"variants": [{name, song:"rec", level:"REC", heldOut, wav, truth}]}

Assumed manifest shape (T6 should match; paths are relative to DIR):
  {"variants": [{"name": "full-t116-shuffle", "song": "saints", "mix": "full",
                 "wav": "saints/full-t116-shuffle.wav",
                 "truth": "saints/full-t116-shuffle.truth.json", ...}]}
Unknown extra fields are ignored. Only "name" and "truth" are required; "name" falls back to the truth file stem,
"truth" falls back to the wav path with .wav -> .truth.json. A bare list is also accepted.

Writes DIR/results/<variant>.<analyzer>.json (result + score), summary.md, summary.csv, summary.levels.md,
run-info.json (commit, dirty flag, config hash of this run: R19).
--only re-runs the matching variants and rewrites the summaries together with the stored results of the other
variants (R15). The phase-0 comparison row is named "<dsp-name>-phase0" ("dsp-phase0" for the default dsp-v1, Q3).
Any run that scores a held-out variant or a private-recording ("REC") variant appends one line per kind to
DIR/results/heldout-log.jsonl (time, commit, dirty flag, config hash, variants) and warns when the same config
hash was already logged for that kind (Q1).
"""
import argparse
import csv
import datetime
import fnmatch
import hashlib
import json
import os
import subprocess
import sys
import time
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import baseline  # noqa: E402
import score as S  # noqa: E402

# R19: matplotlib 3.8.4 + pyparsing 3.3 print many deprecation warnings that hide real ones (behaviour is fine)
warnings.filterwarnings("ignore", message=".*pyparsing.*")
warnings.filterwarnings("ignore", category=DeprecationWarning, module=r"matplotlib.*")

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
    ("beats outside (before)", ("beats", "nEstOutsideBefore")),
    ("beats outside (after)", ("beats", "nEstOutsideAfter")),
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


MANIFESTS = [("manifest.json", 0), ("derived/manifest.derived.json", None), ("derived/manifest.trim.json", None),
             ("rec/manifest.rec.json", None)]
PHASE0 = "dsp-phase0"  # baseline: dsp-v1's beats with the downbeat phase assumed 0 (R2)
DEFAULT_ANALYZERS = ["constant", "oracle", "mode-chord", "dsp-v1", PHASE0]
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


def git_state(cwd=None):
    """{commit, dirty, diffHash} of the code that produced a run (R19, Q1); commit None outside a git checkout.
    `dirty` = uncommitted changes under py/ (the analyzer + scorer); `diffHash` fingerprints them."""
    here = os.path.dirname(os.path.abspath(__file__))
    cwd = cwd or here

    def git(*args):
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip())
        return r.stdout

    try:
        commit = git("rev-parse", "--short", "HEAD").strip()
        status = git("status", "--porcelain", "--", here)
        diff = git("diff", "HEAD", "--", here)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        return {"commit": None, "dirty": None, "diffHash": None}
    dirty = bool(status.strip())
    return {"commit": commit, "dirty": dirty,
            "diffHash": hashlib.sha256((status + diff).encode()).hexdigest()[:12] if dirty else None}


def _read_log(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def _log_looked_at(results_dir, scored, dsp_config, dsp_name, git, include_held_out, log):
    """Q1: one jsonl line per kind ("heldOut" / "rec") that this run scored; warn on a repeated config hash."""
    kinds = {"heldOut": [v["name"] for v in scored if v["heldOut"]],
             "rec": [v["name"] for v in scored if v["level"] == "REC"]}
    kinds = {k: v for k, v in kinds.items() if v}
    if not kinds:
        return
    from dsp.config import config_hash, load_config
    chash = config_hash(load_config(dsp_config))
    path = os.path.join(results_dir, "heldout-log.jsonl")
    previous = _read_log(path)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    with open(path, "a") as f:
        for kind, names in kinds.items():
            n_before = sum(1 for e in previous if e.get("kind") == kind and e.get("configHash") == chash)
            if n_before:
                log(f"WARNING: {kind} data was already looked at {n_before} time(s) with config hash {chash}; "
                    "a second look with the same config is not a new evaluation (see results/heldout-log.jsonl)")
            f.write(json.dumps({"time": now, "kind": kind, "variants": names, "commit": git.get("commit"),
                                "dirty": git.get("dirty"), "diffHash": git.get("diffHash"), "configHash": chash,
                                "dspName": dsp_name, "dspConfig": dsp_config,
                                "includeHeldOut": include_held_out}, ensure_ascii=False) + "\n")


class HeldOutError(ValueError):
    """Held-out data requested in a tuning / selection path (R10)."""


def phase0_name(dsp_name):
    return PHASE0 if dsp_name == "dsp-v1" else f"{dsp_name}-phase0"


def run_all(out_dir, analyzers=None, only=None, dsp_config=None, dsp_name="dsp-v1", log=print,
            include_held_out=False, git_info=None):
    if include_held_out and dsp_config is not None:
        raise HeldOutError("held-out variants must not be run with --dsp-config (tuning path); "
                           "evaluate them once with the default config")
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
        elif a == PHASE0:
            if "dsp-v1" not in names:
                raise ValueError(f"{PHASE0} needs dsp-v1 in --analyzers (it reuses its beats)")
            if dsp is not None and dsp.fn is None:
                continue
            active.append((phase0_name(dsp_name), "phase0"))
        elif a in baseline.ANALYZERS2:
            active.append((a, a))
        else:
            raise ValueError(f"unknown analyzer {a!r}")
    active.sort(key=lambda a: a[1] == "phase0")  # phase0 reuses the dsp result of the same variant
    rows = []
    timings = {}
    n_held_skipped = 0
    scored = []
    git = (git_info or git_state)()
    for v in load_variants(out_dir):
        if v["heldOut"] and not include_held_out:
            n_held_skipped += 1
            continue
        if only and not fnmatch.fnmatch(v["name"], only):
            # R15: keep this variant's stored rows so a partial run does not drop them from the summaries
            for aname, _ in active:
                rpath = os.path.join(results_dir, f"{v['name']}.{aname}.json")
                if os.path.exists(rpath):
                    with open(rpath) as f:
                        sc = json.load(f).get("score") or {}
                    rows.append({"variant": v["name"], "analyzer": aname, "song": v["song"], "level": v["level"],
                                 "heldOut": v["heldOut"], "values": [_get(sc, p) for _, p in COLUMNS]})
            continue
        tpath = os.path.join(out_dir, v["truth"])
        if not os.path.exists(tpath):
            log(f"SKIP {v['name']}: truth not found ({tpath})")
            continue
        with open(tpath) as f:
            truth = json.load(f)
        wav = os.path.join(out_dir, v["wav"])
        have_wav = os.path.exists(wav)
        dsp_result = None
        ran = False
        for aname, kind in active:
            if kind == "phase0" and dsp_result is None:
                continue
            if (kind == "dsp" or kind in baseline.NEEDS_WAV) and not have_wav:
                log(f"SKIP {v['name']} x {aname}: wav not found ({wav})")
                continue
            t0 = time.perf_counter()
            if kind == "dsp":
                result = dsp_result = dsp(wav)  # never sees the truth
            elif kind == "phase0":
                result = baseline.phase0_from(dsp_result, aname)  # dsp-v1 comes first in `active`
            else:
                result = baseline.ANALYZERS2[kind](truth, wav)
            scores = S.score(truth, result)
            timings[(v["name"], aname)] = time.perf_counter() - t0
            ran = True
            with open(os.path.join(results_dir, f"{v['name']}.{aname}.json"), "w") as f:
                json.dump({"result": result, "score": scores}, f, indent=2, ensure_ascii=False)
            rows.append({"variant": v["name"], "analyzer": aname, "song": v["song"], "level": v["level"],
                         "heldOut": v["heldOut"], "values": [_get(scores, p) for _, p in COLUMNS]})
        if ran:
            scored.append(v)
    _log_looked_at(results_dir, scored, dsp_config, dsp_name, git, include_held_out, log)
    with open(os.path.join(results_dir, "run-info.json"), "w") as f:
        json.dump({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                   "analyzers": [a for a, _ in active], "only": only, "dspConfig": dsp_config,
                   "includeHeldOut": include_held_out, **git}, f, indent=2)
    if n_held_skipped:
        log(f"held-out: skipped {n_held_skipped} variants (use --include-held-out for the final evaluation)")
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
    # level "M" (mid-bar starts, py/midbar.py) is a separate stress test: kept out of the per-song means
    lines += _table("曲ごと（調整用、M を除く）", "song",
                    group_means([r for r in tuned if r["level"] != "M"], lambda r: (r["song"], r["analyzer"])), sk)
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
                    help="comma list from constant,oracle,mode-chord,dsp-v1,dsp-phase0 (phase0 needs dsp-v1)")
    ap.add_argument("--only", help="glob on the variant name")
    ap.add_argument("--dsp-config", help="JSON file with (partial) dsp Config overrides")
    ap.add_argument("--include-held-out", action="store_true",
                    help="also run held-out variants (final evaluation only; refused with --dsp-config)")
    ap.add_argument("--dsp-name", default="dsp-v1", help="analyzer name used in the output files/tables")
    args = ap.parse_args(argv)
    t0 = time.perf_counter()
    rows, timings = run_all(args.out, [a for a in args.analyzers.split(",") if a], args.only,
                            args.dsp_config, args.dsp_name, include_held_out=args.include_held_out)
    print(f"scored {len(rows)} (variant x analyzer) in {time.perf_counter() - t0:.2f} s")
    print(f"wrote {os.path.join(args.out, 'results', 'summary.md')} (+ summary.csv, summary.levels.md)")


if __name__ == "__main__":
    sys.exit(main())
