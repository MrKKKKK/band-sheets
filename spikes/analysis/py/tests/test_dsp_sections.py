import unittest
from dataclasses import replace

import numpy as np

from py.dsp.config import Config, SectionsConfig
from py.dsp.sections import (
    bar_features,
    find_sections,
    block_novelty,
    segment_bars,
)
from py.dsp.types import BeatGrid, Downbeats, Features, Section

# chord roots: C=0 ... B=11
C, D, E, F, G, A, B = 0, 2, 4, 5, 7, 9, 11


def triad(root: int, minor: bool = False) -> np.ndarray:
    v = np.zeros(12)
    for iv in (0, 3 if minor else 4, 7):
        v[(root + iv) % 12] = 1.0
    return v


def bass_of(root: int) -> np.ndarray:
    v = np.zeros(12)
    v[root % 12] = 1.0
    return v


# pop-like loops: A = C Am F G, B = D Bm E A (mostly different chords)
LOOP_A = [(C, False), (A, True), (F, False), (G, False)]
LOOP_B = [(D, False), (B, True), (E, False), (A, False)]


def song(prog, loud=None, noise=0.0, loud_noise=0.0, seed=0):
    """prog: list of (root, minor) per bar -> (bar_chroma, bar_bass, bar_loud)."""
    rng = np.random.default_rng(seed)
    n = len(prog)
    chroma = np.array([triad(r, m) for r, m in prog])
    bass = np.array([bass_of(r) for r, _ in prog])
    if noise:
        chroma = chroma + rng.uniform(0, noise, chroma.shape)
        bass = bass + rng.uniform(0, noise, bass.shape)
    lo = np.full(n, -20.0) if loud is None else np.asarray(loud, dtype=float)
    if loud_noise:
        lo = lo + rng.normal(0, loud_noise, n)
    return chroma, bass, lo


def bounds(secs):
    return [s.start_bar for s in secs[1:]]


def labels(secs):
    return [s.label for s in secs]


def check_cover(tc, secs, n, min_len):
    tc.assertEqual(secs[0].start_bar, 0)
    tc.assertEqual(secs[-1].end_bar, n)
    for a, b in zip(secs[:-1], secs[1:]):
        tc.assertEqual(a.end_bar, b.start_bar)
    for s in secs:
        tc.assertGreaterEqual(s.end_bar - s.start_bar, min_len, secs)


SC = SectionsConfig()


class SegmentTest(unittest.TestCase):
    def test_abab_clean(self):
        prog = (LOOP_A * 2 + LOOP_B * 2) * 2
        secs = segment_bars(*song(prog), SC)
        self.assertEqual(bounds(secs), [8, 16, 24])
        self.assertEqual(labels(secs), ['A', 'B', 'A', 'B'])
        check_cover(self, secs, 32, SC.min_section_bars)

    def test_abab_noisy_no_oversegmentation(self):
        prog = (LOOP_A * 2 + LOOP_B * 2) * 2
        for seed in range(10):
            with self.subTest(seed=seed, noise=0.2):
                secs = segment_bars(*song(prog, noise=0.2, loud_noise=1.0, seed=seed), SC)
                self.assertEqual(bounds(secs), [8, 16, 24])
                self.assertEqual(labels(secs), ['A', 'B', 'A', 'B'])
        for seed in range(10):
            # heavy noise: may miss a boundary, but never adds one off the truth
            with self.subTest(seed=seed, noise=0.4):
                secs = segment_bars(*song(prog, noise=0.4, loud_noise=1.0, seed=seed), SC)
                self.assertIn(16, bounds(secs))
                self.assertLessEqual(set(bounds(secs)), {8, 16, 24})

    def test_shared_chords_with_louder_b(self):
        # A = C Am F G, B = F G C Am (same chord set) but B is 6 dB louder
        b_loop = [(F, False), (G, False), (C, False), (A, True)]
        prog = (LOOP_A * 2 + b_loop * 2) * 2
        loud = [-20.0] * 8 + [-14.0] * 8 + [-20.0] * 8 + [-14.0] * 8
        secs = segment_bars(*song(prog, loud=loud, noise=0.2, seed=3), SC)
        self.assertEqual(bounds(secs), [8, 16, 24])
        self.assertEqual(labels(secs), ['A', 'B', 'A', 'B'])

    def test_etude_like_random_chords_repetition(self):
        # A1 B1 A2 B2 with 8 random chords each; A2 == A1, B2 == B1 (like the etude).
        # Chord sets say nothing here; the repeat of the 16-bar block must still be found.
        for es in range(6):
            with self.subTest(song_seed=es):
                rng = np.random.default_rng(es)
                a = [(int(r), bool(m)) for r, m in zip(rng.integers(0, 12, 8), rng.integers(0, 2, 8))]
                b = [(int(r), bool(m)) for r, m in zip(rng.integers(0, 12, 8), rng.integers(0, 2, 8))]
                secs = segment_bars(*song(a + b + a + b, noise=0.2, seed=1), SC)
                self.assertIn(16, bounds(secs))
                self.assertLessEqual(len(secs), 4)
                check_cover(self, secs, 32, SC.min_section_bars)
                lab = {s.start_bar: s.label for s in secs}
                self.assertEqual(lab[0], lab[16])

    def test_random_noise_no_too_short_sections(self):
        rng = np.random.default_rng(0)
        for seed in range(10):
            n = int(rng.integers(10, 60))
            r = np.random.default_rng(seed)
            chroma = r.uniform(0, 1, (n, 12))
            bass = r.uniform(0, 1, (n, 12))
            loud = r.normal(-20, 3, n)
            for min_len in (4, 6, 8):
                sc = replace(SC, min_section_bars=min_len)
                with self.subTest(seed=seed, min_len=min_len):
                    secs = segment_bars(chroma, bass, loud, sc)
                    check_cover(self, secs, n, min(min_len, n))

    def test_single_section_loop(self):
        for noise, seed in ((0.0, 0), (0.3, 1), (0.3, 2), (0.5, 3)):
            with self.subTest(noise=noise, seed=seed):
                secs = segment_bars(*song(LOOP_A * 8, noise=noise, loud_noise=1.0, seed=seed), SC)
                self.assertEqual(secs, [Section(0, 32, 'A')])

    def test_single_chord(self):
        secs = segment_bars(*song([(C, False)] * 24, noise=0.2), SC)
        self.assertEqual(secs, [Section(0, 24, 'A')])

    def test_short_and_empty(self):
        self.assertEqual(segment_bars(np.zeros((0, 12)), None, None, SC), [])
        for n in (1, 3, 7):
            with self.subTest(n=n):
                secs = segment_bars(*song((LOOP_A + LOOP_B)[:n]), SC)
                self.assertEqual(secs, [Section(0, n, 'A')])

    def test_loudness_only_change(self):
        loud = [-22.0] * 16 + [-16.0] * 16
        args = song(LOOP_A * 8, loud=loud, noise=0.2, loud_noise=0.5, seed=4)
        self.assertEqual(bounds(segment_bars(*args, SC)), [16])
        no_loud = replace(SC, loudness_weight=0.0)
        self.assertEqual(bounds(segment_bars(*args, no_loud)), [])

    def test_loudness_change_keeps_9_bar_intro(self):
        # like the user's recording: 9 + 8 bars, second part louder; 9 is not snapped to 8
        loud = [-22.0] * 9 + [-15.0] * 8
        secs = segment_bars(*song((LOOP_A * 5)[:17], loud=loud, noise=0.2, seed=5), SC)
        self.assertEqual(bounds(secs), [9])

    def test_snap_to_grid(self):
        # change at bar 7 with a weak, gradual edge -> snapped to 8 when allowed
        loud = [-22.0] * 7 + [-19.0] + [-16.0] * 16
        args = song(LOOP_A * 6, loud=loud, seed=6)
        self.assertEqual(bounds(segment_bars(*args, replace(SC, snap_min_ratio=0.0))), [8])
        self.assertEqual(bounds(segment_bars(*args, replace(SC, snap_bars=0))), [7])

    def test_lead_in_silence(self):
        prog = (LOOP_A * 2 + LOOP_B * 2) * 2
        chroma, bass, loud = song(prog, noise=0.2, seed=2)
        chroma = np.vstack([np.full((2, 12), 1e-4), chroma])
        bass = np.vstack([np.zeros((2, 12)), bass])
        loud = np.concatenate([[-80.0, -80.0], loud])
        secs = segment_bars(chroma, bass, loud, SC)
        self.assertEqual(bounds(secs), [10, 18, 26])
        self.assertEqual(labels(secs), ['A', 'B', 'A', 'B'])
        check_cover(self, secs, 34, 4)

    def test_aaba_labels(self):
        prog = LOOP_A * 2 + LOOP_A * 2 + LOOP_B * 2 + LOOP_A * 2
        secs = segment_bars(*song(prog, noise=0.2, seed=8), SC)
        # A A cannot be split by chords alone; the B and the return to A must be
        self.assertIn(16, bounds(secs))
        self.assertIn(24, bounds(secs))
        self.assertEqual(secs[-1].label, secs[0].label)
        self.assertNotEqual(next(s for s in secs if s.start_bar == 16).label, secs[0].label)

    def test_block_novelty_flat_for_constant(self):
        x = np.tile(triad(C), (20, 1))
        self.assertTrue(np.allclose(block_novelty(x, np.full(20, -20.0), 4, 1.0, 0.5), 0.0))


class BeatLevelTest(unittest.TestCase):
    def test_bar_features_phase_and_partial_bar(self):
        nb = 1 + 4 * 3 + 2  # pickup beat, 3 full bars, 2-beat tail
        chroma = np.zeros((12, nb))
        chroma[0, :] = np.arange(nb)
        loud = np.full(nb, -20.0)
        bc, bb, bl = bar_features(chroma, None, loud, phase=1, beats_per_bar=4)
        self.assertEqual(bc.shape, (4, 12))
        self.assertIsNone(bb)
        self.assertAlmostEqual(bc[0, 0], np.mean([1, 2, 3, 4]))
        self.assertAlmostEqual(bc[3, 0], np.mean([13, 14]))
        self.assertTrue(np.allclose(bl, -20.0))

    def _inputs(self, phase=1):
        sr, bpm = 4000, 120
        spb = 60 / bpm
        prog = (LOOP_A * 2 + LOOP_B * 2) * 2
        nb = phase + len(prog) * 4
        times = np.arange(nb) * spb
        chroma = np.zeros((12, nb))
        bass = np.zeros((12, nb))
        for i in range(nb):
            r, m = prog[max(0, i - phase) // 4]
            chroma[:, i] = triad(r, m)
            bass[:, i] = bass_of(r)
        dur = nb * spb
        rng = np.random.default_rng(0)
        y = 0.1 * rng.standard_normal(int(dur * sr))
        feat = Features(sr, 512, dur, y, y, y, np.zeros(10))
        grid = BeatGrid(times, bpm, 'test')
        db = Downbeats(phase, 4, 1.0, [1.0, 0, 0, 0])
        return chroma, grid, db, feat, bass

    def test_find_sections_end_to_end(self):
        chroma, grid, db, feat, bass = self._inputs()
        secs = find_sections(chroma, grid, db, feat, Config(), bass=bass)
        self.assertEqual(bounds(secs), [8, 16, 24])
        self.assertEqual(labels(secs), ['A', 'B', 'A', 'B'])
        self.assertEqual(secs[-1].end_bar, 32)

    def test_disabled(self):
        chroma, grid, db, feat, bass = self._inputs()
        cfg = Config(sections=replace(SC, enabled=False))
        self.assertEqual(find_sections(chroma, grid, db, feat, cfg), [])

    def test_without_feat_or_bass(self):
        chroma, grid, db, _, _ = self._inputs()
        secs = find_sections(chroma, grid, db, None, Config())
        self.assertEqual(bounds(secs), [8, 16, 24])


if __name__ == '__main__':
    unittest.main()
