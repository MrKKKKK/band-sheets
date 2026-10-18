"""Spike 4 T4: py/tools/pyin_ref.py only ever selects dev variants (never held-out, never tuning)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import pyin_ref  # noqa: E402

MANIFEST = {'variants': [
    {'name': 'syn-h0-a-s1', 'split': 'tuning', 'heldOut': False},
    {'name': 'syn-h0-a-s4', 'split': 'dev', 'heldOut': False},
    {'name': 'syn-h0-a-s6', 'split': 'heldOut', 'heldOut': True},
    {'name': 'syn-h0-a-s9', 'split': 'dev', 'heldOut': True},  # inconsistent entry: the flag wins
]}


class DevVariantsTest(unittest.TestCase):
    def test_default_selects_dev_only(self):
        self.assertEqual([v['name'] for v in pyin_ref.dev_variants(MANIFEST, [])], ['syn-h0-a-s4'])

    def test_named_held_out_or_tuning_is_refused(self):
        for n in ('syn-h0-a-s1', 'syn-h0-a-s6', 'syn-h0-a-s9', 'nope'):
            with self.assertRaises(SystemExit):
                pyin_ref.dev_variants(MANIFEST, [n])

    def test_named_dev_is_allowed(self):
        self.assertEqual(len(pyin_ref.dev_variants(MANIFEST, ['syn-h0-a-s4'])), 1)


if __name__ == '__main__':
    unittest.main()
