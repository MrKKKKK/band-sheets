"""check_alignment rules added in spike 2 (T4): whole-note strike times (Q4), comp 'rec', quiet limit."""
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import check_alignment as CA  # noqa: E402

SR = 22050
BEAT = 0.5  # 120 BPM
PCS = {"C": 0, "F": 5, "G": 7, "A": 9}


def _chord_burst(pcs, sec):
    n = int(round(sec * SR))
    t = np.arange(n) / SR
    y = sum(np.sin(2 * np.pi * 261.63 * 2 ** (pc / 12) * t) for pc in pcs)
    return y * np.exp(-t * 1.5)


def whole_truth(bars=8):
    """4/4, one chord per bar except bar 3 (C | F at beat 3); every bar struck on its downbeat."""
    beats = [{"t": round((b * 4 + k) * BEAT, 6), "downbeat": k == 0, "bar": b, "beat": k}
             for b in range(bars) for k in range(4)]
    roots = ["C", "F", "G", "C", "A", "F", "G", "C"][:bars]
    chords = []
    for b, r in enumerate(roots):
        chords.append({"start": b * 4 * BEAT, "end": (b + 1) * 4 * BEAT, "root": r, "quality": "maj"})
    # bar 3 changes on beat 3 (C -> F)
    chords[3]["end"] = (3 * 4 + 2) * BEAT
    chords.insert(4, {"start": (3 * 4 + 2) * BEAT, "end": 4 * 4 * BEAT, "root": "F", "quality": "maj"})
    return {"beats": beats, "chords": chords}


def render_whole(truth, shift_sec=0.0, sec=None):
    """Struck chords at every strike time (+ shift), each ringing until the next strike."""
    strikes = list(CA.strike_times(truth))
    end = truth["beats"][-1]["t"] + BEAT
    y = np.zeros(int(round((end + 1.0) * SR)))
    for i, s in enumerate(strikes):
        nxt = strikes[i + 1] if i + 1 < len(strikes) else end
        c = next(c for c in truth["chords"] if c["start"] <= s < c["end"])
        r = PCS[c["root"]]
        burst = _chord_burst([r, r + 4, r + 7], nxt - s)
        a = int(round((s + shift_sec) * SR))
        y[a:a + len(burst)] += burst[:max(0, len(y) - a)]
    return (0.25 * y / np.abs(y).max()).astype(np.float32)


def check(truth, y, comp="whole"):
    with tempfile.TemporaryDirectory() as d:
        sf.write(os.path.join(d, "w.wav"), y, SR)
        with open(os.path.join(d, "w.truth.json"), "w") as f:
            json.dump(truth, f)
        v = {"name": "w", "mix": "piano", "comp": comp, "wav": "w.wav", "truth": "w.truth.json"}
        _, checks, _ = CA.check_variant(d, v, [v])
    return {c["label"]: c for c in checks}


class StrikeTimesTest(unittest.TestCase):
    def test_downbeats_and_chord_starts(self):
        t = whole_truth(4)
        self.assertEqual(list(CA.strike_times(t)), [0.0, 2.0, 4.0, 6.0, 7.0])

    def test_whole_offsets_are_per_strike(self):
        t = whole_truth()
        strikes = CA.strike_times(t)
        onsets = strikes + 0.01
        d = CA.onset_offsets(onsets, [b["t"] for b in t["beats"]], "whole", t)
        self.assertEqual(len(d), len(strikes))
        self.assertAlmostEqual(float(np.median(d)), 0.01, places=6)

    def test_whole_beat_shift_is_seen_by_the_new_rule_only(self):
        t = whole_truth()
        beats = [b["t"] for b in t["beats"]]
        onsets = CA.strike_times(t) + BEAT  # the whole accompaniment one beat late
        old = CA.onset_offsets(onsets, beats, "whole")  # spike 1 rule: every onset is on some beat
        self.assertAlmostEqual(float(np.median(np.abs(old))), 0.0, places=6)
        new = CA.onset_offsets(onsets, beats, "whole", t)
        self.assertGreater(abs(float(np.median(new))) * 1000, 400)


class WholeEndToEndTest(unittest.TestCase):
    def test_aligned_whole_passes_and_one_beat_late_fails(self):
        t = whole_truth()
        ok = check(t, render_whole(t))
        self.assertTrue(ok["onset"]["ok"], ok["onset"]["text"])
        late = check(t, render_whole(t, shift_sec=BEAT))
        self.assertFalse(late["onset"]["ok"], late["onset"]["text"])
        self.assertTrue(late["onset"]["enforced"])


class RecCompTest(unittest.TestCase):
    def test_rec_is_scored_per_chord_span(self):
        # A chord change anticipated to the "and" of beat 2: the truth chord spans are not beat-aligned.
        beats = [{"t": i * BEAT, "downbeat": i % 4 == 0} for i in range(8)]
        t = {"beats": beats, "chords": [
            {"start": 0.0, "end": 1.25, "root": "C", "quality": "maj"},
            {"start": 1.25, "end": 4.0, "root": "F", "quality": "maj"}]}
        y = np.concatenate([_chord_burst([0, 4, 7], 1.25), _chord_burst([5, 9, 12], 2.75), np.zeros(SR)])
        y = (0.25 * y / np.abs(y).max()).astype(np.float32)
        ok_s, n_s = CA.chord_share(y, SR, t, by_span=True)
        self.assertEqual((ok_s, n_s), (2, 2))
        self.assertIn("rec", CA.BROKEN_COMPS)
        c = check(t, y, comp="rec")
        self.assertIn("per chord span", c["chord"]["text"])


class QuietLimitTest(unittest.TestCase):
    def test_quiet_limit_is_085_and_below_the_normal_one(self):
        self.assertEqual(CA.CHORD_MIN_SHARE_QUIET, 0.85)
        self.assertLess(CA.CHORD_MIN_SHARE_QUIET, 0.898)  # lowest observed quiet-piano share (spike 1 T15)
        self.assertEqual(CA.chord_min_share({"pianoGainDb": -9}), 0.85)


if __name__ == "__main__":
    unittest.main()
