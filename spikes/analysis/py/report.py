"""Error analysis report for audio analysis spike 1 (docs/audio-spike1-plan.md, decision 8).

Usage: python py/report.py [--out out] [--analyzer dsp-v1] [--only GLOB] [--plots NAME[,NAME...]]
Reads  out/results/<variant>.<analyzer>.json ({result, score}) and the truth JSONs named by the manifests
       (out/manifest.json, out/derived/manifest.derived.json, out/rec/manifest.rec.json).
Writes out/results/report.md and out/results/plots/<variant>.<analyzer>.png (all under out/, git-ignored).

Scoring (Q6): like score.py, each truth beat is sampled at 1/4 and 3/4 of its window (weight 1/2 each), so counts
are weighted sums in beats. Level M (mid-bar starts) is shown in its own level row only; the overall and per-song
tables leave it out. Level REC (private recordings, R17) is shown as "REC": no chord names and no recording names
anywhere in the report; mistakes are listed by kind only (e.g. "mistaken for a fifth above").
Plots (R17): the variants named by --plots (default DEFAULT_PLOTS), plus the first variant of levels LR and REC.

Chord categories (truth classes maj/min only, like score.py):
  correct   same root and maj/min class
  parallel  same root, other class (C vs Cm)
  relative  relative major/minor (C vs Am, Am vs C)
  fifth     roots a fifth/fourth apart, IV/V (C vs G, C vs F, also with other class)
  other     anything else (also a result chord of a class other than maj/min)
  missed    result has no chord at that time
"""
import argparse
import bisect
import fnmatch
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score as S  # noqa: E402

CATEGORIES = ["correct", "parallel", "relative", "fifth", "other", "missed"]
CAT_JA = {
    "correct": "正解",
    "parallel": "ルート同じで長短違い(同主調)",
    "relative": "平行調(長短の相対)",
    "fifth": "5度/4度違い",
    "other": "その他",
    "missed": "コード無し",
}
N_BINS = 5
EXCLUDED_FROM_TOTALS = ("M",)  # Q6: shown by level only
ANON_LEVELS = ("REC",)  # R17: no chord names / recording names
SAMPLE_FRACTIONS = (0.25, 0.75)  # as score.py (R6); each sample weighs 1/2
DEFAULT_PLOTS = ["full-t116-straight", "full-t116-straight__l2-rev06", "etude2-full-t90-straight"]
ALWAYS_PLOT_LEVELS = ("LR", "REC")
KIND_JA = {
    "fifth_up": "5度上と取り違え",
    "fifth_down": "4度上(5度下)と取り違え",
    "relative": "平行調と取り違え",
    "parallel": "同主調(長短違い)と取り違え",
    "other": "その他",
    "missed": "コード無し",
}
KINDS = list(KIND_JA)
TEMPO_TOL = 0.08
_NAMES = S._SHARP_NAMES


def chord_label(pc, cls):
    return _NAMES[pc] + ("m" if cls == "min" else "")


def classify_pair(truth, result):
    """truth: (root_pc, 'maj'|'min'); result: same or None (no chord). -> category key."""
    if result is None:
        return "missed"
    tr, tc = truth
    rr, rc = result
    if rc not in ("maj", "min"):
        return "other"
    if tr == rr:
        return "correct" if tc == rc else "parallel"
    if tc == "maj" and rc == "min" and rr == (tr - 3) % 12:
        return "relative"
    if tc == "min" and rc == "maj" and rr == (tr + 3) % 12:
        return "relative"
    if (rr - tr) % 12 in (5, 7):
        return "fifth"
    return "other"


def error_kind(truth, result):
    """Kind of a mistake without chord names (R17); None when correct."""
    cat = classify_pair(truth, result)
    if cat == "correct":
        return None
    if cat == "fifth":
        return "fifth_up" if (result[0] - truth[0]) % 12 == 7 else "fifth_down"
    return cat


def _key(c):
    return S.note_to_pc(c["root"]), S.quality_class(c["quality"])


def chord_beats(truth, result):
    """[(truth_key, result_key|None, confidence|None, text, weight)] per scored sample (two per truth beat, 1/2 each)."""
    tc, rc, tb = truth.get("chords"), result.get("chords"), truth.get("beats")
    if not tc or rc is None or not tb or len(tb) < 2:
        return []
    ttrack, rtrack = S._ChordTrack(tc), S._ChordTrack(rc)
    out = []
    for t0, _, _, t1 in S._beat_windows(tb):
        for f in SAMPLE_FRACTIONS:
            tm = t0 + f * (t1 - t0)
            t = ttrack.at(tm)
            if t is None:
                continue
            tk = _key(t)
            if tk[1] is None:
                continue
            r = rtrack.at(tm)
            out.append((tk, _key(r) if r is not None else None,
                        None if r is None else r.get("confidence"), "" if r is None else str(r.get("text") or ""),
                        1.0 / len(SAMPLE_FRACTIONS)))
    return out


def confusion(beats):
    cats = Counter()
    pairs = Counter()
    for tk, rk, _, _, w in beats:
        cat = classify_pair(tk, rk)
        cats[cat] += w
        if cat != "correct":
            pairs[(chord_label(*tk), "N" if rk is None else chord_label(rk[0], rk[1] or "?"))] += w
    return cats, pairs


def kind_counts(beats):
    """Weighted count of mistakes by kind (no chord names)."""
    kinds = Counter()
    for tk, rk, _, _, w in beats:
        k = error_kind(tk, rk)
        if k:
            kinds[k] += w
    return kinds


def calibration(beats, n_bins=N_BINS):
    """Per confidence bin [i/n, (i+1)/n): [n, hits]. Beats without a result chord or confidence are skipped."""
    bins = [[0, 0] for _ in range(n_bins)]
    for tk, rk, conf, _, w in beats:
        if rk is None or conf is None:
            continue
        i = min(n_bins - 1, max(0, int(float(conf) * n_bins)))
        bins[i][0] += w
        bins[i][1] += w * (classify_pair(tk, rk) == "correct")
    return bins


def question_split(beats):
    """{'?': [n, hits], 'plain': [n, hits]} by whether the result text ends with '?'."""
    out = {"?": [0, 0], "plain": [0, 0]}
    for tk, rk, _, text, w in beats:
        if rk is None:
            continue
        k = "?" if text.endswith("?") else "plain"
        out[k][0] += w
        out[k][1] += w * (classify_pair(tk, rk) == "correct")
    return out


def phase_error(truth, result):
    """Beats the detected downbeats are off from the truth bar position: {offset: count}, or None.

    Each result beat is matched to the nearest truth beat (within 40% of the median beat interval);
    a matched result downbeat on truth bar position p is p beats off. The variant's phase error is the mode.
    """
    tb = sorted(truth.get("beats") or [], key=lambda b: b["t"])
    rb = sorted(result.get("beats") or [], key=lambda b: b["t"])
    if len(tb) < 2 or not rb or not any("downbeat" in b for b in rb):
        return None
    ts = [b["t"] for b in tb]
    med = S._median_interval(ts)
    num = int((truth.get("timeSignature") or {}).get("num", 4)) or 4
    pos, cur = [], None
    for i, b in enumerate(tb):  # truth bar position
        if b.get("beat") is not None:
            cur = int(b["beat"])
        elif b.get("downbeat"):
            cur = 0
        else:
            cur = 0 if cur is None else (cur + 1) % num
        pos.append(cur)
    hist = Counter()
    for b in rb:
        if not b.get("downbeat"):
            continue
        j = bisect.bisect_left(ts, b["t"])
        cand = [k for k in (j - 1, j) if 0 <= k < len(ts)]
        k = min(cand, key=lambda k: abs(ts[k] - b["t"]))
        if abs(ts[k] - b["t"]) <= 0.4 * med:
            hist[pos[k] % num] += 1
    if not hist:
        return None
    return dict(hist)


def phase_mode(hist):
    return None if not hist else max(sorted(hist), key=lambda k: hist[k])


def tempo_class(truth, result):
    """'ok' | 'double' (result beats twice as dense) | 'half' | 'other' | None."""
    tm = S._median_interval(sorted(b["t"] for b in truth.get("beats") or []))
    rm = S._median_interval(sorted(b["t"] for b in result.get("beats") or []))
    if not tm or not rm:
        return None
    r = rm / tm
    if abs(r - 1) <= TEMPO_TOL:
        return "ok"
    if abs(r - 0.5) <= 0.5 * TEMPO_TOL:
        return "double"
    if abs(r - 2) <= 2 * TEMPO_TOL:
        return "half"
    return "other"


def analyze_variant(truth, result):
    beats = chord_beats(truth, result)
    cats, pairs = confusion(beats)
    return {"n": sum(b[4] for b in beats), "cats": cats, "pairs": pairs, "kinds": kind_counts(beats),
            "calib": calibration(beats),
            "qsplit": question_split(beats), "phase": phase_error(truth, result),
            "tempo": tempo_class(truth, result)}


# ---------------- aggregation ----------------

def aggregate(items):
    agg = {"variants": 0, "n": 0, "cats": Counter(), "pairs": Counter(), "kinds": Counter(), "calib": [[0, 0] for _ in range(N_BINS)],
           "qsplit": {"?": [0, 0], "plain": [0, 0]}, "phase": Counter(), "phaseVariants": Counter(),
           "tempo": Counter()}
    for a in items:
        agg["variants"] += 1
        agg["n"] += a["n"]
        agg["cats"].update(a["cats"])
        agg["pairs"].update(a["pairs"])
        agg["kinds"].update(a["kinds"])
        for i, (n, h) in enumerate(a["calib"]):
            agg["calib"][i][0] += n
            agg["calib"][i][1] += h
        for k in ("?", "plain"):
            agg["qsplit"][k][0] += a["qsplit"][k][0]
            agg["qsplit"][k][1] += a["qsplit"][k][1]
        if a["phase"]:
            agg["phase"].update(a["phase"])
            agg["phaseVariants"][phase_mode(a["phase"])] += 1
        if a["tempo"]:
            agg["tempo"][a["tempo"]] += 1
    return agg


# ---------------- inputs ----------------

def load_manifests(out_dir):
    """{name: {truth, song, level}} from the three manifests (missing ones are skipped)."""
    res = {}
    for rel in ("manifest.json", "derived/manifest.derived.json", "derived/manifest.trim.json", "rec/manifest.rec.json"):
        p = os.path.join(out_dir, rel)
        if not os.path.exists(p):
            continue
        with open(p) as f:
            m = json.load(f)
        for v in (m["variants"] if isinstance(m, dict) else m):
            truth = v.get("truth") or (os.path.splitext(v["wav"])[0] + ".truth.json" if v.get("wav") else None)
            name = v.get("name") or (os.path.basename(truth).replace(".truth.json", "") if truth else None)
            if name:
                res[name] = {"truth": truth, "song": v.get("song", ""),
                             "level": str(v.get("level", 0 if rel == "manifest.json" else "?")),
                             "heldOut": bool(v.get("heldOut", False))}
    return res


def load_results(out_dir, analyzer, only=None):
    """[(variant, result_path)] for results/<variant>.<analyzer>.json."""
    d = os.path.join(out_dir, "results")
    suffix = f".{analyzer}.json"
    out = []
    for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if fn.endswith(suffix):
            name = fn[:-len(suffix)]
            if not only or fnmatch.fnmatch(name, only):
                out.append((name, os.path.join(d, fn)))
    return out


def _level_key(l):
    return (0, int(l), "") if str(l).isdigit() else (1, 0, str(l))


# ---------------- timeline PNG ----------------

def plot_timeline(truth, result, path, title="", dpi=80):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle

    fig, axes = plt.subplots(3, 1, figsize=(20, 5.5), dpi=dpi, sharex=True,
                             gridspec_kw={"height_ratios": [3, 3, 2]})
    cmap = plt.get_cmap("hsv")

    def draw_chords(ax, chords, label):
        for c in chords or []:
            if S.is_no_chord(c):
                continue
            pc = S.note_to_pc(c["root"])
            cls = S.quality_class(c["quality"])
            col = cmap(pc / 12.0)
            alpha = 0.45 if cls == "min" else 0.9
            ax.add_patch(Rectangle((c["start"], 0), c["end"] - c["start"], 1, facecolor=col, alpha=alpha,
                                   edgecolor="white", linewidth=0.5))
            if c["end"] - c["start"] > 0.8:
                ax.text((c["start"] + c["end"]) / 2, 0.5, str(c.get("text") or chord_label(pc, cls or "maj")),
                        ha="center", va="center", fontsize=7)
        ax.set_ylim(0, 1)
        ax.set_yticks([])
        ax.set_ylabel(label, rotation=0, ha="right", va="center")

    draw_chords(axes[0], truth.get("chords"), "truth chords")
    draw_chords(axes[1], result.get("chords"), "detected chords")
    ax = axes[2]
    for y, bl, lab in ((0.75, truth.get("beats"), "truth beats"), (0.25, result.get("beats"), "detected beats")):
        for b in bl or []:
            h = 0.4 if b.get("downbeat") else 0.2
            ax.plot([b["t"], b["t"]], [y - h / 2, y + h / 2], color="k" if b.get("downbeat") else "gray",
                    linewidth=1.2 if b.get("downbeat") else 0.5)
        ax.text(-0.005, y, lab, transform=ax.get_yaxis_transform(), ha="right", va="center", fontsize=9)
    ax.set_ylim(0, 1)
    ax.set_yticks([])
    for a_, secs in ((axes[0], truth.get("sections")), (axes[1], result.get("sections"))):
        for s in secs or []:
            for a2 in (a_, ax) if a_ is axes[1] else (a_,):
                a2.axvline(s["start"], color="red", linestyle="--", linewidth=0.8)
            a_.text(s["start"] + 0.1, 0.95, str(s.get("label", "")), color="red", fontsize=8, va="top")
    ends = [c["end"] for c in (truth.get("chords") or [])] + [b["t"] for b in (truth.get("beats") or [])]
    if ends:
        ax.set_xlim(0, max(ends))
    ax.set_xlabel("time (s)")
    fig.suptitle(title)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fig.savefig(path, dpi=dpi)
    plt.close(fig)
    return path


# ---------------- markdown ----------------

def _pct(n, d):
    return "-" if not d else f"{100.0 * n / d:.1f}%"


def _num(x):
    return f"{x:g}"


def _level_label(l):
    return l if l in ANON_LEVELS or not str(l).isdigit() and l != "?" else f"L{l}"


def _display_name(level, name, idx):
    """R17: private recordings are shown as REC-<n>, never by their variant name."""
    return f"REC-{idx}" if level in ANON_LEVELS else name


def _cat_table(rows):
    """rows: [(label, agg)]"""
    head = "| 対象 | 変化形数 | 拍数 | " + " | ".join(CAT_JA[c] for c in CATEGORIES) + " |"
    lines = [head, "|" + "---|" * (3 + len(CATEGORIES))]
    for label, a in rows:
        lines.append(f"| {label} | {a['variants']} | {_num(a['n'])} | "
                     + " | ".join(_pct(a["cats"][c], a["n"]) for c in CATEGORIES) + " |")
    return lines


def _calib_table(a):
    lines = ["| 確信度 | 拍数 | 正解率 |", "|---|---|---|"]
    for i, (n, h) in enumerate(a["calib"]):
        lines.append(f"| {i / N_BINS:.1f}-{(i + 1) / N_BINS:.1f} | {_num(n)} | {_pct(h, n)} |")
    q, p = a["qsplit"]["?"], a["qsplit"]["plain"]
    lines += ["", f"`?` 付きの拍: {_num(q[0])} 拍、正解率 {_pct(q[1], q[0])} / `?` 無し: {_num(p[0])} 拍、正解率 {_pct(p[1], p[0])}"]
    return lines


def _question_table(rows):
    """rows: [(label, agg)] -> error rate by whether the result chord is flagged `?`."""
    lines = ["| 対象 | `?` 付きの拍 | `?` 付きの誤り率 | `?` 無しの拍 | `?` 無しの誤り率 |", "|---|---|---|---|---|"]
    for label, a in rows:
        q, p = a["qsplit"]["?"], a["qsplit"]["plain"]
        lines.append(f"| {label} | {_num(q[0])} | {_pct(q[0] - q[1], q[0])} | {_num(p[0])} | {_pct(p[0] - p[1], p[0])} |")
    return lines


def _kind_table(rows):
    """rows: [(label, agg)] -> mistakes by kind (shares of scored beats); no chord names."""
    lines = ["| 対象 | 拍数 | 誤り計 | " + " | ".join(KIND_JA[k] for k in KINDS) + " |", "|" + "---|" * (3 + len(KINDS))]
    for label, a in rows:
        lines.append(f"| {label} | {_num(a['n'])} | {_pct(sum(a['kinds'].values()), a['n'])} | "
                     + " | ".join(_pct(a["kinds"][k], a["n"]) for k in KINDS) + " |")
    return lines


def build_report(out_dir, analyzer, only=None, plots=None, log=print):
    manifests = load_manifests(out_dir)
    entries = []  # (name, level, song, truth, result, analysis); tuned variants only
    held_entries = []  # same, held-out variants: reported separately
    for name, rpath in load_results(out_dir, analyzer, only):
        meta = manifests.get(name)
        if not meta or not meta["truth"] or not os.path.exists(os.path.join(out_dir, meta["truth"])):
            log(f"SKIP {name}: truth not found")
            continue
        with open(os.path.join(out_dir, meta["truth"])) as f:
            truth = json.load(f)
        with open(rpath) as f:
            result = json.load(f)["result"]
        a = analyze_variant(truth, result)
        song = meta["song"]
        if meta["level"] in ANON_LEVELS:
            a["pairs"] = Counter()  # R17: no chord names for private recordings
            song = "REC"
        e = (name, meta["level"], song, truth, result, a)
        (held_entries if meta["heldOut"] else entries).append(e)  # held-out never enters the main tables (R10)
    levels = sorted({e[1] for e in entries}, key=_level_key)
    by_level = {l: aggregate([e[5] for e in entries if e[1] == l]) for l in levels}
    scored = [e for e in entries if e[1] not in EXCLUDED_FROM_TOTALS]  # Q6: M only in the level rows
    songs = sorted({e[2] for e in scored})
    by_song = {s: aggregate([e[5] for e in scored if e[2] == s]) for s in songs}
    total = aggregate([e[5] for e in scored])
    disp = {}  # variant name -> name shown in the report
    for lv in ANON_LEVELS:
        for i, e in enumerate([e for e in entries + held_entries if e[1] == lv], 1):
            disp[e[0]] = _display_name(lv, e[0], i)

    L = [f"# 誤りの分析 ({analyzer})", "",
         f"対象: {len(entries)} 変化形(ホールドアウト {len(held_entries)} 本は別集計)。拍ごとに 1/4 と 3/4 の 2 点(重み 1/2 ずつ)で、正解コードのある点だけ解析のコードと比べる(長短のある3和音のみ。数は拍単位の重み付き和)。レベル M は「全体」と曲別に含めない。", ""]
    L += ["## レベル別の概要", ""] + _cat_table([(_level_label(l), by_level[l]) for l in levels] + [("全体", total)]) + [""]
    L += ["## 曲(song)別", ""] + _cat_table([(s or "(不明)", by_song[s]) for s in songs]) + [""]
    L += ["## 変化形ごとの取り違え", ""] + _cat_table(
        [(disp.get(e[0], e[0]), aggregate([e[5]])) for e in entries]) + [""]
    L += ["## 取り違えの多い組(上位10、全体)", "", "| 正解 → 解析 | 拍数 |", "|---|---|"]
    for (t, r), n in total["pairs"].most_common(10):
        L.append(f"| {t} → {r} | {_num(n)} |")
    for l in levels:
        if l in ANON_LEVELS:
            continue  # REC: kinds only (see the kind table)
        L += ["", f"### {_level_label(l)} の上位10", "", "| 正解 → 解析 | 拍数 |", "|---|---|"]
        for (t, r), n in by_level[l]["pairs"].most_common(10):
            L.append(f"| {t} → {r} | {_num(n)} |")
    L += ["", "## 取り違えの種類(コード名なし)", "",
          "誤りの拍数を、種類ごとに全拍数に対する割合で示す。LR と REC は特に見る。", ""]
    L += _kind_table([(_level_label(l), by_level[l]) for l in levels] + [("全体", total)])
    L += ["", "## `?` の有無ごとの誤り率", "",
          "解析のコードのテキストが `?` で終わる拍と、そうでない拍の誤り率(コード無しの拍は除く)。", ""]
    L += _question_table([(_level_label(l), by_level[l]) for l in levels] + [("全体", total)])
    L += ["", "## 確信度ごとの正解率(全体)", ""] + _calib_table(total)
    for l in levels:
        L += ["", f"### {_level_label(l)}", ""] + _calib_table(by_level[l])
    L += ["", "## ホールドアウト(別集計、上の表・全体には含めない)", ""]
    if held_entries:
        hlevels = sorted({e[1] for e in held_entries}, key=_level_key)
        L += _cat_table([(_level_label(l), aggregate([e[5] for e in held_entries if e[1] == l])) for l in hlevels]
                        + [(disp.get(e[0], e[0]), aggregate([e[5]])) for e in held_entries])
    else:
        L += ["なし"]
    L += ["", "## 小節の頭の位相のずれ", "",
          "変化形ごとの最頻のずれ(解析の小節頭が正解の小節の何拍目に当たるか)の変化形数。括弧内は小節頭ごとの拍数。", "",
          "| レベル | 0拍 | 1拍 | 2拍 | 3拍 |", "|---|---|---|---|---|"]
    for l, a in list(by_level.items()) + [("全体", total)]:
        L.append(f"| {_level_label(l) if l in by_level else l} | " + " | ".join(
            f"{a['phaseVariants'][k]} ({a['phase'][k]})" for k in range(4)) + " |")
    L += ["", "## テンポのオクターブ誤り", "",
          "解析の拍間隔の中央値 / 正解 が 0.5 付近=倍(double)、2 付近=半分(half)。", "",
          "| レベル | 一致 | 倍 | 半分 | その他 |", "|---|---|---|---|---|"]
    for l, a in list(by_level.items()) + [("全体", total)]:
        t = a["tempo"]
        L.append(f"| {_level_label(l) if l in by_level else l} | {t['ok']} | {t['double']} | {t['half']} | {t['other']} |")

    want = list(DEFAULT_PLOTS if plots is None else plots)
    chosen, seen = [], set()
    for n in want:
        for e in entries + held_entries:
            if e[0] == n and n not in seen:
                chosen.append(e)
                seen.add(n)
    for lv in ALWAYS_PLOT_LEVELS:
        first = [e for e in entries + held_entries if e[1] == lv]
        if first and not any(c[1] == lv for c in chosen):
            chosen.append(first[0])
    plot_files = []
    plot_dir = os.path.join(out_dir, "results", "plots")
    for name, lv, _, truth, result, _ in chosen:
        shown = disp.get(name, name)
        fn = f"{shown}.{analyzer}.png"
        try:
            plot_timeline(truth, result, os.path.join(plot_dir, fn), title=f"{shown} ({analyzer})")
            plot_files.append((lv, shown, fn))
        except Exception as ex:  # a plot failure must not lose the report
            log(f"plot failed for {shown}: {ex}")
    L += ["", "## 時間軸の図", ""]
    for lv, shown, fn in plot_files:
        L += [f"### {_level_label(lv)} {shown}", "", f"![{shown}](plots/{fn})", ""]
    md = "\n".join(L) + "\n"
    with open(os.path.join(out_dir, "results", "report.md"), "w") as f:
        f.write(md)
    return md


def main(argv=None):
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=os.path.join(here, "out"))
    ap.add_argument("--analyzer", default="dsp-v1")
    ap.add_argument("--only")
    ap.add_argument("--plots", help="comma-separated variant names to plot (default: representatives)")
    args = ap.parse_args(argv)
    build_report(args.out, args.analyzer, args.only, args.plots.split(",") if args.plots else None)
    print(os.path.join(args.out, "results", "report.md"))


if __name__ == "__main__":
    sys.exit(main())
