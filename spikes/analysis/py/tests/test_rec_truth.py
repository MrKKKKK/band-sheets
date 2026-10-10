import json
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import rec_truth as R  # noqa: E402

ANN = {"tempo": 120, "timeSignature": [4, 4], "click": True, "firstSoundSec": 0.0, "eighthsPerBar": 8,
       "sections": [{"label": "A", "startBar": 0, "bars": 1}, {"label": "B", "startBar": 1, "bars": 1}],
       "bars": [[["C", 3], ["F", 5]], [["Am7/G", 8]]]}


class TestBuild(unittest.TestCase):
    def test_times(self):
        t = R.build_truth(ANN, 10.0, 1.0, 120)
        self.assertEqual([b["t"] for b in t["beats"]], [1.0 + 0.5 * i for i in range(8)])
        self.assertEqual([b["downbeat"] for b in t["beats"]], [True, False, False, False] * 2)
        self.assertEqual([(b["bar"], b["beat"]) for b in t["beats"]][4:6], [(1, 0), (1, 1)])
        c = t["chords"]
        self.assertAlmostEqual(c[0]["end"], 1.75)
        self.assertAlmostEqual(c[1]["start"], 1.75)  # 3 * 0.25 s after the bar start
        self.assertAlmostEqual(c[1]["end"], 3.0)
        self.assertAlmostEqual(c[2]["start"], 3.0)
        self.assertEqual(c[2]["end"], 10.0)  # rings to the end of the file
        self.assertEqual((c[2]["root"], c[2]["quality"], c[2]["bass"]), ("A", "min7", "G"))
        self.assertEqual(t["source"]["durationSec"], 5.0)
        self.assertEqual(t["source"]["leadInSec"], 1.0)
        self.assertEqual(t["sections"][1], {"start": 3.0, "end": 5.0, "label": "B"})
        self.assertNotIn("melody", t)

    def test_bad_bar(self):
        with self.assertRaises(ValueError):
            R.build_truth({**ANN, "bars": [[["C", 3]]]}, 1.0, 0, 120)


class TestPickup(unittest.TestCase):
    # 120 BPM: beat = 0.5 s, eighth = 0.25 s. 2 pickup beats starting at t0 = 1.0 -> bar 0 starts at 2.0.
    ANN = {"tempo": 120, "timeSignature": [4, 4], "eighthsPerBar": 8, "pickupBeats": 2,
           "pickupChords": [["G7", 4]],
           "sections": [{"label": "A", "startBar": 0, "bars": 1, "key": "C"},
                        {"label": "B", "startBar": 1, "bars": 1, "key": "Am"}],
           "bars": [[["C", 8]], [["F", 4], ["G", 4]]]}

    def test_pickup_beats_and_bars(self):
        t = R.build_truth(self.ANN, 8.0, 1.0, 120)
        got = [(b["t"], b["bar"], b["beat"], b["downbeat"]) for b in t["beats"]]
        self.assertEqual(got[:4], [(1.0, -1, 2, False), (1.5, -1, 3, False), (2.0, 0, 0, True), (2.5, 0, 1, False)])
        self.assertEqual(len(got), 2 + 8)
        self.assertEqual([g[0] for g in got if g[3]], [2.0, 4.0])
        self.assertEqual(t["source"]["pickupBeats"], 2)
        self.assertEqual(t["source"]["durationSec"], 6.0)

    def test_pickup_chords_sections_keys(self):
        t = R.build_truth(self.ANN, 8.0, 1.0, 120)
        c = t["chords"]
        self.assertEqual([(x["start"], x["end"], x["text"]) for x in c[:3]],
                         [(1.0, 2.0, "G7"), (2.0, 4.0, "C"), (4.0, 5.0, "F")])
        self.assertEqual(t["sections"][0], {"start": 2.0, "end": 4.0, "label": "A"})
        self.assertEqual(t["keys"], [{"startBar": 0, "key": "C"}, {"startBar": 1, "key": "Am"}])

    def test_without_pickup_unchanged(self):
        t = R.build_truth(ANN, 10.0, 1.0, 120)
        self.assertNotIn("keys", t)
        self.assertNotIn("pickupBeats", t["source"])
        self.assertEqual(t["beats"][0]["bar"], 0)

    def test_without_pickup_chords_first_chord_starts_at_bar0(self):
        a = {**self.ANN}
        del a["pickupChords"]
        self.assertEqual(R.build_truth(a, 8.0, 1.0, 120)["chords"][0]["start"], 2.0)

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            R.build_truth({**self.ANN, "pickupBeats": 4}, 8.0, 1.0, 120)
        with self.assertRaises(ValueError):
            R.build_truth({**self.ANN, "pickupChords": [["G7", 3]]}, 8.0, 1.0, 120)
        bad = {**self.ANN, "sections": [{"label": "A", "startBar": 0, "bars": 1, "key": "H"}]}
        with self.assertRaises(ValueError):
            R.build_truth(bad, 8.0, 1.0, 120)

    def test_global_key_nochord_metadata(self):
        a = {"tempo": 120, "timeSignature": [4, 4], "eighthsPerBar": 8, "key": "F", "maximizer": True, "hasMidi": True,
             "bars": [[["N.C.", 4], ["F", 4]]]}
        t = R.build_truth(a, 4.0, 0.0, 120)
        self.assertEqual([c["text"] for c in t["chords"]], ["F"])
        self.assertEqual(t["chords"][0]["start"], 1.0)
        self.assertEqual(t["keys"], [{"startBar": 0, "key": "F"}])
        self.assertTrue(t["source"]["maximizer"] and t["source"]["hasMidi"])


class TestRegister(unittest.TestCase):
    def test_register_fixes_heldout(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "Some Song.wav")
            open(src, "wb").write(b"x")
            rec = os.path.join(d, "recordings")
            rid = R.register_recording(rec, src, True, "b")
            self.assertEqual(rid, "rec-01")
            self.assertTrue(os.path.exists(os.path.join(rec, "rec-01.wav")))
            ids = json.load(open(os.path.join(rec, "ids.local.json")))["recordings"]
            self.assertTrue(ids["rec-01"]["heldOut"])
            with self.assertRaises(ValueError):
                R.register_recording(rec, src, False)  # cannot flip the decision
            src2 = os.path.join(d, "other.wav")
            open(src2, "wb").write(b"y")
            self.assertEqual(R.register_recording(rec, src2, False), "rec-02")


class TestParse(unittest.TestCase):
    def test_outside_vocabulary(self):
        self.assertEqual(R.parse_chord("G7(#9)"), ("G", "7(#9)", None))
        self.assertEqual(R.parse_chord("Bm7b5"), ("B", "m7b5", None))
        self.assertEqual(R.parse_chord("C13/E"), ("C", "13", "E"))
        self.assertEqual(R.parse_chord("Dmaj7(#11)/A"), ("D", "maj7(#11)", "A"))
        for bad in ("Hm7", "C7/H", "Cfoo", "G7(#9"):
            with self.assertRaises(ValueError, msg=bad):
                R.parse_chord(bad)
    def test_table(self):
        cases = {"C": ("C", "maj", None), "Dm7": ("D", "min7", None), "G7": ("G", "7", None),
                 "Fmaj7": ("F", "maj7", None), "Am": ("A", "min", None), "Bbadd9": ("Bb", "maj", None),
                 "Cadd2": ("C", "maj", None), "F6": ("F", "maj", None), "Am6": ("A", "min", None),
                 "Cmadd9": ("C", "min", None), "Csus4": ("C", "sus4", None), "Aaug7": ("A", "aug", None),
                 "Gaug": ("G", "aug", None), "C/E": ("C", "maj", "E"), "F#m7/C#": ("F#", "min7", "C#")}
        for text, exp in cases.items():
            self.assertEqual(R.parse_chord(text), exp, text)
        with self.assertRaises(ValueError):
            R.parse_chord("Hm")
        with self.assertRaises(ValueError):
            R.parse_chord("Cfoo")


class TestFit(unittest.TestCase):
    def test_recovers_offset_and_tempo(self):
        sr = 22050
        tempo, t0 = 120.4, 0.04  # nominal 120 / 0.0
        eighth = 30 / tempo
        n = 32
        y = np.zeros(int(sr * (t0 + n * eighth + 1)))
        rng = np.random.default_rng(0)
        for k in range(n):
            i = int((t0 + k * eighth) * sr)
            m = int(0.02 * sr)
            y[i:i + m] += rng.standard_normal(m) * np.hanning(m) * (1.0 if k % 2 == 0 else 0.6)
        import soundfile as sf
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.wav")
            sf.write(p, y, sr)
            ann = {"tempo": 120, "firstSoundSec": 0.0, "eighthsPerBar": 8, "bars": [[["C", 8]]] * 4}
            fit = R.fit_grid(p, ann)
        self.assertAlmostEqual(fit["t0"], t0, delta=0.012)
        self.assertLess(abs(fit["tempo"] / tempo - 1), 0.002)
        self.assertLess(fit["residualMedianMs"], 12)


if __name__ == "__main__":
    unittest.main()
