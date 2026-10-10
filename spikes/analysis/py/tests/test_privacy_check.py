import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import privacy_check as P  # noqa: E402

TITLE = "Quartz Lemonade Parade"  # fake title, only for this test
RUN = ["Fmaj7", "Em7", "Dm7", "G7", "Cmaj7", "Am7"]


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class TestPrivacy(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = self.t.name
        self.rec = os.path.join(self.root, "recordings")
        write(os.path.join(self.rec, "ids.local.json"),
              json.dumps({"recordings": {"rec-01": {"original": TITLE + ".m4a"}}}))
        write(os.path.join(self.rec, "private-terms.local.txt"), "Some Artist Name\n")
        write(os.path.join(self.rec, "rec-01.chords.json"),
              json.dumps({"bars": [[[c, 8]] for c in RUN]}))
        write(os.path.join(self.root, "src", "ok.md"), "nothing private here: C F G C\n")

    def tearDown(self):
        self.t.cleanup()

    def run_check(self):
        return P.check(self.root, self.rec, check_log=False)

    def test_clean(self):
        self.assertEqual(self.run_check(), [])
        self.assertEqual(P.main(["--root", self.root, "--recordings", self.rec, "--no-log"]), 0)

    def test_title_in_file_found_case_and_separator_insensitive(self):
        write(os.path.join(self.root, "docs", "n.md"), "line1\nI love quartz_lemonade-parade a lot\n")
        bad = self.run_check()
        self.assertEqual(len(bad), 1)
        self.assertIn("docs/n.md:2", bad[0])
        self.assertNotIn("uartz", bad[0])  # report never repeats the term
        self.assertEqual(P.main(["--root", self.root, "--recordings", self.rec, "--no-log"]), 1)

    def test_term_from_private_terms_and_file_name(self):
        write(os.path.join(self.root, "docs", "some-artist-name.md"), "x\n")
        self.assertEqual(len(self.run_check()), 1)

    def test_chord_progression_found(self):
        write(os.path.join(self.root, "docs", "p.md"), "| " + " | ".join(RUN) + " |\n")
        bad = self.run_check()
        self.assertEqual(len(bad), 1)
        self.assertNotIn("Fmaj7", bad[0])

    def test_short_progression_not_flagged(self):
        write(os.path.join(self.root, "docs", "p.md"), "Fmaj7 Em7 Dm7 G7\n")
        self.assertEqual(self.run_check(), [])

    def test_recordings_folder_and_binary_ignored(self):
        with open(os.path.join(self.root, "src", "b.bin"), "wb") as f:
            f.write(b"\0\0" + TITLE.encode())
        self.assertEqual(self.run_check(), [])  # binary skipped; recordings/ not scanned

    def test_anonymous_names_not_terms(self):
        terms, _ = P.collect_terms(self.rec)
        self.assertNotIn("rec 01", terms)
        self.assertIn("quartz lemonade parade", terms)


if __name__ == "__main__":
    unittest.main()
