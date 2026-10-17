"""degrade.py additions of spike 2 (T4): level LR conditions, the maximizer, merge / keep-existing."""
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import degrade as D  # noqa: E402

SR = 44100


def music(sec=4.0):
    t = np.arange(int(sec * SR)) / SR
    env = np.exp(-(t % 0.5) * 6)  # a struck note every 0.5 s
    return 0.1 * env * (np.sin(2 * np.pi * 220 * t) + 0.5 * np.sin(2 * np.pi * 330 * t))


class MaximizerTest(unittest.TestCase):
    def test_ceiling_and_loudness(self):
        x = music()
        y = D.maximize(x, -12.0, -0.3)
        self.assertLessEqual(np.max(np.abs(y)), 10 ** (-0.3 / 20) + 1e-9)
        self.assertGreater(D.active_rms(y), D.active_rms(x) * 3)  # much louder than the input
        self.assertLess(20 * np.log10(D.active_rms(y)), -12.0 + 0.5)  # limiting only lowers it

    def test_limiter_does_not_clip_by_itself(self):
        # Without the guard clip, the limited signal already stays under the ceiling.
        x = music()
        y = D.maximize(x, -12.0, -0.3)
        self.assertLess(np.mean(np.abs(y) >= 10 ** (-0.3 / 20) - 1e-12), 0.001)

    def test_keeps_time_and_is_deterministic(self):
        x = np.zeros(SR)
        x[SR // 2] = 0.01
        x[SR // 2 + 1:SR // 2 + 400] = 0.005
        y = D.maximize(x, -12.0)
        self.assertEqual(len(y), len(x))
        self.assertEqual(int(np.argmax(np.abs(y))), SR // 2)
        np.testing.assert_array_equal(y, D.maximize(x, -12.0))

    def test_quiet_part_is_untouched_by_the_limiter(self):
        x = music() * 0.001
        y = D.maximize(x, -40.0, -0.3)  # target below the ceiling: pure make-up gain
        g = 10 ** (-40 / 20) / D.active_rms(x)
        np.testing.assert_allclose(y, x * g, rtol=1e-9, atol=1e-12)


class LrConditionsTest(unittest.TestCase):
    def test_jobs(self):
        lr0 = {"name": "x-rec", "level": "LR", "lrGrade": 0}
        jobs = {cn: (lv, g) for cn, lv, g, _ in D.jobs_for(lr0)}
        self.assertEqual(jobs, {"l1-noise30": ("LR", 1), "l2-room": ("LR", 2), "lr-max": ("LR", 1)})
        self.assertFalse(D.is_lr_base({"level": "LR", "lrGrade": 1}))
        l0 = {"name": "z", "level": 0}
        self.assertEqual([j[0] for j in D.jobs_for(l0)], list(D.CONDITIONS))  # no maximizer on spike 1 bases
        self.assertEqual([j[0] for j in D.jobs_for({**l0, "heldOut": True})],
                         [k for k, (lv, _) in D.CONDITIONS.items() if lv <= 2])

    def test_select_bases(self):
        m = {"variants": [{"name": "a", "level": 0}, {"name": "b", "level": "LR", "lrGrade": 0},
                          {"name": "c", "level": "LR", "lrGrade": 1}, {"name": "d", "level": "V"},
                          {"name": "e", "level": 1}]}
        self.assertEqual([v["name"] for v in D.select_bases(m)], ["a", "b"])

    def test_run_writes_lr_entries_and_merges(self):
        with tempfile.TemporaryDirectory() as d:
            sf.write(os.path.join(d, "b.wav"), music(2.0).astype(np.float32), SR, subtype="PCM_16")
            truth = {"source": {"kind": "synthetic"}, "beats": [{"t": 0.0}], "render": {"variant": "b"}}
            with open(os.path.join(d, "b.truth.json"), "w") as f:
                json.dump(truth, f)
            with open(os.path.join(d, "manifest.json"), "w") as f:
                json.dump({"variants": [{"name": "b", "song": "etude", "level": "LR", "lrGrade": 0,
                                         "heldOut": True, "wav": "b.wav", "truth": "b.truth.json"}]}, f)
            os.makedirs(os.path.join(d, "derived"))
            with open(os.path.join(d, "derived", "manifest.derived.json"), "w") as f:
                json.dump([{"name": "other__l1-noise30"}], f)
            D.run(d, only="b", log=lambda *_: None)
            with open(os.path.join(d, "derived", "manifest.derived.json")) as f:
                ents = json.load(f)
            names = [e["name"] for e in ents]
            self.assertEqual(names[0], "other__l1-noise30")  # kept (merged by name)
            mx = next(e for e in ents if e["name"] == "b__lr-max")
            self.assertEqual((mx["level"], mx["lrGrade"], mx["heldOut"]), ("LR", 1, True))
            with open(os.path.join(d, "derived", "b__lr-max.truth.json")) as f:
                t = json.load(f)
            self.assertEqual(t["beats"], truth["beats"])  # times unchanged
            self.assertEqual(t["source"]["degrade"]["lrGrade"], 1)
            y, _ = sf.read(os.path.join(d, "derived", "b__lr-max.wav"))
            self.assertLessEqual(np.max(np.abs(y)), 10 ** (-0.3 / 20) + 1e-4)
            # keep-existing: an existing output is not rewritten
            p = os.path.join(d, "derived", "b__l2-room.wav")
            before = os.path.getmtime(p)
            os.utime(p, (before - 100, before - 100))
            D.run(d, only="b", keep_existing=True, log=lambda *_: None)
            self.assertEqual(os.path.getmtime(p), before - 100)


if __name__ == "__main__":
    unittest.main()
