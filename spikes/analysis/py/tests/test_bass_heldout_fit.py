"""Tests for py/tools/bass_heldout_fit.py (the T13 guard). Fake registries only; the fit itself is stubbed."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import bass_heldout_fit as H  # noqa: E402

IDS = {"recordings": {"bas-01-a": {"letter": "a", "heldOut": False}, "bas-05-e": {"letter": "e", "heldOut": True},
                      "bas-06-f": {"letter": "f", "heldOut": True}}}
MAN = {"variants": [{"name": "bas-01-a", "heldOut": False}, {"name": "bas-05-e", "heldOut": True},
                    {"name": "bas-06-f", "heldOut": True}]}
SYN = {"variants": [{"name": "syn-b0-x-tA-s1", "heldOut": False, "split": "tuning", "timbre": "A"},
                    {"name": "syn-b0-x-tC-s6", "heldOut": True, "split": "heldOut", "timbre": "C"}]}


class TestPure(unittest.TestCase):
    def test_held_takes(self):
        self.assertEqual(H.held_takes(IDS, MAN), ["bas-05-e", "bas-06-f"])

    def test_held_takes_refuses_disagreeing_flags(self):
        man = {"variants": [dict(v, heldOut=False) if v["name"] == "bas-05-e" else v for v in MAN["variants"]]}
        with self.assertRaises(SystemExit):
            H.held_takes(IDS, man)

    def test_held_takes_refuses_wrong_letter(self):
        ids = {"recordings": dict(IDS["recordings"], **{"bas-02-b": {"letter": "b", "heldOut": True}})}
        man = {"variants": MAN["variants"] + [{"name": "bas-02-b", "heldOut": True}]}
        with self.assertRaises(SystemExit):
            H.held_takes(ids, man)

    def test_held_synthetic(self):
        self.assertEqual(H.held_synthetic(SYN["variants"]), ["syn-b0-x-tC-s6"])
        with self.assertRaises(SystemExit):
            H.held_synthetic([{"name": "syn-b0-x-tC-s1", "heldOut": False, "split": "tuning", "timbre": "C"}])

    def test_final_block(self):
        self.assertIsNone(H.final_block([{"kind": "register", "input": "bass", "heldOut": True}], "abc"))
        self.assertRegex(H.final_block([], None), "commit")
        self.assertRegex(H.final_block([], ""), "commit")
        for prior in ({"lookPoint": 3}, {"task": "T13"}, {"heldOut": True}):
            self.assertRegex(H.final_block([dict({"kind": "look", "input": "bass"}, **prior)], "abc"), "already exists")
        self.assertIsNone(H.final_block([{"kind": "look", "input": "bass", "lookPoint": 2, "task": "R3", "heldOut": False}], "abc"))
        self.assertIsNone(H.final_block([{"kind": "look", "input": "drum", "lookPoint": 3, "heldOut": True}], "abc"))
        self.assertIsNone(H.final_block([{"kind": "selftest", "input": "bass", "task": "T13"}], "abc"))


class TestMain(unittest.TestCase):
    def setUp(self):
        self.cwd = os.getcwd()
        self.d = tempfile.mkdtemp()
        os.chdir(self.d)
        for p, obj in ((H.IDS, IDS), (H.MANIFEST, MAN), (H.SYN_MANIFEST, SYN)):
            os.makedirs(os.path.dirname(p), exist_ok=True)
            json.dump(obj, open(p, "w"))
        self.calls = []
        self.orig = H.fit_takes
        H.fit_takes = lambda takes, ids, held, fit_dir, task: self.calls.append((takes, held, fit_dir, len(H.read_log())))

    def tearDown(self):
        H.fit_takes = self.orig
        os.chdir(self.cwd)
        shutil.rmtree(self.d)

    def test_final_logs_once_before_the_fit(self):
        H.main(["--final-heldout", "--commit", "abc1234"])
        (takes, held, fit_dir, lines_at_fit), = self.calls
        self.assertEqual((takes, held, fit_dir), (["bas-05-e", "bas-06-f"], True, "out/bass-rec/heldout-fit"))
        self.assertEqual(lines_at_fit, 1)  # the line exists before anything held-out is opened
        line, = H.read_log()
        self.assertEqual((line["kind"], line["input"], line["lookPoint"], line["task"], line["heldOut"], line["commit"]),
                         ("look", "bass", 3, "T13", True, "abc1234"))
        self.assertEqual(line["configHashes"], H.FROZEN_HASHES)
        self.assertEqual(line["synthetic"], {"split": "heldOut", "timbre": "C", "files": 1})
        self.assertEqual(line["inputGain"], ["raw", "tuning-median-rms"])
        with self.assertRaises(SystemExit):
            H.main(["--final-heldout", "--commit", "abc1234"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(H.read_log()), 1)

    def test_final_needs_a_commit(self):
        os.environ.pop("BAND_SHEETS_COMMIT", None)
        with self.assertRaises(SystemExit):
            H.main(["--final-heldout"])
        self.assertEqual((self.calls, H.read_log()), ([], []))

    def test_selftest_fits_dev_only_and_never_writes_a_look(self):
        H.main(["--selftest", "--commit", "abc1234"])
        (takes, held, fit_dir, _), = self.calls
        self.assertEqual((takes, held, fit_dir), (["bas-01-a"], False, "out/bass-rec/selftest-fit"))
        self.assertEqual([d["kind"] for d in H.read_log()], ["selftest"])
        self.assertIsNone(H.final_block(H.read_log(), "abc1234"))


if __name__ == "__main__":
    unittest.main()
