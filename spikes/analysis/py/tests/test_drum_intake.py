"""Tests for drum_intake.py. Fake inputs only (made-up tick truth, tone audio)."""
import json
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import drum_intake as D  # noqa: E402


def ticks(letter="e", name="drm-05-e", held=True, bpm=120, n=4):
    hits = [{"bar": b, "tick": 16 * k, "playTick": 16 * k, "inst": "BD" if k % 2 == 0 else "SD"}
            for b in range(n) for k in range(4)]
    hits[1]["mark"] = "g"
    hits.append({"bar": 3, "tick": 8, "playTick": 32 / 3, "inst": "HH"})
    return {"name": name, "letter": letter, "heldOut": held, "bpm": bpm, "ts": [4, 4], "barTicks": 64, "nBars": n,
            "hits": hits, "swingBars": [{"bar": b, "kind": "8" if b == 3 else "none"} for b in range(n)]}


def txt(letter="e", held="はい", bpm=120, start="2秒", kit="Kit X", excl="", special=()):
    s = (f"# fake\nbpm: {bpm}\n拍子: 4/4\n叩き方: {letter}\nホールドアウト: {held}\n開始: {start}   # 説明\n"
         f"キット: {kit}\nマイク/接続: line\nクリック: no\n楽譜と違って叩いた小節: {excl}\n")
    return s + "".join(f"特殊奏法: {x}\n" for x in special)


def tone(path, sec=12.0, sr=48000):
    t = np.arange(int(sec * sr)) / sr
    y = 0.3 * np.sin(2 * np.pi * 220 * t)
    sf.write(path, np.stack([y, y], axis=1), sr, subtype="PCM_16")


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.rec = os.path.join(self.d, "recordings")
        self.inbox = os.path.join(self.rec, "drm-inbox")
        self.scores = os.path.join(self.rec, "drum-scores")
        self.out = os.path.join(self.d, "out")
        for p in (self.inbox, self.scores):
            os.makedirs(p)
        for L, n, h in (("a", "drm-01-a", False), ("e", "drm-05-e", True)):
            with open(os.path.join(self.scores, f"{L}.ticks.json"), "w") as f:
                json.dump(ticks(L, n, h), f)

    def tearDown(self):
        shutil.rmtree(self.d)

    def put(self, letter, text):
        tone(os.path.join(self.inbox, f"{letter}.wav"))
        with open(os.path.join(self.inbox, f"{letter}.txt"), "w", encoding="utf-8") as f:
            f.write(text)

    def run_main(self, *extra):
        return D.main(["--inbox", self.inbox, "--out", self.out, "--no-privacy-check", *extra])

    def log(self):
        p = os.path.join(self.out, "results", "heldout-log.jsonl")
        return [json.loads(x) for x in open(p)] if os.path.exists(p) else []

    def truth(self, rid):
        return json.load(open(os.path.join(self.rec, rid + ".truth.json"), encoding="utf-8"))


class TestParse(unittest.TestCase):
    T = ticks()

    def test_bar_ranges(self):
        self.assertEqual(D.parse_bar_ranges("2, 3-4、1小節", 4, "x"), [0, 1, 2, 3])
        self.assertEqual(D.parse_bar_ranges("", 4, "x"), [])
        self.assertEqual(D.parse_bar_ranges("なし", 4, "x"), [])
        self.assertEqual(D.parse_bar_ranges("３", 4, "x"), [2])
        for bad in ("5", "0", "4-2", "abc"):
            with self.assertRaises(D.DrumError):
                D.parse_bar_ranges(bad, 4, "x")

    def test_txt_fields(self):
        a = D.parse_drum_txt(txt(excl="2, 4", special=("2-3 ライド ベル（楽譜は RD）", "4 スネア クロススティック")), self.T)
        self.assertEqual((a["startSec"], a["kit"], a["excludedBars"]), (2.0, "Kit X", [1, 3]))
        self.assertEqual(a["extraLabels"][0], {"bars": [1, 2], "text": "ライド ベル", "tech": "bell", "inst": "RD"})
        self.assertEqual((a["extraLabels"][1]["tech"], a["extraLabels"][1]["inst"]), ("cross_stick", "SD"))
        self.assertEqual(D.parse_drum_txt(txt(special=("出なかった",)), self.T)["extraLabels"], [])

    def test_txt_errors(self):
        for bad in (txt(bpm=100), txt(letter="a"), txt(held="いいえ"), txt(kit=""), txt(excl="9"), txt(start="x秒"),
                    txt() + "謎: 1\n", txt(special=("9 ベル",))):
            with self.assertRaises(D.DrumError, msg=bad):
                D.parse_drum_txt(bad, self.T)


class TestIntake(Base):
    def test_names_heldout_log_truth_excluded(self):
        self.put("e", txt("e", excl="2", special=("3 スネア リムショット",)))
        self.put("a", txt("a", held="いいえ", kit="Kit Y"))
        with open(os.path.join(self.scores, "a.ticks.json")) as f:
            self.assertFalse(json.load(f)["heldOut"])
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(os.listdir(self.inbox), [])
        log = self.log()
        self.assertEqual([(r["take"], r["heldOut"], r["kind"], r["input"]) for r in log],
                         [("drm-01-a", False, "register", "drum"), ("drm-05-e", True, "register", "drum")])
        ids = json.load(open(os.path.join(self.rec, D.IDS_FILE)))["recordings"]
        self.assertEqual(ids["drm-05-e"]["heldOut"], True)
        for rid in ("drm-01-a", "drm-05-e"):
            self.assertTrue(os.path.exists(os.path.join(self.rec, rid + ".wav")))
            self.assertTrue(os.path.exists(os.path.join(self.rec, "drm-originals", rid + ".txt")))
        data, sr = sf.read(os.path.join(self.rec, "drm-05-e.wav"))
        self.assertEqual((sr, data.ndim), (44100, 1))
        t = self.truth("drm-05-e")
        self.assertEqual((t["excludedBars"], t["heldOut"], t["kit"]), ([1], True, "Kit X"))
        self.assertEqual(t["extraLabels"], [{"bars": [2], "text": "スネア リムショット", "tech": "rimshot", "inst": "SD"}])
        self.assertEqual(t["barStartsSec"], [2.0, 4.0, 6.0, 8.0, 10.0])  # 120 bpm: 2 s per bar
        self.assertEqual(len(t["hits"]), 17)
        self.assertEqual(t["hits"][0], {"t": 2.0, "inst": "BD", "bar": 0, "tick": 0})
        self.assertEqual(t["hits"][1]["mark"], "g")
        swung = t["hits"][-1]  # bar 3 tick 8 played at 32/3 ticks: 2/3 beat = 0.3333 s after 8.0 s
        self.assertAlmostEqual(swung["t"], 8.0 + 2 / 3 * 0.5, places=5)
        self.assertEqual(t["swingBars"][3], {"bar": 3, "kind": "8"})
        man = json.load(open(os.path.join(self.out, "rec", "manifest.drum.json")))
        self.assertEqual([v["name"] for v in man["variants"]], ["drm-01-a", "drm-05-e"])
        self.assertEqual(man["variants"][1]["excludedBars"], [1])

    def test_bad_take_stays_in_inbox_and_nothing_registered(self):
        self.put("e", txt("e", excl="99"))
        self.assertEqual(self.run_main(), 1)
        self.assertTrue(os.path.exists(os.path.join(self.inbox, "e.wav")))
        self.assertEqual(self.log(), [])
        self.assertFalse(os.path.exists(os.path.join(self.rec, D.IDS_FILE)))

    def test_missing_ticks_and_odd_name(self):
        self.put("b", txt("b"))
        self.put("zz", txt("e"))
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.log(), [])

    def test_reintake_refused_unless_flag(self):
        self.put("e", txt("e"))
        self.assertEqual(self.run_main(), 0)
        self.put("e", txt("e", excl="1"))
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.run_main("--reintake"), 1)  # dev flag does not unlock held-out
        self.assertEqual(self.truth("drm-05-e")["excludedBars"], [])
        self.assertEqual(self.run_main("--reintake-held-out"), 0)
        self.assertEqual(self.truth("drm-05-e")["excludedBars"], [0])
        self.assertEqual([r["kind"] for r in self.log()], ["register", "reintake"])
        self.assertTrue(all(r["heldOut"] for r in self.log()))

    def test_dev_reintake_flag(self):
        self.put("a", txt("a", held="いいえ"))
        self.assertEqual(self.run_main(), 0)
        self.put("a", txt("a", held="いいえ"))
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.run_main("--reintake"), 0)

    def test_reparse_changes_excluded_only(self):
        self.put("e", txt("e"))
        self.assertEqual(self.run_main(), 0)
        reg = open(os.path.join(self.rec, D.IDS_FILE)).read()
        orig = os.path.join(self.rec, "drm-originals", "drm-05-e.txt")
        with open(orig, "w", encoding="utf-8") as f:
            f.write(txt("e", excl="1-2"))
        self.assertEqual(self.run_main("--reparse"), 0)
        t = self.truth("drm-05-e")
        self.assertEqual((t["excludedBars"], t["heldOut"]), ([0, 1], True))
        self.assertEqual(open(os.path.join(self.rec, D.IDS_FILE)).read(), reg)
        self.assertEqual([r["kind"] for r in self.log()], ["register", "reparse"])
        with open(orig, "w", encoding="utf-8") as f:
            f.write(txt("e", excl="77"))
        self.assertEqual(self.run_main("--reparse", "drm-05-e"), 1)
        self.assertEqual(self.truth("drm-05-e")["excludedBars"], [0, 1])  # kept

    def test_kit_warning(self):
        self.put("e", txt("e", kit="Same"))
        self.put("a", txt("a", held="いいえ", kit="same"))
        self.run_main()
        self.assertEqual(len(D.kit_warnings(self.rec)), 1)


if __name__ == "__main__":
    unittest.main()
