"""Drop-folder intake of real recordings (task T3).

Usage (from spikes/analysis):  python py/intake.py [--inbox recordings/inbox] [--out out] [--dry-run]

The user drops   <anyname>.<audio>  (+ optional <anyname>.max.<audio>, the post-maximizer export of the same take)
                 <anyname>.txt      (bpm / time signature / style / bars, see parse_txt)
                 <anyname>.mid      (optional: what was played)
into recordings/inbox/. For every take this script
  1. parses + validates the .txt and decodes the audio (all errors are Japanese, line-numbered),
  2. gives the take an anonymous id rec-NN and records heldOut (decided by the style: b, d = held-out) in
     recordings/ids.local.json and out/results/heldout-log.jsonl BEFORE any analysis,
  3. stores mono 44.1 kHz 24-bit WAV as recordings/rec-NN[-max].wav, moves the originals (and the txt / mid) to
     recordings/originals/ (all gitignored),
  4. finds the start (bar 1 beat 1; first onset unless `開始:` is given), writes recordings/rec-NN.chords.json,
     out/rec/<id>.truth.json and merges out/rec/manifest.rec.json,
  5. runs privacy_check.
Original file names and titles are never printed.
"""
import argparse
import json
import os
import re
import shutil
import sys
import unicodedata

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rec_truth as RT  # noqa: E402

AUDIO_EXT = {".wav", ".flac", ".ogg", ".mp3", ".aif", ".aiff", ".m4a", ".aac", ".wma"}
MIDI_EXT = {".mid", ".midi"}
TARGET_SR = 44100
HELD_OUT_STYLES = {"b", "d"}  # plan section 3.3: development = REC, a, c, e; held-out = b, d

KEYS = {"bpm": "bpm", "テンポ": "bpm", "拍子": "time", "time": "time", "キー": "key", "key": "key",
        "弾き方": "style", "style": "style", "弱起": "pickup", "pickup": "pickup", "開始": "start", "start": "start",
        "クリック": "click", "click": "click", "マキシマイザー": "maximizer", "maximizer": "maximizer"}
TRUE = {"あり", "有", "yes", "y", "true", "1", "on", "はい"}
FALSE = {"なし", "無", "no", "n", "false", "0", "off", "いいえ"}


class IntakeError(ValueError):
    pass


def _bool(v, ln, key):
    v = v.strip().lower()
    if v in TRUE:
        return True
    if v in FALSE:
        return False
    raise IntakeError(f"{ln}行目: 「{key}」は あり / なし で書いてください")


def _norm(line):
    line = unicodedata.normalize("NFKC", line)  # full-width digits, colon, bar, sharp ...
    return line.replace("♯", "#").replace("♭", "b")


def parse_txt(text):
    """-> annotation dict for rec_truth.build_truth (without wav / firstSoundSec) plus meta keys:
    style, start (sec or None), maximizer (bool or None). Raises IntakeError (Japanese, line-numbered)."""
    head = {}
    bar_lines = []
    for ln, raw in enumerate(text.lstrip("﻿").splitlines(), 1):
        line = _norm(raw).strip()
        if not line or line.startswith("#"):  # blank / whole-line comment ('#' elsewhere is a sharp)
            continue
        if line.startswith("|"):
            bar_lines.append((ln, line))
            continue
        m = re.fullmatch(r"([^:]+?)\s*:\s*(.*)", line)
        if not m:
            raise IntakeError(f"{ln}行目: 「キー: 値」の形でも「| コード |」の形でもありません")
        k = KEYS.get(m.group(1).strip().lower())
        if k is None:
            raise IntakeError(f"{ln}行目: 知らない項目「{m.group(1)}」(使えるのは bpm / 拍子 / キー / 弾き方 / 弱起 / 開始 / "
                              "クリック / マキシマイザー)")
        head[k] = (ln, m.group(2).strip())
    for need, label in (("bpm", "bpm"), ("style", "弾き方")):
        if need not in head:
            raise IntakeError(f"「{label}:」がありません")
    ln, v = head["bpm"]
    try:
        bpm = float(v)
    except ValueError:
        raise IntakeError(f"{ln}行目: bpm は数字で書いてください")
    if not 30 <= bpm <= 300:
        raise IntakeError(f"{ln}行目: bpm は 30〜300 の範囲です")
    ln, v = head.get("time", (0, "4/4"))
    m = re.fullmatch(r"(\d+)\s*/\s*4", v)
    if not m or not 2 <= int(m.group(1)) <= 7:
        raise IntakeError(f"{ln}行目: 拍子は 4/4・3/4 のような「n/4」だけ使えます")
    num = int(m.group(1))
    eps = num * 2
    ln, v = head["style"]
    st = v.strip().strip("()").lower()
    if st not in list("abcde"):
        raise IntakeError(f"{ln}行目: 弾き方は a〜e のどれかです")
    pickup = 0
    if "pickup" in head:
        ln, v = head["pickup"]
        m = re.fullmatch(r"(\d+)\s*(拍|beats?)?", v.strip().lower())
        if not m or not 0 <= int(m.group(1)) < num:
            raise IntakeError(f"{ln}行目: 弱起は 0〜{num - 1} 拍で「1拍」のように書きます")
        pickup = int(m.group(1))
    start = None
    if "start" in head:
        ln, v = head["start"]
        m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(秒|s|sec)?", v.strip().lower())
        if not m:
            raise IntakeError(f"{ln}行目: 開始は「1.23秒」のように書きます")
        start = float(m.group(1))
        if pickup * 60.0 / bpm > start + 1e-9:
            raise IntakeError(f"{ln}行目: 開始({start}秒)が小さすぎます。弱起{pickup}拍ぶん({pickup * 60.0 / bpm:.3f}秒)"
                              "より前の位置には置けません")
    key = None
    if "key" in head:
        ln, v = head["key"]
        v = v.strip()
        if RT._key_text(v) is None:
            raise IntakeError(f"{ln}行目: キーは C・F#・Bb・Am のように書きます")
        key = v
    click = True
    if "click" in head:
        click = _bool(head["click"][1], head["click"][0], "クリック")
    maximizer = None
    if "maximizer" in head:
        maximizer = _bool(head["maximizer"][1], head["maximizer"][0], "マキシマイザー")
    bars = []
    for ln, line in bar_lines:
        for seg in line.split("|"):
            toks = seg.split()
            if not toks:
                continue
            n = len(toks)
            if eps % n:
                raise IntakeError(f"{ln}行目: 小節「{seg.strip()}」は {n} 個に分かれますが、1小節({num}拍)を等分できません")
            if toks[0] == ".":
                raise IntakeError(f"{ln}行目: 小節の最初に「.」は置けません")
            each = eps // n
            entries = []
            for t in toks:
                if t == ".":
                    entries[-1][1] += each
                    continue
                if t.upper() in ("N.C.", "N"):
                    entries.append(["N.C.", each])
                    continue
                try:
                    RT.parse_chord(t)
                except ValueError:
                    raise IntakeError(f"{ln}行目: コード「{t}」が読めません")
                entries.append([t, each])
            bars.append(entries)
    if not bars:
        raise IntakeError("コードの小節(| F | Dm7 | のような行)がありません")
    ann = {"tempo": bpm, "timeSignature": [num, 4], "click": click, "eighthsPerBar": eps, "sections": [],
           "bars": bars, "style": st, "start": start, "maximizer": maximizer}
    if pickup:
        ann["pickupBeats"] = pickup
    if key:
        ann["key"] = key
    if click:
        ann["tempoHint"] = bpm
    return ann


def decode_audio(path):
    """-> (mono float32 at TARGET_SR). Raises IntakeError (Japanese) when undecodable."""
    import soundfile as sf
    try:
        y, sr = sf.read(path, dtype="float32", always_2d=True)
    except Exception:
        ext = os.path.splitext(path)[1].lower()
        raise IntakeError(f"この音声ファイル({ext})は読めません。DAW から WAV で書き出してください")
    y = y.mean(axis=1)
    if y.size == 0 or float(np.abs(y).max()) < 1e-5:
        raise IntakeError("音声が無音か空です")
    if sr != TARGET_SR:
        import librosa
        y = librosa.resample(y, orig_sr=sr, target_sr=TARGET_SR)
    return np.clip(y, -1.0, 1.0).astype(np.float32)


def first_onset(y, sr=TARGET_SR):
    import librosa
    y = librosa.resample(y, orig_sr=sr, target_sr=22050)
    hop = 128
    env = librosa.onset.onset_strength(y=librosa.effects.percussive(y), sr=22050, hop_length=hop)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=22050, hop_length=hop, backtrack=False)
    frames = [f for f in frames if env[f] >= 0.2 * env.max()]
    if not frames:
        raise IntakeError("音の始まりが見つかりません。「開始:」で秒数を指定してください")
    return float(librosa.frames_to_time(frames[0], sr=22050, hop_length=hop))


def validate_midi(path):
    """Minimal SMF check (no MIDI library in the image): header + chunk lengths. Raises IntakeError."""
    data = open(path, "rb").read()
    if data[:4] != b"MThd" or len(data) < 14:
        raise IntakeError("MIDI ファイルとして読めません")
    hlen = int.from_bytes(data[4:8], "big")
    ntr = int.from_bytes(data[10:12], "big")
    pos = 8 + hlen
    n = 0
    while pos + 8 <= len(data):
        if data[pos:pos + 4] != b"MTrk":
            raise IntakeError("MIDI ファイルのトラックが壊れています")
        pos += 8 + int.from_bytes(data[pos + 4:pos + 8], "big")
        n += 1
    if n != ntr or pos != len(data):
        raise IntakeError("MIDI ファイルのトラックの数・長さが合いません")


def scan_inbox(inbox):
    """-> {base: {"audio": {"plain"|"max": path}, "txt": path|None, "midi": path|None}} (sorted by base)."""
    takes = {}
    for fn in sorted(os.listdir(inbox)):
        stem, ext = os.path.splitext(fn)
        ext = ext.lower()
        p = os.path.join(inbox, fn)
        if fn.startswith(".") or not os.path.isfile(p):
            continue
        if ext in AUDIO_EXT:
            kind = "max" if stem.lower().endswith(".max") else "plain"
            base = stem[:-4] if kind == "max" else stem
            takes.setdefault(base, {"audio": {}, "txt": None, "midi": None})["audio"][kind] = p
        elif ext == ".txt":
            takes.setdefault(stem, {"audio": {}, "txt": None, "midi": None})["txt"] = p
        elif ext in MIDI_EXT:
            takes.setdefault(stem, {"audio": {}, "txt": None, "midi": None})["midi"] = p
    return takes


def _log_register(out, rid, held_out, style, variants):
    import datetime
    d = os.path.join(out, "results")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "heldout-log.jsonl"), "a") as f:
        f.write(json.dumps({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                            "kind": "register", "take": rid, "heldOut": held_out, "style": style,
                            "variants": variants}) + "\n")


def process_take(base, t, rec_dir, out, log=print, fit=True):
    """Returns the list of variant names written. Raises IntakeError before anything is registered."""
    if not t["audio"]:
        raise IntakeError("音声ファイルがありません")
    if not t["txt"]:
        raise IntakeError("コードの .txt がありません")
    ann = parse_txt(open(t["txt"], encoding="utf-8").read())
    if t["midi"]:
        validate_midi(t["midi"])
    audio = {k: decode_audio(p) for k, p in t["audio"].items()}
    held_out = ann["style"] in HELD_OUT_STYLES
    originals = sorted(os.path.basename(p) for p in list(t["audio"].values()) + [t["txt"]])
    rid = RT.allocate_id(rec_dir, base, held_out, ann["style"])
    names = {}
    both = len(audio) == 2
    for kind in audio:
        names[kind] = rid + ("-max" if both and kind == "max" else "")
    _log_register(out, rid, held_out, ann["style"], list(names.values()))
    odir = os.path.join(rec_dir, "originals")
    os.makedirs(odir, exist_ok=True)
    import soundfile as sf
    beat = 60.0 / ann["tempo"]
    pickup = ann.get("pickupBeats", 0)
    has_midi = bool(t["midi"])
    written = []
    for kind, y in audio.items():
        name = names[kind]
        wav = os.path.join(rec_dir, name + ".wav")
        sf.write(wav, y, TARGET_SR, subtype="PCM_24")
        a = {k: v for k, v in ann.items() if k not in ("style", "start", "maximizer")}
        a["wav"] = name + ".wav"
        a["maximizer"] = (kind == "max") if both else ann["maximizer"]
        if has_midi:
            a["hasMidi"] = True
        if ann["start"] is not None:
            a["firstSoundSec"] = round(ann["start"] - pickup * beat, 4)
            how = "指定"
            f = {"t0": a["firstSoundSec"], "tempo": ann["tempo"], "residualMedianMs": 0.0, "nOnsets": 0}
        else:
            a["firstSoundSec"] = round(first_onset(y), 4)
            how = "最初の音から自動検出"
            f = None
        if f is None:
            f = RT.fit_grid(wav, a) if fit else {"t0": a["firstSoundSec"], "tempo": ann["tempo"],
                                               "residualMedianMs": 0.0, "nOnsets": 0}
            how += f"、ずれ補正後 {f['t0'] + pickup * beat:.3f}秒"
        f["audioSec"] = len(y) / TARGET_SR
        with open(os.path.join(rec_dir, name + ".chords.json"), "w") as fh:
            json.dump(a, fh, indent=1, ensure_ascii=False)
        RT.emit(a, wav, name, out, f, held_out, take=rid)
        bar1 = f["t0"] + pickup * beat
        log(f"{name}: 1小節目の頭 = {bar1:.3f}秒 ({how})  [{'ホールドアウト' if held_out else '開発用'}]")
        written.append(name)
    # move originals out of the inbox (private area)
    for kind, p in t["audio"].items():
        shutil.move(p, os.path.join(odir, rid + (".max" if kind == "max" else "") + os.path.splitext(p)[1].lower()))
    shutil.move(t["txt"], os.path.join(odir, rid + ".txt"))
    if has_midi:
        ext = os.path.splitext(t["midi"])[1].lower()
        shutil.copy2(t["midi"], os.path.join(rec_dir, rid + ".mid"))
        shutil.move(t["midi"], os.path.join(odir, rid + ext))
    ids = RT._load_ids(rec_dir)
    ids["recordings"][rid]["files"] = written
    ids["recordings"][rid]["originalFiles"] = originals
    RT._save_ids(rec_dir, ids)
    return written


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", default="recordings/inbox")
    ap.add_argument("--out", default="out")
    ap.add_argument("--recordings", default=None, help="default: parent of --inbox")
    ap.add_argument("--privacy-root", default=None, help="scan this tree instead of the repository (tests)")
    ap.add_argument("--no-privacy-check", action="store_true")
    a = ap.parse_args(argv)
    rec_dir = a.recordings or os.path.dirname(os.path.abspath(a.inbox))
    if not os.path.isdir(a.inbox):
        os.makedirs(a.inbox, exist_ok=True)
    takes = scan_inbox(a.inbox)
    if not takes:
        print("inbox が空です。音声(.wav など)と同じ名前の .txt を入れてください。")
        return 0
    fails = 0
    for i, (base, t) in enumerate(takes.items(), 1):
        try:
            process_take(base, t, rec_dir, a.out)
        except IntakeError as e:
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
