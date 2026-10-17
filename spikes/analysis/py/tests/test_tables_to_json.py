"""Drift guard (spike 3 T3): the committed ts/tables/*.json must equal a fresh conversion of the TOML tables.
Fix a failure with: python py/tools/tables_to_json.py"""
import os
import sys
import unittest

PY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PY, 'tools'))
import tables_to_json as T  # noqa: E402


class TablesToJson(unittest.TestCase):
    def test_committed_json_matches_toml(self):
        for name in T.NAMES:
            with self.subTest(table=name):
                with open(T.json_path(name), encoding='utf-8') as f:
                    self.assertEqual(f.read(), T.convert(name), f'{name}.json is stale: run py/tools/tables_to_json.py')

    def test_source_lines_kept(self):
        for name in T.NAMES:
            with self.subTest(table=name):
                s = T.convert(name)
                self.assertIn('和声法ノート v3', s)
                self.assertIn('books:', s)

    def test_deterministic(self):
        for name in T.NAMES:
            self.assertEqual(T.convert(name), T.convert(name))


if __name__ == '__main__':
    unittest.main()
