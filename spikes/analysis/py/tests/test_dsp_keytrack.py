"""Spike 2 T22: per-bar key HMM (py/dsp/keytrack.py) and its table py/dsp/tables/key_fit.toml."""

import unittest

import numpy as np

from py.dsp import keytrack
from py.dsp.config import Config, apply_overrides
from py.dsp.types import BeatChord

C, Db, D, Eb, E, F, Gb, G, Ab, A, Bb, B = range(12)
QUALITIES = {'maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'm7b5', 'dim7', 'sus4'}
CFG = apply_overrides(Config(), {'key': {'track': 'sections'}})


def bars(*chords_per_bar, beats=4, pickup=0):
    """One chord (root, quality) per bar -> (per-beat BeatChord list, bar_of_col). `pickup` beats of
    no chord come first (negative bar indexes)."""
    cols = [BeatChord(None, 'maj', 0.0)] * pickup
    for r, q in chords_per_bar:
        cols += [BeatChord(r, q, 0.5)] * beats
    bar_of_col = (np.arange(len(cols)) - pickup) // beats
    return cols, bar_of_col


C_PHRASE = [(C, 'maj'), (F, 'maj'), (G, '7'), (C, 'maj')]
G_PHRASE = [(G, 'maj'), (D, '7'), (C, 'maj'), (G, 'maj')]  # opens with chords that tell G from C


def change_bars(keys):
    return [k.bar for prev, k in zip(keys, keys[1:]) if (prev.tonic, prev.mode) != (k.tonic, k.mode)]


class TableTest(unittest.TestCase):
    def test_table_loads_and_is_well_formed(self):
        t = keytrack.load_table()
        st = t['stage']
        self.assertGreater(st['tonic'], st['diatonic'])
        self.assertGreater(st['diatonic'], st['borrowed'])
        self.assertGreaterEqual(st['borrowed'], st['secondary'])
        self.assertGreater(st['secondary'], st['other'])
        self.assertGreaterEqual(st['other'], 0.0)  # never forbids
        ch = t['change']
        self.assertGreater(ch['mid'], ch['boundary'])
        self.assertGreater(ch['boundary'], 0.0)
        self.assertTrue(0.0 < ch['near_factor'] <= 1.0)
        for mode in ('major', 'minor'):
            for stage in ('tonic', 'diatonic', 'borrowed', 'secondary'):
                for item in t[mode][stage]:
                    deg, q = item.split()
                    self.assertIn(int(deg), range(12), item)
                    self.assertIn(q, QUALITIES, item)
            # the tonic chord is also diatonic
            self.assertLessEqual(set(t[mode]['tonic']), set(t[mode]['diatonic']))

    def test_table_header_cites_its_source(self):
        with open(keytrack.TABLE_PATH, encoding='utf-8') as f:
            head = f.read().split('\n[', 1)[0]
        self.assertIn('# source:', head)
        self.assertIn('和声法ノート', head)
        self.assertIn('# weights:', head)

    def test_fit_stages(self):
        t = keytrack.load_table()
        st = t['stage']
        fit = keytrack.fit_matrix(t)  # (24 keys, 12 roots, qualities)
        k_c, k_am = keytrack.key_index(C, 'major'), keytrack.key_index(A, 'minor')
        self.assertEqual(fit[k_c, C, keytrack.QUAL_INDEX['maj']], st['tonic'])
        self.assertEqual(fit[k_c, G, keytrack.QUAL_INDEX['7']], st['diatonic'])
        self.assertEqual(fit[k_c, F, keytrack.QUAL_INDEX['min']], st['borrowed'])  # iv
        self.assertEqual(fit[k_c, D, keytrack.QUAL_INDEX['7']], st['secondary'])  # V/V
        self.assertEqual(fit[k_c, C, keytrack.QUAL_INDEX['7']], st['secondary'])  # V/IV, not I
        self.assertEqual(fit[k_c, Db, keytrack.QUAL_INDEX['min']], st['other'])
        self.assertEqual(fit[k_c, Bb, keytrack.QUAL_INDEX['7']], st['borrowed'])  # bVII7: highest stage wins
        self.assertEqual(fit[k_am, A, keytrack.QUAL_INDEX['min']], st['tonic'])
        self.assertEqual(fit[k_am, E, keytrack.QUAL_INDEX['7']], st['dominant'])  # harmonic minor V
        # transposition invariance: G major fits D7 like C major fits G7
        self.assertEqual(fit[keytrack.key_index(G, 'major'), D, keytrack.QUAL_INDEX['7']], st['diatonic'])


class EstimateTest(unittest.TestCase):
    def test_minor_in_key_set_is_natural_plus_harmonic_dominant(self):
        # note v3 §2.3: natural minor + harmonic-minor V / vii°; melodic-minor / dorian chords are borrowed
        t = keytrack.load_table()
        st, fit, Q = t['stage'], keytrack.fit_matrix(t), keytrack.QUAL_INDEX
        k_am = keytrack.key_index(A, 'minor')
        for root, q in [(B, 'm7b5'), (C, 'maj7'), (D, 'min'), (E, 'min'), (F, 'maj'), (G, '7')]:
            self.assertEqual(fit[k_am, root, Q[q]], st['diatonic'], (root, q))
        for root, q in [(E, 'maj'), (E, '7'), (E, 'sus4'), (Ab, 'dim'), (Ab, 'dim7')]:
            self.assertGreaterEqual(fit[k_am, root, Q[q]], st['dominant'], (root, q))
        for root, q in [(D, 'maj'), (D, '7'), (B, 'min'), (B, 'min7'), (Gb, 'dim'), (Gb, 'm7b5'), (Ab, 'm7b5')]:
            self.assertEqual(fit[k_am, root, Q[q]], st['borrowed'], (root, q))
        self.assertLessEqual(set(t['minor']['dominant']), set(t['minor']['diatonic']))

    def test_harmonic_dominant_ties_the_relative_keys(self):
        # E / E7 is V in A minor and V/vi in C major: alone it never tells the two apart (note §5.0)
        t = keytrack.load_table()
        fit, neutral, Q = keytrack.fit_matrix(t), keytrack.neutral_matrix(t), keytrack.QUAL_INDEX
        k_c, k_am = keytrack.key_index(C, 'major'), keytrack.key_index(A, 'minor')
        for root, q in [(E, 'maj'), (E, '7'), (E, 'sus4'), (Ab, 'dim'), (Ab, 'dim7')]:
            self.assertEqual(fit[k_c, root, Q[q]], fit[k_am, root, Q[q]], (root, q))
            self.assertTrue(neutral[k_c, root, Q[q]] and neutral[k_am, root, Q[q]], (root, q))
        self.assertEqual(fit[keytrack.key_index(E, 'major'), E, Q['maj']], t['stage']['tonic'])  # still E major's I
        self.assertFalse(neutral[keytrack.key_index(E, 'major'), E, Q['maj']])
        chords, boc = bars((E, 'maj'), (A, 'min'), (C, 'maj'), (E, 'maj'))
        dia = keytrack._bar_diatonic(chords, boc, 4, fit, t['stage']['diatonic'], neutral)
        self.assertEqual(dia[:, k_c].tolist(), [False, True, True, False])  # an E-only bar is in neither key
        self.assertEqual(dia[:, k_am].tolist(), [False, True, True, False])
        self.assertTrue(dia[0, keytrack.key_index(A, 'major')])  # but it is V of A major

    def test_secondary_dominant_of_vi_keeps_the_major_key(self):
        # C major with V/vi -> vi (plain triads) and one V7 -> I: E -> Am alone does not make it A minor
        keys = keytrack.estimate(*bars(*[(C, 'maj'), (E, 'maj'), (A, 'min'), (F, 'maj')] * 3, (G, '7'), (C, 'maj')),
                                 [0], CFG)
        self.assertEqual({(k.tonic, k.mode) for k in keys}, {(C, 'major')})

    def test_empty(self):
        self.assertEqual(keytrack.estimate([], np.zeros(0, int), [0], CFG), [])

    def test_one_barkey_per_bar_pickup_ignored(self):
        chords, boc = bars(*C_PHRASE * 2, pickup=2)
        keys = keytrack.estimate(chords, boc, [0], CFG)
        self.assertEqual([k.bar for k in keys], list(range(8)))
        self.assertEqual({(k.tonic, k.mode) for k in keys}, {(C, 'major')})

    def test_modulation_at_section_boundary(self):
        chords, boc = bars(*C_PHRASE * 4, *G_PHRASE * 4)
        keys = keytrack.estimate(chords, boc, [0, 16], CFG)
        self.assertEqual((keys[0].tonic, keys[0].mode), (C, 'major'))
        self.assertEqual((keys[-1].tonic, keys[-1].mode), (G, 'major'))
        ch = change_bars(keys)
        self.assertEqual(len(ch), 1)
        self.assertLessEqual(abs(ch[0] - 16), 1)

    def test_boundary_off_by_four_bars_follows_the_chords(self):
        # T22 change costs (mid 0.75, boundary 0.25): the change follows the chords, not the boundary
        t22 = apply_overrides(CFG, {'key': {'change_cost_mid': 0.75, 'change_cost_boundary': 0.25}})
        chords, boc = bars(*C_PHRASE * 4, *G_PHRASE * 4)
        for sections in ([0, 20], [0, 12]):
            with self.subTest(sections=sections):
                ch = change_bars(keytrack.estimate(chords, boc, sections, t22))
                self.assertEqual(len(ch), 1)
                self.assertLessEqual(abs(ch[0] - 16), 1)

    def test_t14_costs_change_once_between_chords_and_boundary(self):
        # T14 table costs (mid 4.0, boundary 2.0, deliberately less jumpy): still exactly one change, and it
        # lands between the chord change (16) and the detected boundary when the boundary comes late
        chords, boc = bars(*C_PHRASE * 4, *G_PHRASE * 4)
        for sections, lo, hi in (([0, 20], 15, 20), ([0, 12], 15, 17), ([0, 16], 15, 17)):
            with self.subTest(sections=sections):
                ch = change_bars(keytrack.estimate(chords, boc, sections, CFG))
                self.assertEqual(len(ch), 1)
                self.assertTrue(lo <= ch[0] <= hi, ch)

    def test_one_borrowed_bar_keeps_the_key(self):
        phrase = C_PHRASE * 2 + [(C, 'maj'), (F, 'maj'), (F, 'min'), (C, 'maj')] + C_PHRASE
        for sections in ([0], [0, 10], [0, 11]):  # even a boundary right at the Fm bar
            with self.subTest(sections=sections):
                keys = keytrack.estimate(*bars(*phrase), sections, CFG)
                self.assertEqual({(k.tonic, k.mode) for k in keys}, {(C, 'major')})

    def test_secondary_dominant_keeps_the_key(self):
        phrase = C_PHRASE + [(C, 'maj'), (A, '7'), (D, 'min'), (G, '7')] + [(E, '7'), (A, 'min'), (D, '7'), (G, '7')] + C_PHRASE
        keys = keytrack.estimate(*bars(*phrase), [0], CFG)
        self.assertEqual({(k.tonic, k.mode) for k in keys}, {(C, 'major')})

    def test_confidence_high_when_clear_low_when_ambiguous(self):
        clear = keytrack.estimate(*bars(*C_PHRASE * 4), [0], CFG)
        self.assertGreater(min(k.confidence for k in clear), 0.7)
        ambiguous = keytrack.estimate(*bars(*[(D, 'min'), (E, 'min')] * 4), [0], CFG)  # C major or A minor
        self.assertLess(max(k.confidence for k in ambiguous), 0.6)
        silent = keytrack.estimate(*bars(*[(None, 'maj')] * 4), [0], CFG)
        self.assertLess(max(k.confidence for k in silent), 0.1)
        for k in clear + ambiguous + silent:
            self.assertTrue(0.0 <= k.confidence <= 1.0)

    def test_resolutions_found(self):
        chords, boc = bars((G, '7'), (C, 'maj'), (Db, '7'), (C, 'maj'), (B, 'dim'), (C, 'maj'), (Ab, 'dim7'), (A, 'min'),
                           (E, 'maj'), (A, 'min7'), (G, '7'), (E, '7'), (C, 'maj'), (F, 'maj'))
        ev = keytrack.resolutions(chords, boc)
        got = [(e.dom_bar, e.target_bar, e.tonic, e.mode, e.kind) for e in ev]
        self.assertEqual(got, [
            (0, 1, C, 'major', 'dominant7'),   # V7 -> I
            (2, 3, C, 'major', 'dominant7'),   # subV7 -> I
            (4, 5, C, 'major', 'dominant7'),   # vii° -> I
            (6, 7, A, 'minor', 'dominant7'),   # dim7 (G# B D F): A is a semitone above G#
            (8, 9, A, 'minor', 'triad'),       # plain V triad -> i
            (12, 13, F, 'major', 'triad'),     # C -> F counts as a plain V -> I in F
        ])  # G7 -> E7: target not stable; E7 -> C: not a resolution

    def test_tonicization_keeps_the_key(self):
        # A7 -> Dm, then straight back to C material: V/ii, not a modulation to D minor
        phrase = C_PHRASE + [(A, '7'), (D, 'min'), (G, '7'), (C, 'maj')] + C_PHRASE
        keys = keytrack.estimate(*bars(*phrase * 2), [0], CFG)
        self.assertEqual({(k.tonic, k.mode) for k in keys}, {(C, 'major')})

    def test_plain_i_iv_at_the_end_is_not_a_modulation(self):
        # C -> F looks like V -> I in F; at the end of the song with only C / F after it, the key stays C
        keys = keytrack.estimate(*bars(*C_PHRASE * 3, (C, 'maj'), (F, 'maj'), (F, 'maj'), (C, 'maj'), (C, 'maj')),
                                 [0, 12], CFG)
        self.assertEqual({(k.tonic, k.mode) for k in keys}, {(C, 'major')})

    def test_cadence_followed_by_new_key_modulates(self):
        d_phrase = [(A, '7'), (D, 'maj'), (G, 'maj'), (E, 'min'), (A, '7'), (D, 'maj'), (B, 'min'), (D, 'maj')]
        keys = keytrack.estimate(*bars(*C_PHRASE * 4, *d_phrase * 2), [0], CFG)  # no section boundary at all
        self.assertEqual((keys[0].tonic, keys[0].mode), (C, 'major'))
        self.assertEqual((keys[-1].tonic, keys[-1].mode), (D, 'major'))
        ch = change_bars(keys)
        self.assertEqual(len(ch), 1)
        self.assertLessEqual(abs(ch[0] - 16), 1)

    def test_relative_keys_decided_by_resolution(self):
        # the same C major / A minor chord set; only the cadences differ
        to_c = [(A, 'min'), (D, 'min'), (F, 'maj'), (G, '7'), (C, 'maj'), (A, 'min'), (F, 'maj'), (G, '7')]
        keys = keytrack.estimate(*bars(*to_c * 2, (C, 'maj')), [0], CFG)
        self.assertEqual({(k.tonic, k.mode) for k in keys}, {(C, 'major')})
        to_am = [(C, 'maj'), (F, 'maj'), (D, 'min'), (E, '7'), (A, 'min'), (F, 'maj'), (C, 'maj'), (D, 'min')]
        keys = keytrack.estimate(*bars(*to_am * 2, (E, '7'), (A, 'min')), [0], CFG)
        self.assertEqual({(k.tonic, k.mode) for k in keys}, {(A, 'minor')})

    def test_minor_key(self):
        phrase = [(A, 'min'), (D, 'min'), (E, '7'), (A, 'min')]
        keys = keytrack.estimate(*bars(*phrase * 4), [0], CFG)
        self.assertEqual({(k.tonic, k.mode) for k in keys}, {(A, 'minor')})

    def test_config_costs_override_the_table(self):
        chords, boc = bars(*C_PHRASE * 4, *G_PHRASE * 4)
        stiff = apply_overrides(CFG, {'key': {'change_cost_mid': 50.0, 'change_cost_boundary': 50.0}})
        self.assertEqual(change_bars(keytrack.estimate(chords, boc, [0, 16], stiff)), [])

    def test_kk_profile_comparison(self):
        chords, boc = bars(*C_PHRASE * 4, *G_PHRASE * 4)
        keys = keytrack.estimate(chords, boc, [0, 16], CFG, profile='kk')
        self.assertEqual((keys[0].tonic, keys[0].mode), (C, 'major'))
        self.assertEqual((keys[-1].tonic, keys[-1].mode), (G, 'major'))

    def test_eighth_resolution_same_keys(self):
        quarter = keytrack.estimate(*bars(*C_PHRASE * 4, *G_PHRASE * 4), [0, 16], CFG)
        eighth = keytrack.estimate(*bars(*C_PHRASE * 4, *G_PHRASE * 4, beats=8), [0, 16], CFG)
        self.assertEqual([(k.bar, k.tonic, k.mode) for k in quarter], [(k.bar, k.tonic, k.mode) for k in eighth])


if __name__ == '__main__':
    unittest.main()
