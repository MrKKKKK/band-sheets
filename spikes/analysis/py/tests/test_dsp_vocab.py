"""Spike 2 T21: chord vocabulary 'v2' (docs/audio-spike2-plan.md design decision 8)."""

import unittest
from dataclasses import replace

import numpy as np

import py.score as S
from py.dsp import vocab
from py.dsp.chords import _viterbi, chord_name, estimate_chords
from py.dsp.chroma import beat_chroma
from py.dsp.config import Config, apply_overrides
from py.dsp.types import BeatGrid, Features

SR = 22050
HOP = 512
BEAT = 0.5

V1_QUALS = ('maj', 'min', '7', 'maj7', 'min7')
NEW_QUALS = ('dim', 'aug', 'sus4', 'm7b5', 'dim7')


def v2(**chords):
    c = apply_overrides(Config(), {'chords': {'vocab': 'v2'}})
    return replace(c, chords=replace(c.chords, **chords)) if chords else c


def sine(midis, dur):
    """Pure sine tones (no harmonics), equal amplitude, short fades."""
    t = np.arange(int(dur * SR)) / SR
    y = sum(np.sin(2 * np.pi * 440.0 * 2 ** ((m - 69) / 12) * t) for m in midis)
    env = np.minimum(1.0, np.minimum(t / 0.01, (dur - t) / 0.01))
    return 0.3 * y / len(midis) * env


def analyze_notes(midis, cfg, beats=4):
    y = np.concatenate([sine(midis, BEAT) for _ in range(beats)]).astype(np.float32)
    feat = Features(sr=SR, hop=HOP, duration=len(y) / SR, y=y, y_harm=y, y_perc=np.zeros_like(y),
                    onset_env=np.zeros(1 + len(y) // HOP))
    grid = BeatGrid(times=np.arange(beats) * BEAT, tempo=120.0, method='test')
    chroma, _ = beat_chroma(feat, grid, cfg)
    return [chord_name(c.root, c.quality) for c in estimate_chords(chroma, cfg)]


class StatesTest(unittest.TestCase):
    def test_v1_unchanged(self):
        want = [(r, q) for q in V1_QUALS for r in range(12)]
        self.assertEqual(vocab.states(Config()), want)
        no7 = apply_overrides(Config(), {'chords': {'use_seventh': False}})
        self.assertEqual(vocab.states(no7), want[:24])

    def test_v2_adds_the_new_qualities_after_v1(self):
        st = vocab.states(v2())
        self.assertEqual(st[:60], vocab.states(Config()))
        self.assertEqual(st[60:], [(r, q) for q in NEW_QUALS for r in range(12)])
        self.assertEqual(len(set(st)), len(st))

    def test_v2_without_sevenths_has_triads_only(self):
        st = vocab.states(v2(use_seventh=False))
        self.assertEqual({q for _, q in st}, {'maj', 'min', 'dim', 'aug', 'sus4'})

    def test_intervals_no_tensions(self):
        self.assertEqual(vocab.intervals('dim'), (0, 3, 6))
        self.assertEqual(vocab.intervals('aug'), (0, 4, 8))
        self.assertEqual(vocab.intervals('sus4'), (0, 5, 7))
        self.assertEqual(vocab.intervals('m7b5'), (0, 3, 6, 10))
        self.assertEqual(vocab.intervals('dim7'), (0, 3, 6, 9))
        for _, q in vocab.states(v2()):
            self.assertTrue(all(i in (0, 3, 4, 5, 6, 7, 8, 9, 10, 11) for i in vocab.intervals(q)), q)

    def test_names_consistent_with_scoring(self):
        for q in V1_QUALS + NEW_QUALS:
            self.assertEqual(S.map_vocab(q), q)  # result 'quality' field
            self.assertEqual(S.map_vocab(vocab.suffix(q)), q)  # chord text suffix
        self.assertEqual(set(V1_QUALS + NEW_QUALS), set(S.VOCAB_QUALITIES))
        self.assertEqual([chord_name(11, q) for q in NEW_QUALS], ['Bdim', 'Baug', 'Bsus4', 'Bm7b5', 'Bdim7'])

    def test_unknown_vocab_raises(self):
        with self.assertRaises(ValueError):
            vocab.states(apply_overrides(Config(), {'chords': {'vocab': 'v3'}}))


class GateTest(unittest.TestCase):
    def test_v1_returns_scores_untouched(self):
        st = vocab.states(Config())
        s = np.random.default_rng(0).random((len(st), 5))
        unit = np.ones((12, 5)) / np.sqrt(12)
        out, masked = vocab.gate_scores(s, unit, st, Config())
        self.assertIs(out, s)
        self.assertFalse(masked.any())

    def test_new_quality_needs_margin_over_v1_states(self):
        st = [(0, 'maj'), (11, 'dim')]
        s = np.array([[0.80, 0.80], [0.84, 0.90]])
        unit = np.zeros((12, 2))
        out, masked = vocab.gate_scores(s, unit, st, v2(vocab_weight=1.0, vocab_margin=0.05))
        np.testing.assert_allclose(out[1], [0.0, 0.90])
        self.assertEqual(masked[1].tolist(), [True, False])
        np.testing.assert_allclose(out[0], s[0])

    def test_sus4_has_its_own_margin(self):
        st = [(0, 'maj'), (7, 'sus4'), (11, 'dim')]
        s = np.array([[0.80], [0.90], [0.90]])
        out, _ = vocab.gate_scores(s, np.zeros((12, 1)), st, v2(vocab_margin=0.05, vocab_sus4_margin=0.15))
        np.testing.assert_allclose(out[:, 0], [0.80, 0.0, 0.90])

    def test_weight_scales_new_qualities(self):
        st = [(0, 'maj'), (0, 'aug')]
        s = np.array([[0.5], [1.0]])
        out, _ = vocab.gate_scores(s, np.zeros((12, 1)), st, v2(vocab_weight=0.9, vocab_margin=0.0))
        self.assertAlmostEqual(out[1, 0], 0.9)

    def test_symmetric_root_from_chroma(self):
        # aug / dim7 templates are the same for every root of the set: the stronger chroma bin wins
        st = [(0, 'maj'), (0, 'aug'), (4, 'aug'), (8, 'aug')]
        s = np.array([[0.5], [1.0], [1.0], [1.0]])
        unit = np.zeros((12, 1))
        unit[[0, 4, 8], 0] = [0.5, 0.7, 0.5]
        out, _ = vocab.gate_scores(s, unit, st, v2(vocab_margin=0.0))
        self.assertEqual(int(np.argmax(out[:, 0])), 2)


class MoveCostTest(unittest.TestCase):
    def test_move_states_is_the_v1_count(self):
        self.assertEqual(vocab.move_states(Config()), 60)
        self.assertEqual(vocab.move_states(v2()), 60)
        self.assertEqual(vocab.move_states(v2(use_seventh=False)), 24)

    def test_masked_extra_states_do_not_change_the_path(self):
        # extras all gated to 0: the v2 path over 120 states equals the v1 path over 60 states
        rng = np.random.default_rng(1)
        s = rng.random((60, 40)) * 0.2 + 0.7
        padded = np.vstack([s, np.zeros((60, 40))])
        for prior in (None, np.full((40, 120, 120), 1e-3)):
            with self.subTest(prior=prior is not None):
                p1 = _viterbi(s, 0.6, None if prior is None else prior[:, :60, :60], None)
                p2 = _viterbi(padded, 0.6, prior, 60)
                self.assertEqual(p2.tolist(), p1.tolist())


class SineTest(unittest.TestCase):
    """End of T21: sine waves give each new quality; a 9th over C stays C."""

    def test_new_qualities_from_sines(self):
        cases = {
            'Bdim': [47, 59, 62, 65],  # B (bass doubled) D F
            'Caug': [36, 48, 52, 56],
            'Csus4': [36, 48, 53, 55],
            'Bm7b5': [47, 59, 62, 65, 69],
            'Bdim7': [47, 59, 62, 65, 68],
        }
        for name, notes in cases.items():
            with self.subTest(name=name):
                self.assertEqual(analyze_notes(notes, v2()), [name] * 4)

    def test_ninth_over_c_stays_c(self):
        for notes in ([36, 48, 52, 55, 62], [36, 48, 50, 52, 55]):
            with self.subTest(notes=notes):
                self.assertEqual(analyze_notes(notes, v2()), ['C'] * 4)

    def test_plain_triads_unchanged_by_v2(self):
        for notes in ([36, 48, 52, 55], [45, 57, 60, 64], [43, 55, 59, 62]):
            self.assertEqual(analyze_notes(notes, v2()), analyze_notes(notes, Config()))


if __name__ == '__main__':
    unittest.main()
