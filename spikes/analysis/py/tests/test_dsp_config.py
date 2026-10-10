import json
import os
import tempfile
import unittest
from dataclasses import FrozenInstanceError

import numpy as np

from py.dsp.config import (
    Config,
    apply_overrides,
    config_hash,
    config_summary,
    config_to_dict,
    load_config,
)
from py.dsp.types import BeatChord, BeatGrid, Downbeats, Features, Section


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
