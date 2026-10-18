"""Drop-folder intake of the user's humming recordings (spike 4, task T3).

Usage (from spikes/analysis):  python py/hum_intake.py [--inbox recordings/hum-inbox] [--out out] [--dry-run]

The user drops   <anyname>.<audio>   (the humming; mono or stereo, any common sample rate)
                 <anyname>.txt       (bpm / time signature / start second of bar 1 / singing style / `メロディ:` + the
                                      truth melody in the band-sheets melody alphaTex subset, see parse_hum_txt)
into recordings/hum-inbox/. For every take this script
  1. parses + validates the .txt (all errors are Japanese) and decodes the audio,
  2. gives the SONG an anonymous id hum-NN (takes of one song share it: file stem up to the first `_`, or the whole
     stem) and the take hum-NN-<style letter>; heldOut is decided per song when it is first registered (even NN =
     held-out, like spike 2) and recorded in recordings/hum-ids.local.json and out/results/heldout-log.jsonl
     (kind "register", input "hum") BEFORE anything is analysed,
  3. stores mono 44.1 kHz 24-bit WAV as recordings/hum-NN-x.wav, moves the originals to recordings/hum-originals/
     (all gitignored),
  4. writes the truth JSON (the melody as notes/rests in ticks + seconds computed from bpm / startSec) to
     recordings/hum-NN-x.truth.json and out/rec/hum-NN-x.truth.json and merges out/rec/manifest.hum.json,
  5. runs privacy_check.
Original file names, titles and the note sequences are never printed, logged or written outside the gitignored
folders. Nothing is analysed here.
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
import intake as I  # noqa: E402  (decode_audio, scan_inbox, song_key, song_held_out, TARGET_SR)

IDS_FILE = "hum-ids.local.json"
INBOX = "recordings/hum-inbox"
TARGET_SR = I.TARGET_SR
WHOLE_TICKS = 64  # src/lib/melody.ts
DURATION_TICKS = {"1": 64, "2": 32, "4": 16, "8": 8, "16": 4, "32": 2}
STYLES = "abcdef"

KEYS = {"bpm": "bpm", "テンポ": "bpm", "拍子": "time", "time": "time", "開始": "start", "start": "start",
        "歌い方": "style", "style": "style", "メロディ": "melody", "melody": "melody"}


class HumError(ValueError):
    pass


# ---------------------------------------------------------------- melody text (alphaTex subset, read-only copy of
# the rules in src/lib/melody.ts "Reading"; tuplets are not supported here)

_PITCH = re.compile(r"^([A-G])(#|b)?([0-8])$")
_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def pitch_to_midi(p):
    m = _PITCH.match(p)
    if not m:
        raise HumError(f"音名「{p}」が読めません（C4 / C#4 / Bb3 のように大文字で書いてください）")
    return 12 * (int(m.group(3)) + 1) + _PC[m.group(1)] + {"#": 1, "b": -1, None: 0}[m.group(2)]


def _effects(body):
    """Validate the inside of `{...}` -> (dotted, tied). lyrics / ch / slur are accepted and dropped."""
    dotted = tied = False
    i = 0
    while i < len(body):
        if body[i] == " ":
            i += 1
            continue
        j = i
        while j < len(body) and body[j] not in ' "':
            j += 1
        name = body[i:j]
        i = j
        if name == "d":
            dotted = True
        elif name == "t":
            tied = True
        elif name in ("lyrics", "ch", "slur"):
            while i < len(body) and body[i] == " ":
                i += 1
            if i < len(body) and body[i] == '"':
                e = body.find('"', i + 1)
                if e < 0:
                    raise HumError("メロディ: 引用符 \" が閉じていません")
                i = e + 1
            else:
                while i < len(body) and body[i] != " ":
                    i += 1
        elif name == "tu":
            raise HumError("メロディ: 連符 {tu} は鼻歌のスパイクでは使えません（16 分の格子だけ）")
        else:
            raise HumError("メロディ: 使えない効果があります（d / t / lyrics / ch / slur だけ）")
    return dotted, tied


def _tokens(src):
    out = []
    i = 0
    while i < len(src):
        if src[i].isspace():
            i += 1
            continue
        j = i
        while j < len(src) and not src[j].isspace() and src[j] != "{":
            j += 1
        word = src[i:j]
        eff = None
        if j < len(src) and src[j] == "{":
            k, q = j + 1, False
            while k < len(src) and (q or src[k] != "}"):
                if src[k] == '"':
                    q = not q
                k += 1
            if k >= len(src) or word == "":
                raise HumError("メロディ: { } の書き方が正しくありません（音符の直後に空白なしで書く）")
            eff = _effects(src[j + 1:k])
            j = k + 1
        out.append((word, eff))
        i = j
    return out


def bar_ticks(ts):
    return ts[0] * WHOLE_TICKS // ts[1]


def parse_melody(src, ts):
    """Melody text -> list of events {kind:'note'|'rest', startTick, ticks, midi?} (ties merged, adjacent rests merged),
    ticks from the start of bar 1. Raises HumError (Japanese) for anything outside the subset or a wrong bar total."""
    if "\\" in src or "//" in src or "/*" in src:
        raise HumError("メロディ: \\ で始まる指定やコメントは使えません（音符と | と :N だけ）")
    dur = None
    bars = [[]]  # per bar: list of (kind, pitchstr|None, ticks, tied)
    for word, eff in _tokens(src):
        if word == "|":
            if eff is not None:
                raise HumError("メロディ: 小節線 | に効果は付けられません")
            if not bars[-1]:
                raise HumError("メロディ: 空の小節があります")
            bars.append([])
            continue
        if word.startswith(":"):
            if word[1:] not in DURATION_TICKS or eff is not None:
                raise HumError(f"メロディ: 音価「{word}」は使えません")
            dur = word[1:]
            continue
        base, glued = word, None
        if "." in word:
            base, _, glued = word.partition(".")
            if glued not in DURATION_TICKS:
                raise HumError(f"メロディ:「{word}」は読めません")
            dur = glued
        if base != "r":
            pitch_to_midi(base)
        if dur is None:
            raise HumError("メロディ: 最初の音符の前に :4 のような音価が必要です")
        dotted, tied = eff or (False, False)
        if glued is not None and tied:
            raise HumError("メロディ: .N で音価を書いた音符に t は付けられません")
        ticks = DURATION_TICKS[dur] * 3 // 2 if dotted else DURATION_TICKS[dur]
        if dotted and dur == "32":
            raise HumError("メロディ: 付点 32 分音符は使えません")
        bars[-1].append(("rest" if base == "r" else "note", None if base == "r" else base, ticks, tied))
    if not bars[-1]:
        bars.pop()
    if not bars:
        raise HumError("メロディ: 音符がありません")
    bt = bar_ticks(ts)
    for n, bar in enumerate(bars):
        tot = sum(b[2] for b in bar)
        if (n < len(bars) - 1 and tot != bt) or tot > bt:
            raise HumError(f"メロディ: {n + 1} 小節目の長さが拍子と合いません")
    events = []
    t = 0
    prev = None  # last note pitch string (None after a rest)
    for bar in bars:
        for kind, pitch, ticks, tied in bar:
            if kind == "rest":
                if tied:
                    raise HumError("メロディ: 休符に t は付けられません")
                if events and events[-1]["kind"] == "rest":
                    events[-1]["ticks"] += ticks
                else:
                    events.append({"kind": "rest", "startTick": t, "ticks": ticks})
                prev = None
            elif tied:
                if prev is None or prev != pitch:
                    raise HumError("メロディ: タイ t は直前の同じ高さの音符にだけ付けられます")
                events[-1]["ticks"] += ticks
            else:
                events.append({"kind": "note", "startTick": t, "ticks": ticks, "midi": pitch_to_midi(pitch)})
                prev = pitch
            t += ticks
    return events, len(bars)


# ---------------------------------------------------------------- .txt

def _num(v, ln, what):
    m = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*(秒|s|sec)?\s*", v, re.I)
    if not m:
        raise HumError(f"{ln}行目: {what} は数字で書いてください")
    return float(m.group(1))


def parse_hum_txt(text):
    """-> dict(bpm, ts, startSec, style, melody). Header lines `key: value` (Japanese or English names, full-width
    characters and CRLF are fine; `#` lines are notes), then a line `メロディ:` (or `melody:`) and the melody text
    (the rest of the file, may start on the same line). Raises HumError (Japanese, line-numbered)."""
    ann = {"ts": [4, 4]}
    lines = unicodedata.normalize("NFKC", text.lstrip("﻿")).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    melody = None
    for ln, raw in enumerate(lines, 1):
        if melody is not None:
            melody.append(raw)
            continue
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([^:：\s]+)\s*[:：]\s*(.*)$", line)
        key = KEYS.get(m.group(1).lower()) if m else None
        if key is None:
            raise HumError(f"{ln}行目: 読めない行です（「bpm: 100」のような形で書いてください）")
        val = m.group(2).strip()
        if key == "melody":
            melody = [val]
        elif key == "bpm":
            ann["bpm"] = _num(val, ln, "bpm")
            if not 30 <= ann["bpm"] <= 300:
                raise HumError(f"{ln}行目: bpm は 30〜300 で書いてください")
        elif key == "time":
            mm = re.fullmatch(r"(\d+)\s*/\s*(2|4|8)", val)
            if not mm or not 1 <= int(mm.group(1)) <= 16:
                raise HumError(f"{ln}行目: 拍子は 4/4 のように書いてください")
            ann["ts"] = [int(mm.group(1)), int(mm.group(2))]
        elif key == "start":
            ann["startSec"] = _num(val, ln, "開始")
        elif key == "style":
            s = re.sub(r"[()\s]", "", val.lower())
            if len(s) != 1 or s not in STYLES:
                raise HumError(f"{ln}行目: 歌い方は a〜f の 1 文字で書いてください")
            ann["style"] = s
    for k, name in (("bpm", "bpm"), ("startSec", "開始"), ("style", "歌い方")):
        if k not in ann:
            raise HumError(f"「{name}:」の行がありません")
    if melody is None or not "".join(melody).strip():
        raise HumError("「メロディ:」の行とその下のメロディのテキストがありません")
    ann["melody"] = "\n".join(melody)
    ann["events"], ann["bars"] = parse_melody(ann["melody"], ann["ts"])
    return ann


# ---------------------------------------------------------------- truth

def build_truth(ann, hid, song, held_out, audio_sec):
    """Truth JSON: the melody in ticks (whole = 64, from bar 1) and in seconds (startSec + tick * secPerTick;
    one beat = 1/den note at `bpm`). Contains the private note sequence: only ever written under recordings/ and out/."""
    spt = 60.0 / ann["bpm"] / (WHOLE_TICKS / ann["ts"][1])
    t0 = ann["startSec"]
    events = []
    notes = []
    for e in ann["events"]:
        ev = dict(e)
        ev["start"] = round(t0 + e["startTick"] * spt, 6)
        ev["end"] = round(t0 + (e["startTick"] + e["ticks"]) * spt, 6)
        events.append(ev)
        if e["kind"] == "note":
            notes.append({"startTick": e["startTick"], "ticks": e["ticks"], "midi": e["midi"],
                          "start": ev["start"], "end": ev["end"]})
    return {"name": hid, "song": song, "heldOut": bool(held_out), "style": ann["style"],
            "source": {"kind": "humming", "durationSec": round(audio_sec, 4)},
            "info": {"bpm": ann["bpm"], "ts": ann["ts"], "startSec": t0},
            "bars": ann["bars"], "totalTicks": sum(e["ticks"] for e in ann["events"]),
            "notes": notes, "events": events}


# ---------------------------------------------------------------- registry

def _load_ids(rec_dir):
    p = os.path.join(rec_dir, IDS_FILE)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {"version": 1, "recordings": {}}


def _save_ids(rec_dir, ids):
    with open(os.path.join(rec_dir, IDS_FILE), "w", encoding="utf-8") as f:
        json.dump(ids, f, indent=1, ensure_ascii=False)


def register_take(rec_dir, base, style, now=None):
    """-> (take id hum-NN-<style>, song id hum-NN, heldOut). Same rules as intake.register_take: the song is found by
    its key (file stem up to the first '_'), else registered with the next number; even number = held-out; the
    decision is final and shared by all takes of the song. Written to hum-ids.local.json before anything else."""
    os.makedirs(rec_dir, exist_ok=True)
    ids = _load_ids(rec_dir)
    recs = ids["recordings"]
    key = I.song_key(base)
    song = held = None
    nums = [0]
    for rid, e in recs.items():
        m = re.match(r"hum-(\d+)", rid)
        if m:
            nums.append(int(m.group(1)))
        if song is None and e["songKey"] == key:
            song, held = e["song"], bool(e["heldOut"])
    if song is None:
        no = max(nums) + 1
        song = f"hum-{no:02d}"
        held = I.song_held_out(no)
    tag, i = style, 1
    while f"{song}-{tag}" in recs:
        i += 1
        tag = f"{style}{i}"
    rid = f"{song}-{tag}"
    stamp = now or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    recs[rid] = {"original": base, "songKey": key, "song": song, "heldOut": held, "style": style,
                 "registeredAt": stamp}
    _save_ids(rec_dir, ids)
    return rid, song, held


def _log_register(out, rid, held_out, style, song):
    d = os.path.join(out, "results")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "heldout-log.jsonl"), "a") as f:
        f.write(json.dumps({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                            "kind": "register", "input": "hum", "take": rid, "song": song, "heldOut": held_out,
                            "style": style, "variants": [rid]}) + "\n")


def _merge_manifest(out, entry):
    d = os.path.join(out, "rec")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "manifest.hum.json")
    man = {"variants": []}
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            man = json.load(f)
    man["variants"] = [v for v in man["variants"] if v["name"] != entry["name"]] + [entry]
    man["variants"].sort(key=lambda v: v["name"])
    with open(p, "w", encoding="utf-8") as f:
        json.dump(man, f, indent=1)


def process_take(base, t, rec_dir, out, log=print):
    """Returns the take id. Raises HumError before anything is registered."""
    if not t["audio"]:
        raise HumError("音声ファイルがありません")
    if len(t["audio"]) > 1:
        raise HumError("同じ名前の音声ファイルが 2 つあります（1 本だけにしてください）")
    if not t["txt"]:
        raise HumError(".txt がありません")
    with open(t["txt"], encoding="utf-8") as f:
        ann = parse_hum_txt(f.read())
    path = t["audio"].get("plain") or next(iter(t["audio"].values()))
    try:
        y = I.decode_audio(path)
    except I.IntakeError as e:
        raise HumError(str(e))
    audio_sec = len(y) / TARGET_SR
    end = ann["startSec"] + sum(e["ticks"] for e in ann["events"]) * 60.0 / ann["bpm"] / (WHOLE_TICKS / ann["ts"][1])
    rid, song, held_out = register_take(rec_dir, base, ann["style"])
    _log_register(out, rid, held_out, ann["style"], song)  # BEFORE any analysis
    import soundfile as sf
    wav = os.path.join(rec_dir, rid + ".wav")
    sf.write(wav, y, TARGET_SR, subtype="PCM_24")
    truth = build_truth(ann, rid, song, held_out, audio_sec)
    for d in (rec_dir, os.path.join(out, "rec")):
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, rid + ".truth.json"), "w", encoding="utf-8") as f:
            json.dump(truth, f, indent=1, ensure_ascii=False)
    _merge_manifest(out, {"name": rid, "wav": f"recordings/{rid}.wav", "truth": f"out/rec/{rid}.truth.json",
                          "song": song, "heldOut": held_out, "style": ann["style"], "bpm": ann["bpm"],
                          "ts": ann["ts"], "startSec": ann["startSec"], "durationSec": round(audio_sec, 4)})
    originals = sorted(os.path.basename(p) for p in list(t["audio"].values()) + [t["txt"]])
    odir = os.path.join(rec_dir, "hum-originals")
    os.makedirs(odir, exist_ok=True)
    shutil.move(path, os.path.join(odir, rid + os.path.splitext(path)[1].lower()))
    shutil.move(t["txt"], os.path.join(odir, rid + ".txt"))
    ids = _load_ids(rec_dir)
    ids["recordings"][rid]["originalFiles"] = originals
    _save_ids(rec_dir, ids)
    note = ""
    if audio_sec < end - 0.5:
        note = "（注意: 録音が正解のメロディより短いようです）"
    log(f"{rid}: 取り込みました [{'ホールドアウト' if held_out else '開発用'}] "
        f"{audio_sec:.1f}秒、{ann['bars']}小節{note}")
    return rid


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", default=INBOX)
    ap.add_argument("--out", default="out")
    ap.add_argument("--recordings", default=None, help="default: parent of --inbox")
    ap.add_argument("--privacy-root", default=None, help="scan this tree instead of the repository (tests)")
    ap.add_argument("--no-privacy-check", action="store_true")
    a = ap.parse_args(argv)
    rec_dir = a.recordings or os.path.dirname(os.path.abspath(a.inbox))
    os.makedirs(a.inbox, exist_ok=True)
    takes = I.scan_inbox(a.inbox)
    if not takes:
        print("hum-inbox が空です。音声(.wav など)と同じ名前の .txt を入れてください。")
        return 0
    fails = 0
    for i, (base, t) in enumerate(takes.items(), 1):
        try:
            process_take(base, t, rec_dir, a.out)
        except HumError as e:
            fails += 1
            print(f"[{i}番目のファイルの組] 取り込めませんでした: {e}  (inbox に残してあります)")
    if not a.no_privacy_check:
        import privacy_check
        rc = privacy_check.main(["--recordings", rec_dir] + (["--root", a.privacy_root, "--no-log"] if a.privacy_root else []))
        if rc:
            return rc
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
