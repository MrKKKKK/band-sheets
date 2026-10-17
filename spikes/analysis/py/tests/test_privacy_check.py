import json
import os
import shutil
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


class TestCharts(unittest.TestCase):
    """T28: recordings/charts/*.txt feed the checker (file name, comments, 6-chord runs)."""
    RUN = ["Gmaj7", "Em7", "Bm7", "A7", "Dmaj7", "F#m7"]

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = self.t.name
        self.rec = os.path.join(self.root, "recordings")
        write(os.path.join(self.rec, "charts", "Violet Harbor Lights.txt"),
              "# Velvet Orchard Song\nbpm: 100\nキー: G\n| " + " | ".join(self.RUN) + " |\nキー: A\n| A | D |\n")
        write(os.path.join(self.rec, "charts", "ids.local.json"),
              json.dumps({"charts": {"chart-01": {"original": "Old Original Name"}}}))
        write(os.path.join(self.rec, "charts", "chart-01.song.json"), "{}")
        write(os.path.join(self.root, "src", "ok.md"), "chart-01 chart-01-rec fine\n")

    def tearDown(self):
        self.t.cleanup()

    def check(self):
        return P.check(self.root, self.rec, check_log=False)

    def test_clean_and_anonymous_ids_ignored(self):
        self.assertEqual(self.check(), [])
        terms, runs = P.collect_terms(self.rec)
        self.assertIn("violet harbor lights", terms)
        self.assertIn("velvet orchard song", terms)
        self.assertIn("old original name", terms)
        self.assertNotIn("chart 01", terms)
        self.assertNotIn("chart 01 song", terms)
        self.assertIn(tuple(self.RUN), runs)

    def test_name_comment_and_chords_found_without_echo(self):
        write(os.path.join(self.root, "docs", "a.md"), "x\nviolet-harbor-lights\n")
        write(os.path.join(self.root, "docs", "b.md"), "VELVET ORCHARD SONG\n")
        write(os.path.join(self.root, "docs", "c.md"), "| " + " | ".join(self.RUN) + " |\n")
        write(os.path.join(self.root, "docs", "d.md"), "Old_Original_Name\n")
        bad = self.check()
        self.assertEqual(len(bad), 4, bad)
        for b in bad:
            for secret in ("iolet", "elvet", "Gmaj7", "riginal"):
                self.assertNotIn(secret, b)

    def test_file_name_term_and_broken_chart_still_covered(self):
        write(os.path.join(self.rec, "charts", "broken.txt"), "bpm: ??\n| " + " | ".join(self.RUN[::-1]) + " |\n| H |\n")
        write(os.path.join(self.root, "docs", "violet-harbor-lights.md"), "x\n")
        write(os.path.join(self.root, "docs", "e.md"), " ".join(self.RUN[::-1]) + "\n")
        bad = self.check()
        self.assertEqual(len(bad), 2, bad)

    @unittest.skipUnless(shutil.which("git"), "git is not in the analysis image (runs on the host)")
    def test_commit_messages_are_checked(self):
        import subprocess
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        subprocess.run(["git", "init", "-q", self.root], check=True)
        subprocess.run(["git", "-C", self.root, "add", "src/ok.md"], check=True)
        subprocess.run(["git", "-C", self.root, "commit", "-q", "-m", "work on Velvet Orchard Song"], check=True, env=env)
        bad = P.check(self.root, self.rec, check_log=True)
        self.assertEqual(len(bad), 1)
        self.assertTrue(bad[0].startswith("commit "))



class TestT17(unittest.TestCase):
    """T17: lyric charts (inline chords, lyric fragments), song.json bars, generic loops, commit / history scans.
    Fake data only."""
    RUN = ["Bbmaj7", "Gm7", "Cm7", "F7", "Dm7", "Ebmaj7"]
    LYRIC = "ほしぞらのむこうへはしる"  # fake lyric line
    SONG_RUN = ["Db", "Bbm", "Gb", "Ab", "Fm", "Ebm"]

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = self.t.name
        self.rec = os.path.join(self.root, "recordings")
        chart = ("{title: x}\nbpm: 90\n"
                 + "".join(f"[{c}]" + ("ほしぞらの" if i == 0 else "むこうへはしる" if i == 1 else "") + " "
                           for i, c in enumerate(self.RUN)) + "\n"
                 + "[C]Silver lanterns drifting over quiet harbor water\n")
        write(os.path.join(self.rec, "charts", "Fake Lyric Chart.txt"), chart)
        write(os.path.join(self.rec, "charts", "chart-01.song.json"),
              json.dumps({"bars": [[[c, 8]] for c in self.SONG_RUN]}))
        write(os.path.join(self.root, "src", "ok.md"), "generic: C Am F G C Am F G, ほしぞら\n")

    def tearDown(self):
        self.t.cleanup()

    def check(self, **kw):
        return P.check(self.root, self.rec, check_log=False, **kw)

    def test_clean(self):
        self.assertEqual(self.check(), [])
        _, runs, grams = P.collect_all(self.rec)
        self.assertIn(tuple(self.RUN), runs)
        self.assertIn(tuple(self.SONG_RUN), runs)
        self.assertTrue(grams)

    def test_chart_text_parts(self):
        comments, seq, lyrics = P.chart_texts("# c\n| C | [Dm]--[G7]- |\n[Am]あいう[F]えお\nキー: C\n{key: C}\n")
        self.assertEqual(comments, ["c"])
        self.assertEqual(seq, ["C", "Dm", "G7", "Am", "F"])
        self.assertEqual(lyrics, ["あいう えお"])

    def test_inline_chords_song_json_and_lyrics_found(self):
        write(os.path.join(self.root, "docs", "a.md"), " - ".join(self.RUN) + "\n")
        write(os.path.join(self.root, "docs", "b.md"), " ".join(self.SONG_RUN) + "\n")
        write(os.path.join(self.root, "docs", "c.md"), "x ぞらの むこうへは y\n")
        write(os.path.join(self.root, "docs", "d.md"), "Lanterns drifting over quiet harbor!\n")
        write(os.path.join(self.root, "docs", "e.md"), "drifting over quiet\n")  # 3 words: too short
        bad = self.check()
        self.assertEqual(sorted(b.split(":")[0] for b in bad),
                         [os.path.join("docs", x) for x in ("a.md", "b.md", "c.md", "d.md")], bad)
        for b in bad:
            for secret in ("ほし", "むこう", "Bb", "Db", "harbor"):
                self.assertNotIn(secret, b)

    def test_generic_loop_allowed_in_any_key(self):
        self.assertTrue(P.is_generic_run(["C", "Am", "F", "G", "C", "Am"]))
        self.assertTrue(P.is_generic_run(["Bm7", "G", "A7", "D", "Bm", "G"]))  # I-vi-IV-V in D, rotated
        self.assertFalse(P.is_generic_run(["C", "G", "Am", "F", "C", "G"]))
        write(os.path.join(self.rec, "charts", "chart-02.song.json"),
              json.dumps({"bars": [[[c, 8]] for c in ["Eb", "Cm", "Ab", "Bb"] * 2]}))
        _, runs, _ = P.collect_all(self.rec)
        self.assertNotIn(("Eb", "Cm", "Ab", "Bb", "Eb", "Cm"), runs)

    def _git(self, *args, env=None):
        import subprocess
        e = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
                 GIT_COMMITTER_EMAIL="t@t")
        subprocess.run(["git", "-C", self.root, *args], check=True, env=e, capture_output=True)

    @unittest.skipUnless(shutil.which("git"), "git is not in the analysis image (runs on the host)")
    def test_commit_messages_and_history(self):
        self._git("init", "-q", "-b", "main")
        self._git("add", "src/ok.md")
        self._git("commit", "-q", "-m", "base")
        self._git("branch", "base")
        write(os.path.join(self.root, "docs", "tmp.md"), " ".join(self.SONG_RUN) + "\n")
        self._git("add", "docs/tmp.md")
        self._git("commit", "-q", "-m", "progression " + " ".join(self.RUN))
        os.remove(os.path.join(self.root, "docs", "tmp.md"))
        self._git("add", "-A", "docs")
        self._git("commit", "-q", "-m", "remove")
        bad = P.check(self.root, self.rec, check_log=True, base="base")
        self.assertEqual(len(bad), 1, bad)
        self.assertTrue(bad[0].startswith("commit ") and "chord progression" in bad[0])
        bad = P.check(self.root, self.rec, check_log=True, base="base", history=True)
        hist = [b for b in bad if b.startswith("history ")]
        self.assertEqual(len(hist), 1, bad)
        self.assertIn("docs/tmp.md", hist[0])
        bad = P.check(self.root, self.rec, check_log=False, base="nope", history=True)
        self.assertEqual(len(bad), 1)
        self.assertIn("not found", bad[0])

if __name__ == "__main__":
    unittest.main()
