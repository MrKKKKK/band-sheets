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
