"""Drop-folder intake of real recordings (task T3).

Usage (from spikes/analysis):  python py/intake.py [--inbox recordings/inbox] [--out out] [--dry-run]

The user drops   <anyname>.<audio>  (+ optional <anyname>.max.<audio>, the post-maximizer export of the same take)
                 <anyname>.txt      (bpm / time signature / style / bars, see parse_txt)
                 <anyname>.mid      (optional: what was played)
into recordings/inbox/. For every take this script
  1. parses + validates the .txt and decodes the audio (all errors are Japanese, line-numbered),
  2. gives the SONG an anonymous id rec-NN (takes of one song share it: file stem up to the first `_`, or the whole
     stem) and the take rec-NN-<style letter>; heldOut is decided per song when it is first registered (even NN =
     held-out) and recorded in recordings/ids.local.json and out/results/heldout-log.jsonl BEFORE any analysis,
  3. stores mono 44.1 kHz 24-bit WAV as recordings/rec-NN-<take>[-max].wav, moves the originals (and the txt / mid) to
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


_BRACKET = re.compile(r"\[([^\]]*)\]")
_BAR_TOKEN = re.compile(r"\[([^\]]*)\]|(-+)|(\s+)|(.)")


def _line_kind(line):
    """'bar' (has a bar line `|`, or only bracket chords / dashes), 'lyric' (bracket chords + other text, no `|`)
    or None (neither: key-value or garbage)."""
    if "|" in line:
        return "bar"
    if _BRACKET.search(line):
        rest = _BRACKET.sub("", line)
        return "bar" if not re.sub(r"[-.\s]", "", rest) else "lyric"
    return None


def _check_chord(t, ln):
    if t.upper() in ("N.C.", "N"):
        return "N.C."
    try:
        RT.parse_chord(t)
    except ValueError:
        raise IntakeError(f"{ln}行目: コード「{t}」が読めません")
    return t


def _parse_bar(seg, ln, num, eps, prev=None):
    """One bar segment -> [[chord, eighths], ...] or None when empty. Bracket form `[Dm]---[Am7]- --`: each `-` after a
    chord is one eighth of that chord, spaces are ignored; no dashes at all = split equally (a lone chord = whole bar).
    Old form `C . Em .`: tokens split the bar equally, `.` continues the previous chord."""
    if seg.strip() == "[":  # stray bracket at the end of a line: no bar
        return None
    if "[" in seg:
        cur = []  # [chord, dashes]
        lead = 0  # dashes before the first chord: the previous bar's last chord still sounds
        for m in _BAR_TOKEN.finditer(seg):
            if m.group(1) is not None:
                cur.append([_check_chord(m.group(1).strip(), ln), 0])
            elif m.group(2):
                if not cur:
                    lead += len(m.group(2))
                else:
                    cur[-1][1] += len(m.group(2))
            elif m.group(4):
                raise IntakeError(f"{ln}行目: 小節「{seg.strip()}」に読めない文字「{m.group(4)}」があります")
        if not cur:
            if not seg.strip():
                return None
            raise IntakeError(f"{ln}行目: 小節「{seg.strip()}」にコードがありません")
        if lead:
            if prev is None:
                raise IntakeError(f"{ln}行目: 小節「{seg.strip()}」の最初の「-」は前のコードの続きですが、前の小節がありません")
        tot = lead + sum(d for _, d in cur)
        if tot == 0:
            n = len(cur)
            if eps % n:
                raise IntakeError(f"{ln}行目: 小節「{seg.strip()}」は {n} 個に分かれますが、1小節({num}拍)を等分できません")
            return [[c, eps // n] for c, _ in cur]
        if any(d == 0 for _, d in cur):
            raise IntakeError(f"{ln}行目: 小節「{seg.strip()}」は「-」のあるコードとないコードが混ざっています(長さが決まりません)")
        if tot != eps:
            raise IntakeError(f"{ln}行目: 小節「{seg.strip()}」の長さが「-」{tot}個(八分音符{tot}個)で、"
                              f"1小節({num}拍 = 八分音符{eps}個)と合いません")
        return ([[prev, lead]] if lead else []) + [[c, d] for c, d in cur]
    toks = seg.split()
    if not toks:
        return None
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
        entries.append([_check_chord(t, ln), each])
    return entries


def _sequence_of(kind, ln, line):
    """Chord texts of a bar line / lyric line in order (lyrics are dropped on the spot; N.C. is no chord)."""
    out = []
    if kind == "bar" and "[" not in line:
        for seg in line.split("|"):
            out += [_check_chord(t, ln) for t in seg.split() if t != "."]
    else:
        out = [_check_chord(m.group(1).strip(), ln) for m in _BRACKET.finditer(line)]
    return [c for c in out if c != "N.C."]


def parse_txt(text, require_style=True, allow_sequence=False):
    """-> annotation dict for rec_truth.build_truth (without wav / firstSoundSec) plus meta keys:
    style (primary = first of `styles`), styles (list), start (sec or None), maximizer (bool or None).
    Raises IntakeError (Japanese, line-numbered). CRLF and trailing spaces are fine; `キー: ?` = no key.
    A `キー:` line AFTER the first bar line marks a modulation from the next bar (T28): the dict then also has
    "keys" = [{startBar, key}, ...] (the header key first, at bar 0). `require_style=False` (chart-only
    songs, py/charts.py) lets `弾き方:` be missing (style None).
    Chord lines: `| C . Em . |` (old) or `|[Dm]---[Am7]- --[Abm7]--|` (each `-` = one eighth). Lines with chords
    among lyrics and no bar line (`[CM7]words[D]words`) have no timing: with allow_sequence=True the result is
    sequence-only ("timing": "sequence", "sequence": [chord texts], "bars": []); lyrics are never kept."""
    head = {}
    items = []  # (kind, ln, line) in file order
    nbars = 0
    key_changes = []  # (line, text, bar index of the first bar it applies to)
    for ln, raw in enumerate(text.lstrip("\ufeff").splitlines(), 1):
        line = _norm(raw).strip()
        if not line or line.startswith("#"):  # blank / whole-line comment ('#' elsewhere is a sharp)
            continue
        line = re.sub(r"\[\s*\|\s*\]", " ", line)  # `[|]` = a bar mark inside a lyric line: no timing, just drop it
        if not line.strip():
            continue
        if re.fullmatch(r"[—–―－-]+[^|\[\]]*[—–―－-]+|[—–―－-]+", line):  # divider / section label like "-- name --"
            continue
        if "|" in line and "[" in line:  # text after the last bar line is a comment
            body, _, tail = line.rpartition("|")
            if "[" not in tail and re.sub(r"[-.\s]", "", tail):
                line = body + "|"
        kind = _line_kind(line)
        if kind:
            items.append((kind, ln, line))
            if kind == "bar":
                nbars += sum(1 for seg in line.split("|") if seg.split()) if "|" in line else 1
            continue
        m = re.fullmatch(r"([^:]+?)\s*:\s*(.*)", line)
        if not m:
            raise IntakeError(f"{ln}行目: 「キー: 値」の形でも「| コード |」の形でも「[コード]歌詞」の形でもありません")
        k = KEYS.get(m.group(1).strip().lower())
        if k is None:
            raise IntakeError(f"{ln}行目: 知らない項目「{m.group(1)}」(使えるのは bpm / 拍子 / キー / 弾き方 / 弱起 / 開始 / "
                              "クリック / マキシマイザー)")
        if k == "key" and items:
            key_changes.append((ln, m.group(2).strip(), nbars))
            continue
        head[k] = (ln, m.group(2).strip())
    for need, label in (("bpm", "bpm"), ("style", "弾き方")):
        if need not in head and (need == "bpm" or require_style):
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
    st = None
    styles = []
    if "style" in head:
        ln, v = head["style"]
        for t in re.split(r"[,、\s]+", v.strip().strip("()").lower()):
            if not t:
                continue
            if t not in list("abcde"):
                raise IntakeError(f"{ln}行目: 弾き方は a〜e のどれか(複数なら b,e のように区切る)です")
            if t not in styles:
                styles.append(t)
        if not styles:
            raise IntakeError(f"{ln}行目: 弾き方は a〜e のどれかです")
        st = styles[0]
    pickup = 0
    if "pickup" in head:
        ln, v = head["pickup"]
        m = re.fullmatch(r"(\d+)\s*(拍|beats?)?", "0" if v.strip().lower() in ("なし", "無", "none", "no") else v.strip().lower())
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
        if v in ("?", "不明", ""):
            key = None  # unknown key: key scoring is skipped
        elif RT._key_text(v) is None:
            raise IntakeError(f"{ln}行目: キーは C・F#・Bb・Am のように書きます(不明なら ?)")
        else:
            key = v
    click = True
    if "click" in head:
        click = _bool(head["click"][1], head["click"][0], "クリック")
    maximizer = None
    if "maximizer" in head:
        maximizer = _bool(head["maximizer"][1], head["maximizer"][0], "マキシマイザー")
    bars = []
    sequence = None
    if any(k == "lyric" for k, _, _ in items):  # no timing for (some of) the chord lines: order only
        if not allow_sequence:
            ln = next(ln for k, ln, _ in items if k == "lyric")
            raise IntakeError(f"{ln}行目: 歌詞つきのコード行(小節線なし)はここでは使えません")
        sequence = []
        for kind, ln, line in items:
            sequence += _sequence_of(kind, ln, line)
        if not sequence:
            raise IntakeError("コードがありません")
        key_changes = []
    else:
        for kind, ln, line in items:
            for seg in line.split("|"):
                entries = _parse_bar(seg, ln, num, eps, bars[-1][-1][0] if bars else None)
                if entries:
                    bars.append(entries)
        if not bars:
            raise IntakeError("コードの小節(| F | Dm7 | のような行)がありません")
    keys = []
    if key_changes:
        if key:
            keys.append({"startBar": 0, "key": key})
        for ln, v, at in key_changes:
            if RT._key_text(v) is None:
                raise IntakeError(f"{ln}行目: キーは C・F#・Bb・Am のように書きます")
            if at >= len(bars):
                raise IntakeError(f"{ln}行目: 途中のキーの後ろに小節がありません")
            if keys and keys[-1]["startBar"] == at:
                keys.pop()
            keys.append({"startBar": at, "key": v})
    ann = {"tempo": bpm, "timeSignature": [num, 4], "click": click, "eighthsPerBar": eps, "sections": [],
           "bars": bars, "style": st, "styles": styles, "start": start, "maximizer": maximizer}
    if sequence is not None:
        ann["timing"] = "sequence"
        ann["sequence"] = sequence
    if pickup:
        ann["pickupBeats"] = pickup
    if key:
        ann["key"] = key
    if keys:
        ann["keys"] = keys
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


def song_key(base):
    """Takes of one song: file stem up to the first '_' (the whole stem when there is none)."""
    return base.split("_", 1)[0]


def song_held_out(song_no):
    """Per-song rule, fixed when the song is first registered: even song number = held-out."""
    return song_no % 2 == 0


def register_take(rec_dir, base, style, now=None, styles=None):
    """-> (take id rec-NN-<take>, song id rec-NN, heldOut). The song is found by its key among the registered
    takes (legacy entries without "song" are their own song rec-NN) or registered new with the next number.
    The decision is final and shared by all takes of the song."""
    import datetime
    os.makedirs(rec_dir, exist_ok=True)
    ids = RT._load_ids(rec_dir)
    recs = ids["recordings"]
    key = song_key(base)
    song = held = None
    nums = [0]
    for rid, e in recs.items():
        m = re.match(r"rec-(\d+)", rid)
        if m:
            nums.append(int(m.group(1)))
        if song is None and song_key(e.get("songKey", e["original"])) == key:
            song = e.get("song") or rid
            held = bool(e["heldOut"])
    if song is None:
        no = max(nums) + 1
        song = f"rec-{no:02d}"
        held = song_held_out(no)
    tag, i = style, 1
    while f"{song}-{tag}" in recs:
        i += 1
        tag = f"{style}{i}"
    rid = f"{song}-{tag}"
    stamp = now or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    recs[rid] = {"original": base, "songKey": key, "song": song, "heldOut": held, "style": style, "file": None,
                 "registeredAt": stamp}
    if styles and len(styles) > 1:
        recs[rid]["styles"] = styles
    RT._save_ids(rec_dir, ids)
    return rid, song, held


def _log_register(out, rid, held_out, style, variants, song=None):
    import datetime
    d = os.path.join(out, "results")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "heldout-log.jsonl"), "a") as f:
        f.write(json.dumps({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                            "kind": "register", "take": rid, "song": song or rid, "heldOut": held_out,
                            "style": style, "variants": variants}) + "\n")


def process_take(base, t, rec_dir, out, log=print, fit=True):
    """Returns the list of variant names written. Raises IntakeError before anything is registered."""
    if not t["audio"]:
        raise IntakeError("音声ファイルがありません")
    if not t["txt"]:
        raise IntakeError("コードの .txt がありません")
    ann = parse_txt(open(t["txt"], encoding="utf-8").read(), allow_sequence=True)
    if t["midi"]:
        validate_midi(t["midi"])
    audio = {k: decode_audio(p) for k, p in t["audio"].items()}
    originals = sorted(os.path.basename(p) for p in list(t["audio"].values()) + [t["txt"]])
    rid, song, held_out = register_take(rec_dir, base, ann["style"], styles=ann["styles"])
    names = {}
    both = len(audio) == 2
    for kind in audio:
        names[kind] = rid + ("-max" if both and kind == "max" else "")
    _log_register(out, rid, held_out, ann["style"], list(names.values()), song)
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
        a = {k: v for k, v in ann.items() if k not in ("style", "styles", "start", "maximizer")}
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
        if f is None and ann.get("timing") == "sequence":
            f = {"t0": a["firstSoundSec"], "tempo": ann["tempo"], "residualMedianMs": 0.0, "nOnsets": 0}
            how += "(コードの順序だけ・拍の位置合わせなし)"
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
