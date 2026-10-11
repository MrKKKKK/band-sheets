import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import charts as C  # noqa: E402
import intake as I  # noqa: E402

# synthetic, generic fixtures (not any real song)
CHART = """# fixture
bpm: 100
拍子: 4/4
キー: C
| C | Am7 . F . | G7 | C |
キー: D
| D | Bm7 | Em7 A7(#9) | D |
"""
OTHER = "bpm: 90\n拍子: 3/4\n| C | Am | N.C. | G7 |\n"
PICKUP = "bpm: 120\n弱起: 1拍\n| F | Bb | C7 | F |\n"


def write(d, name, text):
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        f.write(text)


class TestSimplify(unittest.TestCase):
    def test_reductions(self):
        for src, want in [("C", "C"), ("Dm7", "Dm7"), ("C6", "C"), ("Cadd9", "C"), ("Cmaj9", "Cmaj7"), ("CM7", "Cmaj7"),
                          ("Dm9", "Dm7"), ("Dm6", "Dm"), ("Dm11", "Dm7"), ("G9", "G7"), ("G13", "G7"), ("G7(#9)", "G7"),
                          ("G7sus4", "Gsus4"), ("Csus2", "Csus4"), ("Bm7b5", "Bm7b5"), ("Bdim7", "Bdim7"), ("Bdim", "Bdim"),
                          ("Caug", "Caug"), ("C+", "Caug"), ("Am7/G", "Am7/G"), ("C/E", "C/E"), ("Cmmaj7", "Cm"),
                          ("N.C.", "N.C."), ("N", "N.C."), ("Eb-7", "Ebm7")]:
            self.assertEqual(C.simplify_chord(src), want, src)

    def test_unreadable(self):
        with self.assertRaises(ValueError):
            C.simplify_chord("Hm7")


class TestProcess(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.d = os.path.join(self.t.name, "recordings", "charts")
        self.out = os.path.join(self.t.name, "out")
        os.makedirs(self.d)
        self.msgs = []

    def tearDown(self):
        self.t.cleanup()

    def run_it(self, **kw):
        return C.process(self.d, self.out, log=self.msgs.append, **kw)

    def log_lines(self):
        p = os.path.join(self.out, "results", "heldout-log.jsonl")
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []

    def test_ids_song_json_and_every_fourth_held_out(self):
        for i in range(5):
            write(self.d, f"s{i}.txt", "bpm: 100\n| C | F | G | C |\n")
        self.assertEqual(self.run_it(), 0)
        songs = {f: json.load(open(os.path.join(self.d, f))) for f in sorted(os.listdir(self.d)) if f.endswith(".song.json")}
        self.assertEqual(list(songs), [f"chart-0{i}.song.json" for i in range(1, 6)])
        self.assertEqual([s["heldOut"] for s in songs.values()], [False, False, False, True, False])
        reg = [e for e in self.log_lines() if e["kind"] == "register"]
        self.assertEqual([(e["take"], e["heldOut"]) for e in reg][3], ("chart-04", True))
        self.assertEqual(len(reg), 5)
        for m in self.msgs:
            self.assertNotIn("s0", m)

    def test_same_file_keeps_id_and_is_not_registered_twice(self):
        write(self.d, "a.txt", CHART)
        self.run_it()
        write(self.d, "b.txt", OTHER)
        self.run_it()
        self.assertEqual(self.run_it(), 0)
        ids = json.load(open(os.path.join(self.d, "ids.local.json")))["charts"]
        self.assertEqual({k: v["original"] for k, v in ids.items()}, {"chart-01": "a", "chart-02": "b"})
        self.assertEqual(len(self.log_lines()), 2)

    def test_song_content_keys_pickup_and_simplified(self):
        write(self.d, "a.txt", CHART)
        write(self.d, "b.txt", PICKUP)
        write(self.d, "c.txt", OTHER)
        self.run_it()
        a = json.load(open(os.path.join(self.d, "chart-01.song.json")))
        self.assertEqual(a["keys"], [{"startBar": 0, "key": "C"}, {"startBar": 4, "key": "D"}])
        self.assertEqual(a["bars"][5], [["Bm7", 8]])
        self.assertEqual(a["bars"][6], [["Em7", 4], ["A7", 4]])  # 7(#9) -> 7
        self.assertEqual((a["tempo"], a["pickupBeats"], a["heldOut"]), (100.0, 0, False))
        b = json.load(open(os.path.join(self.d, "chart-02.song.json")))
        self.assertEqual((b["pickupBeats"], b["keys"]), (1, []))
        c = json.load(open(os.path.join(self.d, "chart-03.song.json")))
        self.assertEqual(c["timeSignature"], [3, 4])
        self.assertEqual(c["bars"][2], [["N.C.", 6]])
        self.assertTrue(any("簡略化" in m for m in self.msgs))

    def test_errors_do_not_name_the_file_and_do_not_register(self):
        write(self.d, "secret-title.txt", "bpm: 100\n| C | Hm7 |\n")
        write(self.d, "pu.txt", "bpm: 100\n拍子: 3/4\n弱起: 1拍\n| C |\n")
        write(self.d, "nc.txt", "bpm: 100\n| N.C. |\n")
        self.assertEqual(self.run_it(), 3)
        self.assertFalse(os.path.exists(os.path.join(self.d, "ids.local.json")))
        text = "\n".join(self.msgs)
        self.assertNotIn("secret", text)
        self.assertIn("2行目", text)  # line-numbered Japanese message
        self.assertIn("弱起", text)
        self.assertIn("N.C.", text)

    def test_dry_run_writes_nothing(self):
        write(self.d, "a.txt", CHART)
        self.assertEqual(self.run_it(dry_run=True), 0)
        self.assertEqual([f for f in os.listdir(self.d) if f != "a.txt"], [])

    def test_empty_folder(self):
        self.assertEqual(self.run_it(), 0)
        self.assertTrue(self.msgs)

    def test_main_runs_privacy_check_on_an_isolated_tree(self):
        write(self.d, "Quartz Lemonade Parade.txt", CHART)
        os.makedirs(os.path.join(self.t.name, "src"))
        write(os.path.join(self.t.name, "src"), "n.md", "I love quartz lemonade parade\n")
        rc = C.main(["--charts", self.d, "--out", self.out, "--privacy-root", self.t.name])
        self.assertEqual(rc, 1)  # the title leaked into a (non-ignored) file of the scanned tree
        write(os.path.join(self.t.name, "src"), "n.md", "clean\n")
        self.assertEqual(C.main(["--charts", self.d, "--out", self.out, "--privacy-root", self.t.name]), 0)


if __name__ == "__main__":
    unittest.main()
