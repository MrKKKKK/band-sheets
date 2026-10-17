"""Spike 3 T1: py/tools/dump_stages.py (stage dump for the TS port's parity tests)."""
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

from py.analyze import analyze
from py.dsp.config import config_hash, load_config
from py.tests.hooks_synth import SR, synth

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from tools import dump_stages as D  # noqa: E402

DEFAULT_HASH = 'adec583eb3c6'
COMMIT = 'abc1234'


def strip_timings(result):
    result = json.loads(json.dumps(result))
    result['analyzer'].pop('timingsSec', None)
    return json.dumps(result, indent=2, ensure_ascii=False)


class DumpStagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = cls.tmp.name
        os.makedirs(os.path.join(cls.out, 'synth'))
        sf.write(os.path.join(cls.out, 'synth', 'dev.wav'), synth(), SR, subtype='FLOAT')
        cls.wav = os.path.join(cls.out, 'synth', 'dev.wav')
        entries = [
            {'name': 'dev', 'song': 'x', 'level': 0, 'heldOut': False, 'wav': 'synth/dev.wav'},
            {'name': 'ho', 'song': 'x', 'level': 0, 'heldOut': True, 'wav': 'synth/ho.wav'},
            {'name': 'ho-l1-noise', 'song': 'x', 'level': 1, 'heldOut': False, 'wav': 'synth/d.wav'},
            {'name': 'rec-01-a', 'song': 'rec', 'level': 'REC', 'heldOut': False, 'wav': 'rec/rec-01-a.wav'},
            {'name': 'sneaky', 'song': 'x', 'level': 0, 'heldOut': False, 'wav': 'recordings/x.wav'},
        ]
        with open(os.path.join(cls.out, 'manifest.json'), 'w') as f:
            json.dump({'variants': entries}, f)
        cls.parity = os.path.join(cls.out, 'parity')
        cls.meta = D.dump_variant('dev', cls.out, cls.parity, COMMIT)
        cls.dir = os.path.join(cls.parity, 'dev')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_result_json_identical_to_analyze(self):
        ref = analyze(self.wav, load_config(None))
        with open(os.path.join(self.dir, 'result.json'), encoding='utf-8') as f:
            got = json.load(f)
        self.assertEqual(strip_timings(got), strip_timings(ref))

    def test_config_hash_and_files(self):
        self.assertEqual(config_hash(load_config(None)), DEFAULT_HASH)
        self.assertEqual(self.meta['configHash'], DEFAULT_HASH)
        self.assertEqual(self.meta['commit'], COMMIT)
        with open(os.path.join(self.dir, 'config.json'), encoding='utf-8') as f:
            self.assertEqual(json.load(f)['name'], 'dsp-v1')
        with open(os.path.join(self.dir, 'meta.json'), encoding='utf-8') as f:
            self.assertEqual(json.load(f), self.meta)

    def test_stage_files_match_meta(self):
        need = {'y', 'y_harm', 'y_perc', 'stft_re', 'stft_im', 'onset_env', 'beat_times', 'beat_chroma', 'col_chroma',
                'chords1_root', 'chords1_posterior', 'chords2_root', 'downbeat_phase', 'segments', 'sections',
                'key_tonic', 'bar_keys', 'chord_prior', 'frame_chroma', 'frame_bass'}
        self.assertLessEqual(need, set(self.meta['stages']))
        for name, s in self.meta['stages'].items():
            self.assertEqual(s['dtype'], 'float32')
            size = os.path.getsize(os.path.join(self.dir, s['file']))
            self.assertEqual(size, 4 * int(np.prod(s['shape'], dtype=np.int64)), name)
        st = self.meta['stages']
        self.assertEqual(st['beat_chroma']['shape'][0], 12)
        self.assertEqual(st['stft_re']['shape'][0], 1025)
        self.assertEqual(st['stft_re']['shape'], st['stft_im']['shape'])
        self.assertEqual(st['downbeat_phase']['shape'], [])
        self.assertEqual(st['chords1_posterior']['shape'], [len(self.meta['states']), st['col_chroma']['shape'][1]])
        self.assertLess(self.meta['hpssRecomputeMaxAbsDiff'], 1e-6)

    def test_values_roundtrip(self):
        def read(name):
            s = self.meta['stages'][name]
            return np.fromfile(os.path.join(self.dir, s['file']), dtype='<f4').reshape(s['shape'])
        np.testing.assert_array_equal(read('y'), np.asarray(synth(), dtype=np.float32)[:len(read('y'))])
        with open(os.path.join(self.dir, 'result.json'), encoding='utf-8') as f:
            beats = json.load(f)['beats']
        self.assertEqual(len(read('beat_times')), len(beats))
        self.assertEqual(float(read('downbeat_beats_per_bar')), 4.0)

    def test_held_out_and_recordings_raise(self):
        with self.assertRaises(ValueError):
            D.dump_variant('ho', self.out, self.parity, COMMIT)
        with self.assertRaises(ValueError):  # named after a held-out take
            D.dump_variant('ho-l1-noise', self.out, self.parity, COMMIT)
        for name in ('rec-01-a', 'sneaky'):
            with self.assertRaises(D.NotTuningVariantError):
                D.dump_variant(name, self.out, self.parity, COMMIT)
        with self.assertRaises(KeyError):
            D.dump_variant('nope', self.out, self.parity, COMMIT)
        self.assertFalse(os.path.exists(os.path.join(self.parity, 'ho')))

    def test_commit_required(self):
        old = os.environ.pop('BAND_SHEETS_COMMIT', None)
        try:
            self.assertEqual(D.resolve_commit('abc1234-dirty'), 'abc1234-dirty')
            with self.assertRaises(ValueError):
                D.resolve_commit('not a sha')
        finally:
            if old is not None:
                os.environ['BAND_SHEETS_COMMIT'] = old


if __name__ == '__main__':
    unittest.main()
