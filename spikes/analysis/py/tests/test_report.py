import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import report as R  # noqa: E402


def ch(s, e, root, q="maj", conf=1.0, text=None):
    return {"start": s, "end": e, "root": root, "quality": q, "confidence": conf, "text": text or root}


def beats(n, dt=0.5, offset=0, num=4):
    return [{"t": i * dt, "downbeat": (i - offset) % num == 0 and i >= offset,
             "bar": 0, "beat": (i - offset) % num} for i in range(n)]


class ClassifyTest(unittest.TestCase):
    def test_pairs(self):
        c = (0, "maj")
        self.assertEqual(R.classify_pair(c, (0, "maj")), "correct")
        self.assertEqual(R.classify_pair(c, (9, "min")), "relative")
        self.assertEqual(R.classify_pair((9, "min"), (0, "maj")), "relative")
        self.assertEqual(R.classify_pair(c, (0, "min")), "parallel")
        self.assertEqual(R.classify_pair(c, (7, "maj")), "fifth")
        self.assertEqual(R.classify_pair(c, (5, "maj")), "fifth")
        self.assertEqual(R.classify_pair(c, (2, "min")), "other")
        self.assertEqual(R.classify_pair(c, None), "missed")
        self.assertEqual(R.classify_pair(c, (0, None)), "other")


class AnalyzeTest(unittest.TestCase):
    def setUp(self):
        self.truth = {"beats": beats(16), "timeSignature": {"num": 4},
                      "chords": [ch(0, 2, "C"), ch(2, 4, "G"), ch(4, 6, "A", "min"), ch(6, 8, "F")]}

    def test_confusion_and_calibration(self):
        res = {"beats": beats(16), "chords": [
            ch(0, 2, "C", conf=0.9), ch(2, 4, "D", conf=0.1, text="D?"), ch(4, 6, "C", conf=0.5)]}
        a = R.analyze_variant(self.truth, res)
        self.assertEqual(a["n"], 16)
        self.assertEqual(a["cats"]["correct"], 4)
        self.assertEqual(a["cats"]["fifth"], 4)  # G vs D
        self.assertEqual(a["cats"]["relative"], 4)  # Am vs C
        self.assertEqual(a["cats"]["missed"], 4)
        self.assertEqual(a["pairs"][("Am", "C")], 4)
        self.assertEqual(a["calib"][4], [4, 4])
        self.assertEqual(a["calib"][0], [4, 0])
        self.assertEqual(a["calib"][2], [4, 0])
        self.assertEqual(a["qsplit"]["?"], [4, 0])

    def test_phase(self):
        for off in range(4):
            res = {"beats": beats(16, offset=off)}
            self.assertEqual(R.phase_mode(R.phase_error(self.truth, res)), off)
        self.assertIsNone(R.phase_error(self.truth, {"beats": [{"t": 0}]}))

    def test_tempo(self):
        self.assertEqual(R.tempo_class(self.truth, {"beats": beats(16)}), "ok")
        self.assertEqual(R.tempo_class(self.truth, {"beats": beats(32, dt=0.25)}), "double")
        self.assertEqual(R.tempo_class(self.truth, {"beats": beats(8, dt=1.0)}), "half")
        self.assertEqual(R.tempo_class(self.truth, {"beats": beats(16, dt=0.7)}), "other")

    def test_aggregate(self):
        res = {"beats": beats(16), "chords": [ch(0, 8, "C")]}
        a = R.analyze_variant(self.truth, res)
        g = R.aggregate([a, a])
        self.assertEqual(g["n"], 32)
        self.assertEqual(g["variants"], 2)


class FileTest(unittest.TestCase):
    def test_plot_and_report(self):
        truth = {"beats": beats(16), "timeSignature": {"num": 4}, "sections": [{"start": 0, "end": 4, "label": "A"}],
                 "chords": [ch(0, 4, "C"), ch(4, 8, "A", "min")]}
        res = {"beats": beats(16, offset=1), "sections": [{"start": 0, "end": 8, "label": "A"}],
               "chords": [ch(0, 4, "C", text="C?"), ch(4, 8, "F")]}
        with tempfile.TemporaryDirectory() as d:
            png = R.plot_timeline(truth, res, os.path.join(d, "p", "x.png"), "t")
            self.assertGreater(os.path.getsize(png), 1000)
            os.makedirs(os.path.join(d, "results"))
            with open(os.path.join(d, "t.truth.json"), "w") as f:
                json.dump(truth, f)
            with open(os.path.join(d, "manifest.json"), "w") as f:
                json.dump({"variants": [{"name": "v1", "song": "s", "truth": "t.truth.json"}]}, f)
            with open(os.path.join(d, "results", "v1.dsp-v1.json"), "w") as f:
                json.dump({"result": res, "score": {}}, f)
            md = R.build_report(d, "dsp-v1", log=lambda *_: None)
            self.assertIn("L0", md)
            self.assertIn("plots/v1.dsp-v1.png", md)
            self.assertTrue(os.path.getsize(os.path.join(d, "results", "plots", "v1.dsp-v1.png")) > 0)
            self.assertTrue(os.path.exists(os.path.join(d, "results", "report.md")))

    def test_held_out_is_a_separate_table(self):
        truth = {"beats": beats(16), "timeSignature": {"num": 4}, "sections": [{"start": 0, "end": 4, "label": "A"}],
                 "chords": [ch(0, 4, "C"), ch(4, 8, "A", "min")]}
        res = {"beats": beats(16), "sections": [], "chords": [ch(0, 4, "C"), ch(4, 8, "A", "min")]}
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "results"))
            with open(os.path.join(d, "t.truth.json"), "w") as f:
                json.dump(truth, f)
            with open(os.path.join(d, "manifest.json"), "w") as f:
                json.dump({"variants": [{"name": "tuned1", "song": "s", "truth": "t.truth.json"},
                                        {"name": "held1", "song": "h", "truth": "t.truth.json", "heldOut": True}]}, f)
            for n in ("tuned1", "held1"):
                with open(os.path.join(d, "results", f"{n}.dsp-v1.json"), "w") as f:
                    json.dump({"result": res, "score": {}}, f)
            md = R.build_report(d, "dsp-v1", log=lambda *_: None)
            main_part, held_part = md.split("## ホールドアウト", 1)
            self.assertIn("tuned1", main_part)
            self.assertNotIn("held1", main_part)
            self.assertNotIn("| h |", main_part)  # not in the per-song table
            self.assertIn("held1", held_part)
            self.assertIn("対象: 1 変化形", md)


if __name__ == "__main__":
    unittest.main()
