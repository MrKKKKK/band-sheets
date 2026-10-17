import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import parity_report as P  # noqa: E402


def res(times, chords=()):
    return {'beats': [{'t': t, 'downbeat': i % 4 == 0} for i, t in enumerate(times)],
            'chords': [{'start': a, 'end': b, 'text': x, 'confidence': c} for a, b, x, c in chords]}


class ParityReportTest(unittest.TestCase):
    def test_tempo_and_beats(self):
        a = res([i * 0.5 for i in range(16)])
        self.assertFalse(P.tempo_differs(a, res([i * 0.5 + 0.002 for i in range(16)])))
        self.assertTrue(P.tempo_differs(a, res([i * 0.52 for i in range(16)])))
        m, phase = P.beat_match(a, res([i * 0.5 + 0.002 for i in range(16)]))
        self.assertEqual((m, phase), (1.0, True))
        self.assertFalse(P.beat_match(a, res([i * 0.5 + 0.5 for i in range(16)]))[1])

    def test_question_marks(self):
        a = res([], [(0, 1, 'C', 0.99), (1, 2, 'D?', 0.5)])
        qa, qb, agree, unexpl = P.question_stats(a, a)
        self.assertAlmostEqual(qa, 0.5)
        self.assertEqual((agree, unexpl), (1.0, 0.0))
        b = res([], [(0, 1, 'C', 0.99), (1, 2, 'D?', 0.5)])
        b['chords'][0].update(text='C?', confidence=0.92)
        a['chords'][0].update(confidence=0.94)
        _, _, agree, unexpl = P.question_stats(a, b)
        self.assertAlmostEqual(agree, 0.5, places=2)
        self.assertEqual(unexpl, 0.0)  # both confidences within 0.93 +- .02

    def test_exceeded(self):
        row = {'m': {k: (0.5, 0.5) for k, *_ in P.METRICS}, 'phase': True, 'beat5': 1.0, 'q': (0, 0, 1.0, 0.0)}
        self.assertEqual(P.exceeded(row), [])
        row['m']['beat_f'] = (1.0, 0.98)
        self.assertEqual(P.exceeded(row), ['beat F'])


if __name__ == '__main__':
    unittest.main()
