import json
import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import baseline  # noqa: E402
import midbar as M  # noqa: E402
import score as S  # noqa: E402

SR = 8000
BI = 0.5


def truth(bars=4):
    return {
        "source": {"kind": "synthetic", "durationSec": bars * 4 * BI, "audioSec": bars * 4 * BI + 2},
        "render": {"variant": "base"},
        "beats": [{"t": i * BI, "downbeat": i % 4 == 0, "bar": i // 4, "beat": i % 4} for i in range(bars * 4)],
        "timeSignature": {"num": 4, "den": 4, "confidence": 1},
        "chords": [{"start": 0.0, "end": 4.0, "root": "C", "quality": "maj"},
                   {"start": 4.0, "end": 8.0, "root": "G", "quality": "7"}],
        "sections": [{"start": 0.0, "end": 4.0, "label": "A"}, {"start": 4.0, "end": 8.0, "label": "B"}],
        "drums": [{"t": 0.0, "inst": "HH"}, {"t": 0.5, "inst": "HH"}, {"t": 1.0, "inst": "HH"}],
        "melody": {"notes": [{"start": 0.0, "end": 0.5, "midi": 60}, {"start": 1.0, "end": 1.5, "midi": 62}]},
    }


class TrimTruthTest(unittest.TestCase):
    def test_shift_and_flags(self):
        t = M.trim_truth(truth(), 1.0, "b__mid2", "b", 2)  # 2 beats cut
        self.assertEqual(t["beats"][0]["t"], 0.0)
        self.assertFalse(t["beats"][0]["downbeat"])  # music now starts on beat 3 of its bar
        self.assertEqual(t["beats"][0]["beat"], 2)
        self.assertEqual([b["t"] for b in t["beats"] if b["downbeat"]], [1.0, 3.0, 5.0])
        self.assertEqual(len(t["beats"]), 14)
        self.assertEqual(t["source"]["durationSec"], 7.0)
        self.assertEqual(t["source"]["trim"], {"base": "b", "beats": 2, "cutSec": 1.0})
        self.assertEqual(t["render"]["variant"], "b__mid2")

    def test_chords_sections_drums_melody(self):
        t = M.trim_truth(truth(), 2.0, "n", "b", 4)
        self.assertEqual((t["chords"][0]["start"], t["chords"][0]["end"]), (0.0, 2.0))  # C clipped
        self.assertEqual((t["chords"][1]["start"], t["chords"][1]["end"]), (2.0, 6.0))
        self.assertEqual([s["label"] for s in t["sections"]], ["A", "B"])
        self.assertEqual(t["drums"], [])  # all hits before the cut
        self.assertEqual(t["melody"]["notes"], [])
        t = M.trim_truth(truth(), 4.0, "n", "b", 8)
        self.assertEqual([c["root"] for c in t["chords"]], ["G"])  # C ended at the cut -> dropped
        self.assertEqual([s["label"] for s in t["sections"]], ["B"])

    def test_original_untouched(self):
        orig = truth()
        M.trim_truth(orig, 1.0, "n", "b", 2)
        self.assertEqual(orig, truth())

    def test_scores_perfect_against_itself(self):
        t = M.trim_truth(truth(), 1.5, "n", "b", 3)
        s = S.score(t, t)
        self.assertEqual(s["beats"]["f"], 1.0)
        self.assertEqual(s["downbeats"]["f"], 1.0)


class RunTest(unittest.TestCase):
    def test_run_writes_wav_truth_manifest_and_skips_held_out(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "s"))
            sf.write(os.path.join(d, "s", "a.wav"), np.zeros(SR * 10, dtype=np.float32), SR)
            json.dump(truth(), open(os.path.join(d, "s", "a.truth.json"), "w"))
            variants = [{"name": n, "song": "s", "level": 0, "heldOut": h, "click": False,
                         "wav": "s/a.wav", "truth": "s/a.truth.json"} for n, h in (("a", False), ("held", True))]
            json.dump({"variants": variants}, open(os.path.join(d, "manifest.json"), "w"))
            entries = M.run(d, only="*", log=lambda *_: None)
            self.assertEqual(sorted(e["name"] for e in entries), ["a__mid1", "a__mid2", "a__mid3"])
            self.assertTrue(all(e["level"] == "M" and not e["heldOut"] for e in entries))
            y, sr = sf.read(os.path.join(d, "derived", "a__mid2.wav"))
            self.assertAlmostEqual(len(y) / sr, 10 - 2 * BI, places=3)
            self.assertTrue(os.path.exists(os.path.join(d, "derived", "manifest.trim.json")))


class Phase0Test(unittest.TestCase):
    def test_phase0_flags_every_bar_from_index_zero(self):
        t = M.trim_truth(truth(), 1.0, "n", "b", 2)  # truth downbeats at beat index 2, 6, ...
        result = {"beats": [{"t": b["t"], "downbeat": b["downbeat"]} for b in t["beats"]],
                  "timeSignature": {"num": 4}, "chords": [], "sections": [], "analyzer": {"name": "dsp-v1"}}
        # the real analyzer got it right ...
        self.assertEqual(S.score(t, result)["downbeats"]["f"], 1.0)
        # ... the phase-0 baseline cannot
        p0 = baseline.phase0_from(result)
        self.assertEqual([i for i, b in enumerate(p0["beats"]) if b["downbeat"]], [0, 4, 8, 12])
        self.assertEqual(S.score(t, p0)["downbeats"]["f"], 0.0)
        self.assertEqual(S.score(t, p0)["beats"]["f"], 1.0)
        self.assertEqual(p0["analyzer"]["name"], "dsp-phase0")
        self.assertTrue(result["beats"][2]["downbeat"])  # input not mutated

    def test_phase0_is_perfect_when_the_music_starts_on_the_downbeat(self):
        t = truth()
        result = {"beats": [{"t": b["t"], "downbeat": False} for b in t["beats"]], "timeSignature": {"num": 4}}
        self.assertEqual(S.score(t, baseline.phase0_from(result))["downbeats"]["f"], 1.0)


if __name__ == "__main__":
    unittest.main()
