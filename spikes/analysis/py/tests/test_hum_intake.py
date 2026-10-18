"""Tests for hum_intake.py and the humming part of privacy_check.py. Generic fake inputs only (made-up melody)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import hum_intake as H  # noqa: E402
import privacy_check as P  # noqa: E402

MELODY = """:4 C4 E4 G4 E4 |
:8 D4 F4 A4 F4 G4 E4 C5 r |
:2 B3 :4 D5 G4 |"""
MIDI = [60, 64, 67, 64, 62, 65, 69, 65, 67, 64, 72, 59, 74, 67]
TXT = f"""# note: fake
bpm: 120
拍子: 4/4
開始: 2秒
歌い方: a
メロディ:
{MELODY}
"""
TS = [4, 4]


def tone_wav(path, sec=8.0, sr=48000, channels=2):
    t = np.arange(int(sec * sr)) / sr
    y = 0.3 * np.sin(2 * np.pi * 220 * t)
    sf.write(path, np.stack([y] * channels, axis=1), sr, subtype="PCM_16")


class TestMelody(unittest.TestCase):
    def test_events_ticks_and_rest(self):
        ev, bars = H.parse_melody(MELODY, TS)
        self.assertEqual(bars, 3)
        self.assertEqual([e["midi"] for e in ev if e["kind"] == "note"], MIDI)
        self.assertEqual(ev[0], {"kind": "note", "startTick": 0, "ticks": 16, "midi": 60})
        rest = [e for e in ev if e["kind"] == "rest"]
        self.assertEqual(rest, [{"kind": "rest", "startTick": 64 + 56, "ticks": 8}])
        self.assertEqual(ev[-1]["startTick"] + ev[-1]["ticks"], 192)

    def test_tie_dot_accidentals_effects_and_glued_duration(self):
        ev, _ = H.parse_melody(':4 Bb3{d lyrics "ら ら"} C#4.8 r.8 :4 r :8 C#4 | :2 C#4{t} :2 C4 |', TS)
        self.assertEqual([(e["kind"], e["ticks"], e.get("midi")) for e in ev],
                         [("note", 24, 58), ("note", 8, 61), ("rest", 24, None), ("note", 40, 61), ("note", 32, 60)])
        ev, _ = H.parse_melody(":4 C4{ch \"C\"} r :2 r | :2 r :4 r C4 |", TS)
        self.assertEqual(ev[1]["ticks"], 96)  # rests merge, also across the bar line

    def test_errors_are_japanese(self):
        for bad in (":4 C4 E4 G4 | :4 C4 D4 E4 F4 |", ":4 C4 D4 E4 F4 | :4 c4 |", "C4 D4 |", ":4 C4 :8 {tu 3} |",
                    ":4 C4 D4 E4 F4 | | :4 C4 |", ":4 C4 r{t} |", "\\ts 4 4 :4 C4 |",
                    ":4 C4{tu 3} D4{tu 3} E4{tu 3} F4 |", ":4 C4 D4 E4 F4 | :4 C4 D4 E4 F4 G4 |"):
            with self.assertRaises(H.HumError, msg=bad):
                H.parse_melody(bad, TS)

    def test_short_last_bar_ok_middle_not(self):
        H.parse_melody(":4 C4 D4 E4 F4 | :4 C4 |", TS)
        with self.assertRaises(H.HumError):
            H.parse_melody(":4 C4 | :4 C4 D4 E4 F4 |", TS)


class TestTxt(unittest.TestCase):
    def test_parse(self):
        a = H.parse_hum_txt(TXT)
        self.assertEqual((a["bpm"], a["ts"], a["startSec"], a["style"], a["bars"]), (120.0, [4, 4], 2.0, "a", 3))

    def test_aliases_fullwidth_crlf_inline_melody(self):
        a = H.parse_hum_txt("テンポ：90\r\ntime: 3/4\r\nstart: 1.5s\r\nstyle: (b)\r\nmelody: :4 C4 D4 E4 |\r\n")
        self.assertEqual((a["bpm"], a["ts"], a["startSec"], a["style"]), (90.0, [3, 4], 1.5, "b"))

    def test_errors(self):
        for bad in (TXT.replace("bpm: 120\n", ""), TXT.replace("開始: 2秒\n", ""), TXT.replace("歌い方: a", "歌い方: z"),
                    TXT.replace("bpm: 120", "bpm: abc"), TXT.split("メロディ:")[0], TXT.replace("拍子: 4/4", "拍子: 4/5"),
                    "xyz\n" + TXT):
            with self.assertRaises(H.HumError, msg=bad):
                H.parse_hum_txt(bad)

    def test_truth_seconds(self):
        a = H.parse_hum_txt(TXT)
        t = H.build_truth(a, "hum-01-a", "hum-01", False, 10.0)
        n = t["notes"]
        self.assertEqual([x["midi"] for x in n], MIDI)
        # 120 bpm: a quarter = 0.5 s, a tick = 1/32 s; bar 1 starts at 2 s
        self.assertAlmostEqual(n[0]["start"], 2.0)
        self.assertAlmostEqual(n[1]["start"], 2.5)
        self.assertAlmostEqual(n[4]["start"], 2.0 + 64 / 32)
        self.assertAlmostEqual(n[-1]["end"], 2.0 + 192 / 32)
        self.assertEqual(t["totalTicks"], 192)


REST_MELODY = ":4 r C4 D4 E4 | :4 F4 G4 A4 B4 |"  # starts with a quarter rest


class TestStartRule(unittest.TestCase):
    def txt(self, head, melody=REST_MELODY):
        return f"bpm: 120\n{head}\n歌い方: a\nメロディ:\n{melody}\n"

    def test_first_note_after_rest(self):
        a = H.parse_hum_txt(self.txt("開始: 2.5秒"))
        # 120 bpm: a quarter = 0.5 s; first note is 1 beat into bar 1 -> bar 1 head at 2.0 s
        self.assertAlmostEqual(a["startSec"], 2.0)
        self.assertAlmostEqual(a["firstNoteSec"], 2.5)
        self.assertTrue(a["startApprox"])
        t = H.build_truth(a, "hum-01-a", "hum-01", False, 10.0)
        self.assertEqual((t["info"]["startSec"], t["info"]["firstNoteSec"], t["info"]["startApprox"]), (2.0, 2.5, True))
        self.assertAlmostEqual(t["notes"][0]["start"], 2.5)

    def test_bar_head_before_audio_is_allowed(self):
        a = H.parse_hum_txt(self.txt("開始: 0.2秒"))  # pickup bar: head 0.3 s before the recording
        self.assertAlmostEqual(a["startSec"], -0.3)
        t = H.build_truth(a, "hum-01-a", "hum-01", False, 10.0)
        self.assertTrue(t["info"]["barStartBeforeAudio"])
        self.assertAlmostEqual(t["notes"][0]["start"], 0.2)

    def test_first_note_at_bar_head_and_long_rest(self):
        a = H.parse_hum_txt(self.txt("開始: 3", ":2 r :4 r r | :4 C4 D4 E4 F4 |".replace(":2 r :4 r r", ":1 r")))
        self.assertAlmostEqual(a["startSec"], 3.0 - 2.0)  # a whole rest = 4 beats = 2 s
        b = H.parse_hum_txt(self.txt("開始: 3", ":4 C4 D4 E4 F4 |"))
        self.assertAlmostEqual(b["startSec"], 3.0)

    def test_bar_start_key_keeps_old_meaning(self):
        for key in ("小節頭", "barStart"):
            a = H.parse_hum_txt(self.txt(f"{key}: 2"))
            self.assertAlmostEqual(a["startSec"], 2.0)
            self.assertFalse(a["startApprox"])
            self.assertAlmostEqual(a["firstNoteSec"], 2.5)

    def test_errors(self):
        with self.assertRaises(H.HumError):  # both keys
            H.parse_hum_txt(self.txt("開始: 3\n小節頭: 2"))
        with self.assertRaises(H.HumError):  # neither
            H.parse_hum_txt(self.txt(""))
        with self.assertRaises(H.HumError):  # first note beyond the audio
            H.build_truth(H.parse_hum_txt(self.txt("開始: 20")), "hum-01-a", "hum-01", False, 10.0)
        with self.assertRaises(H.HumError):  # rests only
            H.parse_hum_txt(self.txt("開始: 2", ":1 r |"))


FULL_PART = """\\section "Made up"
\\ts 4 4
:4 C4{lyrics "la"} E4{ch "C" slur s1} G4{d lyrics "x"} // trailing comment
/* block
comment */ :8 E4 |

:8 D4{st} F4 A4 F4 G4 E4 C5 r |
\\section "Second"
:2 B3 :4 D5 G4 |"""


class TestFullPartText(unittest.TestCase):
    def txt(self, part):
        return TXT.split("メロディ:")[0] + "メロディ:\n" + part + "\n"

    def test_directives_comments_blank_lines_and_sections(self):
        a = H.parse_hum_txt(self.txt(FULL_PART))
        self.assertEqual(a["bars"], 3)
        self.assertEqual([e["midi"] for e in a["events"] if e["kind"] == "note"][:3], [60, 64, 67])

    def test_matches_plain_melody(self):
        plain = H.parse_hum_txt(TXT)
        full = H.parse_hum_txt(self.txt(FULL_PART.replace("G4{d lyrics \"x\"} // trailing comment\n/* block\ncomment */ :8 E4",
                                                       "G4 E4")))
        self.assertEqual(plain["events"][0], full["events"][0])

    def test_unknown_directive_names_type_and_line(self):
        with self.assertRaises(H.HumError) as c:
            H.parse_hum_txt(self.txt("\\section \"s\"\n\\frobnicate 3\n:4 C4 |"))
        self.assertIn("8行目", str(c.exception))
        self.assertIn("frobnicate", str(c.exception))

    def test_directive_mid_line_and_unclosed_comment(self):
        for bad in (":4 C4 \\ts 4 4 |", ":4 C4 |\n/* open"):
            with self.assertRaises(H.HumError, msg=bad):
                H.parse_hum_txt(self.txt(bad))

    def test_bad_effect_error_has_line_but_no_content(self):
        with self.assertRaises(H.HumError) as c:
            H.parse_hum_txt(self.txt(":4 C4 D4 E4 F4 |\n:4 C4{zzz} |"))
        self.assertIn("8行目", str(c.exception))

    def test_song_key_accepts_hyphen_and_underscore(self):
        self.assertEqual(H.song_key("1-a"), "1")
        self.assertEqual(H.song_key("1_b"), "1")
        self.assertEqual(H.song_key("plain"), "plain")


class TestIntake(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.rec = os.path.join(self.t.name, "recordings")
        self.out = os.path.join(self.t.name, "out")
        self.inbox = os.path.join(self.rec, "hum-inbox")
        os.makedirs(self.inbox)
        self.logs = []

    def tearDown(self):
        self.t.cleanup()

    def drop(self, name, style="a", txt=None):
        tone_wav(os.path.join(self.inbox, name + ".wav"))
        with open(os.path.join(self.inbox, name + ".txt"), "w", encoding="utf-8") as f:
            f.write(txt or TXT.replace("歌い方: a", f"歌い方: {style}"))

    def run_intake(self):
        return H.main(["--inbox", self.inbox, "--out", self.out, "--privacy-root", self.t.name])

    def test_ids_heldout_log_outputs_and_no_original_names(self):
        self.drop("Fake Title One_a", "a")
        self.drop("Fake Title One_b", "b")
        self.drop("Another Fake Title_c", "c")  # sorts first: song hum-01
        self.assertEqual(self.run_intake(), 0)
        ids = json.load(open(os.path.join(self.rec, "hum-ids.local.json")))["recordings"]
        self.assertEqual(sorted(ids), ["hum-01-c", "hum-02-a", "hum-02-b"])
        held = {k: v["heldOut"] for k, v in ids.items()}
        self.assertEqual(held, {"hum-01-c": False, "hum-02-a": True, "hum-02-b": True})  # even song = held-out, shared
        # log written (same file as spike 2), one register line per take, before outputs
        lines = [json.loads(l) for l in open(os.path.join(self.out, "results", "heldout-log.jsonl"))]
        self.assertEqual([(l["kind"], l["input"], l["take"], l["heldOut"]) for l in lines],
                         [("register", "hum", "hum-01-c", False), ("register", "hum", "hum-02-a", True),
                          ("register", "hum", "hum-02-b", True)])
        # outputs
        for rid in ids:
            y, sr = sf.read(os.path.join(self.rec, rid + ".wav"))
            self.assertEqual((sr, y.ndim), (44100, 1))
            self.assertAlmostEqual(len(y) / sr, 8.0, places=2)
            for d in (self.rec, os.path.join(self.out, "rec")):
                tr = json.load(open(os.path.join(d, rid + ".truth.json")))
                self.assertEqual([n["midi"] for n in tr["notes"]], MIDI)
                self.assertEqual(tr["heldOut"], held[rid])
        man = json.load(open(os.path.join(self.out, "rec", "manifest.hum.json")))
        self.assertEqual([v["name"] for v in man["variants"]], ["hum-01-c", "hum-02-a", "hum-02-b"])
        self.assertEqual(os.listdir(self.inbox), [])
        self.assertEqual(len(os.listdir(os.path.join(self.rec, "hum-originals"))), 6)
        # no original name in anything but ids.local.json / hum-originals / hum-inbox
        for d, _, fns in os.walk(self.t.name):
            if "hum-originals" in d:
                continue
            for fn in fns:
                self.assertNotIn("Title", fn)
                if fn != "hum-ids.local.json":
                    self.assertNotIn(b"Title", open(os.path.join(d, fn), "rb").read(), fn)

    def test_second_run_keeps_numbers_and_decisions(self):
        self.drop("Aaa_a", "a")
        self.assertEqual(self.run_intake(), 0)
        self.drop("Aaa_b", "b")  # same song later: same id and decision
        self.drop("Bbb_c", "c")
        self.assertEqual(self.run_intake(), 0)
        ids = json.load(open(os.path.join(self.rec, "hum-ids.local.json")))["recordings"]
        self.assertEqual({k: v["heldOut"] for k, v in ids.items()},
                         {"hum-01-a": False, "hum-01-b": False, "hum-02-c": True})

    def test_bad_txt_registers_nothing(self):
        self.drop("Bad_a", txt=TXT.replace("bpm: 120", "bpm: x"))
        out = []
        self.assertEqual(self.run_intake(), 1)
        self.assertFalse(os.path.exists(os.path.join(self.rec, "hum-ids.local.json")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "results", "heldout-log.jsonl")))
        self.assertEqual(len(os.listdir(self.inbox)), 2)


class TestRebuild(unittest.TestCase):
    def test_rebuild_changes_only_truth_times(self):
        with tempfile.TemporaryDirectory() as tmp:
            rec, out = os.path.join(tmp, "recordings"), os.path.join(tmp, "out")
            inbox = os.path.join(rec, "hum-inbox")
            os.makedirs(inbox)
            tone_wav(os.path.join(inbox, "Fake_a.wav"))
            with open(os.path.join(inbox, "Fake_a.txt"), "w", encoding="utf-8") as f:
                f.write(f"bpm: 120\n開始: 2.5\n歌い方: a\nメロディ:\n{REST_MELODY}\n")
            self.assertEqual(H.main(["--inbox", inbox, "--out", out, "--no-privacy-check"]), 0)
            ids_before = open(os.path.join(rec, "hum-ids.local.json"), encoding="utf-8").read()
            log_p = os.path.join(out, "results", "heldout-log.jsonl")
            log_before = open(log_p).read()
            # simulate a truth built with the old rule (開始 = bar-1 head)
            tp = os.path.join(rec, "hum-01-a.truth.json")
            tr = json.load(open(tp))
            self.assertAlmostEqual(tr["info"]["startSec"], 2.0)
            tr["info"]["startSec"] = 2.5
            json.dump(tr, open(tp, "w"))
            logs = []
            self.assertEqual(H.rebuild_truth(rec, out, log=logs.append), 0)
            self.assertIn("-1.00 拍", logs[0])
            self.assertIn("開発用", logs[0])
            tr = json.load(open(tp))
            self.assertAlmostEqual(tr["info"]["startSec"], 2.0)
            self.assertEqual(open(os.path.join(rec, "hum-ids.local.json"), encoding="utf-8").read(), ids_before)
            self.assertEqual(open(log_p).read(), log_before)
            self.assertEqual(H.main(["--inbox", inbox, "--out", out, "--rebuild-truth"]), 0)


class TestHumPrivacy(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = self.t.name
        self.rec = os.path.join(self.root, "recordings")
        os.makedirs(self.rec)
        a = H.parse_hum_txt(TXT)
        truth = H.build_truth(a, "hum-01-a", "hum-01", False, 8.0)
        with open(os.path.join(self.rec, "hum-01-a.truth.json"), "w") as f:
            json.dump(truth, f, indent=1)
        self.write("src/ok.md", "scale C4 D4 E4 F4 G4 A4 B4 C5, numbers 60 62 64 65 67 69 71 72, key C4 E4 G4\n")

    def tearDown(self):
        self.t.cleanup()

    def write(self, rel, text):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)

    def check(self):
        return P.check(self.root, self.rec, check_log=False)

    def test_clean_and_runs_collected(self):
        self.assertEqual(self.check(), [])
        self.assertTrue(P.collect_hum(self.rec))

    def test_note_names_found_without_echo(self):
        self.write("src/leak.md", "melody: :4 C4 E4 G4 E4 | :8 D4 F4 A4 F4 G4\n")
        bad = self.check()
        self.assertEqual(len(bad), 1)
        self.assertIn("humming note sequence", bad[0])
        self.assertNotIn("C4", bad[0])

    def test_flats_sharps_and_rests_between(self):
        self.write("src/leak.md", "C4 E4 G4 E4 r D4 F4 A4 F4 G4 E4 C5")
        self.assertEqual(len(self.check()), 1)
        # enharmonic spelling is the same MIDI number: B3 = Cb4
        self.write("src/leak.md", "C4 E4 G4 E4 D4 F4 A4 F4 G4 E4 C5 Cb4 D5")
        self.assertEqual(len(self.check()), 1)

    def test_midi_numbers_and_pretty_json(self):
        self.write("src/leak.json", json.dumps({"notes": [{"midi": m} for m in MIDI[:9]]}, indent=1))
        self.assertEqual(len(self.check()), 1)
        self.write("src/leak.json", "[" + ", ".join(map(str, MIDI[2:12])) + "]")
        self.assertEqual(len(self.check()), 1)

    def test_transposed_and_octave_shifted_runs_found(self):
        # T15 (review S7): same interval sequence at another pitch level
        for text in ("D4 F#4 A4 F#4 E4 G4 B4 G4 A4",       # +2
                     "C5 E5 G5 E5 D5 F5 A5 F5 G5",         # +12 (octave)
                     "G3 B3 D4 B3 A3 C4 E4 C4 D4",         # -5
                     "C3 E3 G3 E3 D3 F3 A3 F3 G3 E3 C4"):  # -12 plus more
            self.write("src/leak.md", text + "\n")
            bad = self.check()
            self.assertEqual(len(bad), 1, text)
            self.assertIn("transposed form", bad[0])
            self.assertNotIn("A4", bad[0])
        os.remove(os.path.join(self.root, "src", "leak.md"))
        self.write("src/leak.json", "[" + ", ".join(str(m + 3) for m in MIDI[:9]) + "]")
        self.assertEqual(len(self.check()), 1)
        # the exact sequence still reports as before (no "transposed" tag)
        self.write("src/leak.json", "[" + ", ".join(map(str, MIDI[:9])) + "]")
        bad = self.check()
        self.assertEqual(len(bad), 1)
        self.assertNotIn("transposed", bad[0])

    def test_different_melody_and_plain_patterns_not_flagged(self):
        self.write("src/ok2.md", "C4 E4 G4 C5 E5 G5 C6 E6 G6\n"          # arpeggio, other intervals
                                 "60 67 74 81 88 95 102 109 116\n"         # constant +7 steps
                                 "C4 D4 C4 D4 C4 D4 C4 D4 C4\n")           # alternating
        self.assertEqual(self.check(), [])
        self.assertEqual(P.intervals((60, 64, 67)), (4, 3))
        self.assertFalse(P._distinctive_intervals((2, -2, 2, -2, 2, -2, 2)))

    @unittest.skipUnless(shutil.which("git"), "git is not in the analysis image; runs on the host")
    def test_commit_message_and_history(self):
        git = lambda *a: subprocess.run(["git", "-C", self.root, "-c", "user.email=a@b", "-c", "user.name=n", *a],
                                        check=True, capture_output=True)
        git("init", "-q", "-b", "base")
        self.write("src/a.txt", "x\n")
        git("add", "src/a.txt")
        git("commit", "-q", "-m", "init")
        git("checkout", "-q", "-b", "feat")
        self.write("src/b.json", json.dumps({"midi": MIDI[:9]}, indent=1))
        git("add", "src/b.json")
        git("commit", "-q", "-m", "add C4 E4 G4 E4 D4 F4 A4 F4 G4")
        git("rm", "-q", "-f", "src/b.json")
        git("commit", "-q", "-m", "remove")
        bad = P.check(self.root, self.rec, check_log=True, base="base", history=True)
        self.assertTrue(any(b.startswith("commit ") and "humming" in b for b in bad), bad)
        self.assertTrue(any(b.startswith("history ") and "humming" in b for b in bad), bad)

    def test_hum_names_are_anonymous_and_original_names_are_terms(self):
        with open(os.path.join(self.rec, "hum-ids.local.json"), "w") as f:
            json.dump({"recordings": {"hum-01-a": {"original": "Fake Hum Title", "originalFiles": ["Fake Hum Title_a.wav"]}}}, f)
        terms, _ = P.collect_terms(self.rec)
        self.assertIn("fake hum title", terms)
        self.write("src/hum-01-a.md", "hum-01-a is fine\n")
        self.assertEqual(self.check(), [])
        self.write("src/t.md", "see Fake Hum Title here\n")
        self.assertEqual(len(self.check()), 1)


if __name__ == "__main__":
    unittest.main()
