"""Tests for bass_intake.py. Fake inputs only (generated tone, never a real recording)."""
import json
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import bass_intake as B  # noqa: E402

BPM = 120  # bar = 2 s
CHORDS = "| G G/B | C |\n| D/F# | G |\n"  # 4 bars


def txt(letter, held=None, start="2秒", gear="Piano X", excl="", click="あり", chords=CHORDS, bpm=BPM):
    h = {"e": "はい", "f": "はい"}.get(letter, "いいえ") if held is None else held
    return (f"# bas-?-{letter}\nbpm: {bpm}\n拍子: 4/4\nキー: G\nホールドアウト: {h}\n開始: {start}  # 説明\n"
            f"機材: {gear}\nクリック: {click}\n楽譜と違って弾いた小節: {excl}\n{chords}")


def tone(path, sec, sr=48000):
    t = np.arange(int(sec * sr)) / sr
    sf.write(path, 0.1 * np.sin(2 * np.pi * 110 * t), sr, subtype="PCM_16")


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.rec = os.path.join(self.d, "recordings")
        self.inbox = os.path.join(self.rec, "bas-inbox")
        self.scores = os.path.join(self.d, "scores")
        self.out = os.path.join(self.d, "out")
        for p in (self.inbox, self.scores):
            os.makedirs(p)
        for L in "abcdef":
            with open(os.path.join(self.scores, f"{L}.txt"), "w", encoding="utf-8") as f:
                f.write(txt(L, gear=""))

    def tearDown(self):
        shutil.rmtree(self.d)

    def put(self, letter, text=None, sec=12.0):
        tone(os.path.join(self.inbox, f"{letter}.wav"), sec)
        with open(os.path.join(self.inbox, f"{letter}.txt"), "w", encoding="utf-8") as f:
            f.write(txt(letter) if text is None else text)

    def run_main(self, *extra):
        return B.main(["--inbox", self.inbox, "--out", self.out, "--scores", self.scores, "--no-privacy-check", *extra])

    def log(self):
        p = os.path.join(self.out, "results", "heldout-log.jsonl")
        return [json.loads(x) for x in open(p)] if os.path.exists(p) else []


class TestParse(unittest.TestCase):
    def test_template_lines_and_click(self):
        a = B.parse_bass_txt(txt("a", excl="2", click="あり"), "a")
        self.assertEqual(a["startSec"], 2.0)
        self.assertFalse(a["click"])
        self.assertNotIn("tempoHint", a)
        self.assertEqual(a["excludedBars"], [1])
        self.assertEqual(a["gear"], "Piano X")
        self.assertEqual(len(a["bars"]), 4)
        self.assertEqual(a["style"], "a")

    def test_errors(self):
        for letter, t in (("a", txt("a", held="はい")), ("e", txt("e", held="いいえ")), ("a", txt("a", click="たぶん")),
                          ("a", txt("a", excl="9")), ("a", txt("a", start="x秒")),
                          ("a", txt("a").replace("開始: 2秒  # 説明\n", ""))):
            with self.assertRaises(B.BassError):
                B.parse_bass_txt(t, letter)

    def test_start_check_rule(self):
        # 4 bars of 2 s from start 2 -> score ends at 10 s
        self.assertTrue(B.start_check(2.0, 12.0, 120, 4, 4)[0])
        self.assertTrue(B.start_check(2.0, 9.6, 120, 4, 4)[0])  # ends under 1 beat (0.5 s) early is tolerated
        self.assertFalse(B.start_check(2.0, 8.0, 120, 4, 4)[0])  # file too short (start one bar too late)
        self.assertFalse(B.start_check(0.0, 14.5, 120, 4, 4)[0])  # > 1 bar + 2 s of slack
        self.assertFalse(B.start_check(20.0, 12.0, 120, 4, 4)[0])  # past the file
        self.assertFalse(B.start_check(-1.0, 12.0, 120, 4, 4)[0])  # bar 1 before the file start


class TestIntake(Base):
    def test_privacy_check_gets_allow_empty(self):
        """Self-made scores collect 0 private terms; the intake must not report that as a failure."""
        import privacy_check
        seen = []
        orig = privacy_check.main
        privacy_check.main = lambda argv: (seen.append(argv), 0)[1]
        try:
            self.put("a")
            rc = B.main(["--inbox", self.inbox, "--out", self.out, "--scores", self.scores])
        finally:
            privacy_check.main = orig
        self.assertEqual(rc, 0)
        self.assertEqual(len(seen), 1)
        self.assertIn("--allow-empty", seen[0])

    def test_names_heldout_log_truth(self):
        for L in "ae":
            self.put(L)
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(sorted(x for x in os.listdir(self.rec) if x.endswith(".wav")), ["bas-01-a.wav", "bas-05-e.wav"])
        ids = json.load(open(os.path.join(self.rec, "bas-ids.local.json")))["recordings"]
        self.assertFalse(ids["bas-01-a"]["heldOut"])
        self.assertTrue(ids["bas-05-e"]["heldOut"])
        log = self.log()
        self.assertEqual([(x["take"], x["kind"], x["input"], x["heldOut"]) for x in log],
                         [("bas-01-a", "register", "bass", False), ("bas-05-e", "register", "bass", True)])
        tr = json.load(open(os.path.join(self.rec, "bas-05-e.truth.json")))
        self.assertTrue(tr["heldOut"])
        self.assertFalse(tr["source"]["click"])
        self.assertEqual(tr["chords"][1]["bass"], "B")
        self.assertEqual(tr["beats"][0]["t"], 2.0)
        self.assertTrue(tr["startCheck"]["ok"])
        self.assertTrue(os.path.exists(os.path.join(self.rec, "bas-originals", "bas-05-e.txt")))
        self.assertEqual(os.listdir(self.inbox), [])
        man = json.load(open(os.path.join(self.out, "rec", "manifest.bass.json")))
        self.assertEqual([v["name"] for v in man["variants"]], ["bas-01-a", "bas-05-e"])

    def test_registered_before_audio_is_read(self):
        # undecodable audio: the take is already registered and logged, nothing imported
        with open(os.path.join(self.inbox, "f.wav"), "wb") as f:
            f.write(b"not audio")
        open(os.path.join(self.inbox, "f.txt"), "w", encoding="utf-8").write(txt("f"))
        self.assertEqual(self.run_main(), 1)
        self.assertEqual([x["take"] for x in self.log()], ["bas-06-f"])
        self.assertFalse(os.path.exists(os.path.join(self.rec, "bas-06-f.wav")))
        self.assertTrue(os.path.exists(os.path.join(self.inbox, "f.txt")))

    def test_bad_txt_registers_nothing(self):
        self.put("a", txt("a", held="はい"))
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.log(), [])
        self.assertFalse(os.path.exists(os.path.join(self.rec, "bas-ids.local.json")))

    def test_chords_must_match_template(self):
        self.put("a", txt("a", chords="| G | C |\n| D | G |\n"))
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.log(), [])

    def test_start_check_blocks_then_retry_without_second_register(self):
        self.put("a", txt("a", start="4秒"), sec=10.0)  # ends 12 s > file 10 s -> one bar too late
        self.assertEqual(self.run_main(), 1)
        self.assertFalse(os.path.exists(os.path.join(self.rec, "bas-01-a.wav")))
        with open(os.path.join(self.inbox, "a.txt"), "w", encoding="utf-8") as f:
            f.write(txt("a", start="2秒"))
        self.assertEqual(self.run_main(), 0)
        self.assertEqual([x["kind"] for x in self.log()], ["register"])

    def test_skip_start_check_recorded(self):
        self.put("a", txt("a", start="4秒"), sec=10.0)
        self.assertEqual(self.run_main("--skip-start-check"), 0)
        tr = json.load(open(os.path.join(self.rec, "bas-01-a.truth.json")))
        self.assertTrue(tr["startCheck"]["skipped"])

    def test_reintake_refused_unless_flag(self):
        self.put("e")
        self.assertEqual(self.run_main(), 0)
        self.put("e")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.run_main("--reintake"), 1)  # dev flag does not unlock held-out
        self.assertEqual(self.run_main("--reintake-held-out"), 0)
        self.assertEqual([x["kind"] for x in self.log()], ["register", "reintake"])

    def test_reparse_changes_excluded_only(self):
        self.put("a")
        self.run_main()
        orig = os.path.join(self.rec, "bas-originals", "bas-01-a.txt")
        open(orig, "w", encoding="utf-8").write(txt("a", excl="1-2"))
        self.assertEqual(B.main(["--inbox", self.inbox, "--out", self.out, "--scores", self.scores, "--reparse"]), 0)
        tr = json.load(open(os.path.join(self.rec, "bas-01-a.truth.json")))
        self.assertEqual(tr["excludedBars"], [0, 1])
        self.assertEqual(self.log()[-1]["kind"], "reparse")

    def test_gear_warnings(self):
        for L in "ae":
            self.put(L, txt(L, gear="Piano X"))
        self.run_main()
        w = B.gear_warnings(self.rec)
        self.assertEqual(len(w), 1)
        self.assertIn("同じ", w[0])
        self.assertNotIn("Piano", w[0])

    def test_gear_warning_not_raised_when_different_and_empty_warns(self):
        self.put("a", txt("a", gear="Piano X"))
        self.put("e", txt("e", gear="Piano Y"))
        self.put("b", txt("b", gear=""))
        self.run_main()
        w = B.gear_warnings(self.rec)
        self.assertEqual(len(w), 1)
        self.assertIn("空", w[0])


if __name__ == "__main__":
    unittest.main()
