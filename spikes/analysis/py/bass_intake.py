"""Drop-folder intake of the user's 6 piano recordings for the bass/slash-chord spike (spike 6, task T4).

Usage (from spikes/analysis):  python py/bass_intake.py [--inbox recordings/bas-inbox] [--out out] [--reintake]
                               [--reintake-held-out] [--skip-start-check] [--reparse [bas-NN-x ...]]

The user drops   <a..f>.<audio>   and   <a..f>.txt   (the template from bass-scores/<x>.txt) into recordings/bas-inbox/.
The .txt is spike 2's chord-chart format (`| G G/B | C |`, `/X` = the bass the left hand plays), read by intake.parse_txt
after the bass-only template lines are taken out (see parse_bass_txt). The chords are compared with the committed
template bass-scores/<x>.txt so an accidental edit is an error.

For every take this script
  1. parses + validates the .txt (errors are Japanese; nothing is registered when the text is wrong),
  2. takes the id (bas-NN-x, NN = letter order) and the held-out flag from the LETTER (HELD_OUT = e, f; a different
     `ホールドアウト:` in the .txt is an error), registers it in recordings/bas-ids.local.json and appends
     out/results/heldout-log.jsonl (kind "register", input "bass") BEFORE the audio file is opened,
  3. decodes the audio, runs the `開始:` check (start_check) and stops on a failure (the take stays registered and in
     the inbox; fix the .txt and run again; --skip-start-check overrides and is recorded),
  4. stores mono 44.1 kHz 24-bit WAV as recordings/bas-NN-x.wav, moves the originals to recordings/bas-originals/,
     writes recordings/bas-NN-x.truth.json + out/rec/bas-NN-x.truth.json (rec_truth.build_truth: timed chords with
     `bass`, plus name / heldOut / style / excludedBars / startCheck) and merges out/rec/manifest.bass.json,
  5. runs privacy_check.
An imported take (its WAV exists) is refused unless --reintake (dev) / --reintake-held-out; the id and the flag never
change. Names, equipment, chords and timings are not printed. The audio is never analysed here, and the audio of the
held-out takes must never be analysed before the final look.
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
import drum_intake as D  # noqa: E402  (parse_bar_ranges, registry helpers' style)
import intake as I  # noqa: E402
import rec_truth as RT  # noqa: E402

IDS_FILE = "bas-ids.local.json"
INBOX = "recordings/bas-inbox"
SCORES = "bass-scores"  # committed templates (self-made songs), relative to spikes/analysis
TARGET_SR = I.TARGET_SR
LETTERS = "abcdef"
HELD_OUT = frozenset("ef")
# Template-only lines parse_txt does not know. Handled here, never passed on.
OWN_KEYS = {"ホールドアウト": "heldout", "機材": "gear", "楽譜と違って弾いた小節": "excluded", "クリック": "click"}
# `開始:` check margins (see start_check)
SHORT_BEATS = 1.0  # the file may end up to 1 beat before the score's end (an early cut of the last chord)
LONG_BARS = 1.0  # ... and may continue 1 bar + LONG_EXTRA_SEC after it (the decay and the pad)
LONG_EXTRA_SEC = 2.0


class BassError(ValueError):
    pass


def held_out_of(letter):
    return letter in HELD_OUT


def rec_id(letter):
    return f"bas-{LETTERS.index(letter) + 1:02d}-{letter}"


def parse_bass_txt(text, letter):
    """-> annotation dict (rec_truth.build_truth input) + startSec, excludedBars, gear, style. Raises BassError.
    `クリック:` is validated (あり / なし) and then IGNORED: it says the player heard a click in the headphones, the
    recording has none, so source.click is always False. `機材:` is free text kept in the truth (not printed).
    `ホールドアウト:` must agree with the letter. The takes are bar-timed, so a lyric line / key change is not allowed."""
    own, rest = {}, []
    for i, raw in enumerate(text.lstrip("﻿").replace("\r\n", "\n").split("\n"), 1):
        line = unicodedata.normalize("NFKC", raw).strip()
        m = re.match(r"^([^:|\[\]#]+?)\s*:\s*(.*)$", line)
        if m and m.group(1).strip() in OWN_KEYS:
            k = OWN_KEYS[m.group(1).strip()]
            if k in own:
                raise BassError(f"{i} 行目: 「{m.group(1).strip()}」が 2 回あります")
            own[k] = (i, re.split(r"\s+#", " " + m.group(2))[0].strip())
            rest.append("")  # keep the line numbers of the remaining errors
        elif m and m.group(1).strip() in ("開始", "start"):
            rest.append(f"開始: {re.split(chr(32) + '#', ' ' + m.group(2))[0].strip()}")
        else:
            rest.append(raw)
    try:
        ann = I.parse_txt("\n".join(rest), require_style=False)
    except I.IntakeError as e:
        raise BassError(str(e))
    if ann.get("timing") == "sequence" or ann.get("keys") or ann.get("pickupBeats"):
        raise BassError("弱起・途中のキー変更は使えません")
    if ann.get("start") is None:
        raise BassError("「開始:」が書かれていません")
    if "heldout" in own:
        h = own["heldout"][1].strip().lower()
        if h not in I.TRUE | I.FALSE:
            raise BassError(f"{own['heldout'][0]} 行目: ホールドアウトは はい / いいえ で書いてください")
        if (h in I.TRUE) != held_out_of(letter):
            raise BassError("ホールドアウトの印が決め（e・f がホールドアウト）と違います")
    if "click" in own:
        try:
            I._bool(own["click"][1], own["click"][0], "クリック")
        except I.IntakeError as e:
            raise BassError(str(e))
    ann["click"] = False  # headphones only; the recording has no click
    ann.pop("tempoHint", None)
    ann["style"], ann["styles"] = letter, [letter]
    n = len(ann["bars"])
    ann["startSec"] = ann["start"]
    try:
        ann["excludedBars"] = D.parse_bar_ranges(own.get("excluded", (0, ""))[1], n, "楽譜と違って弾いた小節")
    except D.DrumError as e:
        raise BassError(str(e))
    ann["gear"] = own.get("gear", (0, ""))[1]
    return ann


def check_against_template(ann, scores_dir, letter):
    """The chords / tempo / time signature / key must equal the committed template (they are the truth)."""
    p = os.path.join(scores_dir, f"{letter}.txt")
    if not os.path.exists(p):
        raise BassError("楽譜の雛形（bass-scores/x.txt）がありません")
    with open(p, encoding="utf-8") as f:
        ref = parse_bass_txt(f.read(), letter)
    for k in ("tempo", "timeSignature", "key", "bars"):
        if ann.get(k) != ref.get(k):
            raise BassError("コードの行・bpm・拍子・キーが楽譜の雛形と違います（変えないでください）")


def start_check(start, audio_sec, bpm, num, n_bars):
    """The `開始:` check. Only the file length and the text are used: no audio sample is looked at (no music analysis).
    bar 1 is at `start`; the score ends at end = start + n_bars * bar. -> (ok, reason, info).
    Fails when start is negative or past the file, when the file ends more than SHORT_BEATS before `end` (start too
    late, e.g. one bar), or continues more than LONG_BARS bar + LONG_EXTRA_SEC after it (start too early / a long
    silence). Limits: a start that is wrong by less than the margins (about one beat early / late within the decay
    slack), or a cut-off compensated by a long tail, is NOT detected; a one-bar-early start is only caught when the
    tail is then longer than 1 bar + 2 s, so it can slip through on a recording with a long decay."""
    beat = 60.0 / bpm
    bar = num * beat
    end = start + n_bars * bar
    tail = audio_sec - end
    info = {"tailSec": round(tail, 3), "barSec": round(bar, 3)}
    if start < 0 or start >= audio_sec:
        return False, "「開始:」が録音の範囲外です", info
    if tail < -SHORT_BEATS * beat:
        return False, f"録音が楽譜の終わりより {-tail / bar:.2f} 小節ぶん短いです（「開始:」が遅すぎるか、録音が途中で切れています）", info
    if tail > LONG_BARS * bar + LONG_EXTRA_SEC:
        return False, f"楽譜の終わりのあと {tail / bar:.2f} 小節ぶん録音が続いています（「開始:」が早すぎるか、頭か終わりに余白があります）", info
    return True, "", info


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
        f.write(json.dumps({"time": _now(), "kind": kind, "input": "bass", "take": rid, "song": rid,
                            "heldOut": held_out, "style": style, "variants": [rid]}) + "\n")


def _merge_manifest(out, entry):
    d = os.path.join(out, "rec")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "manifest.bass.json")
    man = {"variants": []}
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            man = json.load(f)
    man["variants"] = [v for v in man["variants"] if v["name"] != entry["name"]] + [entry]
    man["variants"].sort(key=lambda v: v["name"])
    with open(p, "w", encoding="utf-8") as f:
        json.dump(man, f, indent=1)


def build_truth(ann, rid, held_out, audio_sec, check_state):
    t = RT.build_truth(ann, audio_sec, ann["startSec"], ann["tempo"], name=rid)
    t.update({"name": rid, "heldOut": held_out, "style": ann["style"], "gear": ann["gear"],
              "startSec": ann["startSec"], "excludedBars": ann["excludedBars"], "startCheck": check_state,
              "nBars": len(ann["bars"])})
    return t


def _write_truth(truth, rec_dir, out):
    rid = truth["name"]
    for d in (rec_dir, os.path.join(out, "rec")):
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, rid + ".truth.json"), "w", encoding="utf-8") as f:
            json.dump(truth, f, indent=1, ensure_ascii=False)
    _merge_manifest(out, {"name": rid, "wav": f"recordings/{rid}.wav", "truth": f"out/rec/{rid}.truth.json",
                          "heldOut": truth["heldOut"], "style": truth["style"], "bpm": truth["beats"] and
                          round(60.0 / (truth["beats"][1]["t"] - truth["beats"][0]["t"]), 3),
                          "startSec": truth["startSec"], "durationSec": truth["source"]["audioSec"],
                          "excludedBars": truth["excludedBars"], "startCheck": truth["startCheck"]})


def process_take(base, t, rec_dir, out, scores_dir, reintake=False, reintake_held_out=False, skip_start=False, log=print):
    """Returns the take id. Raises BassError."""
    if base.lower() not in tuple(LETTERS):
        raise BassError("ファイル名は a〜f のどれかにしてください")
    letter = base.lower()
    if not t["audio"]:
        raise BassError("音声ファイルがありません")
    if len(t["audio"]) > 1:
        raise BassError("同じ名前の音声ファイルが 2 つあります（1 本だけにしてください）")
    if not t["txt"]:
        raise BassError(".txt がありません")
    with open(t["txt"], encoding="utf-8") as f:
        ann = parse_bass_txt(f.read(), letter)
    check_against_template(ann, scores_dir, letter)
    rid, held_out = rec_id(letter), held_out_of(letter)
    path = next(iter(t["audio"].values()))
    ids = _load_ids(rec_dir)
    done = os.path.exists(os.path.join(rec_dir, rid + ".wav"))
    if done and not (reintake_held_out if held_out else reintake):
        raise BassError("すでに取り込み済みです（やり直すときは " +
                        ("--reintake-held-out" if held_out else "--reintake") + "）")
    # registry + log BEFORE the audio is opened
    os.makedirs(rec_dir, exist_ok=True)
    if done or rid not in ids["recordings"]:
        ids["recordings"].setdefault(rid, {"letter": letter, "heldOut": held_out, "registeredAt": _now()})
        _save_ids(rec_dir, ids)
        _log(out, "reintake" if done else "register", rid, held_out, letter)
    try:
        y = I.decode_audio(path)
    except I.IntakeError as e:
        raise BassError(str(e))
    audio_sec = len(y) / TARGET_SR
    num = ann["timeSignature"][0]
    ok, why, info = start_check(ann["startSec"], audio_sec, ann["tempo"], num, len(ann["bars"]))
    if not ok and not skip_start:
        raise BassError(f"開始の確かめに通りません: {why}")
    state = {"ok": ok, "skipped": bool(skip_start and not ok), **info}
    import soundfile as sf
    sf.write(os.path.join(rec_dir, rid + ".wav"), y, TARGET_SR, subtype="PCM_24")
    _write_truth(build_truth(ann, rid, held_out, audio_sec, state), rec_dir, out)
    odir = os.path.join(rec_dir, "bas-originals")
    os.makedirs(odir, exist_ok=True)
    shutil.move(path, os.path.join(odir, rid + os.path.splitext(path)[1].lower()))
    shutil.move(t["txt"], os.path.join(odir, rid + ".txt"))
    log(f"{rid}: {'取り込み直しました' if done else '取り込みました'} [{'ホールドアウト' if held_out else '開発用'}] "
        f"{audio_sec:.1f}秒、{len(ann['bars'])}小節、開始の確かめ {'OK' if ok else '無視（--skip-start-check）'}、"
        f"外す小節 {len(ann['excludedBars'])}")
    return rid


def reparse(rec_dir, out, scores_dir, only=(), log=print):
    """--reparse: re-read bas-originals/<id>.txt for the imported takes (all when `only` is empty) and rewrite the
    truth (the start check runs again against the stored length). Ids, flags, WAVs and the registry are untouched;
    the log gets kind "reparse". -> number of failures."""
    ids = _load_ids(rec_dir)["recordings"]
    fails = 0
    for rid in sorted(only or ids):
        try:
            if rid not in ids:
                raise BassError("登録にありません")
            txt = os.path.join(rec_dir, "bas-originals", rid + ".txt")
            if not os.path.exists(txt):
                raise BassError(".txt が bas-originals にありません")
            letter = ids[rid]["letter"]
            with open(txt, encoding="utf-8") as f:
                ann = parse_bass_txt(f.read(), letter)
            check_against_template(ann, scores_dir, letter)
            with open(os.path.join(rec_dir, rid + ".truth.json"), encoding="utf-8") as f:
                old = json.load(f)
            dur = old["source"]["audioSec"]
            ok, why, info = start_check(ann["startSec"], dur, ann["tempo"], ann["timeSignature"][0], len(ann["bars"]))
            if not ok and not old["startCheck"].get("skipped"):
                raise BassError(f"開始の確かめに通りません: {why}")
            state = {"ok": ok, "skipped": bool(not ok), **info}
            _write_truth(build_truth(ann, rid, bool(ids[rid]["heldOut"]), dur, state), rec_dir, out)
            _log(out, "reparse", rid, bool(ids[rid]["heldOut"]), letter)
            log(f"{rid}: 正解を作り直しました、外す小節 {len(ann['excludedBars'])}")
        except (BassError, OSError, KeyError, ValueError) as ex:
            fails += 1
            log(f"{rid}: NG {ex}")
    return fails


def gear_warnings(rec_dir):
    """Held-out takes (e, f) should use a different piano timbre from a-d (the user writes it in `機材:`); an empty
    `機材:` cannot be compared. Warn only; nothing about the value is printed."""
    dev, held, empty = set(), set(), 0
    for rid, e in _load_ids(rec_dir)["recordings"].items():
        p = os.path.join(rec_dir, rid + ".truth.json")
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8") as f:
            g = unicodedata.normalize("NFKC", json.load(f).get("gear", "")).strip().lower()
        if not g:
            empty += 1
        else:
            (held if e["heldOut"] else dev).add(g)
    w = []
    if empty:
        w.append(f"「機材:」が空の録音が {empty} 本あります（ホールドアウトの音色が別かどうか確かめられません）")
    if dev & held:
        w.append("ホールドアウト（e・f）の「機材:」が開発用（a〜d）と同じです（別の音色で録る方針）")
    return w


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", default=INBOX)
    ap.add_argument("--out", default="out")
    ap.add_argument("--recordings", default=None, help="default: parent of --inbox")
    ap.add_argument("--scores", default=SCORES, help="the committed templates (default bass-scores)")
    ap.add_argument("--privacy-root", default=None, help="scan this tree instead of the repository (tests)")
    ap.add_argument("--no-privacy-check", action="store_true")
    ap.add_argument("--reintake", action="store_true", help="allow importing an imported DEV take again")
    ap.add_argument("--reintake-held-out", action="store_true", help="allow the same for a held-out take (explicit)")
    ap.add_argument("--skip-start-check", action="store_true", help="import although the `開始:` check fails (recorded)")
    ap.add_argument("--reparse", nargs="*", metavar="ID", help="rebuild the truth from bas-originals (all, or the ids)")
    a = ap.parse_args(argv)
    rec_dir = a.recordings or os.path.dirname(os.path.abspath(a.inbox))
    if a.reparse is not None:
        return 1 if reparse(rec_dir, a.out, a.scores, a.reparse) else 0
    os.makedirs(a.inbox, exist_ok=True)
    takes = I.scan_inbox(a.inbox)
    if not takes:
        print("bas-inbox が空です。a.wav … f.wav と同じ名前の .txt を入れてください。")
        return 0
    fails = 0
    for base, t in takes.items():
        try:
            process_take(base, t, rec_dir, a.out, a.scores, a.reintake, a.reintake_held_out, a.skip_start_check)
        except BassError as e:
            fails += 1
            print(f"[{base[:1]}] 取り込めませんでした: {e}  (inbox に残してあります)")
    for w in gear_warnings(rec_dir):
        print("注意:", w)
    if not a.no_privacy_check:
        import privacy_check
        # scores are self-made (RECORDING.md §9): 0 private terms is expected, so --allow-empty keeps a successful intake from printing a failure
        rc = privacy_check.main(["--recordings", rec_dir, "--allow-empty"] + (["--root", a.privacy_root, "--no-log"] if a.privacy_root else []))
        if rc:
            return rc
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
