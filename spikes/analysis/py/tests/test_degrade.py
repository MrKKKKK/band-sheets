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


def tone(sec=6.0, amp=0.3):
    t = np.arange(int(sec * SR)) / SR
    return amp * (np.sin(2 * np.pi * 220 * t) + 0.5 * np.sin(2 * np.pi * 330 * t))


class TestDegrade(unittest.TestCase):
    def test_snr(self):
        x = tone()
        for snr in (30, 20, 10):
            y = D.add_noise(x, snr, seed=3)
            noise = y - x
            measured = 20 * np.log10(D.active_rms(x) / np.sqrt(np.mean(noise ** 2)))
            self.assertAlmostEqual(measured, snr, delta=0.5)

    def test_snr_ignores_silence(self):
        x = np.concatenate([tone(3.0), np.zeros(3 * SR)])
        y = D.add_noise(x, 20, seed=1)
        noise = y - x
        measured = 20 * np.log10(D.active_rms(x) / np.sqrt(np.mean(noise ** 2)))
        self.assertAlmostEqual(measured, 20, delta=0.5)

    def test_noise_is_pink(self):
        n = D.pink_noise(SR * 10, np.random.default_rng(0))
        p = np.abs(np.fft.rfft(n)) ** 2
        f = np.fft.rfftfreq(len(n), 1 / SR)
        lo = p[(f > 100) & (f < 200)].mean()
        ratio = lo / p[(f > 1600) & (f < 1700)].mean()
        self.assertGreater(ratio, 8)   # 1/f: ~ (1650/150)=11x
        self.assertLess(ratio, 15)

    def test_ir_peak_and_decay(self):
        for rt in (0.6, 1.2):
            ir = D.make_ir(rt, seed=2)
            self.assertEqual(int(np.argmax(np.abs(ir))), 0)
            tail = ir[1:] ** 2
            edc = np.cumsum(tail[::-1])[::-1]
            edc_db = 10 * np.log10(edc / edc[0])
            # Schroeder: time for energy decay curve to reach -30 dB, doubled ~ RT60
            i30 = int(np.argmax(edc_db < -30))
            self.assertAlmostEqual(2 * i30 / SR, rt, delta=0.15 * rt)

    def test_reverb_keeps_length_and_time(self):
        x = np.zeros(SR)
        x[1000] = 1.0
        y = D.add_reverb(x, 0.6, seed=1)
        self.assertEqual(len(y), len(x))
        self.assertEqual(int(np.argmax(np.abs(y))), 1000)
        self.assertAlmostEqual(y[1000], 1 - D.REVERB_WET, places=6)
        self.assertLess(float(np.max(np.abs(y[:1000]))), 1e-9)

    def test_gain_envelope_bounded(self):
        env = D.gain_envelope_db(SR * 60, 6.0, seed=5)
        self.assertLessEqual(float(env.max()), 6.0 + 1e-9)
        self.assertGreaterEqual(float(env.min()), -6.0 - 1e-9)
        self.assertGreater(float(env.max() - env.min()), 3.0)  # actually varies
        # slow: max change per 100 ms well under 6 dB
        step = SR // 10
        self.assertLess(float(np.max(np.abs(env[step:] - env[:-step]))), 4.0)

    def test_deterministic(self):
        x = tone(3.0)
        kw = dict(noise_snr_db=20, reverb_rt60=0.6, gain_env_db=6, gain_db=-3)
        a = D.degrade(x, seed=7, **kw)
        b = D.degrade(x, seed=7, **kw)
        c = D.degrade(x, seed=8, **kw)
        self.assertTrue(np.array_equal(a, b))
        self.assertFalse(np.array_equal(a, c))

    def test_gain_db(self):
        x = tone(1.0)
        y = D.degrade(x, gain_db=-6.0)
        self.assertAlmostEqual(float(np.max(np.abs(y)) / np.max(np.abs(x))), 10 ** (-6 / 20), places=6)

    def test_run_end_to_end(self):
        truth = {"format": "band-sheets-analysis", "version": 1,
                 "source": {"kind": "synthetic", "durationSec": 3, "audioSec": 3.0},
                 "render": {"song": "saints", "variant": "base-a"},
                 "beats": [{"t": 0.5, "downbeat": True, "bar": 0, "beat": 0}],
                 "chords": [{"start": 0, "end": 3, "root": "C", "quality": "maj", "bass": None, "confidence": 1}]}
        with tempfile.TemporaryDirectory() as out:
            os.makedirs(os.path.join(out, "saints"))
            sf.write(os.path.join(out, "saints", "base-a.wav"), tone(3.0), SR, subtype="PCM_16")
            with open(os.path.join(out, "saints", "base-a.truth.json"), "w") as f:
                json.dump(truth, f)
            mf = {"variants": [
                {"name": "base-a", "song": "saints", "wav": "saints/base-a.wav", "truth": "saints/base-a.truth.json"},
                {"name": "base-b", "song": "saints", "level": 1, "wav": "x", "truth": "x"}]}
            with open(os.path.join(out, "manifest.json"), "w") as f:
                json.dump(mf, f)
            entries = D.run(out, conditions=["l1-noise30", "l3-harsh"], seed=1, log=lambda *_: None)
            self.assertEqual(len(entries), 2)  # level-1 base skipped
            with open(os.path.join(out, "derived", "manifest.derived.json")) as f:
                self.assertEqual(json.load(f), entries)
            for e in entries:
                self.assertEqual(e["base"], "base-a")
                y, sr = sf.read(os.path.join(out, e["wav"]))
                self.assertEqual(sr, SR)
                self.assertEqual(y.ndim, 1)
                self.assertEqual(len(y), int(3.0 * SR))
                with open(os.path.join(out, e["truth"])) as f:
                    t = json.load(f)
                self.assertEqual(t["beats"], truth["beats"])
                self.assertEqual(t["chords"], truth["chords"])
                self.assertEqual(t["source"]["degrade"]["base"], "base-a")
                self.assertEqual(t["render"]["variant"], e["name"])
            self.assertEqual(entries[1]["degrade"]["reverbRt60"], 1.2)


if __name__ == "__main__":
    unittest.main()
