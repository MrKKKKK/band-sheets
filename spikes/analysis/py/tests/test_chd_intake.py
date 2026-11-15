"""Tests for chd_intake.py (spike 7 T6): the 8 recording templates give a valid truth with the original qualities, and
the intake registers g-n with `split` + `heldOut` before the audio is opened. Fake audio only (generated tone). The
held-out templates are read from the gitignored folder when it exists; nothing about them is printed."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bass_intake as B  # noqa: E402
import chd_intake as C  # noqa: E402
from test_bass_intake import tone  # noqa: E402  (same fake tone as the spike 6 intake tests)

SRC = C.CHORDS2
HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # spikes/analysis
DEV_DIR = os.path.join(HERE, SRC.scores)
HELD_DIR = os.path.join(HERE, SRC.heldout_scores)
# The chords2 vocabulary (ts/chords2/vocab.ts stageQualities('V3')): every truth chord must be one of these.
FULL = {"maj", "min", "7", "maj7", "min7", "dim", "aug", "sus4", "m7b5", "dim7",
        "mM7", "m6", "6", "sus2", "7sus4", "add9", "madd9", "9", "m9", "maj9"}
BARS = 16


def wr(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def rd(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def truth_problems(letter, text):
    """Problems of one template's truth (letter + bar numbers only, never chord names)."""
    ann = B.parse_bass_txt(text, letter, SRC)
    out = []
    if len(ann["bars"]) != BARS:
        out.append(f"{letter}: {len(ann['bars'])} bars")
    bar = 4 * 60.0 / ann["tempo"]
    audio = ann["startSec"] + BARS * bar + 1.5
    if not B.start_check(ann["startSec"], audio, ann["tempo"], 4, BARS)[0]:
        out.append(f"{letter}: the template's 開始 fails the start check")
    t = B.build_truth(ann, B.rec_id(letter, SRC), B.held_out_of(letter, SRC), audio, {"ok": True}, SRC)
    if t["heldOut"] != B.held_out_of(letter, SRC) or t["nBars"] != BARS:
        out.append(f"{letter}: flags")
    for i, c in enumerate(t["chords"]):
        if c.get("originalQuality") not in FULL:
            out.append(f"{letter} chord {i + 1}: original quality outside the chords2 vocabulary")
        if "/" in c["text"] and not c["bass"]:
            out.append(f"{letter} chord {i + 1}: /X lost")
    return out


class TestTemplates(unittest.TestCase):
    def check(self, d, letters):
        problems = []
        for L in letters:
            problems += truth_problems(L, rd(os.path.join(d, f"{L}.txt")))
        self.assertEqual(problems, [])

    def test_dev_templates(self):
        self.check(DEV_DIR, "ghij")

    @unittest.skipUnless(os.path.isdir(HELD_DIR), "held-out templates are local only")
    def test_heldout_templates(self):
        self.check(HELD_DIR, "klmn")

    def test_original_quality_kept(self):
        ann = B.parse_bass_txt("bpm: 120\n拍子: 4/4\nキー: Am\n開始: 2秒\n| Am AmM7 | Am7/G Am6/F# |\n", "g", SRC)
        t = B.build_truth(ann, "chd-07-g", False, 10.0, {"ok": True}, SRC)
        self.assertEqual([(c["quality"], c["originalQuality"], c["bass"]) for c in t["chords"]],
                         [("min", "min", None), ("mM7", "mM7", None), ("min7", "min7", "G"), ("min", "m6", "F#")])

    def test_ids(self):
        self.assertEqual([B.rec_id(x, SRC) for x in "gn"], ["chd-07-g", "chd-14-n"])
        self.assertEqual(sorted(SRC.held_out), list("klmn"))


def txt(letter, held=None, chords="| Am AmM7 | Am7 Am6 |\n| C6 | Csus2 |\n", gear=""):
    h = ("はい" if letter in "klmn" else "いいえ") if held is None else held
    return (f"# chd-?-{letter}\nbpm: 120\n拍子: 4/4\nキー: C\nホールドアウト: {h}\n開始: 2秒\n機材: {gear}\n"
            f"クリック: あり\n楽譜と違って弾いた小節: \n{chords}")


class TestIntake(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.rec = os.path.join(self.d, "recordings")
        self.inbox = os.path.join(self.rec, "chd-inbox")
        self.scores = os.path.join(self.d, "scores")
        self.held = os.path.join(self.rec, "chd-heldout-scores")
        self.out = os.path.join(self.d, "out")
        for p in (self.inbox, self.scores, self.held):
            os.makedirs(p)
        for L in "ghij":
            wr(os.path.join(self.scores, f"{L}.txt"), txt(L))
        for L in "klmn":  # held-out templates only in the gitignored folder
            wr(os.path.join(self.held, f"{L}.txt"), txt(L))
        # T1's re-registered spike 6 take is already in the registry
        wr(os.path.join(self.rec, SRC.ids_file),
           json.dumps({"version": 1, "recordings": {"bas-01-a": {"letter": "a", "heldOut": False, "split": "dev"}}}))

    def tearDown(self):
        shutil.rmtree(self.d)

    def put(self, letter, text=None):
        tone(os.path.join(self.inbox, f"{letter}.wav"), 12.0)
        wr(os.path.join(self.inbox, f"{letter}.txt"), txt(letter) if text is None else text)

    def run_main(self, *extra):
        return C.main(["--inbox", self.inbox, "--out", self.out, "--scores", self.scores, "--heldout-scores", self.held,
                       "--no-privacy-check", *extra])

    def log(self):
        p = os.path.join(self.out, "results", "heldout-log.jsonl")
        return [json.loads(x) for x in rd(p).splitlines()] if os.path.exists(p) else []

    def test_registry_log_truth(self):
        for L in "gk":
            self.put(L, txt(L, gear="Piano X" if L == "g" else "Piano Y"))
        self.assertEqual(self.run_main(), 0)
        ids = json.loads(rd(os.path.join(self.rec, SRC.ids_file)))["recordings"]
        self.assertEqual(ids["bas-01-a"], {"letter": "a", "heldOut": False, "split": "dev"})  # kept
        self.assertEqual((ids["chd-07-g"]["split"], ids["chd-07-g"]["heldOut"]), ("dev", False))
        self.assertEqual((ids["chd-11-k"]["split"], ids["chd-11-k"]["heldOut"]), ("heldOut", True))
        self.assertEqual([(x["take"], x["kind"], x["input"], x["split"], x["heldOut"]) for x in self.log()],
                         [("chd-07-g", "register", "chords2", "dev", False),
                          ("chd-11-k", "register", "chords2", "heldOut", True)])
        tr = json.loads(rd(os.path.join(self.rec, "chd-11-k.truth.json")))
        self.assertEqual([c["originalQuality"] for c in tr["chords"]], ["min", "mM7", "min7", "m6", "6", "sus2"])
        self.assertTrue(os.path.exists(os.path.join(self.rec, SRC.originals, "chd-07-g.txt")))
        man = json.loads(rd(os.path.join(self.out, "rec", SRC.manifest)))
        self.assertEqual([v["name"] for v in man["variants"]], ["chd-07-g", "chd-11-k"])
        self.assertEqual(B.gear_warnings(self.rec, SRC), [])

    def test_heldout_template_must_come_from_the_local_folder(self):
        os.remove(os.path.join(self.held, "k.txt"))
        shutil.copy(os.path.join(self.scores, "g.txt"), os.path.join(self.scores, "k.txt"))
        self.put("k")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.log(), [])

    def test_bad_letter_and_flag(self):
        self.put("a", txt("a", held="いいえ"))
        self.put("h", txt("h", held="はい"))
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.log(), [])

    def test_chords_must_match_template(self):
        self.put("g", txt("g", chords="| Am | Am7 |\n| C6 | Csus2 |\n"))
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.log(), [])

    def test_reparse_only_this_source_and_gear(self):
        self.put("g", txt("g", gear="Piano X"))
        self.put("k", txt("k", gear="Piano X"))
        self.run_main()
        self.assertEqual(self.run_main("--reparse"), 0)  # bas-01-a (registry only) is not this source's take
        self.assertEqual([x["kind"] for x in self.log()][-2:], ["reparse", "reparse"])
        w = B.gear_warnings(self.rec, SRC)
        self.assertEqual(len(w), 1)
        self.assertIn("k・l・m・n", w[0])
        self.assertIn("g〜j", w[0])


if __name__ == "__main__":
    unittest.main()
