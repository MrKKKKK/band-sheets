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

    def test_exceeded_includes_direct(self):
        row = {'m': {k: (0.5, 0.5) for k, *_ in P.METRICS}, 'phase': True, 'beat5': 1.0, 'q': (0, 0, 1.0, 0.0),
               'direct': P.compare_results({'a': 1}, {'a': 2})}
        self.assertTrue(P.exceeded(row)[0].startswith('direct: 1 differing fields, first .a'))


def full():
    return {'beats': [{'t': 0.5, 'downbeat': True}, {'t': 1.0, 'downbeat': False}],
            'chords': [{'start': 0.0, 'end': 1.0, 'text': 'C', 'confidence': 0.9,
                        'candidates': [{'root': 'C', 'quality': 'maj', 'prob': 0.9}]}],
            'keys': [{'startBar': 0, 'tonic': 'C', 'mode': 'major', 'confidence': 0.8}],
            'analyzer': {'name': 'x', 'timingsSec': {'total': 1.0}}}


class CompareResultsTest(unittest.TestCase):
    def test_identical_and_timings_ignored(self):
        a, b = full(), full()
        b['analyzer']['timingsSec'] = {'total': 99.0, 'extra': 1}
        r = P.compare_results(a, b)
        self.assertEqual(r['diffs'], [])

    def test_tolerances(self):
        a, b = full(), full()
        b['beats'][0]['t'] += 5e-7          # within 1e-6
        b['chords'][0]['confidence'] += 5e-5  # within 1e-4
        b['chords'][0]['candidates'][0]['prob'] -= 5e-5
        self.assertEqual(P.compare_results(a, b)['diffs'], [])
        b['beats'][1]['t'] += 2e-6
        d = P.compare_results(a, b)['diffs']
        self.assertEqual([(x[0], x[1]) for x in d], [('.beats[1].t', 'time')])

    def test_float_over_tolerance_and_first_path(self):
        a, b = full(), full()
        b['keys'][0]['confidence'] += 1e-3
        b['chords'][0]['confidence'] += 1e-3
        d = P.compare_results(a, b)['diffs']
        self.assertEqual([x[0] for x in d], ['.chords[0].confidence', '.keys[0].confidence'])
        self.assertEqual(d[0][1], 'float')

    def test_exact_fields(self):
        a, b = full(), full()
        b['keys'][0]['startBar'] = 1          # integer: exact
        b['chords'][0]['text'] = 'C?'         # string
        b['beats'][0]['downbeat'] = False     # bool
        d = P.compare_results(a, b)['diffs']
        self.assertEqual({x[0]: x[1] for x in d},
                         {'.beats[0].downbeat': 'value', '.chords[0].text': 'value', '.keys[0].startBar': 'value'})

    def test_structure(self):
        a, b = full(), full()
        b['beats'].append({'t': 1.5, 'downbeat': False})
        b['extra'] = 1
        kinds = {x[0]: x[1] for x in P.compare_results(a, b)['diffs']}
        self.assertEqual(kinds, {'': 'keys', '.beats': 'length'})
        c = full()
        c['keys'] = None
        self.assertEqual(P.compare_results(a, c)['diffs'], [('.keys', 'type', 'list', 'NoneType')])

    def test_int_vs_float_json(self):
        a, b = full(), full()
        a['beats'][0]['t'] = 1       # JS prints 1, Python 1.0
        b['beats'][0]['t'] = 1.0
        self.assertEqual(P.compare_results(a, b)['diffs'], [])

    def test_wav_mode_beat_fraction(self):
        a = {'beats': [{'t': i * 0.5} for i in range(200)], 'chords': [{'start': 0.0, 'end': 1.0}]}
        b = {'beats': [{'t': i * 0.5} for i in range(200)], 'chords': [{'start': 0.0, 'end': 1.0}]}
        b['beats'][5]['t'] += 4.5e-5
        b['beats'][6]['t'] += 1.0e-2   # 1 late beat of 200 is within 1 %
        self.assertEqual(len(P.compare_results(a, b)['diffs']), 2)  # strict
        self.assertEqual([d[0] for d in P.compare_results(a, b, 5e-3, 1e-4, 0.01)['diffs']], [])
        b['beats'][7]['t'] += 1.0e-2
        b['beats'][8]['t'] += 1.0e-2   # 3 late beats of 200 > 1 %
        self.assertEqual(len(P.compare_results(a, b, 5e-3, 1e-4, 0.01)['diffs']), 3)
        b['chords'][0]['end'] += 1.0e-2  # non-beat times never get the fraction
        self.assertIn('.chords[0].end', [d[0] for d in P.compare_results(a, b, 5e-3, 1e-4, 0.5)['diffs']])

    def test_fmt_diff_hides_values_for_private(self):
        d = ('.chords[3].text', 'value', 'C', 'D')
        self.assertEqual(P.fmt_diff(d, True), '.chords[3].text (value)')
        self.assertIn("'C' vs 'D'", P.fmt_diff(d, False))


if __name__ == '__main__':
    unittest.main()
