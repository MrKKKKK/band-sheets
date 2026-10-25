"""Drop-folder intake of the user's drum recordings (spike 5, task T4).

Usage (from spikes/analysis):  python py/drum_intake.py [--inbox recordings/drm-inbox] [--out out] [--reintake]
                               [--reintake-held-out] [--reparse [drm-NN-x ...]]

The user drops   <a..f>.<audio>   (mono or stereo, any common rate)   and   <a..f>.txt   (fields: see parse_drum_txt)
into recordings/drm-inbox/. The score (the truth) is NOT parsed here: `npx tsx ts/drum/recscore/truthCli.ts`
(the app's own parser, T4b builder) writes recordings/drum-scores/<x>.ticks.json (hits as bar / tick / inst / mark,
bpm, bar count, the take name and the held-out flag from builder.ts TAKE_ROLE) and this script only adds seconds
(`開始:` + bpm). Parse rules thus live in one place and Python stays thin.

For every take this script
  1. parses + validates the .txt (errors are Japanese) and the audio, loads the tick truth,
  2. takes the id (drm-NN-x) and the held-out flag from the tick truth (= TAKE_ROLE, e and f are held-out; a different
     `ホールドアウト:` in the .txt is an error), registers it in recordings/drm-ids.local.json and
     out/results/heldout-log.jsonl (kind "register", input "drum") BEFORE any analysis,
  3. stores mono 44.1 kHz 24-bit WAV as recordings/drm-NN-x.wav, moves the originals to recordings/drm-originals/,
  4. writes recordings/drm-NN-x.truth.json + out/rec/drm-NN-x.truth.json (a ts/drum/score.ts DrumTruth plus
     excludedBars (0-based, from 「楽譜と違って叩いた小節」), extraLabels (特殊奏法 bars), kit) and merges
     out/rec/manifest.drum.json,
  5. runs privacy_check.
A take that is already registered is refused unless --reintake (dev) / --reintake-held-out (held-out); the id and the
flag never change. Names of the user's files and the kit are not printed. Nothing is analysed here.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import intake as I  # noqa: E402  (decode_audio, scan_inbox, TARGET_SR, IntakeError)

IDS_FILE = "drm-ids.local.json"
INBOX = "recordings/drm-inbox"
SCORES = "recordings/drum-scores"
TARGET_SR = I.TARGET_SR
LETTERS = "abcdef"
KEYS = {"bpm": "bpm", "テンポ": "bpm", "拍子": "time", "叩き方": "style", "ホールドアウト": "heldout", "開始": "start",
        "キット": "kit", "マイク/接続": "mic", "クリック": "click", "楽譜と違って叩いた小節": "excluded",
        "特殊奏法": "special"}
TECH = (("ベル", "bell"), ("クロススティック", "cross_stick"), ("リムショット", "rimshot"))
INST = (("ライド", "RD"), ("スネア", "SD"), ("ハイハット", "HH"), ("クラッシュ", "CR"), ("タム", "T1"))


class DrumError(ValueError):
    pass


def _num(v, ln, what):
    try:
        return float(unicodedata.normalize("NFKC", v).replace("秒", "").strip())
    except ValueError:
        raise DrumError(f"{ln} 行目: {what}が数字として読めません")


def parse_bar_ranges(text, n_bars, what):
    """'3, 5-6、9小節' -> sorted unique 0-based bars. Empty / なし -> []. Bars are 1-based in the text."""
    s = unicodedata.normalize("NFKC", text).replace("小節", "").strip()
    if s in ("", "なし", "無し", "-"):
        return []
    out = set()
    for tok in re.split(r"[,、\s]+", s):
        if not tok:
            continue
        m = re.fullmatch(r"(\d+)(?:[-〜~–ー](\d+))?", tok)
        if not m:
            raise DrumError(f"{what}: 「{tok[:12]}」が読めません（例: 3, 5-6）")
        a, b = int(m.group(1)), int(m.group(2) or m.group(1))
        if a < 1 or b < a or b > n_bars:
            raise DrumError(f"{what}: 小節 {tok[:12]} が範囲外です（1〜{n_bars}）")
        out.update(range(a - 1, b))
    return sorted(out)


def parse_special(value, n_bars):
    """'9-10 ライド 四分音符 ベル（楽譜は RD）' -> {bars (0-based), text, tech, inst}; 出なかった -> {skipped}."""
    v = unicodedata.normalize("NFKC", value).strip()
    m = re.match(r"(\d+(?:[-〜~–ー]\d+)?)\s+(.*)$", v)
    if not m:
        if "出なかった" in v or v == "":
            return {"skipped": True}
        raise DrumError("特殊奏法: 「小節 内容」の形で書いてください（例: 9-10 ライド ベル）")
    bars = parse_bar_ranges(m.group(1), n_bars, "特殊奏法")
    body = re.sub(r"\(.*?\)", "", m.group(2))
    return {"bars": bars, "text": body.strip(),
            "tech": next((k for w, k in TECH if w in body), "other"),
            "inst": next((k for w, k in INST if w in body), None)}


def parse_drum_txt(text, ticks):
    """The take's .txt, checked against its tick truth. -> dict (bpm, ts, style, startSec, kit, excludedBars, extraLabels)."""
    raw = {}
    for i, line in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = re.match(r"^([^:：]+)[:：]\s*(.*)$", s)
        if not m or m.group(1).strip() not in KEYS:
            raise DrumError(f"{i} 行目: 項目名が読めません")
        key, val = KEYS[m.group(1).strip()], re.split(r"\s+#", " " + m.group(2))[0].strip()
        if key == "special":
            raw.setdefault("special", []).append((i, val))
        elif key in raw:
            raise DrumError(f"{i} 行目: 「{m.group(1).strip()}」が 2 回あります")
        else:
            raw[key] = (i, val)
    for k, label in (("bpm", "bpm"), ("style", "叩き方"), ("start", "開始"), ("kit", "キット")):
        if k not in raw or raw[k][1] == "":
            raise DrumError(f"「{label}:」が書かれていません")
    bpm = _num(raw["bpm"][1], raw["bpm"][0], "bpm")
    if abs(bpm - ticks["bpm"]) > 1e-6:
        raise DrumError(f"bpm が楽譜（{ticks['bpm']}）と違います（.txt の bpm は変えないでください）")
    ts = raw.get("time", (0, "4/4"))[1]
    if [int(x) for x in re.findall(r"\d+", ts)] != ticks["ts"]:
        raise DrumError("拍子が楽譜と違います")
    style = raw["style"][1].strip().lower()
    if style != ticks["letter"]:
        raise DrumError("叩き方がファイル名の記号（a〜f）と違います")
    if "heldout" in raw:
        h = raw["heldout"][1]
        if (h in ("はい", "yes", "true")) != bool(ticks["heldOut"]) or h not in ("はい", "いいえ", "yes", "no", "true", "false"):
            raise DrumError("ホールドアウトの印が決め（e・f がホールドアウト）と違います")
    start = _num(raw["start"][1], raw["start"][0], "開始")
    if start < 0:
        raise DrumError("開始が負です")
    n = ticks["nBars"]
    excluded = parse_bar_ranges(raw.get("excluded", (0, ""))[1], n, "楽譜と違って叩いた小節")
    labels = [parse_special(v, n) for _, v in raw.get("special", [])]
    return {"bpm": bpm, "ts": ticks["ts"], "style": style, "startSec": start, "kit": raw["kit"][1],
            "excludedBars": excluded, "extraLabels": [x for x in labels if not x.get("skipped")],
            "specialSkipped": sum(1 for x in labels if x.get("skipped"))}


def build_truth(ann, ticks, audio_sec):
    """DrumTruth (ts/drum/score.ts) + excludedBars / extraLabels / kit. Seconds = startSec + played tick * secPerTick."""
    num, den = ticks["ts"]
    spt = 60.0 / ann["bpm"] / (64 / den)
    bt = ticks["barTicks"]
    t0 = ann["startSec"]
    starts = [round(t0 + i * bt * spt, 6) for i in range(ticks["nBars"] + 1)]
    hits = []
    for h in ticks["hits"]:
        e = {"t": round(t0 + (h["bar"] * bt + h["playTick"]) * spt, 6), "inst": h["inst"], "bar": h["bar"], "tick": h["tick"]}
        if "mark" in h:
            e["mark"] = h["mark"]
        hits.append(e)
    return {"name": ticks["name"], "heldOut": bool(ticks["heldOut"]), "style": ann["style"], "kit": ann["kit"],
            "source": {"kind": "drums", "durationSec": round(audio_sec, 4)},
            "info": {"bpm": ann["bpm"], "ts": ann["ts"], "startSec": t0},
            "hits": hits, "barTicks": bt, "barStartsSec": starts, "bpm": ann["bpm"],
            "swingBars": ticks["swingBars"], "excludedBars": ann["excludedBars"], "extraLabels": ann["extraLabels"]}


# ---------------------------------------------------------------- registry / logs

def _load_ids(rec_dir):
    p = os.path.join(rec_dir, IDS_FILE)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {"version": 1, "recordings": {}}


def _save_ids(rec_dir, ids):
    with open(os.path.join(rec_dir, IDS_FILE), "w", encoding="utf-8") as f:
        json.dump(ids, f, indent=1, ensure_ascii=False)


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _log(out, kind, rid, held_out, style):
    d = os.path.join(out, "results")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "heldout-log.jsonl"), "a") as f:
        f.write(json.dumps({"time": _now(), "kind": kind, "input": "drum", "take": rid, "song": rid,
                            "heldOut": held_out, "style": style, "variants": [rid]}) + "\n")


def _merge_manifest(out, entry):
    d = os.path.join(out, "rec")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "manifest.drum.json")
    man = {"variants": []}
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            man = json.load(f)
    man["variants"] = [v for v in man["variants"] if v["name"] != entry["name"]] + [entry]
    man["variants"].sort(key=lambda v: v["name"])
    with open(p, "w", encoding="utf-8") as f:
        json.dump(man, f, indent=1)


def _write_truth(truth, ann, rec_dir, out):
    rid = truth["name"]
    for d in (rec_dir, os.path.join(out, "rec")):
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, rid + ".truth.json"), "w", encoding="utf-8") as f:
            json.dump(truth, f, indent=1, ensure_ascii=False)
    _merge_manifest(out, {"name": rid, "wav": f"recordings/{rid}.wav", "truth": f"out/rec/{rid}.truth.json",
                          "heldOut": truth["heldOut"], "style": ann["style"], "bpm": ann["bpm"], "ts": ann["ts"],
                          "startSec": ann["startSec"], "durationSec": truth["source"]["durationSec"],
                          "excludedBars": ann["excludedBars"]})


def load_ticks(scores_dir, letter):
    p = os.path.join(scores_dir, f"{letter}.ticks.json")
    if not os.path.exists(p):
        raise DrumError("楽譜の正解（ticks.json）がありません。先に `npx tsx ts/drum/recscore/truthCli.ts` を実行してください")
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def process_take(base, t, rec_dir, out, scores_dir, reintake=False, reintake_held_out=False, log=print):
    """Returns the take id. Raises DrumError before anything is registered."""
    if base.lower() not in tuple(LETTERS):
        raise DrumError("ファイル名は a〜f のどれかにしてください")
    letter = base.lower()
    if not t["audio"]:
        raise DrumError("音声ファイルがありません")
    if len(t["audio"]) > 1:
        raise DrumError("同じ名前の音声ファイルが 2 つあります（1 本だけにしてください）")
    if not t["txt"]:
        raise DrumError(".txt がありません")
    ticks = load_ticks(scores_dir, letter)
    with open(t["txt"], encoding="utf-8") as f:
        ann = parse_drum_txt(f.read(), ticks)
    path = next(iter(t["audio"].values()))
    try:
        y = I.decode_audio(path)
    except I.IntakeError as e:
        raise DrumError(str(e))
    audio_sec = len(y) / TARGET_SR
    if ann["startSec"] >= audio_sec:
        raise DrumError("「開始:」が録音の長さを超えています")
    rid, held_out = ticks["name"], bool(ticks["heldOut"])
    ids = _load_ids(rec_dir)
    again = rid in ids["recordings"]
    if again and not (reintake_held_out if held_out else reintake):
        raise DrumError("すでに取り込み済みです（やり直すときは " +
                        ("--reintake-held-out" if held_out else "--reintake") + "）")
    # registry + log BEFORE anything is analysed (and before the audio is touched)
    os.makedirs(rec_dir, exist_ok=True)
    ids["recordings"].setdefault(rid, {"letter": letter, "heldOut": held_out, "registeredAt": _now()})
    _save_ids(rec_dir, ids)
    _log(out, "reintake" if again else "register", rid, held_out, letter)
    import soundfile as sf
    sf.write(os.path.join(rec_dir, rid + ".wav"), y, TARGET_SR, subtype="PCM_24")
    _write_truth(build_truth(ann, ticks, audio_sec), ann, rec_dir, out)
    odir = os.path.join(rec_dir, "drm-originals")
    os.makedirs(odir, exist_ok=True)
    shutil.move(path, os.path.join(odir, rid + os.path.splitext(path)[1].lower()))
    shutil.move(t["txt"], os.path.join(odir, rid + ".txt"))
    end = ann["startSec"] + ticks["nBars"] * ticks["barTicks"] * 60.0 / ann["bpm"] / (64 / ticks["ts"][1])
    note = "（注意: 録音が楽譜より短いようです）" if audio_sec < end - 0.5 else ""
    extra = f"、外す小節 {len(ann['excludedBars'])}、特殊奏法 {len(ann['extraLabels'])}"
    log(f"{rid}: {'取り込み直しました' if again else '取り込みました'} [{'ホールドアウト' if held_out else '開発用'}] "
        f"{audio_sec:.1f}秒、{ticks['nBars']}小節{extra}{note}")
    return rid


def reparse(rec_dir, out, scores_dir, only=(), log=print):
    """--reparse: re-read drm-originals/<id>.txt + the ticks for the registered takes (all when `only` is empty) and
    rewrite the truth. Ids, flags, WAVs and the registry are untouched; the log gets kind "reparse". -> failures."""
    ids = _load_ids(rec_dir)["recordings"]
    fails = 0
    for rid in sorted(only or ids):
        try:
            if rid not in ids:
                raise DrumError("登録にありません")
            txt = os.path.join(rec_dir, "drm-originals", rid + ".txt")
            if not os.path.exists(txt):
                raise DrumError(".txt が drm-originals にありません")
            ticks = load_ticks(scores_dir, ids[rid]["letter"])
            if ticks["name"] != rid or bool(ticks["heldOut"]) != bool(ids[rid]["heldOut"]):
                raise DrumError("楽譜側の名前・ホールドアウトの印が登録と違います")
            with open(txt, encoding="utf-8") as f:
                ann = parse_drum_txt(f.read(), ticks)
            with open(os.path.join(rec_dir, rid + ".truth.json"), encoding="utf-8") as f:
                dur = json.load(f)["source"]["durationSec"]
            _write_truth(build_truth(ann, ticks, dur), ann, rec_dir, out)
            _log(out, "reparse", rid, bool(ids[rid]["heldOut"]), ids[rid]["letter"])
            log(f"{rid}: 正解を作り直しました、外す小節 {len(ann['excludedBars'])}")
        except (DrumError, OSError, KeyError, ValueError) as ex:
            fails += 1
            log(f"{rid}: NG {ex}")
    return fails


def kit_warnings(rec_dir):
    """Held-out takes should use a kit different from the dev takes (DRUM_RECORDING.md section 3). Warn only."""
    dev, held = set(), set()
    for rid, e in _load_ids(rec_dir)["recordings"].items():
        p = os.path.join(rec_dir, rid + ".truth.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                (held if e["heldOut"] else dev).add(json.load(f)["kit"].strip().lower())
    return ["ホールドアウトのキットが開発用と同じです（別のキットで録り直す方針）"] if dev & held else []


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", default=INBOX)
    ap.add_argument("--out", default="out")
    ap.add_argument("--recordings", default=None, help="default: parent of --inbox")
    ap.add_argument("--scores", default=None, help=f"default: <recordings>/{os.path.basename(SCORES)}")
    ap.add_argument("--privacy-root", default=None, help="scan this tree instead of the repository (tests)")
    ap.add_argument("--no-privacy-check", action="store_true")
    ap.add_argument("--reintake", action="store_true", help="allow importing an already registered DEV take again")
    ap.add_argument("--reintake-held-out", action="store_true", help="allow the same for a held-out take (explicit)")
    ap.add_argument("--reparse", nargs="*", metavar="ID", help="rebuild the truth from drm-originals (all, or the ids)")
    a = ap.parse_args(argv)
    rec_dir = a.recordings or os.path.dirname(os.path.abspath(a.inbox))
    scores = a.scores or os.path.join(rec_dir, os.path.basename(SCORES))
    if a.reparse is not None:
        return 1 if reparse(rec_dir, a.out, scores, a.reparse) else 0
    os.makedirs(a.inbox, exist_ok=True)
    takes = I.scan_inbox(a.inbox)
    if not takes:
        print("drm-inbox が空です。a.wav … f.wav と同じ名前の .txt を入れてください。")
        return 0
    fails = 0
    for base, t in takes.items():
        try:
            process_take(base, t, rec_dir, a.out, scores, a.reintake, a.reintake_held_out)
        except DrumError as e:
            fails += 1
            print(f"[{base[:1]}] 取り込めませんでした: {e}  (inbox に残してあります)")
    for w in kit_warnings(rec_dir):
        print("注意:", w)
    if not a.no_privacy_check:
        import privacy_check
        rc = privacy_check.main(["--recordings", rec_dir] + (["--root", a.privacy_root, "--no-log"] if a.privacy_root else []))
        if rc:
            return rc
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
