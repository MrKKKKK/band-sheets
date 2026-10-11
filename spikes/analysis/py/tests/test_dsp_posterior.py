"""Spike 2 T9: chord posterior (forward-backward)."""

import unittest

import numpy as np

from py.dsp import chords as chords_mod
from py.dsp import vocab
from py.dsp.config import Config, apply_overrides
from py.dsp.posterior import chord_posterior

BETA = chords_mod._BETA


def _emis(cols, k=24):
    """cols: list of dicts state -> score."""
    m = np.zeros((k, len(cols)))
    for t, c in enumerate(cols):
        for s, v in c.items():
            m[s, t] = v
    return BETA * m


class PosteriorTest(unittest.TestCase):
    def test_columns_sum_to_one(self):
        rng = np.random.default_rng(0)
        p = chord_posterior(rng.normal(size=(24, 30)) * 5, 0.6)
        self.assertEqual(p.shape, (24, 30))
        np.testing.assert_allclose(p.sum(axis=0), 1.0)
        self.assertTrue((p >= 0).all())

    def test_clear_chord_high(self):
        p = chord_posterior(_emis([{3: 0.9}] * 6), 0.6)
        self.assertTrue((p[3] >= 0.9).all())

    def test_between_two_chords_low(self):
        cols = [{3: 0.9}] * 3 + [{3: 0.6, 10: 0.6}] + [{10: 0.9}] * 3
        p = chord_posterior(_emis(cols), 0.6)
        self.assertLess(p[:, 3].max(), 0.6)
        self.assertGreater(p[:, 3].max(), 0.3)
        self.assertGreater(p[:, 0].max(), 0.9)

    def test_argmax_matches_viterbi_on_clear_columns(self):
        cols = [{3: 0.9}] * 4 + [{10: 0.9}] * 4 + [{3: 0.9}] * 4
        e = _emis(cols)
        path = chords_mod._viterbi(e, 0.6)
        p = chord_posterior(e, 0.6)
        np.testing.assert_array_equal(p.argmax(axis=0), path)

    def test_custom_transition_matrix(self):
        e = _emis([{3: 0.5, 10: 0.5}] * 2)
        lt = np.full((24, 24), -20.0)
        lt[:, 3] = 0.0  # everything moves to state 3
        p = chord_posterior(e, 0.6, lt)
        self.assertGreater(p[3, 1], 0.99)

    def test_empty_and_single_state(self):
        self.assertEqual(chord_posterior(np.zeros((24, 0)), 0.6).shape, (24, 0))
        np.testing.assert_allclose(chord_posterior(np.zeros((1, 3)), 0.6), 1.0)

    def test_estimate_chords_uses_posterior(self):
        chroma = np.zeros((12, 6))
        chroma[[0, 4, 7], :] = 1.0
        cfg = apply_overrides(Config(), {'chords': {'confidence': 'posterior', 'use_seventh': False}})
        got = chords_mod.estimate_chords(chroma, cfg)
        self.assertTrue(all(c.confidence > 0.9 and (c.root, c.quality) == (0, 'maj') for c in got))
        self.assertEqual(len(vocab.states(cfg)), 24)


if __name__ == '__main__':
    unittest.main()
