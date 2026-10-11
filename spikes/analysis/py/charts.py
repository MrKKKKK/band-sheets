"""Chord-chart-only private songs (task T28): register + prepare charts for the renderer.

Usage (from spikes/analysis):  python py/charts.py [--charts recordings/charts] [--out out] [--dry-run]
then render in the devcontainer:  npx tsx render/chartsCli.ts   (writes out/charts/*.wav + truth + manifest.charts.json)

The user writes one  <anyname>.txt  per song into recordings/charts/ (the same format as the recording intake .txt,
see parse_txt in py/intake.py; `弾き方`/`開始` are not needed, a `キー: D` line between bar lines marks a modulation).
For every chart this script
  1. parses + validates it (all errors Japanese and line-numbered; the file name is never printed),
  2. gives it an anonymous id chart-NN (recordings/charts/ids.local.json, gitignored) and decides heldOut
     (every 4th id: chart-04, chart-08 ...) BEFORE any analysis; one "register" line goes to
     out/results/heldout-log.jsonl,
  3. writes recordings/charts/chart-NN.song.json, the internal song file of the renderer: tempo, time signature,
     pickup, bars of [chord, eighths] with every chord reduced to what the renderer can play (C6 -> C, Dm9 -> Dm7,
     G7(#9) -> G7, N.C. kept as "N.C."), key runs, heldOut,
  4. runs privacy_check.
Nothing of a chart (name, chords) is printed or written to any tracked place.
"""
import argparse
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import intake as I  # noqa: E402
import rec_truth as RT  # noqa: E402

IDS_FILE = "ids.local.json"
HELD_OUT_EVERY = 4  # chart-04, chart-08 ... are held out (decided from the id alone, before any analysis)
LEVEL = "CH"
EXT = re.compile(r"7|9|11|13")


def simplify_chord(text):
    """-> chord text the renderer can play (render/chordSymbol.ts qualities), or 'N.C.'. Reductions: 6 / add9 / 5 ->
    triad; 9 / 11 / 13 / 7(#9) -> 7; m9 / m11 / m13 -> m7; m6 / m(maj7) -> m; maj9 / maj13 -> maj7; sus2 -> sus4;
    dim7 stays, ø -> m7b5. The slash bass is kept. Raises ValueError for an unreadable chord."""
    if text.strip().upper() in ("N.C.", "N"):
        return "N.C."
    root, _, bass = RT.parse_chord(text)
    m = re.fullmatch(r"([A-G][#b]?)([^/]*)(?:/([A-G][#b]?))?", text.strip())
    s = m.group(2)
    low = s.lower()
    if "m7b5" in low or "ø" in s or "m7-5" in low:
        out = "m7b5"
    elif low.startswith("dim") or "°" in s:
        out = "dim7" if "7" in s else "dim"
    elif "aug" in low or s.startswith("+"):
        out = "aug"
    elif "sus" in low:
        out = "sus4"
    elif low.startswith("maj") or (s.startswith("M") and not s.startswith("m")):
        out = "maj7" if EXT.search(s) else ""
    elif low.startswith("mmaj") or low.startswith("m(maj"):
        out = "m"
    elif s.startswith("m") or s.startswith("-"):
        out = "m7" if EXT.search(s) and "add" not in low else "m"
    elif EXT.search(s) and "add" not in low:
        out = "7"
    else:
        out = ""
    return root + out + (f"/{bass}" if bass else "")


def _load_ids(d):
    p = os.path.join(d, IDS_FILE)
    if os.path.exists(p):
        return json.load(open(p, encoding="utf-8"))
    return {"version": 1, "charts": {}}


def _save_ids(d, ids):
    with open(os.path.join(d, IDS_FILE), "w", encoding="utf-8") as f:
        json.dump(ids, f, indent=1, ensure_ascii=False)


def is_held_out(chart_id):
    """chart-NN is held out when NN is a multiple of HELD_OUT_EVERY (deterministic, from the id alone)."""
    return int(chart_id.split("-")[1]) % HELD_OUT_EVERY == 0


def register(d, original, now=None):
    """-> (id, is_new). The same original file name keeps its id (and so its heldOut) for good."""
    ids = _load_ids(d)
    for cid, e in ids["charts"].items():
        if e["original"] == original:
            return cid, False
    n = 1
    while f"chart-{n:02d}" in ids["charts"]:
        n += 1
    cid = f"chart-{n:02d}"
    ids["charts"][cid] = {"original": original, "heldOut": is_held_out(cid),
                          "registeredAt": now or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    _save_ids(d, ids)
    return cid, True


def _log_register(out, cid, held_out):
    d = os.path.join(out, "results")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "heldout-log.jsonl"), "a") as f:
        f.write(json.dumps({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                            "kind": "register", "take": cid, "heldOut": held_out, "level": LEVEL,
                            "variants": [f"{cid}-block", f"{cid}-rec", f"{cid}-rechard"]}) + "\n")


def to_song(ann):
    """parse_txt annotation -> the renderer's song dict (without id / heldOut)."""
    num = ann["timeSignature"][0]
    pickup = int(ann.get("pickupBeats", 0))
    if pickup and num != 4:
        raise I.IntakeError("弱起は 4/4 の曲だけ使えます")
    bars = [[[simplify_chord(t), n] for t, n in bar] for bar in ann["bars"]]
    if all(t == "N.C." for bar in bars for t, _ in bar):
        raise I.IntakeError("コードが 1 つもありません(N.C. だけです)")
    keys = ann.get("keys") or ([{"startBar": 0, "key": ann["key"]}] if ann.get("key") else [])
    return {"version": 1, "tempo": ann["tempo"], "timeSignature": [num, 4], "eighthsPerBar": ann["eighthsPerBar"],
            "pickupBeats": pickup, "bars": bars, "keys": keys}


def n_simplified(ann):
    return sum(1 for bar in ann["bars"] for t, _ in bar if t.strip().upper() not in ("N.C.", "N") and simplify_chord(t) != t)


def process(charts_dir, out, dry_run=False, log=print):
    """Returns the number of charts that failed."""
    os.makedirs(charts_dir, exist_ok=True)
    names = sorted(fn for fn in os.listdir(charts_dir)
                   if fn.lower().endswith(".txt") and not fn.startswith(".")
                   and os.path.isfile(os.path.join(charts_dir, fn)))
    if not names:
        log("charts フォルダが空です。コード進行の .txt を入れてください。")
        return 0
    fails = 0
    for i, fn in enumerate(names, 1):
        try:
            ann = I.parse_txt(open(os.path.join(charts_dir, fn), encoding="utf-8").read(), require_style=False)
            song = to_song(ann)
        except (I.IntakeError, ValueError, UnicodeDecodeError) as e:
            fails += 1
            log(f"[{i}番目のファイル] 読めませんでした: {e}")
            continue
        if dry_run:
            log(f"[{i}番目のファイル] OK ({len(song['bars'])} 小節)")
            continue
        cid, new = register(charts_dir, os.path.splitext(fn)[0])
        held = is_held_out(cid)
        if new:
            _log_register(out, cid, held)
        song.update(id=cid, heldOut=held)
        with open(os.path.join(charts_dir, cid + ".song.json"), "w") as f:
            json.dump(song, f, indent=1)
        simp = n_simplified(ann)
        log(f"{cid}: {len(song['bars'])} 小節、{'ホールドアウト' if held else '開発用'}"
            + (f"、{simp} 個のコードを簡略化" if simp else "") + (" (新規)" if new else " (更新)"))
    return fails


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--charts", default="recordings/charts")
    ap.add_argument("--out", default="out")
    ap.add_argument("--dry-run", action="store_true", help="only check the .txt files; register / write nothing")
    ap.add_argument("--privacy-root", default=None, help="scan this tree instead of the repository (tests)")
    ap.add_argument("--no-privacy-check", action="store_true")
    a = ap.parse_args(argv)
    fails = process(a.charts, a.out, a.dry_run)
    if not a.no_privacy_check and not a.dry_run:
        import privacy_check
        rec_dir = os.path.dirname(os.path.abspath(a.charts))
        rc = privacy_check.main(["--recordings", rec_dir] + (["--root", a.privacy_root, "--no-log"] if a.privacy_root else []))
        if rc:
            return rc
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
