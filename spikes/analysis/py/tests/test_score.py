import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import score as S  # noqa: E402

BI = 0.5  # beat interval (120 BPM)


def ch(start, end, root, quality):
    return {"start": start, "end": end, "root": root, "quality": quality, "bass": None, "confidence": 1}


def make_truth(chords=None, melody=None, sections=None, bars=4):
    beats = [{"t": i * BI, "downbeat": i % 4 == 0, "bar": i // 4, "beat": i % 4} for i in range(bars * 4)]
    return {
        "beats": beats,
        "timeSignature": {"num": 4, "den": 4, "confidence": 1},
        "chords": chords if chords is not None else [ch(0, 4, "C", "maj"), ch(4, 8, "G", "7")],
        "melody": {"notes": melody if melody is not None else [
            {"start": 0.0, "end": 0.5, "midi": 60, "confidence": 1},
            {"start": 0.5, "end": 1.0, "midi": 62, "confidence": 1},
            {"start": 1.0, "end": 1.5, "midi": 64, "confidence": 1}]},
        "sections": sections if sections is not None else [
            {"start": 0, "end": 4, "label": "A"}, {"start": 4, "end": 8, "label": "B"}],
    }


def shifted(truth, dt):
    r = copy.deepcopy(truth)
    for b in r["beats"]:
        b["t"] += dt
    return r


class ScoreTest(unittest.TestCase):
    def test_self_is_perfect(self):
        t = make_truth()
        s = S.score(t, copy.deepcopy(t))
        self.assertEqual(s["beats"]["f"], 1.0)
        self.assertEqual(s["downbeats"]["f"], 1.0)
        self.assertEqual(s["chords"]["perBeat"], 1.0)
        self.assertEqual(s["chords"]["perBar"], 1.0)
        self.assertEqual(s["chords"]["seventhRecall"], 1.0)
        self.assertEqual(s["chords"]["seventhPrecision"], 1.0)
        self.assertEqual(s["chords"]["majminWeighted"], 1.0)
        self.assertEqual(s["melody"]["f1"], 1.0)
        self.assertEqual(s["sections"]["f"], 1.0)

    def test_beat_shift_60_hits_80_misses(self):
        t = make_truth()
        self.assertEqual(S.score(t, shifted(t, 0.06))["beats"]["f"], 1.0)
        self.assertEqual(S.score(t, shifted(t, 0.08))["beats"]["f"], 0.0)

    def test_first_five_seconds_not_trimmed(self):
        # all truth beats are within 5 s; evaluate() would trim them all
        t = make_truth(bars=2)
        self.assertEqual(S.score(t, t)["beats"]["f"], 1.0)

    def test_enharmonic_roots_equal(self):
        t = make_truth(chords=[ch(0, 4, "C#", "maj"), ch(4, 8, "B", "min")])
        r = make_truth(chords=[ch(0, 4, "Db", "maj"), ch(4, 8, "Cb", "min")])
        self.assertEqual(S.score(t, r)["chords"]["perBeat"], 1.0)
        self.assertEqual(S.note_to_pc("B#"), 0)
        self.assertEqual(S.note_to_pc("Cb"), 11)
        r2 = make_truth(chords=[ch(0, 4, "D", "maj"), ch(4, 8, "B", "min")])
        self.assertEqual(S.score(t, r2)["chords"]["perBeat"], 0.5)

    def test_majmin_class_mapping(self):
        self.assertEqual([S.quality_class(q) for q in ("maj", "7", "maj7")], ["maj"] * 3)
        self.assertEqual([S.quality_class(q) for q in ("min", "min7")], ["min"] * 2)
        self.assertIsNone(S.quality_class("dim"))
        t = make_truth(chords=[ch(0, 8, "C", "maj")])
        r = make_truth(chords=[ch(0, 8, "C", "min")])
        self.assertEqual(S.score(t, r)["chords"]["perBeat"], 0.0)
        r = make_truth(chords=[ch(0, 8, "C", "maj7")])
        self.assertEqual(S.score(t, r)["chords"]["perBeat"], 1.0)

    def test_no_chord_beats_skipped(self):
        t = make_truth(chords=[ch(4, 8, "G", "maj")])  # first 8 beats have no truth chord
        r = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "G", "maj")])
        c = S.score(t, r)["chords"]
        self.assertEqual(c["nBeatsScored"], 8)
        self.assertEqual(c["perBeat"], 1.0)

    def test_dim_beats_excluded(self):
        t = make_truth(chords=[ch(0, 4, "C", "dim"), ch(4, 8, "G", "maj")])
        r = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "G", "maj")])
        c = S.score(t, r)["chords"]
        self.assertEqual(c["nBeatsScored"], 8)
        self.assertEqual(c["nBeatsExcluded"], 8)
        self.assertEqual(c["perBeat"], 1.0)

    def test_seventh_recall_precision(self):
        t = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "G", "7")])
        r = make_truth(chords=[ch(0, 4, "C", "maj7"), ch(4, 8, "G", "7")])
        c = S.score(t, r)["chords"]
        self.assertEqual(c["perBeat"], 1.0)
        self.assertEqual(c["seventhRecall"], 1.0)
        self.assertEqual(c["seventhPrecision"], 0.5)
        self.assertEqual((c["nSeventhTruth"], c["nSeventhResult"], c["nSeventhHit"]), (8, 16, 8))

    def test_constant_triad_has_zero_seventh_recall(self):
        t = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "C", "maj7")])
        r = make_truth(chords=[ch(0, 8, "C", "maj")])
        c = S.score(t, r)["chords"]
        self.assertEqual(c["perBeat"], 1.0)
        self.assertEqual(c["seventhRecall"], 0.0)
        self.assertIsNone(c["seventhPrecision"])

    def test_per_bar_tie_boundary_shift(self):
        # truth bar 0 = C 2 beats + Am 2 beats; result boundary 10 ms early or late
        t = make_truth(chords=[ch(0, 1, "C", "maj"), ch(1, 2, "A", "min"), ch(2, 8, "C", "maj")], bars=4)
        for eps in (-0.01, 0.0, 0.01):
            r = make_truth(chords=[ch(0, 1 + eps, "C", "maj"), ch(1 + eps, 2, "A", "min"), ch(2, 8, "C", "maj")], bars=4)
            c = S.score(t, r)["chords"]
            self.assertEqual(c["perBeat"], 1.0 if eps == 0 else c["perBeat"])
            self.assertEqual(c["perBar"], 1.0, eps)
        # a clearly longer wrong chord is still a miss
        r = make_truth(chords=[ch(0, 2, "F", "maj"), ch(2, 8, "C", "maj")], bars=4)
        self.assertEqual(S.score(t, r)["chords"]["perBar"], 0.75)

    def test_tail_beats_after_truth_not_penalized(self):
        # R5: analyzer beats in the ring-out after the last truth beat (> last + half interval) are not scored
        t = make_truth()
        r = copy.deepcopy(t)
        last = t["beats"][-1]["t"]
        r["beats"] += [{"t": last + BI * k, "downbeat": k % 4 == 0} for k in range(1, 12)]
        s = S.score(t, r)
        self.assertEqual(s["beats"]["f"], 1.0)
        self.assertEqual(s["beats"]["nEst"], len(t["beats"]))
        self.assertEqual(s["downbeats"]["f"], 1.0)
        # beats before the first truth beat (minus tolerance) are dropped too
        r["beats"].insert(0, {"t": t["beats"][0]["t"] - 0.3, "downbeat": False})
        self.assertEqual(S.score(t, r)["beats"]["f"], 1.0)

    def test_extra_beat_inside_window_is_still_an_error(self):
        t = make_truth()
        r = copy.deepcopy(t)
        r["beats"].append({"t": t["beats"][-1]["t"] + 0.2, "downbeat": False})  # < half interval after last
        self.assertLess(S.score(t, r)["beats"]["f"], 1.0)

    def test_chord_boundary_at_beat_midpoint_is_not_ambiguous(self):
        # R6: truth changes C -> G exactly at the midpoint of beat 2 (t=1.25); a result boundary
        # 10 ms either side must score the same (eighth-note resolution), while the old
        # midpoint sampling flipped one half of beat 2.
        t = make_truth(chords=[ch(0, 1.25, "C", "maj"), ch(1.25, 8, "G", "maj")])
        sc = []
        for eps in (-0.01, 0.0, 0.01):
            r = make_truth(chords=[ch(0, 1.25 + eps, "C", "maj"), ch(1.25 + eps, 8, "G", "maj")])
            c = S.score(t, r)["chords"]
            self.assertEqual(c["perBeat"], 1.0, eps)
            sc.append(c["perBeatMidpoint"])
        self.assertNotEqual(sc[0], sc[2])  # the legacy value is the ambiguous one
        # half a beat wrong (result switches one eighth late) costs exactly half a beat of 16
        r = make_truth(chords=[ch(0, 1.5, "C", "maj"), ch(1.5, 8, "G", "maj")])
        c = S.score(t, r)["chords"]
        self.assertAlmostEqual(c["perBeat"], 15.5 / 16)
        self.assertEqual(c["nBeatsScored"], 16)

    def test_last_beat_no_chord_is_a_miss_and_chord_is_a_hit(self):
        # R8: scoring side of the last beat: truth covers it (window extended by a median interval)
        t = make_truth(chords=[ch(0, 8, "C", "maj")])
        r_n = make_truth(chords=[ch(0, 7.5, "C", "maj")])  # no chord on the last beat
        c = S.score(t, r_n)["chords"]
        self.assertEqual(c["nBeatsScored"], 16)
        self.assertAlmostEqual(c["perBeat"], 15 / 16)
        r_ok = make_truth(chords=[ch(0, 8, "C", "maj")])
        self.assertEqual(S.score(t, r_ok)["chords"]["perBeat"], 1.0)
        # a truth whose last chord ends before the last beat: that beat is simply not counted
        t2 = make_truth(chords=[ch(0, 7.5, "C", "maj")])
        c2 = S.score(t2, r_n)["chords"]
        self.assertEqual(c2["nBeatsScored"], 15)
        self.assertEqual(c2["perBeat"], 1.0)

    def test_downbeats_none_without_flags(self):
        t = make_truth()
        r = {"beats": [{"t": b["t"]} for b in t["beats"]]}
        s = S.score(t, r)
        self.assertEqual(s["beats"]["f"], 1.0)
        self.assertIsNone(s["downbeats"])
        r = {"beats": [{"t": b["t"], "downbeat": False} for b in t["beats"]]}
        self.assertEqual(S.score(t, r)["downbeats"]["f"], 0.0)

    def test_no_chord_root_n(self):
        t = make_truth(chords=[ch(0, 4, "N", "maj"), ch(4, 8, "G", "maj")])
        r = make_truth(chords=[ch(0, 4, "N", "maj"), ch(4, 8, "G", "maj")])
        c = S.score(t, r)["chords"]
        self.assertEqual(c["nBeatsScored"], 8)
        self.assertEqual(c["perBeat"], 1.0)
        r2 = make_truth(chords=[ch(0, 8, "N", "maj")])
        c2 = S.score(t, r2)["chords"]
        self.assertEqual(c2["perBeat"], 0.0)
        self.assertEqual(S.score(make_truth(chords=[ch(0, 8, "N", "maj")]), r)["chords"]["perBeat"], None)

    def test_unknown_quality_counted(self):
        t = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "G", "maj")])
        r = make_truth(chords=[ch(0, 4, "C", "maj6"), ch(4, 8, "G", "maj")])
        c = S.score(t, r)["chords"]
        self.assertEqual(c["perBeat"], 0.5)
        self.assertEqual(c["nBeatsUnknownQualityResult"], 8)
        self.assertLess(c["majminWeighted"], 0.51)
        c = S.score(r, t)["chords"]  # unknown quality in truth: excluded, counted
        self.assertEqual(c["nBeatsUnknownQualityTruth"], 8)
        self.assertEqual(c["nBeatsExcluded"], 8)
        self.assertEqual(c["nBeatsScored"], 8)

    def test_leading_silence_offset(self):
        t = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "G", "maj")])
        off = 1.37
        for b in t["beats"]:
            b["t"] += off
        for c in t["chords"]:
            c["start"] += off
            c["end"] += off
        c = S.score(t, copy.deepcopy(t))["chords"]
        self.assertEqual(c["perBeat"], 1.0)
        self.assertEqual(c["perBar"], 1.0)
        self.assertEqual(c["majminWeighted"], 1.0)

    def test_per_bar_majority(self):
        # bar 0: truth C for 3 beats, G for 1; result C for 1 beat, G for 3 -> miss
        # bar 1: truth C all; result C for 3 beats, F for 1 -> hit
        t = make_truth(chords=[ch(0, 1.5, "C", "maj"), ch(1.5, 2, "G", "maj"), ch(2, 4, "C", "maj")])
        r = make_truth(chords=[ch(0, 0.5, "C", "maj"), ch(0.5, 2, "G", "maj"),
                               ch(2, 3.5, "C", "maj"), ch(3.5, 4, "F", "maj")])
        c = S.score(t, r)["chords"]
        self.assertEqual(c["nBarsScored"], 2)
        self.assertEqual(c["perBar"], 0.5)
        self.assertEqual(c["perBeat"], 0.625)  # 5 of 8 beats

    def test_short_notes_ignored(self):
        # 16th at 120 BPM = 0.125 s; a 0.1 s note is dropped from both sides
        notes = [{"start": 0.0, "end": 0.5, "midi": 60, "confidence": 1},
                 {"start": 1.0, "end": 1.1, "midi": 70, "confidence": 1}]
        t = make_truth(melody=notes)
        r = make_truth(melody=[notes[0]])
        m = S.score(t, r)["melody"]
        self.assertEqual(m["nRef"], 1)
        self.assertEqual(m["f1"], 1.0)
        r2 = make_truth(melody=notes + [{"start": 2.0, "end": 2.05, "midi": 50, "confidence": 1}])
        self.assertEqual(S.score(t, r2)["melody"]["f1"], 1.0)

    def test_melody_pitch_and_onset(self):
        notes = [{"start": 0.0, "end": 0.5, "midi": 60, "confidence": 1}]
        t = make_truth(melody=notes)
        near = make_truth(melody=[{"start": 0.04, "end": 0.6, "midi": 60, "confidence": 1}])
        self.assertEqual(S.score(t, near)["melody"]["f1"], 1.0)
        late = make_truth(melody=[{"start": 0.1, "end": 0.6, "midi": 60, "confidence": 1}])
        self.assertEqual(S.score(t, late)["melody"]["f1"], 0.0)
        wrong = make_truth(melody=[{"start": 0.0, "end": 0.5, "midi": 61, "confidence": 1}])
        self.assertEqual(S.score(t, wrong)["melody"]["f1"], 0.0)

    def test_sections_window(self):
        t = make_truth()  # boundary at 4.0, bar = 2.0 s
        near = make_truth(sections=[{"start": 0, "end": 4.9, "label": "A"}, {"start": 4.9, "end": 8, "label": "B"}])
        self.assertEqual(S.score(t, near)["sections"]["f"], 1.0)
        far = make_truth(sections=[{"start": 0, "end": 6.5, "label": "A"}, {"start": 6.5, "end": 8, "label": "B"}])
        self.assertEqual(S.score(t, far)["sections"]["f"], 0.0)

    def test_missing_fields_are_null(self):
        t = make_truth()
        s = S.score(t, {"format": "band-sheets-analysis"})
        self.assertTrue(all(v is None for v in s.values()))
        s = S.score(t, {"beats": t["beats"]})
        self.assertEqual(s["beats"]["f"], 1.0)
        self.assertIsNone(s["chords"])
        self.assertIsNone(s["melody"])
        self.assertIsNone(s["sections"])
        # missing in truth
        t2 = {"beats": t["beats"]}
        s = S.score(t2, make_truth())
        self.assertIsNone(s["chords"])
        self.assertIsNone(s["melody"])
        self.assertIsNone(s["sections"])

    def test_empty_result_lists_score_zero(self):
        t = make_truth()
        r = {"beats": [], "chords": [], "melody": {"notes": []}, "sections": []}
        s = S.score(t, r)
        self.assertEqual(s["beats"]["f"], 0.0)
        self.assertEqual(s["chords"]["perBeat"], 0.0)
        self.assertEqual(s["chords"]["majminWeighted"], 0.0)
        self.assertEqual(s["melody"]["f1"], 0.0)
        self.assertEqual(s["sections"]["f"], 0.0)


class MapVocabTest(unittest.TestCase):
    TABLE = {
        # triads and canonical names pass through
        "maj": "maj", "min": "min", "7": "7", "maj7": "maj7", "min7": "min7", "dim": "dim", "aug": "aug",
        "sus4": "sus4", "m7b5": "m7b5", "dim7": "dim7",
        # 6 / add9 -> underlying triad
        "6": "maj", "add9": "maj", "6/9": "maj", "m6": "min", "madd9": "min",
        # dominant tensions -> 7
        "7(#9)": "7", "7(b9)": "7", "9": "7", "13": "7", "7(#11)": "7", "7(b13)": "7", "7b9": "7", "11": "7",
        # maj7 family
        "M7": "maj7", "M9": "maj7", "maj9": "maj7", "maj7(#11)": "maj7", "M13": "maj7",
        # minor 7 family
        "m7": "min7", "m9": "min7", "m11": "min7", "m13": "min7", "-7": "min7", "min9": "min7",
        # sus
        "7sus4": "sus4", "sus": "sus4", "9sus4": "sus4",
        # m7b5 spellings
        "m9b5": "m7b5", "m7(b5)": "m7b5", "\u00f8": "m7b5",
        # dropped (outside the vocabulary)
        "7(b5)": None, "7(#5)": None, "aug7": None, "+7": None, "9#5": None, "mM7": None, "m(maj7)": None,
        "sus2": None, "weird": None,
    }

    def test_table(self):
        for q, want in self.TABLE.items():
            with self.subTest(quality=q):
                self.assertEqual(S.map_vocab(q), want)

    def test_triad_classes(self):
        got = {q: S.vocab_triad(q) for q in S.VOCAB_QUALITIES}
        self.assertEqual(got["7"], "maj")
        self.assertEqual(got["maj7"], "maj")
        self.assertEqual(got["min7"], "min")
        self.assertEqual(got["m7b5"], "dim")
        self.assertEqual(got["dim7"], "dim")
        self.assertEqual(got["aug"], "aug")
        self.assertEqual(got["sus4"], "sus4")


class VocabScoreTest(unittest.TestCase):
    def test_spike1_numbers_unchanged_by_vocab(self):
        t = make_truth()
        s = S.score(t, copy.deepcopy(t))["chords"]
        self.assertEqual((s["perBeat"], s["perBar"], s["majminWeighted"], s["nBeatsExcluded"]), (1.0, 1.0, 1.0, 0))

    def test_tension_truth_is_scored_against_underlying_chord(self):
        # truth C [0,4), G7(#9) [4,8); result C, G7: vocab 16/16 beats (8 s at 2 samples/beat), spike-1 excludes the G7(#9) half
        t = make_truth(chords=[ch(0, 4, "C", "6"), ch(4, 8, "G", "7(#9)")])
        r = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "G", "7")])
        c = S.score(t, r)["chords"]
        self.assertEqual(c["vocab"]["perBeat"], 1.0)
        self.assertEqual(c["vocab"]["nBeatsScored"], 16)
        self.assertEqual(c["nBeatsUnknownQualityTruth"], 16)  # spike-1 side: both are unknown qualities, unchanged

    def test_vocab_quality_miss_but_triad_class_hit(self):
        t = make_truth(chords=[ch(0, 4, "C", "maj7"), ch(4, 8, "A", "m7b5")])
        r = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "A", "dim")])
        v = S.score(t, r)["chords"]["vocab"]
        self.assertEqual(v["perBeat"], 0.0)
        self.assertEqual(v["triadPerBeat"], 1.0)

    def test_dropped_forms_are_counted_not_scored(self):
        t = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "G", "7(b5)")])
        r = make_truth(chords=[ch(0, 4, "C", "maj"), ch(4, 8, "G", "7")])
        v = S.score(t, r)["chords"]["vocab"]
        self.assertEqual((v["nBeatsScored"], v["nBeatsDropped"], v["perBeat"]), (8, 8, 1.0))

    def test_aug_and_sus4_are_scored_in_vocab(self):
        t = make_truth(chords=[ch(0, 4, "C", "aug"), ch(4, 8, "G", "7sus4")])
        r = make_truth(chords=[ch(0, 4, "C", "aug"), ch(4, 8, "G", "sus4")])
        v = S.score(t, r)["chords"]["vocab"]
        self.assertEqual((v["nBeatsScored"], v["perBeat"]), (16, 1.0))

    def test_slash_bass_recorded(self):
        tc = [ch(0, 4, "C", "maj"), ch(4, 8, "G", "7")]
        tc[0]["bass"] = "E"
        t = make_truth(chords=tc)
        rc = [ch(0, 4, "C", "maj"), ch(4, 8, "G", "7")]
        r = make_truth(chords=rc)
        v = S.score(t, r)["chords"]["vocab"]
        self.assertEqual((v["nBassScored"], v["nBassHit"], v["bassPerBeat"]), (8, 0, 0.0))
        rc[0]["bass"] = "E"
        v = S.score(t, make_truth(chords=rc))["chords"]["vocab"]
        self.assertEqual((v["nBassHit"], v["bassPerBeat"]), (8, 1.0))
        self.assertIsNone(S.score(make_truth(), make_truth())["chords"]["vocab"]["bassPerBeat"])


class KeyScoreTest(unittest.TestCase):
    """4 bars of 4 beats (2 s per bar). Truth keys: C from bar 0, G from bar 2."""

    def truth(self):
        t = make_truth()
        t["keys"] = [{"startBar": 0, "key": "C"}, {"startBar": 2, "key": "G"}]
        return t

    def result(self, keys):
        r = copy.deepcopy(make_truth())
        r["keys"] = [{"startBar": b, "tonic": k, "mode": m, "confidence": 1.0} for b, k, m in keys]
        return r

    def test_exact(self):
        k = S.score(self.truth(), self.result([(0, "C", "major"), (2, "G", "major")]))["keys"]
        self.assertEqual((k["perBar"], k["nearPerBar"], k["changeF"]), (1.0, 1.0, 1.0))
        self.assertEqual((k["nBars"], k["nChangeRef"], k["nChangeEst"], k["nChangeHit"]), (4, 1, 1, 1))

    def test_late_change_within_one_bar(self):
        # result bars C C C G: 3/4 bars; change at bar 3 vs truth bar 2 -> within +-1 -> F 1.0
        k = S.score(self.truth(), self.result([(0, "C", "major"), (3, "G", "major")]))["keys"]
        self.assertEqual((k["nBarsHit"], k["perBar"], k["changeF"]), (3, 0.75, 1.0))

    def test_change_two_bars_off_and_global_key(self):
        t = self.truth()
        t["keys"] = [{"startBar": 0, "key": "C"}, {"startBar": 1, "key": "G"}]
        k = S.score(t, self.result([(0, "C", "major"), (3, "G", "major")]))["keys"]
        self.assertEqual(k["changeF"], 0.0)
        # global key only (no `keys`): C major for all bars -> 1/4 bars of G truth wrong... truth C,G,G,G -> 1 hit
        r = copy.deepcopy(make_truth())
        r["key"] = {"tonic": "C", "mode": "major", "confidence": 0.5}
        k = S.score(t, r)["keys"]
        self.assertEqual((k["nBarsHit"], k["nChangeEst"], k["changeF"]), (1, 0, 0.0))

    def test_near_keys_and_minor(self):
        t = make_truth()
        t["keys"] = [{"startBar": 0, "key": "C"}]
        k = S.score(t, self.result([(0, "A", "minor")]))["keys"]  # relative minor
        self.assertEqual((k["perBar"], k["nearPerBar"], k["changeF"]), (0.0, 1.0, None))
        k = S.score(t, self.result([(0, "F#", "major")]))["keys"]
        self.assertEqual(k["nearPerBar"], 0.0)
        t["keys"] = [{"startBar": 0, "key": "Am"}]
        self.assertEqual(S.score(t, self.result([(0, "A", "minor")]))["keys"]["perBar"], 1.0)
        self.assertEqual(S.score(t, self.result([(0, "A", "major")]))["keys"]["nearPerBar"], 1.0)  # parallel

    def test_result_with_truth_style_keys_entries(self):
        # oracle copies truth `keys` ({startBar, key}) into the result; must not KeyError('tonic')
        t = self.truth()
        k = S.score(t, copy.deepcopy(t))["keys"]
        self.assertEqual(k["perBar"], 1.0)

    def test_no_truth_keys_is_none(self):
        self.assertIsNone(S.score(make_truth(), make_truth())["keys"])


if __name__ == "__main__":
    unittest.main()


class OutsideWindowBeatsTest(unittest.TestCase):
    """Q7: analyzer beats outside the scored window are counted (before / after), not hidden."""

    def test_counts_before_and_after(self):
        t = make_truth()
        r = copy.deepcopy(t)
        last = t["beats"][-1]["t"]
        r["beats"].insert(0, {"t": t["beats"][0]["t"] - 0.3, "downbeat": False})  # 1 before
        r["beats"] += [{"t": last + BI * k, "downbeat": False} for k in (1, 2)]  # 2 after
        b = S.score(t, r)["beats"]
        self.assertEqual(b["nEstOutsideBefore"], 1)
        self.assertEqual(b["nEstOutsideAfter"], 2)
        self.assertEqual(b["nEst"], len(t["beats"]))  # in-window count unchanged
        self.assertEqual(b["f"], 1.0)

    def test_zero_when_nothing_outside(self):
        t = make_truth()
        b = S.score(t, copy.deepcopy(t))["beats"]
        self.assertEqual((b["nEstOutsideBefore"], b["nEstOutsideAfter"]), (0, 0))

    def test_extra_beat_inside_window_is_not_outside(self):
        t = make_truth()
        r = copy.deepcopy(t)
        r["beats"].append({"t": t["beats"][-1]["t"] + 0.2, "downbeat": False})
        b = S.score(t, r)["beats"]
        self.assertEqual((b["nEstOutsideBefore"], b["nEstOutsideAfter"]), (0, 0))
