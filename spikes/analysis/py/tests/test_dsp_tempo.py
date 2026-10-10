import unittest

import numpy as np

from py.dsp.audio import load_features
from py.dsp.config import Config, apply_overrides
from py.dsp.tempo import choose_octave
from py.dsp.types import BeatGrid
from py.tests.hooks_synth import TRIADS, _tone

SR = 22050


def synth(bpm, bars=12, click_every=1):
    """Click on every `click_every`-th beat, bass change on every beat group, triad per bar."""
    bi = 60.0 / bpm
    prog = [(0, 'maj'), (9, 'min'), (5, 'maj'), (7, 'maj')] * (bars // 4)
    y = np.zeros(int(bars * 4 * bi * SR) + SR)
    kn = int(0.03 * SR)
    kt = np.arange(kn) / SR
    click = np.sin(2 * np.pi * 1500 * kt) * np.exp(-kt * 150)
    for bar, (pc, q) in enumerate(prog):
        t0 = bar * 4 * bi
        for k in range(4):
            if k % click_every == 0:
                s = int((t0 + k * bi) * SR)
                y[s:s + kn] += click
        for iv in TRIADS[q]:
            c = _tone(55 + (pc + iv - 7) % 12, 4 * bi, 0.4)
            s = int(t0 * SR)
            y[s:s + len(c)] += c
        b = _tone(36 + pc, 4 * bi, 0.15)
        y[int(t0 * SR):int(t0 * SR) + len(b)] += b
    return (y / np.abs(y).max() * 0.8).astype(np.float32), bars * 4, bi


def grid_of(times):
    return BeatGrid(times=np.asarray(times, float), tempo=60.0 / float(np.median(np.diff(times))), method='ellis')


class TempoTest(unittest.TestCase):
    def setUp(self):
        self.y, self.nbeats, self.bi = synth(90)
        self.truth = np.arange(self.nbeats) * self.bi
        self.cfg_rule = apply_overrides(Config(), {'beats': {'tempo_octave': 'rule'}})
        self.feat = load_features((self.y, SR), self.cfg_rule)

    def test_double_grid_is_halved(self):  # tracker answered 180
        dbl = np.arange(self.nbeats * 2) * self.bi / 2
        out = choose_octave(self.feat, grid_of(dbl), self.cfg_rule)
        self.assertAlmostEqual(out.tempo, 90, delta=1.0)
        self.assertLess(float(np.max(np.abs(out.times[:, None] - self.truth[None, :]).min(axis=1))), 0.01)

    def test_half_grid_is_doubled(self):  # tracker answered 45
        out = choose_octave(self.feat, grid_of(self.truth[::2]), self.cfg_rule)
        self.assertAlmostEqual(out.tempo, 90, delta=1.0)
        self.assertEqual(len(out.times), len(self.truth) - 1)

    def test_correct_grid_kept(self):
        g = grid_of(self.truth)
        out = choose_octave(self.feat, g, self.cfg_rule)
        self.assertIs(out, g)

    def test_half_phase_prefers_beats_with_events(self):
        # clicks only on beats 1 and 3 (45-BPM pulse of 90): tracker at 90 with a 180 grid
        y, n, bi = synth(90, click_every=2)
        feat = load_features((y, SR), self.cfg_rule)
        dbl = np.arange(n * 2) * bi / 2
        out = choose_octave(feat, grid_of(dbl), self.cfg_rule)
        self.assertGreaterEqual(out.tempo, 70)
        self.assertLessEqual(out.tempo, 150)

    def test_hint_selects_nearest(self):
        y, n, bi = synth(124)
        cfg = apply_overrides(Config(), {'beats': {'tempo_hint': 124.0}})
        feat = load_features((y, SR), cfg)
        truth = np.arange(n) * bi
        for g in (truth[::2], np.arange(n * 2) * bi / 2, truth):
            out = choose_octave(feat, grid_of(g), cfg)
            self.assertAlmostEqual(out.tempo, 124, delta=1.5)

    def test_degenerate_grid_unchanged(self):
        g = BeatGrid(times=np.zeros(0), tempo=0.0, method='ellis')
        self.assertIs(choose_octave(self.feat, g, self.cfg_rule), g)


if __name__ == '__main__':
    unittest.main()
