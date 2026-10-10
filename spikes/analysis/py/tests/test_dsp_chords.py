import unittest
from dataclasses import replace

import numpy as np

from py.dsp.chords import chord_name, chord_text, estimate_chords, merge_chords
from py.dsp.chroma import beat_chroma
from py.dsp.config import ChordsConfig, Config
from py.dsp.types import BeatChord, BeatGrid, Features

SR = 22050
HOP = 512
BEAT = 0.5

C = {'root': 0, 'notes': [48, 52, 55]}


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tone(midis, dur, amp=0.3):
    t = np.arange(int(dur * SR)) / SR
    y = np.zeros_like(t)
    for m in midis:
        for k, a in ((1, 1.0), (2, 0.5), (3, 0.33)):
            y += a * np.sin(2 * np.pi * midi_hz(m) * k * t)
    env = np.minimum(1.0, np.minimum(t / 0.01, (dur - t) / 0.01))
    return amp * y / len(midis) * env


CHORDS = {
    'C': [36, 48, 52, 55],
    'Am': [45, 48, 52, 57],
    'F': [41, 48, 53, 57],
    'G7': [43, 50, 53, 59],
    'G': [43, 50, 55, 59],
    'Cmaj7': [36, 48, 52, 55, 59],
}


def make(seq, silent=False, n_extra_tail=0.0):
    """seq: list of (name, beats). Returns Features, BeatGrid."""
    parts = []
    times = []
    t = 0.0
    for name, nb in seq:
        for _ in range(nb):
            times.append(t)
            parts.append(np.zeros(int(BEAT * SR)) if silent else tone(CHORDS[name], BEAT))
            t += BEAT
    y = np.concatenate(parts + [np.zeros(int(n_extra_tail * SR))]).astype(np.float32)
    feat = Features(
        sr=SR, hop=HOP, duration=len(y) / SR, y=y, y_harm=y, y_perc=np.zeros_like(y),
        onset_env=np.zeros(1 + len(y) // HOP),
    )
    return feat, BeatGrid(times=np.array(times), tempo=120.0, method='test')


def cfg_with(**kw):
    c = Config()
    return replace(c, chords=replace(c.chords, **kw))


def est(feat, grid, cfg):
    chroma, _ = beat_chroma(feat, grid, cfg)
    return estimate_chords(chroma, cfg)


def names(chords):
    return [chord_name(c.root, c.quality) for c in chords]


SEQ = [('C', 4), ('Am', 4), ('F', 4), ('G7', 4)]


class ChromaTest(unittest.TestCase):
    def test_columns_equal_beats_and_shapes(self):
        feat, grid = make(SEQ)
        for kind in ('cqt', 'cens'):
            cfg = replace(Config(), chroma=replace(Config().chroma, kind=kind))
            ch, bass = beat_chroma(feat, grid, cfg)
            self.assertEqual(ch.shape, (12, len(grid.times)))
            self.assertEqual(bass.shape, (12, len(grid.times)))

    def test_leading_gap_and_late_first_beat(self):
        feat, grid = make([('C', 4)])
        grid = BeatGrid(times=grid.times + 0.7, tempo=120.0, method='test')
        ch, bass = beat_chroma(feat, grid, Config())
        self.assertEqual(ch.shape[1], 4)

    def test_bass_chroma_is_root(self):
        feat, grid = make([('G7', 4)])
        _, bass = beat_chroma(feat, grid, Config())
        self.assertEqual(int(np.argmax(bass[:, 1])), 7)

    def test_last_beat_ignores_decay_tail(self):
        # R8: the last beat's span ends one beat interval after it, not at the audio end
        feat, grid = make([('C', 4)], n_extra_tail=2.0)
        self.assertEqual(names(est(feat, grid, Config())), ['C'] * 4)
        feat, grid = make([('C', 3), ('G', 2)], n_extra_tail=2.0)
        self.assertEqual(names(est(feat, grid, cfg_with(smoothing='none'))), ['C'] * 3 + ['G'] * 2)

    def test_mean_aggregate(self):
        feat, grid = make(SEQ)
        cfg = replace(Config(), chroma=replace(Config().chroma, aggregate='mean'))
        ch, _ = beat_chroma(feat, grid, cfg)
        self.assertEqual(ch.shape[1], 16)


class ChordsTest(unittest.TestCase):
    def test_sequence_all_beats(self):
        feat, grid = make(SEQ)
        for sm in ('viterbi', 'median', 'none'):
            got = names(est(feat, grid, cfg_with(smoothing=sm)))
            self.assertEqual(got, ['C'] * 4 + ['Am'] * 4 + ['F'] * 4 + ['G7'] * 4, sm)

    def test_g7_as_triad_when_sevenths_off(self):
        feat, grid = make(SEQ)
        got = names(est(feat, grid, cfg_with(use_seventh=False)))
        self.assertEqual(got[12:], ['G'] * 4)

    def test_flicker_removed_by_smoothing_only(self):
        feat, grid = make([('C', 4), ('F', 1), ('C', 4)])
        self.assertIn('F', names(est(feat, grid, cfg_with(smoothing='none'))))
        # median always removes a clear 1-beat blip; Viterbi removes it only with a sticky
        # transition prior. The T12 default (self_transition 0.6) deliberately lets a *clear*
        # 1-beat change survive (real chord changes on a single beat), so pin 0.9 here.
        self.assertEqual(names(est(feat, grid, cfg_with(smoothing='median'))), ['C'] * 9)
        self.assertEqual(names(est(feat, grid, cfg_with(smoothing='viterbi', self_transition=0.9))), ['C'] * 9)

    def test_default_viterbi_keeps_clear_one_beat_change(self):
        # documents the T12 default (self_transition 0.6): a clear single-beat chord is kept
        feat, grid = make([('C', 4), ('F', 1), ('C', 4)])
        self.assertEqual(names(est(feat, grid, Config())), ['C'] * 4 + ['F'] + ['C'] * 4)

    def test_seventh_only_when_conditions_met(self):
        feat, grid = make([('C', 3), ('Cmaj7', 6)])
        # a pure triad scores ~0.9 (harmonic leakage), Cmaj7 ~0.91 on its own template,
        # so the default weight 0.95 / margin 0.05 is too strict here; use looser values.
        loose = dict(seventh_weight=1.0, seventh_margin=0.05)
        self.assertEqual(names(est(feat, grid, cfg_with(**loose))), ['C'] * 3 + ['Cmaj7'] * 6)
        # a plain triad is never promoted even with weight 1.0
        feat_c, grid_c = make([('C', 4)])
        self.assertEqual(names(est(feat_c, grid_c, cfg_with(**loose))), ['C'] * 4)
        # weight too low -> never a seventh
        got = names(est(feat, grid, cfg_with(seventh_weight=0.5, seventh_margin=0.05)))
        self.assertEqual(got, ['C'] * 9)
        # margin too large -> never a seventh
        got = names(est(feat, grid, cfg_with(seventh_weight=1.0, seventh_margin=0.5)))
        self.assertEqual(got, ['C'] * 9)

    def test_silence_is_no_chord(self):
        feat, grid = make([('C', 4)], silent=True)
        got = est(feat, grid, Config())
        self.assertEqual(len(got), 4)
        self.assertTrue(all(c.root is None for c in got))
        self.assertEqual(names(got), ['N'] * 4)

    def test_silence_between_chords(self):
        feat, grid = make([('C', 3)])
        tail = np.zeros(int(3 * BEAT * SR), dtype=np.float32)
        y = np.concatenate([feat.y, tail])
        feat = replace(feat, y=y, y_harm=y, y_perc=np.zeros_like(y), duration=len(y) / SR)
        grid = BeatGrid(times=np.arange(6) * BEAT, tempo=120.0, method='test')
        # the beat right after the chord still holds CQT smear (low-note filters are long)
        got = names(est(feat, grid, Config()))
        self.assertEqual(got[:3], ['C'] * 3)
        self.assertEqual(got[4:], ['N'] * 2)

    def test_confidence_and_question_mark(self):
        feat, grid = make([('C', 4)])
        cfg = Config()
        got = est(feat, grid, cfg)
        self.assertTrue(all(0.0 <= c.confidence <= 1.0 for c in got))
        self.assertTrue(all(c.confidence > cfg.chords.low_confidence for c in got))
        self.assertEqual(chord_text(got[0], cfg), 'C')
        self.assertEqual(chord_text(BeatChord(9, 'min', 0.01), cfg), 'Am?')
        self.assertEqual(chord_text(BeatChord(None, 'maj', 0.0), cfg), 'N')
        self.assertEqual(chord_name(7, '7'), 'G7')
        self.assertEqual(chord_name(2, 'min7'), 'Dm7')

    def test_empty(self):
        self.assertEqual(estimate_chords(np.zeros((12, 0)), Config()), [])

    def test_bad_smoothing(self):
        with self.assertRaises(ValueError):
            estimate_chords(np.ones((12, 2)), cfg_with(smoothing='x'))


class MergeTest(unittest.TestCase):
    def bc(self, r, q='maj', conf=0.5):
        return BeatChord(r, q, conf)

    def test_merge_runs(self):
        seq = [self.bc(0)] * 4 + [self.bc(9, 'min')] * 2 + [self.bc(None)] * 2
        segs = merge_chords(seq, Config())
        self.assertEqual([(s.start_beat, s.end_beat, s.root) for s in segs], [(0, 4, 0), (4, 6, 9), (6, 8, None)])

    def test_min_beats_absorbs_short_runs(self):
        seq = [self.bc(0)] * 4 + [self.bc(5)] + [self.bc(0)] * 3
        segs = merge_chords(seq, cfg_with(merge_min_beats=2))
        self.assertEqual([(s.start_beat, s.end_beat, s.root) for s in segs], [(0, 8, 0)])

    def test_low_confidence_flag(self):
        segs = merge_chords([self.bc(0, conf=0.01)] * 2, Config())
        self.assertTrue(segs[0].low_confidence)


if __name__ == '__main__':
    unittest.main()
