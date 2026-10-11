"""Spike 2 T27: power chords ('5'), inverted fifths, candidates, posterior move count."""

import unittest
from unittest import mock

import numpy as np

from py.dsp import bassroot, posterior, vocab
from py.dsp.chords import ChordSegment, _BETA, chord_name, estimate_chords, merge_chords
from py.dsp.chroma import beat_chroma
from py.dsp.config import Config, apply_overrides, config_hash
from py.dsp.types import BeatChord, BeatGrid, Features

SR = 22050
HOP = 512
BEAT = 0.5
C, E, EB, G, D = 0, 4, 3, 7, 2


def cfg(**chords):
    return apply_overrides(Config(), {'chords': chords})


POWER = cfg(power=True)


def col(**amps):
    """(12, 1) chroma from pitch-class amplitudes, e.g. col(C=1, G=1)."""
    pcs = {'C': 0, 'D': 2, 'Eb': 3, 'E': 4, 'G': 7, 'B': 11, 'A': 9}
    c = np.zeros((12, 1))
    for k, v in amps.items():
        c[pcs[k], 0] = v
    return c


def piano_like(midis, dur):
    """Tones with 2nd and 3rd harmonics (the 3rd harmonic of G is D: the 'fifth up' trap)."""
    t = np.arange(int(dur * SR)) / SR
    y = np.zeros_like(t)
    for m in midis:
        f = 440.0 * 2 ** ((m - 69) / 12)
        y += sum(a * np.sin(2 * np.pi * h * f * t) for h, a in ((1, 1.0), (2, 0.5), (3, 0.3)))
    env = np.minimum(1.0, np.minimum(t / 0.01, (dur - t) / 0.01))
    return 0.2 * y / len(midis) * env


def chords_of(midis, c, beats=4):
    y = np.concatenate([piano_like(midis, BEAT) for _ in range(beats)]).astype(np.float32)
    feat = Features(sr=SR, hop=HOP, duration=len(y) / SR, y=y, y_harm=y, y_perc=np.zeros_like(y),
                    onset_env=np.zeros(1 + len(y) // HOP))
    grid = BeatGrid(times=np.arange(beats) * BEAT, tempo=120.0, method='test')
    chroma, _ = beat_chroma(feat, grid, c)
    return estimate_chords(chroma, c), chroma


class ConfigTest(unittest.TestCase):
    def test_off_values_keep_spike1_hash(self):
        self.assertEqual(config_hash(Config()), '99f2c324b973')
        self.assertNotEqual(config_hash(POWER), config_hash(Config()))
        self.assertNotEqual(config_hash(cfg(candidates=True)), config_hash(Config()))

    def test_bad_values_raise(self):
        for c in (cfg(candidates=True, candidates_k=0), cfg(power=True, power_third_max=-0.1)):
            with self.subTest(c=c.chords), self.assertRaises(ValueError):
                estimate_chords(col(C=1, E=1, G=1), c)


class VocabTest(unittest.TestCase):
    def test_power_states_appended(self):
        base = vocab.states(Config())
        st = vocab.states(POWER)
        self.assertEqual(st[:len(base)], base)
        self.assertEqual(st[len(base):], [(r, '5') for r in range(12)])
        self.assertEqual(vocab.intervals('5'), (0, 7))
        self.assertEqual(chord_name(0, '5'), 'C5')
        self.assertEqual(vocab.move_states(POWER), vocab.move_states(Config()))
        v2p = vocab.states(cfg(vocab='v2', power=True))
        self.assertEqual(v2p[-12:], [(r, '5') for r in range(12)])

    def test_third_ratio(self):
        m = np.zeros(12)
        m[[C, G]] = 1.0
        m[E] = 0.2
        self.assertAlmostEqual(float(vocab.third_ratio(m, C)), 0.2)
        m[EB] = 0.5
        self.assertAlmostEqual(float(vocab.third_ratio(m, C)), 0.5)  # the stronger of m3 / M3
        self.assertEqual(float(vocab.third_ratio(np.zeros(12), C)), np.inf)


class PowerChordTest(unittest.TestCase):
    def _one(self, chroma, c=POWER):
        got = estimate_chords(chroma, c)
        return got[0].root, got[0].quality

    def test_open_fifth_is_power_chord(self):
        self.assertEqual(self._one(col(C=1, G=1)), (C, '5'))
        self.assertEqual(self._one(col(C=1, G=1, E=0.15)), (C, '5'))  # weak 3rd (e.g. a harmonic)

    def test_sounded_third_keeps_triad(self):
        self.assertEqual(self._one(col(C=1, G=1, E=0.6)), (C, 'maj'))
        self.assertEqual(self._one(col(C=1, G=1, Eb=0.6)), (C, 'min'))
        self.assertEqual(self._one(col(C=1, E=1, G=1)), (C, 'maj'))

    def test_off_never_outputs_power(self):
        self.assertEqual(self._one(col(C=1, G=1), Config())[0], C)
        self.assertNotEqual(self._one(col(C=1, G=1), Config())[1], '5')

    def test_power_gate_off_by_default_bit_identical(self):
        rng = np.random.default_rng(1)
        chroma = rng.random((12, 20))
        a = estimate_chords(chroma, Config())
        b = estimate_chords(chroma, cfg(power=True, power_third_max=0.0))  # nothing passes a zero gate
        self.assertEqual([(x.root, x.quality) for x in a], [(x.root, x.quality) for x in b])


class InvertedFifthTest(unittest.TestCase):
    """Rule C: G2 + C3 + G3 (4th at the bottom, no 3rd) is C5: the upper note of the 4th is the root."""

    def test_inverted_power_chord_audio(self):
        got, chroma = chords_of([43, 48, 55], POWER)  # G2 C3 G3
        self.assertGreater(chroma[D].mean(), 0.0)  # the 3rd harmonics of G put D in the chroma
        self.assertEqual({(c.root, c.quality) for c in got}, {(C, '5')})

    def test_inverted_with_third_is_triad(self):
        got, _ = chords_of([43, 48, 52, 55], POWER)  # G2 C3 E3 G3
        self.assertEqual({(c.root, c.quality) for c in got}, {(C, 'maj')})

    def test_root_without_power_switch_is_c(self):
        got, _ = chords_of([43, 48, 55], Config())
        self.assertEqual({c.root for c in got}, {C})

    def test_bass_evidence_ignored_on_power_columns(self):
        chroma = np.repeat(col(C=1, G=1), 2, axis=1)
        ev = np.zeros((12, 2))
        ev[G] = 1.0  # strong G in the bass (the inverted 5th)
        c = cfg(power=True, bass_root='lowest', bass_root_weight=1.0)
        with mock.patch.object(bassroot, 'root_evidence', return_value=ev):
            got = estimate_chords(chroma, c)
        self.assertEqual({(x.root, x.quality) for x in got}, {(C, '5')})

    def test_bass_evidence_still_used_with_third(self):
        chroma = np.repeat(col(C=1, E=1, G=1, A=1), 2, axis=1)  # C6 = Am7 tones
        ev = np.zeros((12, 2))
        ev[9] = 1.0
        c = cfg(power=True, bass_root='lowest', bass_root_weight=1.0, use_seventh=False)
        with mock.patch.object(bassroot, 'root_evidence', return_value=ev):
            got = estimate_chords(chroma, c)
        self.assertEqual({(x.root, x.quality) for x in got}, {(9, 'min')})


def seg(a, b, root, q, conf=0.5):
    return ChordSegment(a, b, root, q, conf, False)


class PowerSegmentTest(unittest.TestCase):
    def test_weak_third_over_segment_becomes_power(self):
        chroma = np.zeros((12, 4))
        chroma[[C, G], :] = 1.0
        chroma[E, 0] = 0.6  # a melody 3rd on one beat only: mean 0.15
        out = vocab.decide_power_segments([seg(0, 4, C, 'maj')], chroma, POWER)
        self.assertEqual([(s.root, s.quality) for s in out], [(C, '5')])

    def test_sounded_third_over_segment_becomes_triad(self):
        chroma = np.zeros((12, 4))
        chroma[[C, G], :] = 1.0
        chroma[EB, :] = 0.6
        out = vocab.decide_power_segments([seg(0, 4, C, '5')], chroma, POWER)
        self.assertEqual(out[0].quality, 'min')
        chroma[E, :] = 0.7
        self.assertEqual(vocab.decide_power_segments([seg(0, 4, C, '5')], chroma, POWER)[0].quality, 'maj')

    def test_sevenths_and_off_untouched_and_merge(self):
        chroma = np.zeros((12, 6))
        chroma[[C, G], :] = 1.0
        segs = [seg(0, 2, C, '5', 0.4), seg(2, 4, C, 'maj', 0.8), seg(4, 6, C, '7')]
        self.assertIs(vocab.decide_power_segments(segs, chroma, Config()), segs)
        out = vocab.decide_power_segments(segs, chroma, POWER)
        self.assertEqual([(s.start_beat, s.end_beat, s.quality) for s in out], [(0, 4, '5'), (4, 6, '7')])
        self.assertAlmostEqual(out[0].confidence, 0.6)


class PosteriorMoveTest(unittest.TestCase):
    def test_n_move_equal_to_states_is_default(self):
        rng = np.random.default_rng(0)
        e = rng.normal(size=(24, 10)) * 5
        np.testing.assert_array_equal(posterior.chord_posterior(e, 0.6), posterior.chord_posterior(e, 0.6, n_move=24))

    def test_n_move_changes_move_cost(self):
        e = np.zeros((36, 3))
        e[0, :] = 5.0
        e[1, 1] = 6.0  # a one-column challenger
        p_all = posterior.chord_posterior(e, 0.6)
        p_v1 = posterior.chord_posterior(e, 0.6, n_move=24)  # cheaper move (split over 24, not 36)
        self.assertGreater(p_v1[1, 1], p_all[1, 1])
        np.testing.assert_allclose(p_v1.sum(axis=0), 1.0)

    def test_chords_pass_move_states(self):
        c = cfg(vocab='v2', confidence='posterior')
        with mock.patch.object(posterior, 'chord_posterior', wraps=posterior.chord_posterior) as cp:
            estimate_chords(col(C=1, E=1, G=1), c)
        self.assertEqual(cp.call_args.kwargs['n_move'], vocab.move_states(c))
        self.assertLess(vocab.move_states(c), len(vocab.states(c)))


class CandidatesTest(unittest.TestCase):
    def test_beat_posteriors_only_with_switch(self):
        chroma = np.repeat(col(C=1, E=1, G=1), 3, axis=1)
        self.assertEqual({b.posterior is None for b in estimate_chords(chroma, Config())}, {True})
        got = estimate_chords(chroma, cfg(candidates=True))
        self.assertEqual(got[0].posterior.shape, (60,))
        self.assertEqual([b.confidence for b in got], [b.confidence for b in estimate_chords(chroma, Config())])  # margin kept

    def test_segment_candidates_ranked(self):
        post = np.zeros((4, 4))
        post[0] = [0.6, 0.6, 0.2, 0.2]
        post[1] = [0.3, 0.3, 0.7, 0.7]
        post[2] = [0.1, 0.1, 0.1, 0.1]
        states = [(0, 'maj'), (9, 'min'), (7, 'maj'), (5, 'maj')]
        got = posterior.segment_candidates(post, states, 0, 4, 3)
        self.assertEqual([(r, q) for r, q, _ in got], [(9, 'min'), (0, 'maj'), (7, 'maj')])
        self.assertAlmostEqual(got[0][2], 0.5)
        self.assertEqual(len(posterior.segment_candidates(post, states, 0, 2, 2)), 2)
        self.assertEqual(posterior.segment_candidates(post, states, 3, 3, 3), [])

    def test_attach_to_segments(self):
        chroma = np.zeros((12, 6))
        chroma[[C, E, G], :3] = 1.0
        chroma[[9, C, E], 3:] = 1.0
        c = cfg(candidates=True, candidates_k=2)
        beats = estimate_chords(chroma, c)
        segs = posterior.attach_candidates(merge_chords(beats, c), beats, c)
        self.assertEqual([(s.root, s.quality) for s in segs], [(C, 'maj'), (9, 'min')])
        for s in segs:
            self.assertEqual(len(s.candidates), 2)
            self.assertEqual(s.candidates[0][:2], (s.root, s.quality))
            self.assertGreaterEqual(s.candidates[0][2], s.candidates[1][2])
        self.assertEqual(posterior.attach_candidates(segs, beats, Config()), segs)

    def test_beat_chord_equality_ignores_posterior(self):
        self.assertEqual(BeatChord(0, 'maj', 1.0, posterior=np.ones(3)), BeatChord(0, 'maj', 1.0))


if __name__ == '__main__':
    unittest.main()
