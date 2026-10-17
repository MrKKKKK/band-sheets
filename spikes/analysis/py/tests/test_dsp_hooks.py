"""Spike 2 T0: the do-nothing hooks and the two-pass flow keep the spike 1 output.

fixtures/t0_default_result.json was written by the spike 1 analyzer (the code before T0) from
hooks_synth.synth(); `analyzer.timingsSec` removed. Regenerate it ONLY with the spike 1 analyzer. Since T14 the
defaults are tuned: the spike 1 output is reached with spike1_config(); fixtures/t14_default_result.json pins the
T14 default output (same synth).
"""

import json
import math
import os
import tempfile
import unittest
from unittest import mock

import numpy as np
import soundfile as sf

import py.analyze as A
from py.dsp import bassroot, harmonics, harmony, keytrack, posterior, seventh, tempo, vocab, voicing
from py.dsp.chords import _viterbi, _viterbi_full, chord_name, estimate_chords, merge_chords
from py.dsp.config import Config, apply_overrides, config_summary, spike1_config
from py.dsp.result import key_runs
from py.dsp.types import BarKey, BeatChord, BeatGrid, Features
from py.tests.hooks_synth import BI, PROG, SR, TRIADS, _tone, synth

GOLDEN = os.path.join(os.path.dirname(__file__), 'fixtures', 't0_default_result.json')  # spike 1 (= spike1_config())
GOLDEN_T14 = os.path.join(os.path.dirname(__file__), 'fixtures', 't14_default_result.json')  # T14 defaults

# Every spike 2 switch on (one at a time and all together). With the T0 stubs none changes the result.  (T9: 'confidence' left out, it is real now)
SWITCHES = [
    {'beats': {'tempo_octave': 'rule'}},
    {'beats': {'tempo_hint': 120.0}},
    {'chroma': {'top_voice_discount': 0.5}},
    {'chords': {'harmonics': 'fixed'}},
    {'chords': {'harmonics': 'profile'}},
    {'chords': {'bass_root': 'lowest', 'bass_root_weight': 0.3}},
    {'chords': {'slash': True}},
    {'chords': {'seventh_mode': 'segment'}},
    {'chords': {'vocab': 'v2'}},
    {'chords': {'theory_prior': 1.0}},
    {'chords': {'power': True}},  # T27: every chord of the synth sounds its 3rd -> no '5'
    {'sections': {'percussive_weight': 0.5}},
    {'key': {'track': 'sections', 'change_cost_mid': 2.0, 'change_cost_boundary': 0.5}},
]
# T13 'eighth' is real now (chord columns per half beat): its own tests below (EighthAnalyzeTest).
EIGHTH = {'chords': {'resolution': 'eighth'}}
ALL_ON: dict = {}
for sw in SWITCHES:
    for group, vals in sw.items():
        ALL_ON.setdefault(group, {}).update(vals)


def _strip(r: dict) -> dict:
    """Result without the parts a switch is allowed to change (config record, timings, keys)."""
    r = json.loads(json.dumps(r))
    r.pop('keys', None)
    r['analyzer'] = {'name': r['analyzer']['name']}
    return r


def _close(a, b, path='$'):
    """Exact for everything but floats; floats equal up to 1e-9 relative (CI runs outside the
    Docker image, so the last bits of BLAS results may differ). Returns a mismatch path or None."""
    if isinstance(a, float) or isinstance(b, float):
        ok = isinstance(a, (int, float)) and isinstance(b, (int, float)) and math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12)
        return None if ok else f'{path}: {a!r} != {b!r}'
    if type(a) is not type(b):
        return f'{path}: type {type(a).__name__} != {type(b).__name__}'
    if isinstance(a, dict):
        if set(a) != set(b):
            return f'{path}: keys {sorted(set(a) ^ set(b))}'
        for k in a:
            m = _close(a[k], b[k], f'{path}.{k}')
            if m:
                return m
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f'{path}: len {len(a)} != {len(b)}'
        for i, (x, y) in enumerate(zip(a, b)):
            m = _close(x, y, f'{path}[{i}]')
            if m:
                return m
        return None
    return None if a == b else f'{path}: {a!r} != {b!r}'


class AnalyzeHooksTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.wav = os.path.join(cls.tmp.name, 'a.wav')
        sf.write(cls.wav, synth(), SR)
        cls.feat = A.load_features(cls.wav, spike1_config())  # same audio config in every run below
        cls.default = cls._analyze(spike1_config())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @classmethod
    def _analyze(cls, cfg):
        with mock.patch.object(A, 'load_features', return_value=cls.feat):
            r = A.analyze(cls.wav, cfg)
        r['analyzer'].pop('timingsSec')
        return r

    def test_spike1_config_matches_spike1_golden(self):
        # T14 changed the defaults; the spike 1 analyzer stays reachable by spike1_config() (configs/spike1.json).
        # analyzer.config records the values that differ from the CURRENT defaults, so it is no longer empty.
        with open(GOLDEN, encoding='utf-8') as f:
            golden = json.load(f)
        mine = json.loads(json.dumps(self.default))
        self.assertEqual(golden['analyzer'].pop('config'), {})
        self.assertEqual(mine['analyzer'].pop('config'), config_summary(spike1_config()))
        self.assertIsNone(_close(golden, mine))
        self.assertEqual(self.default['analyzer']['configHash'], golden['analyzer']['configHash'])
        self.assertNotIn('keys', self.default)

    def test_t14_default_matches_t14_golden(self):
        # T14 tuned defaults: a deliberate output change, pinned by its own fixture (regenerate only on purpose,
        # with the tuned defaults: py/tests/fixtures/t14_default_result.json, analyzer.timingsSec removed)
        with open(GOLDEN_T14, encoding='utf-8') as f:
            golden = json.load(f)
        mine = self._analyze(Config())
        self.assertIsNone(_close(golden, mine))
        self.assertEqual(mine['analyzer']['configHash'], golden['analyzer']['configHash'])
        self.assertIn('keys', mine)

    def test_each_switch_with_stubs_keeps_result(self):
        base = _strip(self.default)
        for sw in SWITCHES + [ALL_ON]:
            with self.subTest(sw=sw):
                r = self._analyze(apply_overrides(spike1_config(), sw))
                self.assertEqual(_strip(r), base)  # same machine: exactly equal
                self.assertNotEqual(r['analyzer']['configHash'], self.default['analyzer']['configHash'])

    def test_candidates_only_add_a_field(self):
        r = self._analyze(apply_overrides(spike1_config(), {'chords': {'candidates': True}}))
        self.assertTrue(r['chords'])
        for c in r['chords']:
            cands = c.pop('candidates')
            self.assertEqual(len(cands), 3)
            self.assertEqual(cands[0]['name'], c['text'].rstrip('?'))  # clear synth: the chosen chord ranks first
            self.assertEqual([x['prob'] for x in cands], sorted((x['prob'] for x in cands), reverse=True))
        self.assertEqual(_strip(r), _strip(self.default))
        self.assertNotIn('candidates', self.default['chords'][0])

    def test_second_pass_runs_and_matches_first(self):
        for sw in ({'chords': {'theory_prior': 1.0}}, {'key': {'track': 'sections'}, 'chords': {'theory_prior': 0.5}}):
            with self.subTest(sw=sw):
                cfg = apply_overrides(spike1_config(), sw)
                with mock.patch.object(A, 'estimate_chords', wraps=A.estimate_chords) as est, \
                        mock.patch.object(A.harmony, 'transition', wraps=A.harmony.transition) as tr:
                    r = self._analyze(cfg)
                self.assertEqual(est.call_count, 2)
                self.assertEqual(tr.call_count, 1)
                self.assertIsNotNone(est.call_args_list[1].args[4])  # prior passed to the 2nd pass
                self.assertEqual(_strip(r), _strip(self.default))

    def test_global_key_feeds_prior_when_not_tracking(self):
        cfg = apply_overrides(spike1_config(), {'chords': {'theory_prior': 1.0}})
        with mock.patch.object(A.harmony, 'transition', wraps=A.harmony.transition) as tr:
            self._analyze(cfg)
        bar_keys = tr.call_args.args[1]
        self.assertTrue(bar_keys)
        self.assertEqual({(k.tonic, k.mode) for k in bar_keys}, {(0, 'major')})  # whole-song key C major
        self.assertEqual([k.bar for k in bar_keys], list(range(len(bar_keys))))

    def test_keytrack_only_with_sections(self):
        with mock.patch.object(A.keytrack, 'estimate', wraps=A.keytrack.estimate) as kt:
            self._analyze(spike1_config())
            self.assertEqual(kt.call_count, 0)
            r = self._analyze(apply_overrides(spike1_config(), {'key': {'track': 'sections'}}))
            self.assertEqual(kt.call_count, 1)
        chords, bar_of_col, section_bars, _ = kt.call_args.args
        self.assertEqual(len(chords), len(bar_of_col))
        self.assertEqual(len(section_bars), len(r['sections']))
        self.assertEqual(section_bars[0], 0)
        self.assertEqual([k['startBar'] for k in r['keys']][:1], [0])  # T22: per-bar keys from bar 0

    def test_keys_in_result_from_tracker(self):
        fake = [BarKey(0, 0, 'major', 0.8), BarKey(1, 0, 'major', 0.6), BarKey(2, 7, 'major', 0.5)]
        cfg = apply_overrides(spike1_config(), {'key': {'track': 'sections'}})
        with mock.patch.object(A.keytrack, 'estimate', return_value=fake):
            r = self._analyze(cfg)
        self.assertEqual(r['keys'], [
            {'startBar': 0, 'tonic': 'C', 'mode': 'major', 'confidence': 0.7},
            {'startBar': 2, 'tonic': 'G', 'mode': 'major', 'confidence': 0.5},
        ])

    def test_unknown_values_raise(self):
        for sw in ({'key': {'track': 'bars'}}, {'chords': {'vocab': 'v3'}}, {'beats': {'tempo_octave': 'x'}},
                   {'chords': {'harmonics': 'all'}}, {'beats': {'tempo_hint': -1.0}}):
            with self.subTest(sw=sw), self.assertRaises(ValueError):
                self._analyze(apply_overrides(spike1_config(), sw))


def synth_anticipated() -> np.ndarray:
    """hooks_synth with every chord change pushed half a beat early (on the 'and' of beat 4), bass too;
    clicks stay on the beats. Bar 0 starts on the beat."""
    y = np.zeros(int(len(PROG) * 4 * BI * SR) + SR)
    kn = int(0.03 * SR)
    kt = np.arange(kn) / SR
    click = np.sin(2 * np.pi * 1500 * kt) * np.exp(-kt * 150)
    starts = [0.0] + [bar * 4 * BI - BI / 2 for bar in range(1, len(PROG))] + [len(PROG) * 4 * BI]
    for bar, (pc, q) in enumerate(PROG):
        t0, t1 = starts[bar], starts[bar + 1]
        for k in range(4):
            s = int((bar * 4 * BI + k * BI) * SR)
            y[s:s + kn] += click * (1.0 if k == 0 else 0.5)
        bass_on = [t0] + [bar * 4 * BI + k * BI for k in range(1, 4)]
        bass_on.append(t1)
        for a, b in zip(bass_on[:-1], bass_on[1:]):
            n = _tone(36 + pc, b - a, 0.15)
            y[int(a * SR):int(a * SR) + len(n)] += n
        for iv in TRIADS[q]:
            c = _tone(55 + (pc + iv - 7) % 12, t1 - t0, 0.4)
            y[int(t0 * SR):int(t0 * SR) + len(c)] += c
    return (y / np.abs(y).max() * 0.8).astype(np.float32)


class EighthAnalyzeTest(unittest.TestCase):
    """chords.resolution 'eighth' through analyze (T13): chord times move to the half beat, the beat grid,
    downbeats and sections do not."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.wav = os.path.join(cls.tmp.name, 'push.wav')
        sf.write(cls.wav, synth_anticipated(), SR)
        cls.feat = A.load_features(cls.wav, spike1_config())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _analyze(self, sw):
        with mock.patch.object(A, 'load_features', return_value=self.feat):
            return A.analyze(self.wav, apply_overrides(spike1_config(), sw))

    def _changes(self, r):
        return [(c['start'], c['text']) for c in r['chords']]

    def test_pushed_changes_land_on_the_off_beat(self):
        beat, eighth = self._analyze({}), self._analyze(EIGHTH)
        self.assertNotEqual(self._changes(eighth), self._changes(beat))
        self.assertEqual(beat['beats'], eighth['beats'])
        self.assertEqual(beat['timeSignature']['num'], eighth['timeSignature']['num'])
        self.assertEqual([s['start'] for s in beat['sections']], [s['start'] for s in eighth['sections']])
        texts = [t for _, t in self._changes(eighth)]
        self.assertEqual(texts, ['C', 'Am', 'F', 'G'] * 2)
        pushed = [bar * 4 * BI - BI / 2 for bar in range(1, len(PROG))]
        starts = [t for t, _ in self._changes(eighth)][1:]
        for want, got in zip(pushed, starts):
            self.assertAlmostEqual(got, want, delta=0.06)  # half-beat column start, not the beat
        beat_starts = [t for t, _ in self._changes(beat)][1:]
        self.assertTrue(all(min(abs(t - b * BI) for b in range(40)) < 0.03 for t in beat_starts))

    def test_with_every_switch_on(self):
        on = json.loads(json.dumps(ALL_ON))
        on['chords']['resolution'] = 'eighth'
        on['chords']['candidates'] = True
        r = self._analyze(on)
        self.assertEqual(r['beats'], self._analyze({})['beats'])
        self.assertTrue(r['chords'])
        for c in r['chords']:
            self.assertTrue(c['candidates'])
            self.assertLess(c['start'], c['end'])

    def test_second_pass_keeps_columns(self):
        sw = {'chords': {'resolution': 'eighth', 'theory_prior': 1.0}}
        with mock.patch.object(A, 'estimate_chords', wraps=A.estimate_chords) as est:
            r = self._analyze(sw)
        self.assertEqual(est.call_count, 2)
        self.assertEqual([c.kwargs.get('per_beat') for c in est.call_args_list], [2, 2])
        self.assertEqual([t for _, t in self._changes(r)], ['C', 'Am', 'F', 'G'] * 2)


class CliTest(unittest.TestCase):
    def test_tempo_flag_sets_hint(self):
        with mock.patch.object(A, 'analyze', return_value={}) as an, \
                mock.patch('builtins.print'), tempfile.TemporaryDirectory() as d:
            A.main(['x.wav', '--tempo', '96', '-o', os.path.join(d, 'o.json')])
            self.assertEqual(an.call_args.args[1].beats.tempo_hint, 96.0)
            A.main(['x.wav', '-o', os.path.join(d, 'o.json')])
            self.assertEqual(an.call_args.args[1].beats.tempo_hint, 0.0)


class StubShapesTest(unittest.TestCase):
    def setUp(self):
        z = np.zeros(8)
        self.feat = Features(SR, 512, 1.0, z, z, z, z)
        self.cfg = spike1_config()
        self.bounds = np.array([0, 2, 4, 6])

    def test_vocab_v1(self):
        st = vocab.states(self.cfg)
        self.assertEqual(len(st), 60)
        self.assertEqual(st[0], (0, 'maj'))
        self.assertEqual(len(vocab.states(apply_overrides(self.cfg, {'chords': {'use_seventh': False}}))), 24)
        self.assertEqual(vocab.intervals('min7'), (0, 3, 7, 10))
        self.assertEqual(vocab.suffix('min'), 'm')

    def test_templates_binary(self):
        t = harmonics.templates([(0, 'maj'), (9, 'min7')], self.feat, self.cfg)
        self.assertEqual(t.shape, (2, 12))
        np.testing.assert_allclose(np.linalg.norm(t, axis=1), 1.0)
        self.assertEqual(list(np.flatnonzero(t[0])), [0, 4, 7])
        self.assertEqual(list(np.flatnonzero(t[1])), [0, 4, 7, 9])

    def test_noop_stubs(self):
        grid = BeatGrid(np.array([0.0, 0.5]), 120.0, 'ellis')
        self.assertIs(tempo.choose_octave(self.feat, grid, self.cfg), grid)
        fc = np.ones((12, 5))
        self.assertIs(voicing.discount_top_voice(fc, self.feat, self.cfg), fc)
        ev = bassroot.root_evidence(self.feat, self.bounds, self.cfg)
        self.assertEqual(ev.shape, (12, 3))
        self.assertFalse(ev.any())
        self.assertEqual(bassroot.bass_notes(self.feat, self.bounds, self.cfg), [None] * 3)
        segs = []
        self.assertIs(seventh.decide_segments(segs, np.zeros((12, 3)), self.cfg), segs)
        self.assertEqual(keytrack.estimate([], np.zeros(0, int), [0], self.cfg), [])
        tr = harmony.transition(vocab.states(self.cfg), [], np.array([-1, 0, 0, 1]), self.cfg)
        self.assertEqual(tr.shape, (4, 60, 60))
        self.assertFalse(tr.any())


class ChordPlumbingTest(unittest.TestCase):
    def test_viterbi_full_zero_prior_equals_fast(self):
        rng = np.random.default_rng(0)
        for emis in (rng.random((60, 40)), np.round(rng.random((24, 30)) * 2) / 2):  # 2nd: many ties
            k, n = emis.shape
            for stay in (0.6, 0.9):
                np.testing.assert_array_equal(_viterbi_full(emis, stay, np.zeros((n, k, k))), _viterbi(emis, stay))

    def test_prior_moves_path(self):
        emis = np.array([[1.0, 1.0, 1.0, 1.0], [0.99, 0.99, 0.99, 0.99]])
        self.assertEqual(list(_viterbi(emis, 0.6)), [0, 0, 0, 0])
        prior = np.zeros((4, 2, 2))
        prior[2, 0, 1] = 10.0  # strong bonus for 0 -> 1 at column 2
        self.assertEqual(list(_viterbi(emis, 0.6, prior)), [0, 0, 1, 1])
        with self.assertRaises(ValueError):
            _viterbi_full(emis, 0.6, np.ones((3, 2, 2)))

    def test_slash_plumbing(self):
        chroma = np.zeros((12, 4))
        chroma[[0, 4, 7], :] = 1.0
        cfg = apply_overrides(spike1_config(), {'chords': {'slash': True}})
        with mock.patch.object(bassroot, 'bass_notes', return_value=[None, None, 4, 0]):
            got = estimate_chords(chroma, cfg)
        self.assertEqual([c.bass for c in got], [None, None, 4, None])  # bass == root -> None
        segs = merge_chords(got, cfg)
        self.assertEqual([(s.start_beat, s.end_beat, s.bass) for s in segs], [(0, 2, None), (2, 3, 4), (3, 4, None)])
        self.assertEqual(chord_name(0, 'maj', 4), 'C/E')
        self.assertEqual(chord_name(9, 'min', 9), 'Am')
        # without slash the bass never reaches the chords
        with mock.patch.object(bassroot, 'bass_notes', return_value=[4] * 4) as bn:
            got = estimate_chords(chroma, spike1_config())
        bn.assert_not_called()
        self.assertEqual({c.bass for c in got}, {None})
        self.assertEqual(len(merge_chords(got, spike1_config())), 1)

    def test_bass_root_evidence_added(self):
        chroma = np.zeros((12, 2))
        chroma[[0, 4, 7, 9], :] = 1.0  # C6 = Am7 tones: C vs Am close
        ev = np.zeros((12, 2))
        ev[9] = 1.0  # strong A in the bass
        cfg = apply_overrides(spike1_config(), {'chords': {'bass_root': 'lowest', 'bass_root_weight': 1.0, 'use_seventh': False}})
        with mock.patch.object(bassroot, 'root_evidence', return_value=ev):
            got = estimate_chords(chroma, cfg)
        self.assertEqual({(c.root, c.quality) for c in got}, {(9, 'min')})

    def test_posterior_confidence_used(self):
        chroma = np.zeros((12, 2))
        chroma[[0, 4, 7], :] = 1.0
        cfg = apply_overrides(spike1_config(), {'chords': {'confidence': 'posterior', 'use_seventh': False}})
        post = np.full((24, 2), 0.01)
        post[0] = 0.42
        with mock.patch.object(posterior, 'chord_posterior', return_value=post):
            got = estimate_chords(chroma, cfg)
        self.assertEqual([c.confidence for c in got], [0.42, 0.42])

    def test_key_runs(self):
        self.assertEqual(key_runs([]), [])
        runs = key_runs([BarKey(1, 9, 'minor', 0.2), BarKey(0, 9, 'minor', 0.4), BarKey(2, 0, 'major', 1.0)])
        self.assertEqual([(r['startBar'], r['tonic'], r['mode']) for r in runs], [(0, 'A', 'minor'), (2, 'C', 'major')])
        self.assertAlmostEqual(runs[0]['confidence'], 0.3)

    def test_beat_chord_bass_default(self):
        self.assertIsNone(BeatChord(0, 'maj', 1.0).bass)


if __name__ == '__main__':
    unittest.main()
