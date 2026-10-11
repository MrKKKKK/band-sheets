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
            md = R.build_report(d, "dsp-v1", plots=["v1"], log=lambda *_: None)
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


class Q6R17Test(unittest.TestCase):
    """Hand-computed: truth beats at 0,.5,..; chords C [0,2) G [2,4) Am [4,6) F [6,8); 16 beats -> 32 samples."""

    def setUp(self):
        self.truth = {"beats": beats(16), "timeSignature": {"num": 4},
                      "chords": [ch(0, 2, "C"), ch(2, 4, "G"), ch(4, 6, "A", "min"), ch(6, 8, "F")]}

    def test_two_point_scoring_splits_a_beat(self):
        # result switches to the right chord at t=2.125: beat [2,2.5) has samples 2.125 (right) and 2.375 (right);
        # a switch at 2.25 makes sample 2.125 wrong and 2.375 right -> half a beat.
        res = {"beats": beats(16), "chords": [ch(0, 2.25, "C"), ch(2.25, 4, "G"), ch(4, 6, "A", "min"), ch(6, 8, "F")]}
        a = R.analyze_variant(self.truth, res)
        self.assertAlmostEqual(a["n"], 16)
        self.assertAlmostEqual(a["cats"]["correct"], 15.5)
        self.assertAlmostEqual(a["cats"]["fifth"], 0.5)  # C vs G
        self.assertEqual(a["kinds"]["fifth_down"], 0.5)  # truth G, result C: a fourth above / fifth below

    def test_question_table_values(self):
        # 4 beats of G? wrong (D?), 4 beats of C right plain, rest missed
        res = {"beats": beats(16), "chords": [ch(0, 2, "C"), ch(2, 4, "D", text="D?")]}
        a = R.analyze_variant(self.truth, res)
        self.assertEqual(a["qsplit"]["?"], [4, 0])
        self.assertEqual(a["qsplit"]["plain"], [4, 4])
        lines = R._question_table([("x", R.aggregate([a]))])
        self.assertEqual(lines[2], "| x | 4 | 100.0% | 4 | 0.0% |")

    def test_error_kinds(self):
        self.assertEqual(R.error_kind((0, "maj"), (7, "maj")), "fifth_up")
        self.assertEqual(R.error_kind((0, "maj"), (5, "maj")), "fifth_down")
        self.assertEqual(R.error_kind((0, "maj"), (9, "min")), "relative")
        self.assertIsNone(R.error_kind((0, "maj"), (0, "maj")))

    def _write(self, d, variants, truth, res):
        os.makedirs(os.path.join(d, "results"))
        with open(os.path.join(d, "t.truth.json"), "w") as f:
            json.dump(truth, f)
        with open(os.path.join(d, "manifest.json"), "w") as f:
            json.dump({"variants": variants}, f)
        for v in variants:
            with open(os.path.join(d, "results", f"{v['name']}.dsp-v1.json"), "w") as f:
                json.dump({"result": res[v["name"]], "score": {}}, f)

    def test_m_excluded_from_totals_and_rec_has_no_names(self):
        good = {"beats": beats(16), "chords": [ch(0, 2, "C"), ch(2, 4, "G"), ch(4, 6, "A", "min"), ch(6, 8, "F")]}
        bad = {"beats": beats(16), "chords": [ch(0, 8, "D")]}
        vs = [{"name": "base1", "song": "s", "truth": "t.truth.json", "level": 0},
              {"name": "mid1", "song": "s", "truth": "t.truth.json", "level": "M"},
              {"name": "secretfile", "song": "secretsong", "truth": "t.truth.json", "level": "REC"}]
        with tempfile.TemporaryDirectory() as d:
            self._write(d, vs, self.truth, {"base1": bad, "mid1": good, "secretfile": bad})
            md = R.build_report(d, "dsp-v1", log=lambda *_: None)
            self.assertNotIn("secretfile", md)
            self.assertNotIn("secretsong", md)
            self.assertNotIn("LREC", md)
            self.assertIn("| REC |", md)
            self.assertIn("| REC-1 |", md)
            self.assertIn("| M |", md)
            # D vs truth: both base1 and REC are 'bad'; M is perfect and must not dilute the overall row
            overall = [l for l in md.splitlines() if l.startswith("| 全体 | ")][0]
            self.assertTrue(overall.startswith("| 全体 | 2 | 32 |"), overall)
            # no chord-pair names for REC: the only pair table is for L0 (D appears there, not as REC)
            self.assertIn("REC-1.dsp-v1.png", md)
            self.assertTrue(os.path.exists(os.path.join(d, "results", "plots", "REC-1.dsp-v1.png")))
            self.assertFalse(os.path.exists(os.path.join(d, "results", "plots", "secretfile.dsp-v1.png")))

    def test_private_chart_variants_are_anonymised_like_rec(self):
        good = {"beats": beats(16), "chords": [ch(0, 2, "C"), ch(2, 4, "G"), ch(4, 6, "A", "min"), ch(6, 8, "F")]}
        bad = {"beats": beats(16), "chords": [ch(0, 8, "D")]}
        vs = [{"name": "base1", "song": "s", "truth": "t.truth.json", "level": 0},
              {"name": "chart-07-rec", "song": "chart", "truth": "t.truth.json", "level": "CH", "private": True},
              {"name": "chart-08-block", "song": "chart", "truth": "t.truth.json", "level": "CH", "private": True,
               "heldOut": True}]
        with tempfile.TemporaryDirectory() as d:
            self._write(d, vs, self.truth, {"base1": good, "chart-07-rec": bad, "chart-08-block": bad})
            # the CH entries live in their own manifest, as written by render/chartsCli.ts
            os.makedirs(os.path.join(d, "charts"))
            with open(os.path.join(d, "charts", "manifest.charts.json"), "w") as f:
                json.dump({"variants": [dict(vs[1], level="CH"), dict(vs[2], private=True)]}, f)
            with open(os.path.join(d, "manifest.json"), "w") as f:
                json.dump({"variants": vs[:1]}, f)
            md = R.build_report(d, "dsp-v1", log=lambda *_: None)
            self.assertNotIn("chart-07", md)
            self.assertNotIn("chart-08", md)
            self.assertIn("| CH |", md)
            self.assertIn("| CH-1 |", md)
            # the wrong chord D appears in no pair table for CH (only the L0 variant would, and it is right)
            self.assertNotIn("→ D", md)
            self.assertNotIn("C → ", md)
            self.assertTrue(os.path.exists(os.path.join(d, "results", "plots", "CH-1.dsp-v1.png")))
            self.assertFalse(os.path.exists(os.path.join(d, "results", "plots", "chart-07-rec.dsp-v1.png")))

    def test_private_flag_alone_anonymises(self):
        entries = R.load_manifests  # noqa: F841  (existence check)
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "charts"))
            with open(os.path.join(d, "charts", "manifest.charts.json"), "w") as f:
                json.dump({"variants": [{"name": "x", "truth": "t.truth.json", "level": 0, "private": True}]}, f)
            self.assertEqual(R.load_manifests(d)["x"]["level"], "CH")


class T20ReportTest(unittest.TestCase):
    def test_vocab_and_key_tables(self):
        truth = {"beats": beats(16), "timeSignature": {"num": 4},
                 "chords": [ch(0, 4, "C", "6"), ch(4, 8, "G", "7(b5)")],
                 "keys": [{"startBar": 0, "key": "C"}]}
        res = {"beats": beats(16), "chords": [ch(0, 4, "C"), ch(4, 8, "G", "7")],
               "keys": [{"startBar": 0, "tonic": "C", "mode": "major", "confidence": 1.0}]}
        a = R.analyze_variant(truth, res)
        self.assertEqual(a["vocab"]["nBeatsScored"], 8)
        self.assertEqual(a["vocab"]["nBeatsDropped"], 8)
        self.assertEqual(a["keys"]["nBars"], 4)
        agg = R.aggregate([a, R.analyze_variant(truth, res)])
        self.assertEqual(agg["vocab"]["nBeatsHit"], 16)
        self.assertEqual(agg["keyVariants"], 2)
        v = "\n".join(R._vocab_table([("L0", agg)]))
        self.assertIn("| L0 | 16 | 100.0% | 100.0% | 16 | 0 | - |", v)
        k = "\n".join(R._key_table([("L0", agg)]))
        self.assertIn("| L0 | 2 | 8 | 100.0% | 100.0% | 0/0/0 | - |", k)

    def test_variant_without_keys_or_vocab_rows(self):
        a = R.analyze_variant({"beats": beats(4)}, {"beats": beats(4)})
        self.assertIsNone(a["vocab"])
        self.assertIsNone(a["keys"])
        agg = R.aggregate([a])
        self.assertEqual(agg["keyVariants"], 0)
        self.assertIn("| x | 0 | 0 | - | - | 0/0/0 | - |", "\n".join(R._key_table([("x", agg)])))


class T27ReportTest(unittest.TestCase):
    def test_split_table(self):
        truth = {"beats": beats(16), "chords": [ch(0, 4, "C"), ch(4, 8, "A", "min")]}
        r1 = ch(0, 4, "C", "5")
        r1["candidates"] = [{"name": "C5", "root": "C", "quality": "5", "prob": 0.6},
                            {"name": "C", "root": "C", "quality": "maj", "prob": 0.4}]
        res = {"beats": beats(16), "chords": [r1, ch(4, 8, "C")]}
        a = R.analyze_variant(truth, res)
        self.assertEqual(a["split"], {"nBeatsScored": 16, "nBeatsRootHit": 8, "nBeatsPower": 8,
                                      "nBeatsQualityScored": 8, "nBeatsQualityHit": 0,
                                      "nBeatsTopKHit": 8, "nBeatsTopKScored": 16})
        agg = R.aggregate([a, R.analyze_variant(truth, {"beats": beats(16), "chords": [ch(0, 8, "C")]})])
        t = "\n".join(R._split_table([("REC", agg)]))
        # 2nd variant has no candidates: top-k is counted over the variants that have them only
        self.assertIn("| REC | 32 | 50.0% | 33.3% | 8 | 25.0% | 50.0% |", t)

    def test_split_section_in_report(self):
        truth = {"beats": beats(16), "chords": [ch(0, 8, "C")]}
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "results"))
            with open(os.path.join(d, "t.truth.json"), "w") as f:
                json.dump(truth, f)
            with open(os.path.join(d, "manifest.json"), "w") as f:
                json.dump({"variants": [{"name": "secretrec", "song": "secretsong", "truth": "t.truth.json",
                                         "level": "REC"}]}, f)
            with open(os.path.join(d, "results", "secretrec.dsp-v1.json"), "w") as f:
                json.dump({"result": {"beats": beats(16), "chords": [ch(0, 8, "C", "5")]}}, f)
            md = R.build_report(d, "dsp-v1", log=lambda *_: None)
        self.assertIn("## ルートと種類の分け(T27)", md)
        self.assertIn("| REC | 16 | 100.0% | - | 16 | 100.0% | - |", md)
        self.assertNotIn("secret", md)
        self.assertNotIn("C5", md)


if __name__ == "__main__":
    unittest.main()
