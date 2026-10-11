import json
import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import intake as I  # noqa: E402

TXT = """# comment
bpm: 120
拍子: 4/4
キー: F#m
弾き方: a
| C | Am7 D7 | F . Em . | N.C. G7(#9) |
"""


def click_wav(path, t0, bpm=120, n=16, sr=48000, channels=2, subtype="PCM_16"):
    y = np.zeros(int(sr * (t0 + n * 60 / bpm + 1)))
    rng = np.random.default_rng(1)
    m = int(0.02 * sr)
    for k in range(n):
        i = int((t0 + k * 60 / bpm) * sr)
        y[i:i + m] += rng.standard_normal(m) * np.hanning(m) * 0.5
    sf.write(path, np.stack([y] * channels, axis=1) if channels > 1 else y, sr, subtype=subtype)


class TestParseTxt(unittest.TestCase):
    def test_bars_and_header(self):
        a = I.parse_txt(TXT)
        self.assertEqual(a["tempo"], 120.0)
        self.assertEqual(a["key"], "F#m")
        self.assertEqual(a["style"], "a")
        self.assertEqual(a["bars"][0], [["C", 8]])
        self.assertEqual(a["bars"][1], [["Am7", 4], ["D7", 4]])
        self.assertEqual(a["bars"][2], [["F", 4], ["Em", 4]])  # 4 tokens = per beat, '.' continues
        self.assertEqual(a["bars"][3], [["N.C.", 4], ["G7(#9)", 4]])
        self.assertEqual(a["tempoHint"], 120.0)

    def test_per_beat_dots(self):
        a = I.parse_txt("bpm: 100\n弾き方: a\n| C . Em . |\n")
        self.assertEqual(a["bars"][0], [["C", 4], ["Em", 4]])
        a = I.parse_txt("bpm: 100\nstyle: a\n| C . . Em |\n")
        self.assertEqual(a["bars"][0], [["C", 6], ["Em", 2]])

    def test_aliases_fullwidth_and_options(self):
        a = I.parse_txt("bpm：90\ntime: 3/4\nstyle: (c)\npickup: 1拍\nstart: 1.5秒\nclick: なし\nmaximizer: yes\n｜ C ｜ G ｜\n")
        self.assertEqual((a["timeSignature"], a["eighthsPerBar"], a["pickupBeats"]), ([3, 4], 6, 1))
        self.assertEqual((a["start"], a["maximizer"], a["click"]), (1.5, True, False))
        self.assertNotIn("tempoHint", a)

    def test_key_change_lines_in_the_body(self):
        a = I.parse_txt("bpm: 100\nキー: C\n| C | F |\nキー: D\n| D | G |\n| A |\nkey: Bb\n| Bb |\n", require_style=False)
        self.assertIsNone(a["style"])
        self.assertEqual(a["key"], "C")
        self.assertEqual(a["keys"], [{"startBar": 0, "key": "C"}, {"startBar": 2, "key": "D"}, {"startBar": 5, "key": "Bb"}])
        # without a header key the first run starts at its own bar; a plain header key adds no "keys"
        b = I.parse_txt("bpm: 100\n| C | F |\nキー: G\n| G |\n", require_style=False)
        self.assertEqual(b["keys"], [{"startBar": 2, "key": "G"}])
        self.assertNotIn("keys", I.parse_txt("bpm: 100\nキー: C\n| C |\n", require_style=False))

    def test_key_change_errors_and_style_still_required_by_default(self):
        with self.assertRaises(I.IntakeError) as cm:
            I.parse_txt("bpm: 100\n| C |\nキー: H\n| G |\n", require_style=False)
        self.assertIn("3行目", str(cm.exception))
        with self.assertRaises(I.IntakeError) as cm:
            I.parse_txt("bpm: 100\n| C |\nキー: G\n", require_style=False)
        self.assertIn("後ろに小節", str(cm.exception))
        with self.assertRaises(I.IntakeError):
            I.parse_txt("bpm: 100\n| C |\n")  # 弾き方 missing

    def test_errors_are_japanese_with_line_numbers(self):
        cases = [("bpm: 100\n弾き方: a\n| C | Hm7 |\n", "3行目"),
                 ("bpm: 100\n弾き方: a\n| C G Em |\n", "等分できません"),
                 ("bpm: 100\n弾き方: z\n| C |\n", "2行目"),
                 ("弾き方: a\n| C |\n", "bpm"),
                 ("bpm: 100\n弾き方: a\n色: 赤\n| C |\n", "3行目"),
                 ("bpm: 100\n弾き方: a\n拍子: 4/8\n| C |\n", "拍子"),
                 ("bpm: 100\n弾き方: a\n弱起: 1拍\n開始: 0.1秒\n| C |\n", "小さすぎ"),
                 ("bpm: 100\n弾き方: a\n", "小節")]
        for text, frag in cases:
            with self.assertRaises(I.IntakeError, msg=text) as cm:
                I.parse_txt(text)
            self.assertIn(frag, str(cm.exception), text)


class TestIntake(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.rec = os.path.join(self.t.name, "recordings")
        self.inbox = os.path.join(self.rec, "inbox")
        self.out = os.path.join(self.t.name, "out")
        os.makedirs(self.inbox)

    def tearDown(self):
        self.t.cleanup()

    def drop(self, base, txt=TXT, audio=("wav",), t0=0.5):
        for kind in audio:
            click_wav(os.path.join(self.inbox, base + (".max" if kind == "max" else "") + ".wav"), t0)
        if txt:
            open(os.path.join(self.inbox, base + ".txt"), "w", encoding="utf-8").write(txt)

    def test_end_to_end_first_onset(self):
        self.drop("Secret Title")
        take = I.scan_inbox(self.inbox)["Secret Title"]
        names = I.process_take("Secret Title", take, self.rec, self.out, log=lambda m: None)
        self.assertEqual(names, ["rec-01-a"])
        self.assertEqual(os.listdir(self.inbox), [])
        self.assertTrue(os.path.exists(os.path.join(self.rec, "originals", "rec-01-a.wav")))
        data, sr = sf.read(os.path.join(self.rec, "rec-01-a.wav"))
        self.assertEqual((sr, data.ndim), (44100, 1))
        man = json.load(open(os.path.join(self.out, "rec", "manifest.rec.json")))["variants"]
        self.assertEqual(len(man), 1)
        self.assertFalse(man[0]["heldOut"])  # song 01 = odd = dev
        self.assertEqual(man[0]["tempoHint"], 120.0)
        truth = json.load(open(os.path.join(self.out, "rec", "rec-01-a.truth.json")))
        self.assertAlmostEqual(truth["beats"][0]["t"], 0.5, delta=0.03)
        self.assertEqual(truth["keys"], [{"startBar": 0, "key": "F#m"}])
        ids = json.load(open(os.path.join(self.rec, "ids.local.json")))["recordings"]["rec-01-a"]
        self.assertFalse(ids["heldOut"])
        self.assertEqual(ids["song"], "rec-01")
        log = [json.loads(l) for l in open(os.path.join(self.out, "results", "heldout-log.jsonl"))]
        self.assertEqual((log[0]["kind"], log[0]["take"], log[0]["heldOut"]), ("register", "rec-01-a", False))
        # no original name in anything under out/
        for d, _, fns in os.walk(self.out):
            for f in fns:
                self.assertNotIn("Secret", open(os.path.join(d, f), errors="ignore").read())

    def test_given_start_far_keeps_given_with_warning_by_default(self):
        self.drop("x", TXT + "開始: 0秒\n", t0=1.0)
        msgs = []
        I.process_take("x", I.scan_inbox(self.inbox)["x"], self.rec, self.out, log=msgs.append)
        self.assertTrue(any("警告" in m and "拍" in m for m in msgs), msgs)
        truth = json.load(open(os.path.join(self.out, "rec", "rec-01-a.truth.json")))
        self.assertEqual(truth["beats"][0]["t"], 0.0)
        a = json.load(open(os.path.join(self.rec, "rec-01-a.chords.json")))
        self.assertEqual((a["startSource"], a["startGiven"]), ("given", 0.0))

    def test_given_start_far_fit_opt_in(self):
        self.drop("x", TXT + "開始: 0秒\n", t0=1.0)
        I.process_take("x", I.scan_inbox(self.inbox)["x"], self.rec, self.out, log=lambda m: None, fit_start=True)
        truth = json.load(open(os.path.join(self.out, "rec", "rec-01-a.truth.json")))
        self.assertAlmostEqual(truth["beats"][0]["t"], 1.0, delta=0.03)
        a = json.load(open(os.path.join(self.rec, "rec-01-a.chords.json")))
        self.assertEqual((a["startSource"], a["startGiven"]), ("fitted", 0.0))

    def test_given_start_aligned_no_warning(self):
        self.drop("x", TXT + "開始: 1.0秒\n", t0=1.0)
        msgs = []
        I.process_take("x", I.scan_inbox(self.inbox)["x"], self.rec, self.out, log=msgs.append)
        self.assertFalse(any("警告" in m for m in msgs), msgs)
        a = json.load(open(os.path.join(self.rec, "rec-01-a.chords.json")))
        self.assertEqual((a["startSource"], a["firstSoundSec"]), ("given", 1.0))

    def test_start_override_and_pickup(self):
        txt = TXT + "弱起: 1拍\n開始: 1.0秒\n"
        self.drop("x", txt, t0=0.5)
        I.process_take("x", I.scan_inbox(self.inbox)["x"], self.rec, self.out, log=lambda m: None)
        truth = json.load(open(os.path.join(self.out, "rec", "rec-01-a.truth.json")))
        b = truth["beats"]
        self.assertEqual((b[0]["t"], b[0]["bar"]), (0.5, -1))
        self.assertEqual((b[1]["t"], b[1]["bar"], b[1]["downbeat"]), (1.0, 0, True))
        man = json.load(open(os.path.join(self.out, "rec", "manifest.rec.json")))["variants"]
        self.assertFalse(man[0]["heldOut"])

    def test_two_variants_share_decision(self):
        self.drop("take", audio=("plain", "max"))
        names = I.process_take("take", I.scan_inbox(self.inbox)["take"], self.rec, self.out, log=lambda m: None)
        self.assertEqual(sorted(names), ["rec-01-a", "rec-01-a-max"])
        man = {v["name"]: v for v in json.load(open(os.path.join(self.out, "rec", "manifest.rec.json")))["variants"]}
        self.assertEqual({v["heldOut"] for v in man.values()}, {False})
        self.assertEqual((man["rec-01-a"]["maximizer"], man["rec-01-a-max"]["maximizer"]), (False, True))
        self.assertEqual({v["take"] for v in man.values()}, {"rec-01-a"})

    def test_midi_stored_and_validated(self):
        self.drop("m")
        mid = b"MThd\0\0\0\6\0\0\0\1\1\xe0MTrk\0\0\0\4\0\xff\x2f\0"
        open(os.path.join(self.inbox, "m.mid"), "wb").write(mid)
        I.process_take("m", I.scan_inbox(self.inbox)["m"], self.rec, self.out, log=lambda m: None)
        self.assertTrue(os.path.exists(os.path.join(self.rec, "rec-01-a.mid")))
        truth = json.load(open(os.path.join(self.out, "rec", "rec-01-a.truth.json")))
        self.assertTrue(truth["source"]["hasMidi"])
        with self.assertRaises(I.IntakeError):
            p = os.path.join(self.t.name, "bad.mid")
            open(p, "wb").write(b"garbage")
            I.validate_midi(p)

    def test_failures_leave_inbox_and_register_nothing(self):
        self.drop("nomatch", txt=None)
        with self.assertRaises(I.IntakeError):
            I.process_take("nomatch", I.scan_inbox(self.inbox)["nomatch"], self.rec, self.out)
        open(os.path.join(self.inbox, "bad.m4a"), "wb").write(b"not audio")
        open(os.path.join(self.inbox, "bad.txt"), "w").write(TXT)
        with self.assertRaises(I.IntakeError) as cm:
            I.process_take("bad", I.scan_inbox(self.inbox)["bad"], self.rec, self.out)
        self.assertIn("WAV", str(cm.exception))
        self.assertFalse(os.path.exists(os.path.join(self.rec, "ids.local.json")))
        self.assertTrue(os.path.exists(os.path.join(self.inbox, "bad.m4a")))

    def test_formats_float32_mono_96k(self):
        click_wav(os.path.join(self.inbox, "f.wav"), 0.5, sr=96000, channels=1, subtype="FLOAT")
        open(os.path.join(self.inbox, "f.txt"), "w").write(TXT)
        I.process_take("f", I.scan_inbox(self.inbox)["f"], self.rec, self.out, log=lambda m: None)
        _, sr = sf.read(os.path.join(self.rec, "rec-01-a.wav"))
        self.assertEqual(sr, 44100)

    def run_all_takes(self):
        res = {}
        for base, t in I.scan_inbox(self.inbox).items():
            res[base] = I.process_take(base, t, self.rec, self.out, log=lambda m: None)
        return res

    def ids(self):
        return json.load(open(os.path.join(self.rec, "ids.local.json")))["recordings"]

    def test_takes_with_same_prefix_share_song_and_decision(self):
        # song 01 (odd, dev): a/b pair; song 02 (even, held-out): single; song 03: no underscore
        self.drop("曲A_いつも", TXT)
        self.drop("曲A_3度あり", TXT.replace("弾き方: a", "弾き方: b"))
        res = self.run_all_takes()
        self.assertEqual(res, {"曲A_いつも": ["rec-01-a"], "曲A_3度あり": ["rec-01-b"]})
        ids = self.ids()
        self.assertEqual({ids["rec-01-a"]["song"], ids["rec-01-b"]["song"]}, {"rec-01"})
        self.assertEqual({ids["rec-01-a"]["heldOut"], ids["rec-01-b"]["heldOut"]}, {False})
        self.drop("曲B_x", TXT.replace("弾き方: a", "弾き方: c"))
        self.drop("曲B_y", TXT)
        self.drop("曲C", TXT)
        self.run_all_takes()
        ids = self.ids()
        self.assertEqual((ids["rec-02-c"]["heldOut"], ids["rec-02-a"]["heldOut"]), (True, True))
        self.assertEqual((ids["rec-03-a"]["song"], ids["rec-03-a"]["heldOut"]), ("rec-03", False))
        log = [json.loads(l) for l in open(os.path.join(self.out, "results", "heldout-log.jsonl"))]
        self.assertEqual({(l["take"], l["song"]) for l in log if l["song"] == "rec-02"},
                         {("rec-02-c", "rec-02"), ("rec-02-a", "rec-02")})
        for d, _, fns in os.walk(self.out):
            for f in fns:
                self.assertNotIn("曲", open(os.path.join(d, f), errors="ignore").read())

    def test_later_batch_joins_existing_song_and_same_style_gets_index(self):
        self.drop("S_one", TXT)
        self.run_all_takes()
        self.drop("T_one", TXT)  # song 02 -> held-out
        self.drop("S_two", TXT)  # joins song 01 later, same style letter
        self.run_all_takes()
        ids = self.ids()
        self.assertEqual((ids["rec-01-a2"]["song"], ids["rec-01-a2"]["heldOut"]), ("rec-01", False))
        self.assertTrue(ids["rec-02-a"]["heldOut"])

    def test_max_pairing_with_grouping(self):
        self.drop("K_a", audio=("plain", "max"))
        res = self.run_all_takes()
        self.assertEqual(sorted(res["K_a"]), ["rec-01-a", "rec-01-a-max"])

    def test_held_out_rule_is_deterministic_by_song_number(self):
        self.assertEqual([I.song_held_out(n) for n in range(1, 7)], [False, True, False, True, False, True])
        self.assertEqual(I.song_key("曲A_いつも"), "曲A")
        self.assertEqual(I.song_key("plain"), "plain")

    def test_legacy_registration_keeps_status_and_numbering(self):
        os.makedirs(self.rec, exist_ok=True)
        json.dump({"version": 1, "recordings": {"rec-01": {"original": "old", "heldOut": False, "style": None}}},
                  open(os.path.join(self.rec, "ids.local.json"), "w"))
        self.drop("old_extra")  # same key as the legacy "old"? no: key "old" == "old" -> joins rec-01
        self.drop("new")
        self.run_all_takes()
        ids = self.ids()
        self.assertEqual((ids["rec-01-a"]["song"], ids["rec-01-a"]["heldOut"]), ("rec-01", False))
        self.assertEqual((ids["rec-02-a"]["song"], ids["rec-02-a"]["heldOut"]), ("rec-02", True))

    def test_legacy_recording_registered_with_fixed_id(self):
        click_wav(os.path.join(self.rec, "Old Name.wav"), 0.5)
        ann = {"wav": "Old Name.wav", "tempo": 120, "timeSignature": [4, 4], "click": True, "firstSoundSec": 0.5,
               "eighthsPerBar": 8, "sections": [], "bars": [[["C", 8]], [["F", 8]]]}
        json.dump(ann, open(os.path.join(self.rec, "Old Name.chords.json"), "w"))
        os.makedirs(os.path.join(self.out, "rec"))
        json.dump({"variants": [{"name": "rec-Old Name", "wav": "../recordings/Old Name.wav", "truth": "rec/Old Name.truth.json"}]},
                  open(os.path.join(self.out, "rec", "manifest.rec.json"), "w"))
        open(os.path.join(self.out, "rec", "Old Name.truth.json"), "w").write("{}")
        rid = I.register_legacy(self.rec, self.out, "Old Name", "rec-00", "a", held_out=False, log=lambda *_: None, fit=False)
        self.assertEqual(rid, "rec-00-a")
        e = self.ids()["rec-00-a"]
        self.assertEqual((e["song"], e["heldOut"], e["original"]), ("rec-00", False, "Old Name.wav"))
        self.assertTrue(os.path.exists(os.path.join(self.rec, "rec-00-a.wav")))
        self.assertTrue(os.path.exists(os.path.join(self.rec, "originals", "rec-00-a.wav")))
        self.assertFalse(os.path.exists(os.path.join(self.rec, "Old Name.wav")))
        self.assertEqual(json.load(open(os.path.join(self.rec, "rec-00-a.chords.json")))["wav"], "rec-00-a.wav")
        man = json.load(open(os.path.join(self.out, "rec", "manifest.rec.json")))["variants"]
        self.assertEqual([(v["name"], v["level"], v["heldOut"]) for v in man], [("rec-00-a", "REC", False)])
        self.assertFalse(os.path.exists(os.path.join(self.out, "rec", "Old Name.truth.json")))
        self.assertNotIn("Old Name", json.dumps(man))
        with self.assertRaises(I.IntakeError):  # final
            I.register_legacy(self.rec, self.out, "Old Name", "rec-00", "a")
        # numbering continues after the fixed id
        self.drop("fresh")
        self.run_all_takes()
        self.assertEqual(self.ids()["rec-01-a"]["heldOut"], False)

    def test_main_runs_privacy_check(self):
        self.drop("Zebra Quokka Song")
        rc = I.main(["--inbox", self.inbox, "--out", self.out, "--privacy-root", self.out])
        self.assertEqual(rc, 0)


HEAD = "bpm: 120\n拍子: 4/4\nキー: C\n弾き方: a\n"


class TestUserNotation(unittest.TestCase):
    def test_crlf_and_trailing_whitespace(self):
        a = I.parse_txt(TXT.replace("\n", "  \r\n"))
        self.assertEqual(a["bars"][1], [["Am7", 4], ["D7", 4]])
        self.assertEqual(a["key"], "F#m")

    def test_multiple_styles(self):
        for v in ("b,e", "b、e", "b e", "b, e", "b，e"):
            a = I.parse_txt(HEAD.replace("弾き方: a", "弾き方: " + v) + "| C |\n")
            self.assertEqual(a["styles"], ["b", "e"])
            self.assertEqual(a["style"], "b")
        self.assertEqual(I.parse_txt(HEAD + "| C |\n")["styles"], ["a"])
        with self.assertRaises(I.IntakeError) as cm:
            I.parse_txt(HEAD.replace("弾き方: a", "弾き方: a,z") + "| C |\n")
        self.assertIn("4行目", str(cm.exception))

    def test_unknown_key(self):
        a = I.parse_txt(HEAD.replace("キー: C", "キー: ?") + "| C |\n")
        self.assertNotIn("key", a)
        self.assertNotIn("keys", a)

    def test_dash_bars(self):
        a = I.parse_txt(HEAD + "|[Dm]---[Am7]- --[Abm7]--|\n| [A]---[B/A]- ----|\n| [F#m7] |\n"
                        "| [F#m7/B]---- [B]----|\n")
        self.assertEqual(a["bars"], [[["Dm", 3], ["Am7", 3], ["Abm7", 2]], [["A", 3], ["B/A", 5]], [["F#m7", 8]],
                                     [["F#m7/B", 4], ["B", 4]]])
        self.assertNotIn("timing", a)

    def test_dash_bar_lines_without_outer_bars_and_multiple_bars(self):
        a = I.parse_txt(HEAD + "[C]---- [G]----|[Am]-------- | [F]\n[Em]----[B]----\n")
        self.assertEqual(a["bars"], [[["C", 4], ["G", 4]], [["Am", 8]], [["F", 8]], [["Em", 4], ["B", 4]]])

    def test_dash_bar_without_any_dash_splits_equally(self):
        a = I.parse_txt(HEAD + "| [C][G] |\n")
        self.assertEqual(a["bars"][0], [["C", 4], ["G", 4]])

    def test_dash_mismatch_errors_with_line_number(self):
        for bar in ("|[C]--- [G]---|", "|[C]----- [G]----|", "|[C]--- [G]|", "|---[C]|"):
            with self.assertRaises(I.IntakeError) as cm:
                I.parse_txt(HEAD + bar + "\n")
            self.assertIn("5行目", str(cm.exception))

    def test_three_quarter_time(self):
        a = I.parse_txt(HEAD.replace("4/4", "3/4") + "|[C]---[G]---|\n")
        self.assertEqual(a["bars"][0], [["C", 3], ["G", 3]])

    def test_old_notation_still_works(self):
        a = I.parse_txt(HEAD + "| C . Em . | F G |\n")
        self.assertEqual(a["bars"], [[["C", 4], ["Em", 4]], [["F", 4], ["G", 4]]])

    def test_lyric_chord_lines_are_sequence_only(self):
        txt = HEAD + "[CM7]aaa bbb[D]ccc\n[Am7/G]ddd[N.C.]eee [C]\n\n| [F]---- [G]---- |\n"
        a = I.parse_txt(txt, allow_sequence=True)
        self.assertEqual(a["timing"], "sequence")
        self.assertEqual(a["sequence"], ["CM7", "D", "Am7/G", "C", "F", "G"])
        b = I.parse_txt(HEAD + "[|][Em](x) [D]yy[|][C]z [|]\n", allow_sequence=True)
        self.assertEqual(b["sequence"], ["Em", "D", "C"])
        self.assertEqual(a["bars"], [])
        self.assertNotIn("aaa", json.dumps(a, ensure_ascii=False))
        with self.assertRaises(I.IntakeError):  # not allowed unless asked (chart songs)
            I.parse_txt(txt)

    def test_bar_timing_wins_when_every_chord_line_has_bars(self):
        a = I.parse_txt(HEAD + "|[C]---- [G]----|\n| C | G |\n", allow_sequence=True)
        self.assertNotIn("timing", a)
        self.assertEqual(len(a["bars"]), 3)

    def test_leading_dash_continues_previous_chord_and_misc_leniency(self):
        a = I.parse_txt(HEAD + "|[Dm]---[G]-----|-[A7]------- |\n|[C]|  # note\n|[F]---- [G]---- | free text\n"
                        "-- label --\n|[Dm]--------|[\n")
        self.assertEqual(a["bars"][1], [["G", 1], ["A7", 7]])
        self.assertEqual(len(a["bars"]), 5)
        with self.assertRaises(I.IntakeError):
            I.parse_txt(HEAD + "|-[C]-------|\n")  # nothing before it to continue

    def test_pickup_none(self):
        self.assertNotIn("pickupBeats", I.parse_txt(HEAD + "弱起: なし\n| C |\n"))

    def test_other_lines_still_error(self):
        with self.assertRaises(I.IntakeError) as cm:
            I.parse_txt(HEAD + "| C |\nただの文章\n")
        self.assertIn("6行目", str(cm.exception))
        with self.assertRaises(I.IntakeError) as cm:
            I.parse_txt(HEAD + "[H]歌\n", allow_sequence=True)
        self.assertIn("5行目", str(cm.exception))

    def test_sequence_take_end_to_end(self):
        with tempfile.TemporaryDirectory() as d:
            inbox = os.path.join(d, "recordings", "inbox")
            os.makedirs(inbox)
            click_wav(os.path.join(inbox, "x.wav"), 0.3)
            with open(os.path.join(inbox, "x.txt"), "w", encoding="utf-8", newline="") as f:
                f.write("bpm: 120\r\nキー: ?\r\n弾き方: b,e\r\n[C]la la[G]la\r\n[Am]la\r\n")
            rec = os.path.join(d, "recordings")
            I.process_take("x", I.scan_inbox(inbox)["x"], rec, os.path.join(d, "out"), log=lambda *_: None)
            truth = json.load(open(os.path.join(d, "out", "rec", "rec-01-b.truth.json")))
            self.assertEqual(truth["timing"], "sequence")
            self.assertEqual([c["text"] for c in truth["chordSequence"]], ["C", "G", "Am"])
            self.assertEqual(truth["chords"], [])
            ids = json.load(open(os.path.join(rec, "ids.local.json")))
            self.assertEqual(ids["recordings"]["rec-01-b"]["styles"], ["b", "e"])


class TestReparse(unittest.TestCase):
    SEQ = "bpm: 120\nキー: C\n弾き方: b\n[C]words [G]more\n[Am]last [F]line\n"
    BARS = "bpm: 120\nキー: C\n弾き方: b\n|[C]----[G]----|[Am]--------|\n"

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.rec = os.path.join(self.t.name, "recordings")
        self.inbox = os.path.join(self.rec, "inbox")
        self.out = os.path.join(self.t.name, "out")
        os.makedirs(self.inbox)
        click_wav(os.path.join(self.inbox, "Secret.wav"), 0.5)
        open(os.path.join(self.inbox, "Secret.txt"), "w", encoding="utf-8").write(self.SEQ)
        I.process_take("Secret", I.scan_inbox(self.inbox)["Secret"], self.rec, self.out, log=lambda m: None)
        self.orig = os.path.join(self.rec, "originals", "rec-01-b.txt")

    def tearDown(self):
        self.t.cleanup()

    def ann(self):
        return json.load(open(os.path.join(self.rec, "rec-01-b.chords.json"), encoding="utf-8"))

    def test_sequence_to_bars_keeps_id_and_held_out(self):
        self.assertEqual(self.ann()["timing"], "sequence")
        wav_before = open(os.path.join(self.rec, "rec-01-b.wav"), "rb").read()
        ids_before = json.load(open(os.path.join(self.rec, "ids.local.json")))
        open(self.orig, "w", encoding="utf-8").write(self.BARS)
        msgs = []
        self.assertEqual(I.reparse_take(self.rec, self.out, "rec-01-b", log=msgs.append, fit=False), ["rec-01-b"])
        a = self.ann()
        self.assertNotIn("timing", a)
        self.assertEqual(a["bars"], [[["C", 4], ["G", 4]], [["Am", 8]]])
        self.assertEqual(open(os.path.join(self.rec, "rec-01-b.wav"), "rb").read(), wav_before)
        ids = json.load(open(os.path.join(self.rec, "ids.local.json")))
        self.assertEqual(ids["recordings"]["rec-01-b"], ids_before["recordings"]["rec-01-b"])
        self.assertEqual(list(ids["recordings"]), ["rec-01-b"])
        truth = json.load(open(os.path.join(self.out, "rec", "rec-01-b.truth.json")))
        self.assertNotEqual(truth.get("timing"), "sequence")
        self.assertEqual(len(truth["chords"]), 3)
        man = json.load(open(os.path.join(self.out, "rec", "manifest.rec.json")))["variants"]
        self.assertEqual(len(man), 1)
        self.assertFalse(man[0]["heldOut"])
        log = [json.loads(l) for l in open(os.path.join(self.out, "results", "heldout-log.jsonl"))]
        self.assertEqual([l["kind"] for l in log], ["register", "reparse"])
        self.assertEqual((log[1]["take"], log[1]["heldOut"], log[1]["timing"]), ("rec-01-b", False, "bars"))
        self.assertNotIn("words", "".join(msgs))

    def test_dash_only_bar_and_bar_running_over_a_line(self):
        a = I.parse_txt("bpm: 120\n弾き方: b\n|[C]----[G]----|--------|\n|[Am]----[F]--\n--|[C]--------|\n")
        self.assertEqual(a["bars"], [[["C", 4], ["G", 4]], [["G", 8]], [["Am", 4], ["F", 4]], [["C", 8]]])
        with self.assertRaises(I.IntakeError) as cm:
            I.parse_txt("bpm: 120\n弾き方: b\n|[C]----[G]----|\n--|[C]--------|\n")
        self.assertIn("4行目", str(cm.exception))

    def test_leading_dashes_are_the_pickup(self):
        a = I.parse_txt("bpm: 120\n弾き方: b\n弱起: 1拍\n--|[C]--------|\n")
        self.assertEqual((a["bars"], a["pickupBeats"]), ([[["C", 8]]], 1))
        with self.assertRaises(I.IntakeError):
            I.parse_txt("bpm: 120\n弾き方: b\n--|[C]--------|\n")

    def test_failure_keeps_old_files(self):
        before = {n: open(os.path.join(self.rec, n), "rb").read() for n in ("rec-01-b.chords.json",)}
        truth = open(os.path.join(self.out, "rec", "rec-01-b.truth.json"), "rb").read()
        open(self.orig, "w", encoding="utf-8").write("bpm: 120\n弾き方: b\n| C |\n| Hm7 |\n")
        with self.assertRaises(I.IntakeError) as cm:
            I.reparse_take(self.rec, self.out, "rec-01-b", log=lambda m: None, fit=False)
        self.assertIn("4行目", str(cm.exception))
        for n, b in before.items():
            self.assertEqual(open(os.path.join(self.rec, n), "rb").read(), b)
        self.assertEqual(open(os.path.join(self.out, "rec", "rec-01-b.truth.json"), "rb").read(), truth)
        log = [json.loads(l) for l in open(os.path.join(self.out, "results", "heldout-log.jsonl"))]
        self.assertEqual(len(log), 1)
        # via main: error is printed, exit code 1
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = I.main(["--reparse", "rec-01-b", "--inbox", self.inbox, "--out", self.out, "--no-privacy-check"])
        self.assertEqual(rc, 1)
        self.assertIn("4行目", buf.getvalue())
        self.assertNotIn("Secret", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
