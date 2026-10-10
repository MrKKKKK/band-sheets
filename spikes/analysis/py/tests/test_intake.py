import json
import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import intake as I  # noqa: E402

TXT = """# comment
bpm: 120
拍子: 4/4
キー: F#m
弾き方: b
| F | Dm7 G7 | Bb . Am . | N.C. C7(#9) |
"""


def click_wav(path, t0, bpm=120, n=16, sr=48000, channels=2, subtype="PCM_16"):
    y = np.zeros(int(sr * (t0 + n * 60 / bpm + 1)))
    rng = np.random.default_rng(1)
    m = int(0.02 * sr)
    for k in range(n):
        i = int((t0 + k * 60 / bpm) * sr)
        y[i:i + m] += rng.standard_normal(m) * np.hanning(m) * 0.5
    sf.write(path, np.stack([y] * channels, axis=1) if channels > 1 else y, sr, subtype=subtype)


class TestParseTxt(unittest.TestCase):
    def test_bars_and_header(self):
        a = I.parse_txt(TXT)
        self.assertEqual(a["tempo"], 120.0)
        self.assertEqual(a["key"], "F#m")
        self.assertEqual(a["style"], "b")
        self.assertEqual(a["bars"][0], [["F", 8]])
        self.assertEqual(a["bars"][1], [["Dm7", 4], ["G7", 4]])
        self.assertEqual(a["bars"][2], [["Bb", 4], ["Am", 4]])  # 4 tokens = per beat, '.' continues
        self.assertEqual(a["bars"][3], [["N.C.", 4], ["C7(#9)", 4]])
        self.assertEqual(a["tempoHint"], 120.0)

    def test_per_beat_dots(self):
        a = I.parse_txt("bpm: 100\n弾き方: a\n| F . Am . |\n")
        self.assertEqual(a["bars"][0], [["F", 4], ["Am", 4]])
        a = I.parse_txt("bpm: 100\nstyle: a\n| F . . Am |\n")
        self.assertEqual(a["bars"][0], [["F", 6], ["Am", 2]])

    def test_aliases_fullwidth_and_options(self):
        a = I.parse_txt("bpm：90\ntime: 3/4\nstyle: (c)\npickup: 1拍\nstart: 1.5秒\nclick: なし\nmaximizer: yes\n｜ C ｜ G ｜\n")
        self.assertEqual((a["timeSignature"], a["eighthsPerBar"], a["pickupBeats"]), ([3, 4], 6, 1))
        self.assertEqual((a["start"], a["maximizer"], a["click"]), (1.5, True, False))
        self.assertNotIn("tempoHint", a)

    def test_errors_are_japanese_with_line_numbers(self):
        cases = [("bpm: 100\n弾き方: a\n| F | Hm7 |\n", "3行目"),
                 ("bpm: 100\n弾き方: a\n| F G Am |\n", "等分できません"),
                 ("bpm: 100\n弾き方: z\n| F |\n", "2行目"),
                 ("弾き方: a\n| F |\n", "bpm"),
                 ("bpm: 100\n弾き方: a\n色: 赤\n| F |\n", "3行目"),
                 ("bpm: 100\n弾き方: a\n拍子: 4/8\n| F |\n", "拍子"),
                 ("bpm: 100\n弾き方: a\n弱起: 1拍\n開始: 0.1秒\n| F |\n", "小さすぎ"),
                 ("bpm: 100\n弾き方: a\n", "小節")]
        for text, frag in cases:
            with self.assertRaises(I.IntakeError, msg=text) as cm:
                I.parse_txt(text)
            self.assertIn(frag, str(cm.exception), text)


class TestIntake(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.rec = os.path.join(self.t.name, "recordings")
        self.inbox = os.path.join(self.rec, "inbox")
        self.out = os.path.join(self.t.name, "out")
        os.makedirs(self.inbox)

    def tearDown(self):
        self.t.cleanup()

    def drop(self, base, txt=TXT, audio=("wav",), t0=0.5):
        for kind in audio:
            click_wav(os.path.join(self.inbox, base + (".max" if kind == "max" else "") + ".wav"), t0)
        if txt:
            open(os.path.join(self.inbox, base + ".txt"), "w", encoding="utf-8").write(txt)

    def test_end_to_end_first_onset(self):
        self.drop("Secret Title")
        take = I.scan_inbox(self.inbox)["Secret Title"]
        names = I.process_take("Secret Title", take, self.rec, self.out, log=lambda m: None)
        self.assertEqual(names, ["rec-01"])
        self.assertEqual(os.listdir(self.inbox), [])
        self.assertTrue(os.path.exists(os.path.join(self.rec, "originals", "rec-01.wav")))
        data, sr = sf.read(os.path.join(self.rec, "rec-01.wav"))
        self.assertEqual((sr, data.ndim), (44100, 1))
        man = json.load(open(os.path.join(self.out, "rec", "manifest.rec.json")))["variants"]
        self.assertEqual(len(man), 1)
        self.assertTrue(man[0]["heldOut"])  # style b
        self.assertEqual(man[0]["tempoHint"], 120.0)
        truth = json.load(open(os.path.join(self.out, "rec", "rec-01.truth.json")))
        self.assertAlmostEqual(truth["beats"][0]["t"], 0.5, delta=0.03)
        self.assertEqual(truth["keys"], [{"startBar": 0, "key": "F#m"}])
        ids = json.load(open(os.path.join(self.rec, "ids.local.json")))["recordings"]["rec-01"]
        self.assertTrue(ids["heldOut"])
        log = [json.loads(l) for l in open(os.path.join(self.out, "results", "heldout-log.jsonl"))]
        self.assertEqual((log[0]["kind"], log[0]["take"], log[0]["heldOut"]), ("register", "rec-01", True))
        # no original name in anything under out/
        for d, _, fns in os.walk(self.out):
            for f in fns:
                self.assertNotIn("Secret", open(os.path.join(d, f), errors="ignore").read())

    def test_start_override_and_pickup(self):
        txt = TXT.replace("弾き方: b", "弾き方: a") + "弱起: 1拍\n開始: 1.0秒\n"
        self.drop("x", txt, t0=0.5)
        I.process_take("x", I.scan_inbox(self.inbox)["x"], self.rec, self.out, log=lambda m: None)
        truth = json.load(open(os.path.join(self.out, "rec", "rec-01.truth.json")))
        b = truth["beats"]
        self.assertEqual((b[0]["t"], b[0]["bar"]), (0.5, -1))
        self.assertEqual((b[1]["t"], b[1]["bar"], b[1]["downbeat"]), (1.0, 0, True))
        man = json.load(open(os.path.join(self.out, "rec", "manifest.rec.json")))["variants"]
        self.assertFalse(man[0]["heldOut"])  # style a = dev

    def test_two_variants_share_decision(self):
        self.drop("take", audio=("plain", "max"))
        names = I.process_take("take", I.scan_inbox(self.inbox)["take"], self.rec, self.out, log=lambda m: None)
        self.assertEqual(sorted(names), ["rec-01", "rec-01-max"])
        man = {v["name"]: v for v in json.load(open(os.path.join(self.out, "rec", "manifest.rec.json")))["variants"]}
        self.assertEqual({v["heldOut"] for v in man.values()}, {True})
        self.assertEqual((man["rec-01"]["maximizer"], man["rec-01-max"]["maximizer"]), (False, True))
        self.assertEqual({v["take"] for v in man.values()}, {"rec-01"})

    def test_midi_stored_and_validated(self):
        self.drop("m")
        mid = b"MThd\0\0\0\6\0\0\0\1\1\xe0MTrk\0\0\0\4\0\xff\x2f\0"
        open(os.path.join(self.inbox, "m.mid"), "wb").write(mid)
        I.process_take("m", I.scan_inbox(self.inbox)["m"], self.rec, self.out, log=lambda m: None)
        self.assertTrue(os.path.exists(os.path.join(self.rec, "rec-01.mid")))
        truth = json.load(open(os.path.join(self.out, "rec", "rec-01.truth.json")))
        self.assertTrue(truth["source"]["hasMidi"])
        with self.assertRaises(I.IntakeError):
            p = os.path.join(self.t.name, "bad.mid")
            open(p, "wb").write(b"garbage")
            I.validate_midi(p)

    def test_failures_leave_inbox_and_register_nothing(self):
        self.drop("nomatch", txt=None)
        with self.assertRaises(I.IntakeError):
            I.process_take("nomatch", I.scan_inbox(self.inbox)["nomatch"], self.rec, self.out)
        open(os.path.join(self.inbox, "bad.m4a"), "wb").write(b"not audio")
        open(os.path.join(self.inbox, "bad.txt"), "w").write(TXT)
        with self.assertRaises(I.IntakeError) as cm:
            I.process_take("bad", I.scan_inbox(self.inbox)["bad"], self.rec, self.out)
        self.assertIn("WAV", str(cm.exception))
        self.assertFalse(os.path.exists(os.path.join(self.rec, "ids.local.json")))
        self.assertTrue(os.path.exists(os.path.join(self.inbox, "bad.m4a")))

    def test_formats_float32_mono_96k(self):
        click_wav(os.path.join(self.inbox, "f.wav"), 0.5, sr=96000, channels=1, subtype="FLOAT")
        open(os.path.join(self.inbox, "f.txt"), "w").write(TXT)
        I.process_take("f", I.scan_inbox(self.inbox)["f"], self.rec, self.out, log=lambda m: None)
        _, sr = sf.read(os.path.join(self.rec, "rec-01.wav"))
        self.assertEqual(sr, 44100)

    def test_main_runs_privacy_check(self):
        self.drop("Zebra Quokka Song")
        rc = I.main(["--inbox", self.inbox, "--out", self.out, "--privacy-root", self.out])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
