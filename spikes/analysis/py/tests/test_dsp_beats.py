import unittest
from dataclasses import replace

import numpy as np

from py.dsp.audio import load_features
from py.dsp.beats import track_beats
from py.dsp.config import Config, apply_overrides

SR = 22050


def click_train(bpm, dur=20.0, lead=0.0, sr=SR):
    """Decaying 1 kHz bursts on every beat, after `lead` seconds of silence."""
    y = np.zeros(int(dur * sr), dtype=np.float32)
    n = int(0.03 * sr)
    t = np.arange(n) / sr
    burst = (np.sin(2 * np.pi * 1000 * t) * np.exp(-t * 150)).astype(np.float32)
    times = np.arange(lead, dur - 0.1, 60.0 / bpm)
    for s in times:
        i = int(round(s * sr))
        y[i:i + n] += burst[: len(y) - i]
    return y, times


def max_err(est, truth):
    return max(float(np.min(np.abs(est - t))) for t in truth)


class BeatsTest(unittest.TestCase):
    def run_case(self, bpm, lead=0.0, method='ellis', tol=0.010):
        y, truth = click_train(bpm, lead=lead)
        cfg = apply_overrides(Config(), {'beats': {'method': method}})
        feat = load_features((y, SR), cfg)
        grid = track_beats(feat, cfg)
        self.assertEqual(grid.method, method)
        self.assertAlmostEqual(grid.tempo, bpm, delta=bpm * 0.01)
        # every true beat has an estimate within tolerance, and none is spurious
        self.assertLessEqual(max_err(grid.times, truth), tol)
        self.assertLessEqual(max_err(truth, grid.times), tol)
        self.assertTrue(np.all(np.diff(grid.times) > 0))

    def test_120(self):
        self.run_case(120)

    def test_leading_silence(self):
        self.run_case(120, lead=1.0)

    def test_80(self):
        self.run_case(80)

    def test_160(self):
        self.run_case(160)

    def test_plp_120(self):
        self.run_case(120, method='plp')

    def test_plp_80_lead(self):
        self.run_case(80, lead=1.0, method='plp')

    def test_plp_160(self):
        self.run_case(160, method='plp')

    def test_features_shapes_and_nohpss(self):
        y, _ = click_train(120, dur=5)
        cfg = apply_overrides(Config(), {'audio': {'hpss': False}})
        f = load_features((y, SR), cfg)
        self.assertEqual(f.sr, SR)
        self.assertAlmostEqual(f.duration, 5.0, places=2)
        self.assertTrue(np.array_equal(f.y, f.y_perc))
        self.assertEqual(len(f.onset_env), 1 + len(y) // f.hop)

    def test_resample_and_silence(self):
        y, _ = click_train(120, dur=3, sr=44100)
        f = load_features((y, 44100), Config())
        self.assertEqual(f.sr, SR)
        g = track_beats(load_features((np.zeros(SR), SR), Config()), Config())
        self.assertEqual(len(g.times), 0)


if __name__ == '__main__':
    unittest.main()
