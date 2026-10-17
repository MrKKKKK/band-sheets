import unittest
from dataclasses import replace

import numpy as np

from py.dsp.chords import beat_level, chord_name, chord_text, estimate_chords, merge_chords
from py.dsp.chroma import beat_chroma, chord_columns, column_times
from py.dsp.config import ChordsConfig, Config, spike1_config
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
    c = spike1_config()
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
            cfg = replace(spike1_config(), chroma=replace(spike1_config().chroma, kind=kind))
            ch, bass = beat_chroma(feat, grid, cfg)
            self.assertEqual(ch.shape, (12, len(grid.times)))
            self.assertEqual(bass.shape, (12, len(grid.times)))

    def test_leading_gap_and_late_first_beat(self):
        feat, grid = make([('C', 4)])
        grid = BeatGrid(times=grid.times + 0.7, tempo=120.0, method='test')
        ch, bass = beat_chroma(feat, grid, spike1_config())
        self.assertEqual(ch.shape[1], 4)

    def test_bass_chroma_is_root(self):
        feat, grid = make([('G7', 4)])
        _, bass = beat_chroma(feat, grid, spike1_config())
        self.assertEqual(int(np.argmax(bass[:, 1])), 7)

    def test_last_beat_ignores_decay_tail(self):
        # R8: the last beat's span ends one beat interval after it, not at the audio end
        feat, grid = make([('C', 4)], n_extra_tail=2.0)
        self.assertEqual(names(est(feat, grid, spike1_config())), ['C'] * 4)
        feat, grid = make([('C', 3), ('G', 2)], n_extra_tail=2.0)
        self.assertEqual(names(est(feat, grid, cfg_with(smoothing='none'))), ['C'] * 3 + ['G'] * 2)

    def test_mean_aggregate(self):
        feat, grid = make(SEQ)
        cfg = replace(spike1_config(), chroma=replace(spike1_config().chroma, aggregate='mean'))
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
        self.assertEqual(names(est(feat, grid, spike1_config())), ['C'] * 4 + ['F'] + ['C'] * 4)

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
        got = est(feat, grid, spike1_config())
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
        got = names(est(feat, grid, spike1_config()))
        self.assertEqual(got[:3], ['C'] * 3)
        self.assertEqual(got[4:], ['N'] * 2)

    def test_confidence_and_question_mark(self):
        feat, grid = make([('C', 4)])
        cfg = spike1_config()
        got = est(feat, grid, cfg)
        self.assertTrue(all(0.0 <= c.confidence <= 1.0 for c in got))
        self.assertTrue(all(c.confidence > cfg.chords.low_confidence for c in got))
        self.assertEqual(chord_text(got[0], cfg), 'C')
        self.assertEqual(chord_text(BeatChord(9, 'min', 0.01), cfg), 'Am?')
        self.assertEqual(chord_text(BeatChord(None, 'maj', 0.0), cfg), 'N')
        self.assertEqual(chord_name(7, '7'), 'G7')
        self.assertEqual(chord_name(2, 'min7'), 'Dm7')

    def test_empty(self):
        self.assertEqual(estimate_chords(np.zeros((12, 0)), spike1_config()), [])

    def test_bad_smoothing(self):
        with self.assertRaises(ValueError):
            estimate_chords(np.ones((12, 2)), cfg_with(smoothing='x'))


class MergeTest(unittest.TestCase):
    def bc(self, r, q='maj', conf=0.5):
        return BeatChord(r, q, conf)

    def test_merge_runs(self):
        seq = [self.bc(0)] * 4 + [self.bc(9, 'min')] * 2 + [self.bc(None)] * 2
        segs = merge_chords(seq, spike1_config())
        self.assertEqual([(s.start_beat, s.end_beat, s.root) for s in segs], [(0, 4, 0), (4, 6, 9), (6, 8, None)])

    def test_min_beats_absorbs_short_runs(self):
        seq = [self.bc(0)] * 4 + [self.bc(5)] + [self.bc(0)] * 3
        segs = merge_chords(seq, cfg_with(merge_min_beats=2))
        self.assertEqual([(s.start_beat, s.end_beat, s.root) for s in segs], [(0, 8, 0)])

    def test_low_confidence_flag(self):
        segs = merge_chords([self.bc(0, conf=0.01)] * 2, spike1_config())
        self.assertTrue(segs[0].low_confidence)


def make_halves(seq, tail=0.0):
    """seq: list of (name, half beats); beats every BEAT seconds (a change may sit on an "and")."""
    y = np.concatenate([tone(CHORDS[name], nh * BEAT / 2) for name, nh in seq] + [np.zeros(int(tail * SR))])
    y = y.astype(np.float32)
    n_beats = sum(nh for _, nh in seq) // 2
    feat = Features(sr=SR, hop=HOP, duration=len(y) / SR, y=y, y_harm=y, y_perc=np.zeros_like(y),
                    onset_env=np.zeros(1 + len(y) // HOP))
    return feat, BeatGrid(times=np.arange(n_beats) * BEAT, tempo=120.0, method='test')


EIGHTH = cfg_with(resolution='eighth')


def est8(feat, grid, cfg=EIGHTH, prior=None):
    _, _, _, cc, cb, pb = chord_columns(feat, grid, cfg)
    return estimate_chords(cc, cfg, feat, cb, prior, per_beat=pb), pb


class EighthTest(unittest.TestCase):
    """T13: half-beat chord columns (chords.resolution 'eighth')."""

    def test_columns_twice_the_beats_on_beat_bounds_shared(self):
        feat, grid = make(SEQ)
        ch, bass, bounds, cc, cb, pb = chord_columns(feat, grid, EIGHTH)
        self.assertEqual(pb, 2)
        self.assertEqual(cc.shape, (12, 2 * len(grid.times)))
        self.assertEqual(len(cb), 2 * len(grid.times) + 1)
        np.testing.assert_array_equal(cb[::2], bounds)
        self.assertTrue(np.all(np.diff(cb) > 0))
        b_ch, b_bass = beat_chroma(feat, grid, EIGHTH)  # beat columns unchanged by the switch
        np.testing.assert_array_equal(ch, b_ch)
        np.testing.assert_array_equal(bass, b_bass)

    def test_beat_resolution_returns_beat_columns(self):
        feat, grid = make(SEQ)
        ch, _, bounds, cc, cb, pb = chord_columns(feat, grid, spike1_config())
        self.assertEqual(pb, 1)
        self.assertIs(cc, ch)
        self.assertIs(cb, bounds)

    def test_unknown_resolution(self):
        feat, grid = make(SEQ)
        with self.assertRaises(ValueError):
            chord_columns(feat, grid, cfg_with(resolution='x'))

    def test_column_times(self):
        np.testing.assert_allclose(column_times([0.0, 0.5, 1.0], 10.0, 2), [0, .25, .5, .75, 1.0, 1.25])
        np.testing.assert_allclose(column_times([0.0, 0.5, 1.0], 10.0, 1), [0, .5, 1.0])

    def test_change_on_the_and_of_beat_two(self):
        # C for 1.5 beats... C on beats 1-2 and the first half of 2 -> F from the and-of-2 (anticipation)
        feat, grid = make_halves([('C', 3), ('F', 5), ('Am', 3), ('G', 5)])
        got, pb = est8(feat, grid)
        self.assertEqual(len(got), 16)
        n = names(got)
        change = [i for i in range(1, len(n)) if n[i] != n[i - 1]]
        self.assertEqual(len(change), 3, n)
        for c, want in zip(change, (3, 8, 11)):
            self.assertLessEqual(abs(c - want), 1, n)
        segs = merge_chords(got, EIGHTH, per_beat=pb)
        self.assertTrue(all(s.per_beat == 2 for s in segs))
        # beat-level view: the on-beat column of each beat
        self.assertEqual(names(beat_level(got, pb)), [n[i] for i in range(0, 16, 2)])

    def test_beat_only_song_same_as_beat(self):
        feat, grid = make(SEQ)
        beat = est(feat, grid, spike1_config())
        got, pb = est8(feat, grid)
        self.assertEqual(names(beat_level(got, pb)), names(beat))
        segs_b = merge_chords(beat, spike1_config())
        segs_e = merge_chords(got, EIGHTH, per_beat=pb)
        self.assertEqual([(s.start_beat * 2, s.end_beat * 2, s.root, s.quality) for s in segs_b],
                         [(s.start_beat, s.end_beat, s.root, s.quality) for s in segs_e])

    def test_switches_at_eighth(self):
        feat, grid = make_halves([('C', 3), ('F', 5), ('Am', 3), ('G', 5)])
        base = names(est8(feat, grid)[0])
        for kw in (dict(confidence='posterior'), dict(candidates=True), dict(vocab='v2'), dict(power=True),
                   dict(slash=True), dict(bass_root='lowest', bass_root_weight=0.3)):
            with self.subTest(kw=kw):
                cfg = cfg_with(resolution='eighth', **kw)
                got, _ = est8(feat, grid, cfg)
                self.assertEqual(len(got), 16)
                self.assertEqual([chord_name(c.root, c.quality) for c in got], base)
                self.assertTrue(all(0.0 <= c.confidence <= 1.0 for c in got))
                if kw.get('candidates'):
                    self.assertTrue(all(c.posterior is not None and len(c.posterior) == 60 for c in got))

    def test_beat_level_prior_is_repeated(self):
        feat, grid = make_halves([('C', 3), ('F', 5), ('Am', 3), ('G', 5)])
        k = 60
        zero = np.zeros((len(grid.times), k, k))
        self.assertEqual(names(est8(feat, grid, prior=zero)[0]), names(est8(feat, grid)[0]))
        bonus = np.zeros((len(grid.times), k, k))
        bonus[:, :, 0] = 50.0  # every move into C is hugely favoured
        self.assertEqual(set(names(est8(feat, grid, prior=bonus)[0])), {'C'})

    def test_result_times_at_half_beats(self):
        from py.dsp.chords import ChordSegment
        from py.dsp.result import build_result
        from py.dsp.types import Downbeats
        feat, grid = make_halves([('C', 3), ('F', 5)])  # 4 beats, 2 s audio
        db = Downbeats(phase=0, beats_per_bar=4, confidence=1.0, scores=[0, 0, 0, 0])
        segs = [ChordSegment(0, 3, 0, 'maj', 0.5, False, per_beat=2), ChordSegment(3, 8, 5, 'maj', 0.5, False, per_beat=2)]
        r = build_result(feat, grid, segs, db, [], None, EIGHTH)
        self.assertEqual([(c['text'], c['start'], c['end']) for c in r['chords']],
                         [('C', 0.0, 0.75), ('F', 0.75, feat.duration)])
        beat_segs = [ChordSegment(0, 2, 0, 'maj', 0.5, False), ChordSegment(2, 4, 5, 'maj', 0.5, False)]
        r = build_result(feat, grid, beat_segs, db, [], None, EIGHTH)  # per_beat 1: beat times as before
        self.assertEqual([(c['start'], c['end']) for c in r['chords']], [(0.0, 1.0), (1.0, feat.duration)])

    def test_segment_sevenths_keep_half_beat_columns(self):
        from py.dsp import seventh
        feat, grid = make_halves([('C', 3), ('G7', 5)])
        cfg = cfg_with(resolution='eighth', seventh_mode='segment')
        got, pb = est8(feat, grid, cfg)
        _, _, _, cc, _, _ = chord_columns(feat, grid, cfg)
        segs = seventh.decide_segments(merge_chords(got, cfg, per_beat=pb), cc, cfg)
        self.assertTrue(segs and all(s.per_beat == 2 for s in segs))
        self.assertEqual(segs[-1].end_beat, 8)

    def test_bad_per_beat(self):
        with self.assertRaises(ValueError):
            estimate_chords(np.ones((12, 3)), EIGHTH, per_beat=2)
        with self.assertRaises(ValueError):
            beat_level([BeatChord(0, 'maj', 1.0)] * 3, 2)


if __name__ == '__main__':
    unittest.main()
