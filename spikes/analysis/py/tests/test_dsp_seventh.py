import unittest
from unittest import mock
from dataclasses import replace

import numpy as np

from py.dsp import seventh
from py.dsp.chords import ChordSegment, chord_name, estimate_chords, merge_chords
from py.dsp.chroma import beat_chroma
from py.dsp.config import Config
from py.tests.test_dsp_chords import make


def cfg_seg(**kw):
    c = Config()
    return replace(c, chords=replace(c.chords, seventh_mode='segment', **kw))


def run(seq, cfg):
    feat, grid = make(seq)
    chroma, _ = beat_chroma(feat, grid, cfg)
    segs = merge_chords(estimate_chords(chroma, cfg), cfg)
    return segs, chroma, seventh.decide_segments(segs, chroma, cfg)


def named(segs):
    return [(chord_name(s.root, s.quality), s.start_beat, s.end_beat) for s in segs]



def cols(*columns):
    m = np.zeros((12, len(columns)))
    for i, col in enumerate(columns):
        for pc, a in col.items():
            m[pc, i] = a
    return m


def seg(a, b, root, quality, conf=0.5):
    return ChordSegment(a, b, root, quality, conf, conf < 0.1)


class SeventhSegmentTest(unittest.TestCase):
    def test_sine_g7_segment_is_seventh(self):
        _, _, out = run([('C', 4), ('G7', 4)], cfg_seg())
        self.assertEqual(named(out), [('C', 0, 4), ('G7', 4, 8)])

    def test_sine_plain_triads_stay_triads(self):
        _, _, out = run([('C', 4), ('Am', 4), ('F', 4), ('G', 4)], cfg_seg())
        self.assertEqual([n for n, _, _ in named(out)], ['C', 'Am', 'F', 'G'])

    def test_maj7(self):
        _, _, out = run([('Cmaj7', 4)], cfg_seg())
        self.assertEqual(named(out), [('Cmaj7', 0, 4)])

    def test_reverb_tail_beat_is_not_seventh(self):
        # C triad with the tail of a Bb (b7 of C) at 30 % of the triad: not a seventh
        ch = cols({0: 1.0, 4: 1.0, 7: 1.0, 10: 0.3})
        out = seventh.decide_segments([seg(0, 1, 0, 'maj')], ch, cfg_seg())
        self.assertEqual(named(out), [('C', 0, 1)])
        out = seventh.decide_segments([seg(0, 1, 0, '7')], ch, cfg_seg())  # beat-level 7th is withdrawn
        self.assertEqual(named(out), [('C', 0, 1)])

    def test_back_half_ignores_tail_in_front(self):
        tail = {0: 1.0, 4: 1.0, 7: 1.0, 10: 1.0}
        clean = {0: 1.0, 4: 1.0, 7: 1.0}
        ch = cols(tail, tail, clean, clean)
        with mock.patch.object(seventh, 'BACK_HALF', True):
            out = seventh.decide_segments([seg(0, 4, 0, '7')], ch, cfg_seg())
        self.assertEqual(named(out), [('C', 0, 4)])
        with mock.patch.object(seventh, 'BACK_HALF', False):  # whole segment: half the columns carry the 7th
            out = seventh.decide_segments([seg(0, 4, 0, 'maj')], ch, cfg_seg())
        self.assertEqual(named(out), [('C7', 0, 4)])

    def test_single_clean_beat_does_not_override_segment(self):
        full = {0: 1.0, 4: 1.0, 7: 1.0, 10: 1.0}
        clean = {0: 1.0, 4: 1.0, 7: 1.0}
        ch = cols(full, full, clean, full)  # one weak column inside a 4-beat segment: mean ratio 0.75
        out = seventh.decide_segments([seg(0, 4, 0, 'maj')], ch, cfg_seg())
        self.assertEqual(named(out), [('C7', 0, 4)])

    def test_minor_dim_and_half_dim(self):
        m = cols({0: 1.0, 3: 1.0, 7: 1.0, 10: 1.0})
        self.assertEqual(named(seventh.decide_segments([seg(0, 1, 0, 'min')], m, cfg_seg())), [('Cm7', 0, 1)])
        c2 = cfg_seg(vocab='v2')
        try:
            from py.dsp import vocab
            qs = {q for _, q in vocab.states(c2)}
        except Exception:  # pragma: no cover
            qs = set()
        if {'m7b5', 'dim7', 'dim'} <= qs:
            hd = cols({0: 1.0, 3: 1.0, 6: 1.0, 10: 1.0})
            d7 = cols({0: 1.0, 3: 1.0, 6: 1.0, 9: 1.0})
            self.assertEqual(seventh.decide_segments([seg(0, 1, 0, 'dim')], hd, c2)[0].quality, 'm7b5')
            self.assertEqual(seventh.decide_segments([seg(0, 1, 0, 'dim')], d7, c2)[0].quality, 'dim7')
            plain = cols({0: 1.0, 3: 1.0, 6: 1.0})
            self.assertEqual(seventh.decide_segments([seg(0, 1, 0, 'm7b5')], plain, c2)[0].quality, 'dim')

    def test_larger_seventh_wins_between_candidates(self):
        ch = cols({0: 1.0, 4: 1.0, 7: 1.0, 10: 0.6, 11: 0.9})
        self.assertEqual(seventh.decide_segments([seg(0, 1, 0, 'maj')], ch, cfg_seg())[0].quality, 'maj7')

    def test_remerge_and_confidence(self):
        full = {0: 1.0, 4: 1.0, 7: 1.0, 10: 1.0}
        ch = cols(full, full, full, full)
        segs = [seg(0, 1, 0, '7', 0.4), seg(1, 2, 0, 'maj', 0.2), seg(2, 4, 0, '7', 0.6)]
        out = seventh.decide_segments(segs, ch, cfg_seg())
        self.assertEqual(named(out), [('C7', 0, 4)])
        self.assertAlmostEqual(out[0].confidence, (0.4 + 0.2 + 1.2) / 4)

    def test_no_chord_empty_and_no_sevenths(self):
        ch = cols({0: 1.0})
        n = ChordSegment(0, 1, None, 'maj', 1.0, False)
        self.assertEqual(seventh.decide_segments([n], ch, cfg_seg()), [n])
        self.assertEqual(seventh.decide_segments([], ch, cfg_seg()), [])
        segs = [seg(0, 1, 0, 'maj')]
        self.assertIs(seventh.decide_segments(segs, ch, cfg_seg(use_seventh=False)), segs)


if __name__ == '__main__':
    unittest.main()
