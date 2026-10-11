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

Two chart formats (parse_chart): bar/dash charts (`| C | Am7 . F . |`, `|[Dm]---[Am7]- --|`) and lyric charts pasted from
ChordWiki (`[C]あいう[G]えお`, ChordPro-like; timing is derived from the lyric length, see lyric_bars). Lyrics are only
used for that timing and are never stored. A compound meter (6/8, 12/8) is registered but marked skipped.
"""
import argparse
import datetime
import json
import os
import re
import sys
import unicodedata

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


# ---------------------------------------------------------------- chart text -> annotation

BEAT_CHOICES = (2, 4, 8)  # a chord lasts 2 / 4 / 8 beats (plus 1 and 2 bars in odd meters)
_REPEAT = re.compile(r"×\s*\d*|[xX]\s*\d+")


def _is_chord(t):
    t = t.strip()
    if t.upper() in ("N.C.", "N"):
        return True
    try:
        RT.parse_chord(t)
        return True
    except ValueError:
        return False


def _count_chars(text):
    """Number of kana / kanji / letters / digits (spaces, punctuation, marks and symbols are ignored)."""
    return sum(1 for ch in _REPEAT.sub("", text) if unicodedata.category(ch)[0] in "LN")


def line_beats(counts, num):
    """Beats per chord of ONE lyric line (deterministic; see lyric_bars). counts = lyric characters until the next
    chord. Returns ints with sum == bars * num, each >= 2."""
    k = len(counts)
    total_chars = sum(counts)
    bars_min = -(-2 * k // num)  # every chord lasts at least 2 beats
    est = int(total_chars / (2 * num) + 0.5)  # about one character per eighth note
    want = max(bars_min, est)
    bars = next((b for b in (2, 4, 8) if b >= want), want)
    total = bars * num
    allowed = sorted(set(BEAT_CHOICES) | {num, 2 * num})
    ideal = [max(2.0, total * c / total_chars) for c in counts]
    cur = [min(allowed, key=lambda a, x=x: (abs(a - x), a)) for x in ideal]
    for _ in range(200):
        if sum(cur) == total:
            break
        if sum(cur) > total:
            cand = [i for i in range(k) if cur[i] > allowed[0]]
            if not cand:
                break
            i = max(cand, key=lambda j: (cur[j] - ideal[j], -j))
            cur[i] = max(a for a in allowed if a < cur[i])
        else:
            i = max(range(k), key=lambda j: (ideal[j] - cur[j], -j))
            cur[i] = min((a for a in allowed if a > cur[i]), default=cur[i] + 1)
    while sum(cur) != total:  # odd meters: close the last difference by single beats
        if sum(cur) > total:
            i = max((j for j in range(k) if cur[j] > 2), key=lambda j: (cur[j] - ideal[j], -j))
            cur[i] -= 1
        else:
            i = max(range(k), key=lambda j: (ideal[j] - cur[j], -j))
            cur[i] += 1
    return cur


def lyric_bars(segs, num):
    """One lyric line, segs = [(chord, lyric characters until the next chord)] -> bars [[chord, eighths], ...].
    Timing rule (deterministic):
      * chord-only line (no lyric characters at all): one bar per chord;
      * otherwise the line gets 2, 4 or 8 bars: the smallest of these >= max(est, ceil(2 * chords / beats per bar)),
        est = round(characters / (2 * beats per bar)) (about one character per eighth note); more bars only when
        the chords alone need them;
      * chord durations are proportional to their characters (a chord at the end of the line takes up to the end
        of the line), each snapped to 2 / 4 / 8 beats (plus 1 and 2 bars in odd meters), minimum 2 beats, then
        adjusted step by step (the chord furthest from its ideal share moves first, earlier chords first on ties)
        until the line is a whole number of bars;
      * a chord longer than what is left of the bar continues into the next bar (same chord, like `-` runs)."""
    eps = num * 2
    if sum(n for _, n in segs) == 0:
        return [[[c, eps]] for c, _ in segs]
    bars, cur, used = [], [], 0
    for (c, _), b in zip(segs, line_beats([n for _, n in segs], num)):
        left = b * 2
        while left:
            take = min(left, eps - used)
            cur.append([c, take])
            used += take
            left -= take
            if used == eps:
                bars.append(cur)
                cur, used = [], 0
    return bars


def _clean_bar_line(line):
    """Bar-form line -> (line without odd tokens, number dropped): bracket contents that are no chord, stray symbols
    next to dashes, tokens such as `×2` `(` `→` in the `| C Am |` form."""
    dropped = 0
    if "[" in line or re.fullmatch(r"[\s|\-.]*", line):
        out = []
        for p in re.split(r"(\[[^\]]*\])", line):
            if p.startswith("["):
                if _is_chord(p[1:-1]):
                    out.append(p)
                else:
                    dropped += 1
            else:
                rest = re.sub(r"[|\-.\s]", "", p)
                dropped += 1 if rest else 0
                out.append(re.sub(r"[^|\-.\s]", "", p))
        return "".join(out), dropped
    segs = []
    for seg in line.split("|"):
        ts = []
        for t in seg.split():
            if t == "." or _is_chord(t):
                ts.append(t)
            else:
                dropped += 1
        segs.append(" ".join(ts))
    return "|".join(segs), dropped


_DIRECTIVE = re.compile(r"\{\s*([A-Za-z_]+)\s*(?::\s*|\s+)?(.*?)\s*\}")


_KEY_WORD = re.compile(r"([A-G])\s*([#b]?)\s*(m|min|minor|maj|major|短調|長調)?\s*(?:[(（]\s*(m|min|minor|maj|major|短調|長調)\s*[)）])?", re.I)
_MINOR_WORDS = ("m", "min", "minor", "短調")


def _norm_key(val):
    """`{key: ...}` value -> canonical key text (C, F#, Bb, Am) or None. Accepts a mode word (major / maj / 長調,
    minor / min / m / 短調, any case, optional spaces or parentheses): `Bb major`, `F# minor`, `Cmaj`, `Am (minor)`."""
    val = val.strip()
    if RT._key_text(val) is not None:
        return val
    m = _KEY_WORD.fullmatch(val)
    if not m or val[0] not in "ABCDEFG" or m.group(2) not in ("", "#", "b"):
        return None
    modes = {w.lower() in _MINOR_WORDS for w in (m.group(3), m.group(4)) if w}
    if len(modes) > 1:
        return None  # contradictory, e.g. `Am (major)`
    return m.group(1) + m.group(2) + ("m" if True in modes else "")


def _add_key_row(rows, key_src, ln, value, src, warns):
    """Mid-song key row. A `キー:` line and a `{key}` directive at the same position (no chord between): `キー:` wins."""
    if rows and rows[-1][1] == "key" and key_src.get(rows[-1][0]) != src:
        warns.append(f"{ln}行目: キー: の行と {{key}} 指定が同じ位置にあるので キー: を使います")
        if src == "directive":
            return
        rows.pop()
    rows.append((ln, "key", value))
    key_src[ln] = src


def _directive(line, ln, head, rows, head_src, key_src, seen_chord, warns):
    """ChordPro `{name: value}`: key / k / tempo / bpm / time are read, everything else (title, artist, comment ...)
    is ignored and never stored. Invalid values -> Japanese warning, ignored."""
    m = _DIRECTIVE.fullmatch(line)
    if not m:
        return
    name, val = m.group(1).lower(), m.group(2).strip()
    if name in ("key", "k"):
        val = _norm_key(val)
        if val is None:
            warns.append(f"{ln}行目: {{key}} の値が読めないので無視しました")
        elif seen_chord:
            _add_key_row(rows, key_src, ln, val, "directive", warns)
        elif head_src.get("key") == "line":
            warns.append(f"{ln}行目: キー: の行と {{key}} 指定が重なったので キー: を使います")
        else:
            head["key"] = (ln, val)
            head_src["key"] = "directive"
    elif name in ("tempo", "bpm"):
        if not re.fullmatch(r"\d+(\.\d+)?", val) or float(val) <= 0:
            warns.append(f"{ln}行目: {{{name}}} の値が読めないので無視しました")
        elif "bpm" not in head:
            head["bpm"] = (ln, val)
            head_src["bpm"] = "directive"
    elif name == "time":
        if not re.fullmatch(r"\d+\s*/\s*\d+", val):
            warns.append(f"{ln}行目: {{time}} の値が読めないので無視しました")
        elif "time" not in head:
            head["time"] = (ln, val)
            head_src["time"] = "directive"


def parse_chart(text):
    """Chart text -> (ann, fmt, warns). ann = parse_txt's annotation (bars, tempo, keys ...), fmt = 'bars' or 'lyrics',
    warns = content-free Japanese notes (line numbers / counts only). A compound meter (6/8, 9/8, 12/8) returns
    ({"skipped": "compound meter"}, None, warns). Raises I.IntakeError.
    Lines are classified first: header `key: value` lines (bpm / 拍子 / キー / 弱起; other keys such as a title are
    ignored), `キー:` after the first chord line = modulation from the next bar, section names / dividers /
    ChordPro directives / lyric-only lines are ignored, chord lines are 'bar' lines (a `|` bar line, or dash timing
    `[C]--[G]--`) or lyric lines (`[C]あいう[G]えお`, or just `[C] [G]`). If every chord line is a bar line the
    existing bar/dash parser is used (a bar whose length does not fit the time signature is stretched with a
    warning); otherwise the whole file is converted by the lyric rule (lyric_bars; bar lines inside such a file
    keep their own timing). Missing bpm = 120 (warned). Lyrics are never kept."""
    warns = []
    head, rows = {}, []  # head: key -> (ln, text); rows: (ln, kind, payload)
    head_src, key_src = {}, {}  # origin ("line" = `key: value`, "directive" = `{key: value}`) of header values / key rows (by line)
    seen_chord = False
    ignored_kv = 0
    for ln, raw in enumerate(text.lstrip("﻿").splitlines(), 1):
        line = I._norm(raw).strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("{") and line.endswith("}"):
            _directive(line, ln, head, rows, head_src, key_src, seen_chord, warns)
            continue
        line = re.sub(r"\[\s*\|\s*\]", " ", line)
        if re.fullmatch(r"[—–―－-]+[^|\[\]]*[—–―－-]+|[—–―－-]+", line) or not line.strip():
            continue
        if "[" not in line and "|" not in line:
            m = re.fullmatch(r"([^:]+?)\s*:\s*(.*)", line)
            k = I.KEYS.get(m.group(1).strip().lower()) if m else None
            if k == "key" and seen_chord:
                _add_key_row(rows, key_src, ln, m.group(2).strip(), "line", warns)
            elif k in ("bpm", "time", "key", "pickup"):
                if k == "key" and head_src.get("key") == "directive":
                    warns.append(f"{ln}行目: キー: の行と {{key}} 指定が重なったので キー: を使います")
                head[k] = (ln, m.group(2).strip())
                head_src[k] = "line"
            elif m:
                ignored_kv += 1
            continue  # otherwise a section name / lyric-only line
        brs = [m.group(1) for m in I._BRACKET.finditer(line)]
        if brs and not any(_is_chord(b) for b in brs):
            continue  # [Verse] [Chorus] ...: a section label
        outside = _REPEAT.sub("", I._BRACKET.sub("", line))
        has_text = any(unicodedata.category(ch)[0] in "LN" for ch in outside)
        if "|" in line and not brs:
            kind = "bar"
        elif brs and not has_text and ("|" in line or "-" in outside):
            kind = "bar"
        else:
            kind = "lyric"
        seen_chord = True
        rows.append((ln, kind, line))
    while rows and rows[-1][1] == "key" and key_src.get(rows[-1][0]) == "directive":
        warns.append(f"{rows[-1][0]}行目: 最後のコードの後ろの {{key}} は使いません")
        rows.pop()
    if ignored_kv:
        warns.append(f"タイトルなど使わない項目の行 {ignored_kv} 行を読み飛ばしました")
    if not any(r[1] in ("bar", "lyric") for r in rows):
        raise I.IntakeError("コードの行がありません")
    mt = re.fullmatch(r"(\d+)\s*/\s*(\d+)", head["time"][1]) if "time" in head else None
    if mt and mt.group(2) == "8" and int(mt.group(1)) in (6, 9, 12):
        return {"skipped": "compound meter"}, None, warns
    if "bpm" not in head:
        warns.append("bpm の指定がないので 120 にしました")
        head["bpm"] = (0, "120")
    nlines = max([v[0] for v in head.values()] + [r[0] for r in rows])
    grid = [""] * nlines
    names = {"bpm": "bpm", "time": "拍子", "key": "キー", "pickup": "弱起"}
    pre = [f"bpm: {head['bpm'][1]}"] if head["bpm"][0] == 0 else []
    for k, (ln, v) in head.items():
        if ln:
            grid[ln - 1] = f"{names[k]}: {v}"
    chord_rows = [r for r in rows if r[1] != "key"]
    if all(r[1] == "bar" for r in chord_rows):
        for ln, kind, payload in rows:
            if kind == "key":
                grid[ln - 1] = "キー: " + payload
                continue
            line, dropped = _clean_bar_line(payload)
            if dropped:
                warns.append(f"{ln}行目: コードとして読めない {dropped} 個を読み飛ばしました")
            grid[ln - 1] = line
        fix = []
        ann = I.parse_txt("\n".join(pre + grid), require_style=False, fix_bars=fix)
        return ann, "bars", warns + fix
    ann = I.parse_txt("\n".join(pre + grid) + "\n| C |", require_style=False)  # validates / reads the header
    num, eps = ann["timeSignature"][0], ann["eighthsPerBar"]
    if ann.pop("pickupBeats", 0):
        warns.append("歌詞形式では弱起は使いません(無視しました)")
    bars, key_changes, fix, skipped = [], [], [], 0
    for ln, kind, payload in rows:
        if kind == "key":
            if RT._key_text(payload) is None:
                raise I.IntakeError(f"{ln}行目: キーは C・F#・Bb・Am のように書きます")
            key_changes.append((ln, payload, len(bars)))
        elif kind == "bar":
            line, dropped = _clean_bar_line(payload)
            skipped += dropped
            for seg in line.split("|"):
                entries = I._parse_bar(seg, ln, num, eps, bars[-1][-1][0] if bars else None, fix)
                if entries:
                    bars.append(entries)
        else:
            out = []
            for m in re.finditer(r"\[([^\]]*)\]([^\[]*)", payload.replace("|", " ")):
                n = _count_chars(m.group(2))
                if _is_chord(m.group(1)):
                    out.append([I._check_chord(m.group(1).strip(), ln), n])
                else:
                    skipped += 1
                    if out:
                        out[-1][1] += n  # its lyric still belongs to the chord before it
            if out:
                bars += lyric_bars(out, num)
    if skipped:
        warns.append(f"コードとして読めない部分 {skipped} 個を読み飛ばしました")
    if not bars:
        raise I.IntakeError("コードがありません")
    keys = []
    if key_changes:
        if ann.get("key"):
            keys.append({"startBar": 0, "key": ann["key"]})
        for ln, v, at in key_changes:
            if at >= len(bars):
                raise I.IntakeError(f"{ln}行目: 途中のキーの後ろに小節がありません")
            if keys and keys[-1]["startBar"] == at:
                keys.pop()
            keys.append({"startBar": at, "key": v})
    ann["bars"] = bars
    ann.pop("keys", None)
    if keys:
        ann["keys"] = keys
    return ann, "lyrics", warns + fix


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
        if e["original"] == original and not e.get("removed"):
            return cid, False
    n = 1
    while f"chart-{n:02d}" in ids["charts"]:
        n += 1
    cid = f"chart-{n:02d}"
    ids["charts"][cid] = {"original": original, "heldOut": is_held_out(cid),
                          "registeredAt": now or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    _save_ids(d, ids)
    return cid, True


def prune_removed(charts_dir, out, originals, log=print):
    """Charts whose source .txt is gone: mark the id `removed` in ids.local.json (the id stays reserved, never reused, so
    the held-out assignment of the others does not shift), delete chart-NN.song.json, its out/charts/chart-NN-* files
    and its manifest.charts.json entries. Returns the removed ids."""
    ids = _load_ids(charts_dir)
    gone = [cid for cid, e in ids["charts"].items() if not e.get("removed") and e["original"] not in originals]
    if not gone:
        return []
    mf = os.path.join(out, "charts", "manifest.charts.json")
    for cid in gone:
        ids["charts"][cid]["removed"] = True
        p = os.path.join(charts_dir, cid + ".song.json")
        if os.path.exists(p):
            os.remove(p)
        cdir = os.path.join(out, "charts")
        if os.path.isdir(cdir):
            for fn in os.listdir(cdir):
                if fn.startswith(cid + "-"):
                    os.remove(os.path.join(cdir, fn))
        log(f"{cid}: 元のファイルが無くなったので removed にしました(id は欠番のまま、出力も削除)")
    if os.path.exists(mf):
        m = json.load(open(mf, encoding="utf-8"))
        m["variants"] = [v for v in m.get("variants", []) if v.get("take") not in gone]
        with open(mf, "w", encoding="utf-8") as f:
            json.dump(m, f, indent=1)
    _save_ids(charts_dir, ids)
    return gone


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


def _log_warns(warns, log, limit=8):
    """Warnings are content-free; identical ones are folded (`x N 回`), at most `limit` distinct lines are shown."""
    counts = {}
    for w in warns:
        counts[w] = counts.get(w, 0) + 1
    for w, n in list(counts.items())[:limit]:
        log("  " + w + (f" (x{n})" if n > 1 else ""))
    if len(counts) > limit:
        log(f"  ... ほか {len(counts) - limit} 種類")


def process(charts_dir, out, dry_run=False, log=print):
    """Returns the number of charts that failed."""
    os.makedirs(charts_dir, exist_ok=True)
    names = sorted(fn for fn in os.listdir(charts_dir)
                   if fn.lower().endswith(".txt") and not fn.startswith(".")
                   and os.path.isfile(os.path.join(charts_dir, fn)))
    if not dry_run:
        prune_removed(charts_dir, out, {os.path.splitext(fn)[0] for fn in names}, log)
    if not names:
        log("charts フォルダが空です。コード進行の .txt を入れてください。")
        return 0
    fails = 0
    for i, fn in enumerate(names, 1):
        try:
            ann, fmt, warns = parse_chart(open(os.path.join(charts_dir, fn), encoding="utf-8").read())
            song = None if fmt is None else to_song(ann)
        except (I.IntakeError, ValueError, UnicodeDecodeError) as e:
            fails += 1
            log(f"[{i}番目のファイル] 読めませんでした: {e}")
            continue
        if dry_run:
            log(f"[{i}番目のファイル] OK ({'複合拍子のためスキップ' if song is None else str(len(song['bars'])) + ' 小節'}、警告 {len(warns)} 件)")
            _log_warns(warns, log)
            continue
        cid, new = register(charts_dir, os.path.splitext(fn)[0])
        held = is_held_out(cid)
        if new:
            _log_register(out, cid, held)
        if song is None:
            song = {"version": 1, "skipped": ann["skipped"]}
        else:
            song["format"] = fmt
        song.update(id=cid, heldOut=held)
        with open(os.path.join(charts_dir, cid + ".song.json"), "w") as f:
            json.dump(song, f, indent=1)
        if "skipped" in song:
            log(f"{cid}: 複合拍子のため描画しません(skipped)、{'ホールドアウト' if held else '開発用'}、警告 {len(warns)} 件")
        else:
            simp = n_simplified(ann)
            log(f"{cid}: 形式={'歌詞' if fmt == 'lyrics' else '小節'}、{len(song['bars'])} 小節、"
                f"コード {sum(len(b) for b in song['bars'])} 個、キー {len(song['keys'])} 個、{'ホールドアウト' if held else '開発用'}"
                + (f"、{simp} 個のコードを簡略化" if simp else "") + f"、警告 {len(warns)} 件" + (" (新規)" if new else " (更新)"))
        _log_warns(warns, log)
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
