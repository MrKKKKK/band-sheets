"""Spike 2 T26: theory transition prior (py/dsp/harmony.py) and its table py/dsp/tables/harmony.toml."""

import unittest
from dataclasses import replace

import numpy as np

from py.dsp import harmony as H
from py.dsp import vocab
from py.dsp.chords import ChordSegment, estimate_chords
from py.dsp.config import Config, apply_overrides, spike1_config
from py.dsp.types import BarKey

C, Db, D, Eb, E, F, Gb, G, Ab, A, Bb, B = range(12)


def cfg(**chords):
    return apply_overrides(spike1_config(), {'chords': chords})


PRIOR = cfg(theory_prior=1.0)
C_MAJ = BarKey(0, C, 'major', 1.0)
A_MIN = BarKey(0, A, 'minor', 1.0)


def tier(a, b, key=C_MAJ):
    return H._tier(a, b, key)


def chroma_of(*cols):
    """(12, n) chroma; each column a dict {pitch class: amplitude}."""
    out = np.zeros((12, len(cols)))
    for t, c in enumerate(cols):
        for pc, v in c.items():
            out[pc, t] = v
    return out


def keys(n_bars, key=C_MAJ):
    return [BarKey(b, key.tonic, key.mode, key.confidence) for b in range(n_bars)]


class TableTest(unittest.TestCase):
    def test_header_cites_note_and_leaves_books_empty(self):
        with open(H.TABLE_PATH, encoding='utf-8') as f:
            head = f.read().split('\n[', 1)[0]
        self.assertIn('# source:', head)
        self.assertIn('和声法ノート', head)
        self.assertIn('§6.4', head)
        books = [ln for ln in head.splitlines() if ln.startswith('# books:')]
        self.assertEqual(len(books), 1)
        self.assertIn('to be filled in', books[0])  # user has not confirmed the books yet
        self.assertIn('# weights:', head)

    def test_every_rule_cites_a_section(self):
        t = H.load_table()
        n = 0
        for name, g in t['generic'].items():
            self.assertIn(g['tier'], ('strong', 'medium', 'weak'), name)
            self.assertIn('§', g['src'], name)
            n += 1
        for mode in H.MODES:
            for tr in ('strong', 'medium', 'weak'):
                for rule in t[mode][tr]:
                    self.assertIn('§', rule['src'], rule)
                    self.assertTrue(rule['from'] and rule['to'], rule)
                    H.parse_chords(rule['from'], t['family'])  # raises on unknown names
                    H.parse_chords(rule['to'], t['family'])
                    n += 1
        self.assertGreater(n, 30)

    def test_tier_order_never_negative(self):
        tv = H.load_table()['tier']
        self.assertGreater(tv['strong'], tv['medium'])
        self.assertGreater(tv['medium'], tv['weak'])
        self.assertGreater(tv['weak'], 0.0)
        for mode in H.MODES:
            T = H.tier_matrix(mode)
            self.assertGreaterEqual(T.min(), 0.0)
            self.assertFalse(np.diag(T).any())


class TierTest(unittest.TestCase):
    """The note §6.2 classes in C major / A minor."""

    def test_major_classes(self):
        tv = H.load_table()['tier']
        s, m, w = tv['strong'], tv['medium'], tv['weak']
        cases = [
            ((G, '7'), (C, 'maj'), s),     # D -> T
            ((F, 'maj'), (G, 'maj'), s),   # S -> D
            ((A, 'min'), (D, 'min7'), s),  # vi -> ii (5th down)
            ((G, '7'), (A, 'min'), m),     # deceptive
            ((G, 'maj'), (E, 'min'), m),   # V -> iii (pending user check)
            ((F, 'maj'), (C, 'maj'), m),   # plagal
            ((A, '7'), (D, 'min'), m),     # V/ii
            ((E, '7'), (A, 'maj'), m),     # V/vi, target quality by root only
            ((E, 'min7'), (A, '7'), m),    # II-V into V/ii
            ((Db, '7'), (C, 'maj'), m),    # tritone substitute
            ((Db, 'dim7'), (D, 'min'), m), # passing diminished
            ((G, 'sus4'), (G, 'maj'), m),  # sus4 -> 3
            ((F, 'maj'), (F, 'min'), m),   # IV -> iv (borrowing)
            ((Bb, 'maj'), (C, 'maj'), m),  # bVII -> I
            ((G, 'maj'), (F, 'maj'), w),   # V -> IV (pending user check)
            ((C, 'maj'), (C, '7'), w),     # into V/IV
            ((C, 'maj'), (Bb, 'maj'), w),  # into a borrowed chord
            ((D, 'min7'), (Db, '7'), w),   # back-door II-V
            ((Ab, 'maj'), (C, 'maj'), w),  # bVI -> I
            ((C, 'maj'), (C, 'maj7'), 0.0),  # same root, quality only (R13)
            ((A, 'min'), (A, 'min7'), 0.0),
            ((C, 'maj'), (Ab, 'aug'), 0.0),  # aug stays base (pending user check)
            ((G, 'aug'), (C, 'maj'), 0.0),
            ((Gb, 'maj'), (B, 'maj'), 0.0),  # outside the key
        ]
        for a, b, want in cases:
            with self.subTest(a=a, b=b):
                self.assertAlmostEqual(tier(a, b), want)

    def test_minor_classes(self):
        tv = H.load_table()['tier']
        s, m, w = tv['strong'], tv['medium'], tv['weak']
        cases = [
            ((E, '7'), (A, 'min'), s),
            ((D, 'min'), (E, '7'), s),
            ((F, 'maj'), (E, 'maj'), s),     # bVI -> V
            ((G, 'maj'), (C, 'maj'), s),     # bVII -> bIII (5th down)
            ((E, '7'), (F, 'maj'), m),       # deceptive
            ((G, 'maj'), (A, 'min'), m),     # subtonic -> i
            ((D, 'maj'), (A, 'min'), m),     # IV -> i (IV borrowed, pending user check)
            ((E, '7'), (A, 'maj'), m),       # Picardy third
            ((Bb, '7'), (A, 'min'), m),      # tritone substitute of V
            ((C, 'aug'), (A, 'min'), 0.0),
        ]
        for a, b, want in cases:
            with self.subTest(a=a, b=b):
                self.assertAlmostEqual(tier(a, b, A_MIN), want)

    def test_same_table_in_every_key(self):
        d_maj = BarKey(0, D, 'major', 1.0)
        self.assertEqual(tier((A, '7'), (D, 'maj'), d_maj), tier((G, '7'), (C, 'maj')))
        self.assertEqual(tier((B, '7'), (E, 'min'), d_maj), tier((A, '7'), (D, 'min')))

    def test_power_chord_takes_the_better_triad(self):
        for a, b in (((G, '7'), (A, '5')), ((C, '5'), (F, 'maj')), ((E, '5'), (A, 'min'))):
            pa = [(a[0], q) for q in ('maj', 'min')] if a[1] == '5' else [a]
            pb = [(b[0], q) for q in ('maj', 'min')] if b[1] == '5' else [b]
            want = max(tier(x, y) for x in pa for y in pb)
            self.assertAlmostEqual(tier(a, b), want)


class TransitionTest(unittest.TestCase):
    def setUp(self):
        self.states = vocab.states(PRIOR)
        self.k = len(self.states)

    def test_off_or_no_keys_or_zero_confidence_is_zero(self):
        boc = np.array([0, 0, 1, 1])
        self.assertFalse(H.transition(self.states, keys(2), boc, cfg(theory_prior=0.0)).any())
        self.assertFalse(H.transition(self.states, [], boc, PRIOR).any())
        zero = keys(2, BarKey(0, C, 'major', 0.0))
        self.assertFalse(H.transition(self.states, zero, boc, PRIOR).any())

    def test_shape_column0_and_stay_untouched(self):
        p = H.transition(self.states, keys(2), np.array([0, 0, 1, 1]), PRIOR)
        self.assertEqual(p.shape, (4, self.k, self.k))
        self.assertFalse(p[0].any())
        for t in range(4):
            self.assertFalse(np.diag(p[t]).any())

    def test_row_normalization_keeps_change_probability(self):
        """Note §6.4: per previous state, sum over j != i of exp(prior) = k - 1 (uniform move row)."""
        p = H.transition(self.states, keys(1), np.array([0, 0]), cfg(theory_prior=2.0))[1]
        e = np.exp(p)
        np.fill_diagonal(e, 0.0)
        np.testing.assert_allclose(e.sum(axis=1), self.k - 1)
        self.assertTrue(np.isfinite(p).all())  # never a ban

    def test_strength_scales_with_prior_and_confidence(self):
        boc = np.array([0, 0])
        g7, c = self.states.index((G, '7')), self.states.index((C, 'maj'))
        raw = lambda s, conf: H.transition(self.states, keys(1, BarKey(0, C, 'major', conf)), boc,
                                           cfg(theory_prior=s))[1]
        # the favoured move gains more with a stronger prior or key
        self.assertGreater(raw(1.0, 1.0)[g7, c], raw(1.0, 0.5)[g7, c])
        self.assertGreater(raw(1.0, 0.5)[g7, c], 0.0)
        self.assertAlmostEqual(raw(1.0, 0.5)[g7, c], raw(0.5, 1.0)[g7, c])

    def test_key_change_takes_the_stronger_key(self):
        states = self.states
        boc = np.array([0, 1])
        bk = [BarKey(0, C, 'major', 1.0), BarKey(1, G, 'major', 0.5)]
        p = H.transition(states, bk, boc, PRIOR)[1]
        raw = np.maximum(1.0 * H._state_tiers(states, C, 'major'), 0.5 * H._state_tiers(states, G, 'major'))
        np.testing.assert_allclose(p, H.normalize_rows(raw))
        d7, g, c, g7 = (states.index(x) for x in ((D, '7'), (G, 'maj'), (C, 'maj'), (G, '7')))
        self.assertGreater(p[d7, g], 0.0)  # V -> I of the new key
        self.assertGreater(p[g7, c], 0.0)  # V -> I of the old key
        # inside the new key only the new key counts
        p2 = H.transition(states, bk, np.array([1, 1]), PRIOR)[1]
        np.testing.assert_allclose(p2, H.normalize_rows(0.5 * H._state_tiers(states, G, 'major')))

    def test_pickup_uses_first_bar(self):
        boc = np.array([-1, -1, 0, 0])
        p = H.transition(self.states, keys(1), boc, PRIOR)
        np.testing.assert_allclose(p[1], p[3])


class SecondPassTest(unittest.TestCase):
    """docs/audio-spike2-plan.md T26 end conditions on a hand-made chroma."""

    G_TRIAD = {G: 1, B: 1, D: 1}
    AMBIG = {C: 1, E: 1, A: 0.52, G: 0.5}  # between C and Am, Am slightly ahead by sound alone

    def _run(self, chroma, c, bar_keys):
        n = chroma.shape[1]
        boc = np.arange(n) // 4
        prior = H.transition(vocab.states(c), bar_keys, boc, c)
        return [(x.root, x.quality) for x in estimate_chords(chroma, c, prior=prior)]

    def test_ambiguous_column_after_g_becomes_c(self):
        chroma = chroma_of(*([self.G_TRIAD] * 4 + [self.AMBIG] * 4))
        c0 = cfg(use_seventh=False)
        first = [(x.root, x.quality) for x in estimate_chords(chroma, c0)]
        self.assertEqual(first[-1], (A, 'min'))  # sound alone: Am
        second = self._run(chroma, apply_overrides(c0, {'chords': {'theory_prior': 3.0}}), keys(2))
        self.assertEqual(second[:4], [(G, 'maj')] * 4)
        self.assertEqual(second[-1], (C, 'maj'))

    def test_clear_out_of_key_chord_is_kept(self):
        db7 = {Db: 1, F: 1, Ab: 1, B: 1}
        chroma = chroma_of(*([{C: 1, E: 1, G: 1}] * 4 + [db7] * 4 + [{C: 1, E: 1, G: 1}] * 4))
        c = cfg(use_seventh=True, theory_prior=3.0)
        out = self._run(chroma, c, keys(3))
        self.assertEqual(out[4:8], [(Db, '7')] * 4)

    def test_zero_prior_equals_first_pass(self):
        rng = np.random.default_rng(1)
        chroma = rng.random((12, 24))
        c = cfg(use_seventh=True)
        a = estimate_chords(chroma, c)
        prior = H.transition(vocab.states(c), keys(6), np.arange(24) // 4, c)  # theory_prior 0 -> zeros
        self.assertFalse(prior.any())
        self.assertEqual(a, estimate_chords(chroma, c, prior=prior))
        zero_conf = keys(6, BarKey(0, C, 'major', 0.0))
        prior = H.transition(vocab.states(PRIOR), zero_conf, np.arange(24) // 4, PRIOR)
        self.assertEqual(a, estimate_chords(chroma, apply_overrides(c, {'chords': {'theory_prior': 1.0}}), prior=prior))

    def test_does_not_split_a_held_chord(self):
        """Row normalization: a steady chord with weak evidence for its neighbours does not start changing."""
        chroma = chroma_of(*([{C: 1, E: 1, G: 1, F: 0.3, A: 0.3}] * 16))
        out = self._run(chroma, cfg(theory_prior=3.0), keys(4))
        self.assertEqual(set(out), {(C, 'maj')})


def seg(a, b, root, q):
    return ChordSegment(a, b, root, q, 0.8, False)


class ResolvePowerTest(unittest.TestCase):
    BOC = np.arange(16) // 4

    def test_power_gets_diatonic_quality_from_context(self):
        segs = [seg(0, 4, G, '7'), seg(4, 8, C, '5'), seg(8, 12, A, '5'), seg(12, 16, D, 'min')]
        out = H.resolve_power(segs, keys(4), self.BOC, PRIOR)
        self.assertEqual([(s.root, s.quality) for s in out], [(G, '7'), (C, 'maj'), (A, 'min'), (D, 'min')])

    def test_minor_key(self):
        segs = [seg(0, 4, D, 'min'), seg(4, 8, E, '5'), seg(8, 12, A, '5')]
        out = H.resolve_power(segs, keys(3, A_MIN), self.BOC[:12], PRIOR)
        self.assertEqual([s.quality for s in out], ['min', 'maj', 'min'])  # iv -> V -> i

    def test_kept_without_prior_key_or_context(self):
        segs = [seg(0, 4, C, '5'), seg(4, 8, F, 'maj')]
        boc = self.BOC[:8]
        self.assertEqual(H.resolve_power(segs, keys(2), boc, cfg()), segs)
        self.assertEqual(H.resolve_power(segs, [], boc, PRIOR), segs)
        self.assertEqual(H.resolve_power(segs, keys(2, BarKey(0, C, 'major', 0.0)), boc, PRIOR), segs)
        lone = [seg(0, 4, Gb, '5')]  # no neighbours, both triads outside C major -> unchanged
        self.assertEqual(H.resolve_power(lone, keys(1), boc[:4], PRIOR), lone)

    def test_equal_neighbours_merge(self):
        segs = [seg(0, 4, C, 'maj'), seg(4, 8, C, '5'), seg(8, 12, F, 'maj')]
        out = H.resolve_power(segs, keys(3), self.BOC[:12], PRIOR)
        self.assertEqual([(s.start_beat, s.end_beat, s.root, s.quality) for s in out],
                         [(0, 8, C, 'maj'), (8, 12, F, 'maj')])

    def test_eighth_columns_use_the_beat_bar(self):
        """per_beat 2 (T13): segment bounds are half-beat columns; the key is looked up at start_beat // 2."""
        boc = self.BOC  # 16 beats, 4 bars
        ks = keys(2) + [BarKey(2, C, 'major', 0.0), BarKey(3, C, 'major', 0.0)]  # no key confidence in bars 2-3
        segs = [replace(seg(0, 8, G, '7'), per_beat=2), replace(seg(8, 16, C, '5'), per_beat=2),
                replace(seg(16, 32, F, 'maj'), per_beat=2)]
        out = H.resolve_power(segs, ks, boc, PRIOR)  # column 8 = beat 4 = bar 1 (C major), not bar 2
        self.assertEqual([(s.root, s.quality) for s in out], [(G, '7'), (C, 'maj'), (F, 'maj')])
        self.assertEqual([s.per_beat for s in out], [2, 2, 2])


if __name__ == '__main__':
    unittest.main()
