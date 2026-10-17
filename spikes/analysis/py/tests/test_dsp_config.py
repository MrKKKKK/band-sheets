import json
import os
import tempfile
import unittest
from dataclasses import FrozenInstanceError

import numpy as np

from py.dsp.config import (
    SPIKE1_OFF_VALUES,
    Config,
    apply_overrides,
    config_hash,
    config_summary,
    config_to_dict,
    load_config,
    spike1_config,
    spike1_overrides,
)
from py.dsp.types import BarKey, BeatChord, BeatGrid, Downbeats, Features, Section

SPIKE1_DEFAULT_HASH = '99f2c324b973'  # config_hash(Config()) before spike 2 = config_hash(spike1_config()) (results/ and baselines use it)
T14_DEFAULT_HASH = '1f15f9825119'  # config_hash(Config()) since T14 (tuned defaults)


class ConfigTest(unittest.TestCase):
    def test_defaults(self):
        c = Config()
        self.assertEqual(c.name, 'dsp-v1')
        self.assertEqual(c.audio.sr, 22050)
        self.assertEqual(c.beats.method, 'ellis')
        self.assertFalse(c.beats.trim)
        self.assertEqual(c.downbeat.beats_per_bar, 4)
        self.assertLess(c.chords.seventh_weight, 1.0)

    def test_frozen(self):
        with self.assertRaises(FrozenInstanceError):
            Config().name = 'x'  # type: ignore[misc]

    def test_partial_override_keeps_rest(self):
        c = apply_overrides(Config(), {'beats': {'method': 'plp'}, 'chords': {'self_transition': 1}})
        self.assertEqual(c.beats.method, 'plp')
        self.assertFalse(c.beats.trim)
        self.assertEqual(c.chords.self_transition, 1.0)
        self.assertIsInstance(c.chords.self_transition, float)
        self.assertEqual(Config().beats.method, 'ellis')  # original untouched

    def test_unknown_key_and_bad_type(self):
        with self.assertRaises(ValueError):
            apply_overrides(Config(), {'beats': {'metod': 'plp'}})
        with self.assertRaises(ValueError):
            apply_overrides(Config(), {'nope': 1})
        with self.assertRaises(ValueError):
            apply_overrides(Config(), {'audio': {'sr': 'high'}})
        with self.assertRaises(ValueError):
            apply_overrides(Config(), {'audio': {'hpss': 1}})
        with self.assertRaises(ValueError):
            apply_overrides(Config(), {'audio': {'sr': 22050.5}})
        with self.assertRaises(ValueError):
            apply_overrides(Config(), {'audio': 3})

    def test_hash(self):
        self.assertEqual(config_hash(Config()), config_hash(Config()))
        self.assertEqual(len(config_hash(Config())), 12)
        a = apply_overrides(Config(), {'beats': {'method': 'plp'}})
        self.assertNotEqual(config_hash(a), config_hash(Config()))
        b = apply_overrides(Config(), {'name': 'dsp-v1-x'})
        self.assertNotEqual(config_hash(b), config_hash(Config()))

    def test_summary(self):
        self.assertEqual(config_summary(Config()), {})
        c = apply_overrides(Config(), {'beats': {'method': 'plp'}})
        self.assertEqual(config_summary(c), {'beats': {'method': 'plp'}})

    def test_roundtrip_and_load(self):
        c = apply_overrides(Config(), {'sections': {'min_section_bars': 8}})
        self.assertEqual(apply_overrides(Config(), config_to_dict(c)), c)
        json.dumps(config_to_dict(c))
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'x.json')
            with open(p, 'w') as f:
                json.dump({'sections': {'min_section_bars': 8}}, f)
            self.assertEqual(load_config(p), c)
        self.assertEqual(load_config(None), Config())


class Spike2ConfigTest(unittest.TestCase):
    def test_t14_defaults(self):
        c = Config()
        self.assertEqual((c.beats.tempo_octave, c.beats.tempo_hint), ('rule', 0.0))
        self.assertEqual(c.chroma.top_voice_discount, 0.0)
        cc = c.chords
        self.assertEqual(
            (cc.resolution, cc.confidence, cc.low_confidence, cc.harmonics, cc.bass_root, cc.slash, cc.seventh_mode,
             cc.vocab, cc.vocab_margin, cc.vocab_sus4_margin, cc.theory_prior, cc.power, cc.candidates),
            ('eighth', 'posterior', 0.93, 'none', 'none', False, 'beat', 'v2', 0.05, 0.2, 1.0, False, True),
        )
        self.assertEqual(c.sections.percussive_weight, 0.5)
        self.assertEqual((c.key.track, c.key.change_cost_mid, c.key.change_cost_boundary), ('sections', 0.0, 0.0))
        self.assertEqual(config_hash(c), T14_DEFAULT_HASH)  # changes only deliberately (results record it)
        self.assertEqual(config_summary(c), {})

    def test_spike1_config_has_the_off_values(self):
        d = config_to_dict(spike1_config())
        for group, offs in SPIKE1_OFF_VALUES.items():
            for k, v in offs.items():
                self.assertEqual(d[group][k], v, f'{group}.{k}')
        self.assertEqual(d['chords']['low_confidence'], 0.1)

    def test_spike1_config_keeps_the_spike1_hash(self):
        self.assertEqual(config_hash(spike1_config()), SPIKE1_DEFAULT_HASH)
        self.assertNotEqual(config_hash(Config()), SPIKE1_DEFAULT_HASH)

    def test_spike1_json_matches(self):
        path = os.path.join(os.path.dirname(__file__), '..', 'configs', 'spike1.json')
        self.assertEqual(config_hash(load_config(path)), SPIKE1_DEFAULT_HASH)
        with open(path, encoding='utf-8') as f:
            self.assertEqual(json.load(f), spike1_overrides())

    def test_switch_changes_hash(self):
        base = spike1_config()
        seen = {config_hash(base)}
        for group, offs in SPIKE1_OFF_VALUES.items():
            for k, off in offs.items():
                if isinstance(off, bool):
                    on = not off
                elif isinstance(off, str):
                    on = 'x'
                else:
                    on = off + 1 if isinstance(off, int) else off + 0.25  # int: T27 candidates_k
                c = apply_overrides(base, {group: {k: on}})
                h = config_hash(c)
                self.assertNotIn(h, seen, f'{group}.{k}')
                seen.add(h)

    def test_bar_key(self):
        k = BarKey(3, 7, 'major', 0.5)
        self.assertEqual((k.bar, k.tonic, k.mode, k.confidence), (3, 7, 'major', 0.5))


class TypesTest(unittest.TestCase):
    def test_construct(self):
        z = np.zeros(4)
        f = Features(22050, 512, 1.0, z, z, z, z)
        g = BeatGrid(np.array([0.0, 0.5]), 120.0, 'ellis')
        BeatChord(None, 'maj', 0.0)
        Downbeats(0, 4, 0.5, [0.0] * 4)
        Section(0, 8, 'A')
        self.assertEqual(f.sr, 22050)
        self.assertEqual(g.method, 'ellis')


if __name__ == '__main__':
    unittest.main()
