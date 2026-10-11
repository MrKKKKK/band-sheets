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
        write(self.d, "secret-title.txt", "bpm: 100\nキー: Q\n| C | F |\n")
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


LYRICS = """bpm: 100
キー: C
Aメロ
[C]あいうえ[G]おかきく[Am]けこさし[F]すせそた
[Verse]
[C] [G] [Am] [F]
キー: D
[D]あいうえおかきくけこさしすせそた[A]ちつてと
"""


class TestLyricCharts(unittest.TestCase):
    def conv(self, text):
        ann, fmt, warns = C.parse_chart(text)
        return ann, fmt, warns

    def test_lyric_line_proportional_timing(self):
        ann, fmt, w = self.conv("bpm: 100\n[C]あいうえ[G]おかきく[Am]けこさし[F]すせそた\n")
        self.assertEqual(fmt, "lyrics")
        self.assertEqual(ann["bars"], [[["C", 4], ["G", 4]], [["Am", 4], ["F", 4]]])  # 16 chars -> 2 bars, 4 beats each

    def test_deterministic_and_whole_bars(self):
        a = self.conv(LYRICS)[0]["bars"]
        self.assertEqual(a, self.conv(LYRICS)[0]["bars"])
        for bar in a:
            self.assertEqual(sum(n for _, n in bar), 8)

    def test_unequal_lengths_snap_to_2_4_8_beats(self):
        ann, _, _ = self.conv("bpm: 100\n[C]あ[G]いうえおかきくけこさしすせそ\n")
        beats = [sum(n for c, n in b if c == "C") for b in ann["bars"]]
        self.assertEqual(sum(sum(n for _, n in b) for b in ann["bars"]) % 8, 0)
        self.assertEqual(ann["bars"][0][0], ["C", 4])  # 1 char: minimum 2 beats, but bars fill up: C 2 beats + G 6 beats
        self.assertTrue(beats)

    def test_chord_only_line_is_one_bar_per_chord(self):
        ann, fmt, _ = self.conv("bpm: 100\n[C] [G] [Am]\n[F]あいうえ\n")
        self.assertEqual(fmt, "lyrics")
        self.assertEqual(ann["bars"][:3], [[["C", 8]], [["G", 8]], [["Am", 8]]])

    def test_mid_song_key_and_header_key(self):
        ann, _, _ = self.conv(LYRICS)
        self.assertEqual(ann["keys"], [{"startBar": 0, "key": "C"}, {"startBar": 6, "key": "D"}])

    def test_long_chord_continues_over_the_bar_line(self):
        ann, _, _ = self.conv("bpm: 100\n[C]あい[G]うえおかきくけこさしすせそ\n")
        flat = [(c, n) for b in ann["bars"] for c, n in b]
        self.assertTrue(all(n > 0 for _, n in flat))
        self.assertEqual(sum(n for _, n in flat), 8 * len(ann["bars"]))

    def test_section_lines_and_odd_tokens_are_skipped(self):
        text = "bpm: 100\n-- X --\n[Chorus]\n{title: x}\n[C]あい[N.C.]うえ[G](×2)→\n[Hm7]おか[F]\n歌詞だけ\n"
        ann, fmt, w = self.conv(text)
        self.assertEqual(fmt, "lyrics")
        chords = [c for b in ann["bars"] for c, _ in b]
        self.assertEqual(set(chords), {"C", "N.C.", "G", "F"})
        self.assertTrue(any("読めない" in x for x in w))
        for x in w:
            self.assertNotIn("Hm7", x)

    def test_missing_bpm_defaults_to_120(self):
        ann, _, w = self.conv("[C]あいうえ[G]おかきく\n")
        self.assertEqual(ann["tempo"], 120.0)
        self.assertTrue(any("120" in x for x in w))

    def test_all_bar_lines_use_the_bar_parser(self):
        ann, fmt, w = self.conv("bpm: 100\n[Verse]\n| C | Am7 . F . |\n")
        self.assertEqual((fmt, w), ("bars", []))
        self.assertEqual(ann["bars"], [[["C", 8]], [["Am7", 4], ["F", 4]]])

    def test_mismatched_dash_bar_is_stretched_for_charts_only(self):
        text = "bpm: 100\n|[C]----[G]--|[Am]--------|\n"
        ann, fmt, w = self.conv(text)
        self.assertEqual(fmt, "bars")
        self.assertEqual([sum(n for _, n in b) for b in ann["bars"]], [8, 8])
        self.assertEqual(ann["bars"][0], [["C", 5], ["G", 3]])
        self.assertEqual(len(w), 2 - 1)
        with self.assertRaises(I.IntakeError):  # recordings stay strict
            I.parse_txt(text, require_style=False)

    def test_bar_lines_inside_a_lyric_file_keep_timing(self):
        ann, fmt, _ = self.conv("bpm: 100\n| C | G |\n[Am]あいうえ[F]おかきく\n")
        self.assertEqual(fmt, "lyrics")
        self.assertEqual(ann["bars"][:2], [[["C", 8]], [["G", 8]]])

    def test_three_four_lyrics(self):
        ann, _, _ = self.conv("bpm: 100\n拍子: 3/4\n[C]あいうえお[G]かきくけこ\n")
        for bar in ann["bars"]:
            self.assertEqual(sum(n for _, n in bar), 6)

    def test_compound_meter_is_skipped_but_registered(self):
        d = tempfile.TemporaryDirectory()
        cd = os.path.join(d.name, "recordings", "charts")
        os.makedirs(cd)
        write(cd, "a.txt", "bpm: 90\n拍子: 6/8\n[C]あいうえ[G]おかきく\n")
        msgs = []
        self.assertEqual(C.process(cd, os.path.join(d.name, "out"), log=msgs.append), 0)
        song = json.load(open(os.path.join(cd, "chart-01.song.json")))
        self.assertEqual(song["skipped"], "compound meter")
        self.assertNotIn("bars", song)
        self.assertTrue(any("複合拍子" in m for m in msgs))
        d.cleanup()

    def test_lyrics_are_not_stored(self):
        d = tempfile.TemporaryDirectory()
        cd = os.path.join(d.name, "recordings", "charts")
        os.makedirs(cd)
        write(cd, "a.txt", "bpm: 100\n[C]あいうえお[G]かきくけこ\n")
        msgs = []
        C.process(cd, os.path.join(d.name, "out"), log=msgs.append)
        raw = open(os.path.join(cd, "chart-01.song.json"), encoding="utf-8").read()
        for frag in ("あい", "かき", "うえ"):
            self.assertNotIn(frag, raw)
            self.assertNotIn(frag, "\n".join(msgs))
        self.assertEqual(json.loads(raw)["format"], "lyrics")
        d.cleanup()


class TestChordProDirectives(unittest.TestCase):
    def test_initial_key_and_ignored_title(self):
        ann, fmt, w = C.parse_chart("{title: Wobble Gantry}\n{artist: Plinth Z}\n{key: C}\n{tempo: 90}\n{time: 3/4}\n[C]あいうえ[G]おかきく\n")
        self.assertEqual((ann["key"], ann["tempo"], ann["timeSignature"][0]), ("C", 90, 3))
        self.assertNotIn("Wobble", json.dumps(ann, ensure_ascii=False) + "".join(w))
        self.assertNotIn("Plinth", json.dumps(ann, ensure_ascii=False) + "".join(w))
        self.assertNotIn("keys", ann)

    def test_midsong_key_lyrics(self):
        ann, fmt, _ = C.parse_chart("{key:C}\nbpm: 100\n[C]あいうえ[G]おかきく\n{k: D}\n[D]あいうえ[A]おかきく\n")
        self.assertEqual(fmt, "lyrics")
        self.assertEqual(ann["keys"], [{"startBar": 0, "key": "C"}, {"startBar": 2, "key": "D"}])

    def test_midsong_key_bars(self):
        ann, fmt, _ = C.parse_chart("bpm: 100\n{key: C}\n| C | F |\n{key: Eb}\n| Eb | Ab |\n")
        self.assertEqual(fmt, "bars")
        self.assertEqual(ann["keys"], [{"startBar": 0, "key": "C"}, {"startBar": 2, "key": "Eb"}])

    def test_normalization(self):
        ann, _, _ = C.parse_chart("bpm: 100\n{key: Ａ♭m}\n| Abm | Db |\n{key: F♯}\n| F# | B |\n")
        self.assertEqual([k["key"] for k in ann["keys"]], ["Abm", "F#"])

    def test_invalid_key_warns_and_is_ignored(self):
        ann, _, w = C.parse_chart("bpm: 100\n{key: Q}\n| C | F |\n")
        self.assertIsNone(ann.get("key"))
        self.assertTrue(any("key" in x for x in w))

    def test_line_key_preferred_over_directive(self):
        ann, _, w = C.parse_chart("bpm: 100\nキー: G\n{key: C}\n| G | C |\nキー: A\n{key: D}\n| A | D |\n")
        self.assertEqual(ann["keys"], [{"startBar": 0, "key": "G"}, {"startBar": 2, "key": "A"}])
        self.assertGreaterEqual(len(w), 2)

    def test_trailing_directive_ignored(self):
        ann, _, w = C.parse_chart("bpm: 100\n[C]あいうえ[G]おかきく\n{key: D}\n")
        self.assertNotIn("keys", ann)


class TestRemovedCharts(unittest.TestCase):
    def test_removed_source_is_pruned_and_id_not_reused(self):
        t = tempfile.TemporaryDirectory()
        cd, out = os.path.join(t.name, "charts"), os.path.join(t.name, "out")
        os.makedirs(cd)
        os.makedirs(os.path.join(out, "charts"))
        write(cd, "a.txt", OTHER)
        write(cd, "b.txt", OTHER)
        C.process(cd, out, log=lambda m: None)
        for fn in ("chart-02-block.wav", "chart-02-rec.truth.json", "chart-01-block.wav"):
            write(os.path.join(out, "charts"), fn, "x")
        mf = os.path.join(out, "charts", "manifest.charts.json")
        json.dump({"variants": [{"name": "chart-01-block", "take": "chart-01"}, {"name": "chart-02-block", "take": "chart-02"}]}, open(mf, "w"))
        os.remove(os.path.join(cd, "b.txt"))
        write(cd, "c.txt", OTHER)
        msgs = []
        C.process(cd, out, log=msgs.append)
        ids = json.load(open(os.path.join(cd, "ids.local.json")))["charts"]
        self.assertTrue(ids["chart-02"]["removed"])
        self.assertNotIn("removed", ids["chart-01"])
        self.assertIn("chart-03", ids)  # new file gets a new id, chart-02 is not reused
        self.assertFalse(os.path.exists(os.path.join(cd, "chart-02.song.json")))
        self.assertTrue(os.path.exists(os.path.join(cd, "chart-03.song.json")))
        self.assertEqual(sorted(os.listdir(os.path.join(out, "charts"))), ["chart-01-block.wav", "manifest.charts.json"])
        self.assertEqual([v["take"] for v in json.load(open(mf))["variants"]], ["chart-01"])
        self.assertTrue(any("chart-02" in m for m in msgs))
        t.cleanup()


if __name__ == "__main__":
    unittest.main()
