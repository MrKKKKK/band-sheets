import builtins
import os
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
import soundfile as sf

from py.analyze import analyze
from py.dsp.config import Config
from py.dsp.keyest import estimate_key

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import score as S  # noqa: E402

SR = 22050
BPM = 120
BI = 60.0 / BPM
PROG = [('C', 0, 'maj'), ('A', 9, 'min'), ('F', 5, 'maj'), ('G', 7, 'maj'), ('C', 0, 'maj'), ('A', 9, 'min')]
TRIADS = {'maj': (0, 4, 7), 'min': (0, 3, 7)}


def tone(midi, dur, amp):
    t = np.arange(int(dur * SR)) / SR
    f = 440.0 * 2 ** ((midi - 69) / 12)
    env = np.minimum(1.0, t * 100) * np.exp(-t * 0.3)
    return amp * env * (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t))


def synth():
    n_bars = len(PROG)
    y = np.zeros(int(n_bars * 4 * BI * SR) + SR)
    truth_chords = []
    kn = int(0.03 * SR)
    kt = np.arange(kn) / SR
    click = np.sin(2 * np.pi * 1500 * kt) * np.exp(-kt * 150)
    for bar, (name, pc, q) in enumerate(PROG):
        t0 = bar * 4 * BI
        truth_chords.append({'start': t0, 'end': t0 + 4 * BI, 'root': name, 'quality': q, 'bass': None})
        for k in range(4):
            s = int((t0 + k * BI) * SR)
            y[s:s + kn] += click * (1.0 if k == 0 else 0.5)
            bass = tone(36 + pc, BI, 0.15)
            y[s:s + len(bass)] += bass
        for iv in TRIADS[q]:
            c = tone(55 + (pc + iv - 7) % 12 + 0, 4 * BI, 0.4)
            s = int(t0 * SR)
            y[s:s + len(c)] += c
    truth_beats = [{'t': i * BI, 'downbeat': i % 4 == 0} for i in range(n_bars * 4)]
    truth = {'beats': truth_beats, 'chords': truth_chords, 'sections': []}
    return (y / np.abs(y).max() * 0.8).astype(np.float32), truth


class AnalyzeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        y, cls.truth = synth()
        cls.wav = os.path.join(cls.tmp.name, 'a.wav')
        sf.write(cls.wav, y, SR)
        cls.opened = []
        real_open = builtins.open

        def spy(file, *a, **k):
            cls.opened.append(str(file))
            return real_open(file, *a, **k)

        with mock.patch('builtins.open', spy), mock.patch('io.open', spy):
            cls.result = analyze(cls.wav, Config())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_shape(self):
        r = self.result
        self.assertEqual(r['format'], 'band-sheets-analysis')
        self.assertEqual(r['version'], 1)
        self.assertEqual(r['source']['kind'], 'recording')
        self.assertIs(r['source']['click'], False)
        self.assertGreater(r['source']['durationSec'], 10)
        self.assertEqual(set(r['analyzer']), {'name', 'version', 'methods', 'configHash', 'config', 'timingsSec'})
        self.assertTrue(r['analyzer']['methods'])
        self.assertTrue(all(isinstance(b['t'], float) and isinstance(b['downbeat'], bool) for b in r['beats']))
        self.assertEqual(r['timeSignature']['num'], 4)
        self.assertIn(r['key']['mode'], ('major', 'minor'))
        for c in r['chords']:
            self.assertEqual(set(c), {'start', 'end', 'root', 'quality', 'bass', 'text', 'confidence'})
            S.note_to_pc(c['root'])
            self.assertIn(c['quality'], S.KNOWN_QUALITIES)
            self.assertLess(c['start'], c['end'])
        for s in r['sections']:
            self.assertLess(s['start'], s['end'])
        import json
        json.dumps(r)

    def test_scores(self):
        sc = S.score(self.truth, self.result)
        self.assertGreater(sc['beats']['f'], 0.8)
        self.assertGreater(sc['downbeats']['f'], 0.6)
        self.assertGreater(sc['chords']['perBeat'], 0.7)

    def test_only_wav_opened(self):
        # Python-level open() calls (libraries may read their own data files; C readers are not seen):
        # nothing named truth, and nothing in the wav's directory except the wav itself.
        d = self.tmp.name
        mine = [p for p in self.opened if p.startswith(d) and p != self.wav]
        self.assertEqual(mine, [])
        self.assertFalse([p for p in self.opened if 'truth' in os.path.basename(p)], self.opened)

    def test_key_c_major_scale(self):
        pcp = np.zeros((12, 8))
        for i, pc in enumerate([0, 2, 4, 5, 7, 9, 11, 0]):
            pcp[pc, i] = 1.0
        tonic, mode, conf = estimate_key(pcp, Config())
        self.assertEqual((tonic, mode), ('C', 'major'))
        self.assertGreater(conf, 0.0)

    def test_key_a_minor_and_silence(self):
        pcp = np.zeros((12, 3))
        for pc, w in [(9, 3), (0, 2), (4, 2.5), (2, 1), (5, 1), (7, 1), (11, 0.5), (8, 0.8)]:
            pcp[pc, 0] = w
        self.assertEqual(estimate_key(pcp, Config())[:2], ('A', 'minor'))
        self.assertEqual(estimate_key(np.zeros((12, 4)), Config()), ('C', 'major', 0.0))


if __name__ == '__main__':
    unittest.main()
