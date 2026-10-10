import os
import sys
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


class TestParse(unittest.TestCase):
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
