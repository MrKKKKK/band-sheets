import json
import os
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import baseline  # noqa: E402
import check_alignment as CA  # noqa: E402
import run_all as RA  # noqa: E402
import score as S  # noqa: E402

SR = 44100


def make_truth(duration=8.0, bpm=120):
    bi = 60.0 / bpm
    n = int(duration / bi)
    beats = [{"t": i * bi, "downbeat": i % 4 == 0, "bar": i // 4, "beat": i % 4} for i in range(n)]
    return {
        "format": "band-sheets-analysis", "version": 1,
        "source": {"kind": "synthetic", "durationSec": duration},
        "analyzer": {"name": "ground-truth", "version": "0.1.0", "methods": []},
        "beats": beats,
        "timeSignature": {"num": 4, "den": 4, "confidence": 1},
        "chords": [
            {"start": 0, "end": 4, "root": "G", "quality": "min", "bass": None, "text": "Gm", "confidence": 1},
            {"start": 4, "end": duration, "root": "C", "quality": "7", "bass": None, "text": "C7", "confidence": 1}],
        "melody": {"notes": [{"start": 0.0, "end": 0.5, "midi": 60, "confidence": 1},
                             {"start": 0.5, "end": 1.0, "midi": 62, "confidence": 1}]},
        "sections": [{"start": 0, "end": 4, "label": "A"}, {"start": 4, "end": duration, "label": "B"}],
    }


def write_clicks(path, times, duration):
    y = np.zeros(int(duration * SR), dtype=np.float32)
    n = int(0.03 * SR)
    tone = (np.sin(2 * np.pi * 1000 * np.arange(n) / SR) * np.hanning(n)).astype(np.float32)
    for t in times:
        i = int(round(t * SR))
        if i + n <= len(y):
            y[i:i + n] += tone
    sf.write(path, y, SR, subtype="PCM_16")


class TestBaseline(unittest.TestCase):
    def test_constant_shape(self):
        r = baseline.constant_from_truth(make_truth(duration=8.0))
        self.assertEqual(r["analyzer"]["name"], "constant")
        self.assertEqual(len(r["beats"]), 16)
        self.assertEqual(r["beats"][1]["t"], 0.5)
        self.assertEqual([b["downbeat"] for b in r["beats"][:5]], [True, False, False, False, True])
        self.assertEqual(len(r["chords"]), 1)
        self.assertEqual((r["chords"][0]["root"], r["chords"][0]["quality"]), ("C", "maj"))
        self.assertEqual(r["chords"][0]["end"], 8.0)
        self.assertEqual(len(r["sections"]), 1)
        self.assertNotIn("melody", r)

    def test_constant_ignores_answers(self):
        a = make_truth()
        b = make_truth(bpm=90)
        b["chords"] = []
        self.assertEqual(baseline.constant_from_truth(a), baseline.constant_from_truth(b))

    def test_constant_scores(self):
        t = make_truth()
        s = S.score(t, baseline.constant_from_truth(t))
        self.assertAlmostEqual(s["beats"]["f"], 1.0)
        self.assertIsNone(s["melody"])

    def test_oracle_all_ones(self):
        t = make_truth()
        r = baseline.oracle(t)
        self.assertEqual(r["analyzer"]["name"], "oracle")
        self.assertEqual(t["analyzer"]["name"], "ground-truth")
        s = S.score(t, r)
        self.assertAlmostEqual(s["beats"]["f"], 1.0)
        self.assertAlmostEqual(s["downbeats"]["f"], 1.0)
        for k in ("perBeat", "perBar", "majminWeighted"):
            self.assertAlmostEqual(s["chords"][k], 1.0)
        self.assertAlmostEqual(s["melody"]["f1"], 1.0)

    def test_wav_duration(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.wav")
            write_clicks(p, [0.5], 2.0)
            self.assertAlmostEqual(baseline.wav_duration(p), 2.0, places=3)


class TestRunAll(unittest.TestCase):
    def test_summary(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "song"))
            for n in ("a", "b"):
                with open(os.path.join(d, "song", f"{n}.truth.json"), "w") as f:
                    json.dump(make_truth(), f)
            manifest = {"variants": [
                {"name": "a", "song": "song", "wav": "song/a.wav", "truth": "song/a.truth.json"},
                {"name": "b", "song": "song", "wav": "song/b.wav"}]}
            with open(os.path.join(d, "manifest.json"), "w") as f:
                json.dump(manifest, f)
            rows, _ = RA.run_all(d)
            self.assertEqual(len(rows), 4)
            res = os.path.join(d, "results")
            for n in ("a.constant.json", "a.oracle.json", "b.oracle.json", "summary.md", "summary.csv"):
                self.assertTrue(os.path.exists(os.path.join(res, n)), n)
            md = open(os.path.join(res, "summary.md")).read()
            self.assertIn("未評価", md)  # constant has no melody
            self.assertIn("7th recall", md)
            self.assertIn("7th prec", md)
            self.assertIn("oracle", md)
            self.assertEqual(len(open(os.path.join(res, "summary.csv")).read().strip().splitlines()), 5)


def write_chords(path, truth, shift=0.0, with_clicks=False, extra_tail=2.0):
    """Decaying triad on every truth beat (+ optional 1 kHz clicks), so onsets and chroma are testable."""
    dur = truth["source"]["durationSec"] + extra_tail
    y = np.zeros(int(dur * SR), dtype=np.float64)
    chords = truth["chords"]
    for i, b in enumerate(truth["beats"]):
        t = b["t"]
        c = next(c for c in chords if c["start"] <= t + 0.25 < c["end"])
        root = S.note_to_pc(c["root"])
        third = 3 if S.quality_class(c["quality"]) == "min" else 4
        n = int(0.4 * SR)
        x = np.arange(n) / SR
        env = np.exp(-6 * x) * np.minimum(1.0, (0.4 - x) / 0.1)
        for pc in (root, root + third, root + 7):
            f = 261.63 * 2 ** (pc / 12)
            tone = np.sin(2 * np.pi * f * x) * env * 0.2
            s = int(round((t + shift) * SR))
            if s < 0:
                continue
            y[s:s + n] += tone[:min(n, len(y) - s)]
    if with_clicks:
        n = int(0.03 * SR)
        click = np.sin(2 * np.pi * 1000 * np.arange(n) / SR) * np.hanning(n) * 0.5
        for b in truth["beats"]:
            s = int(round((b["t"] + shift) * SR))
            if s >= 0:
                y[s:s + n] += click
    sf.write(path, y.astype(np.float32), SR, subtype="PCM_16")


class TestAlignment(unittest.TestCase):
    def _run(self, shift, click_shift=None, offset=0.0, with_click_variant=True, wav_longer=True):
        with tempfile.TemporaryDirectory() as d:
            truth = make_truth(duration=8.0)
            for b in truth["beats"]:
                b["t"] += offset
            for c in truth["chords"]:
                c["start"] += offset
                c["end"] += offset
            for n in truth["melody"]["notes"]:
                n["start"] += offset
                n["end"] += offset
            truth["source"]["durationSec"] = 8.0 + offset
            os.makedirs(os.path.join(d, "s"))
            write_chords(os.path.join(d, "s", "p.wav"), truth, shift)
            variants = [
                {"name": "p", "mix": "piano", "click": False, "extraField": 1, "wav": "s/p.wav", "truth": "s/p.truth.json"},
                {"name": "q", "mix": "full", "wav": "s/missing.wav", "truth": "s/p.truth.json"}]
            if with_click_variant:
                write_chords(os.path.join(d, "s", "p-click.wav"), truth, shift,
                             with_clicks=True)
                if click_shift is not None:  # clicks drift relative to the truth
                    write_chords(os.path.join(d, "s", "p-click.wav"), truth, click_shift, with_clicks=True)
                    write_chords(os.path.join(d, "s", "p.wav"), truth, click_shift)
                variants.append({"name": "p-click", "mix": "piano", "click": True,
                                 "wav": "s/p-click.wav", "truth": "s/p.truth.json"})
            with open(os.path.join(d, "s", "p.truth.json"), "w") as f:
                json.dump(truth, f)
            with open(os.path.join(d, "manifest.json"), "w") as f:
                json.dump({"variants": variants, "alphaTab": "1.8.4", "seed": 1}, f)
            rows = CA.check(d)
            return {r[0]: r for r in rows}, CA.main(["--out", d])

    def test_aligned(self):
        rows, code = self._run(0.0)
        labels = {c["label"]: c for c in rows["p"][2]}
        self.assertEqual(set(labels), {"onset", "edge", "chord"})
        self.assertTrue(all(c["ok"] for c in labels.values()), labels)
        self.assertEqual(labels["chord"]["value"], 1.0)
        self.assertTrue(rows["p-click"][2][0]["ok"], rows["p-click"][2])
        self.assertTrue(rows["q"][2][0]["text"].startswith("SKIP"))  # missing wav of non-piano: tolerated
        self.assertEqual(code, 0)

    def test_leading_silence(self):
        rows, code = self._run(0.0, offset=1.37)
        self.assertTrue(all(c["ok"] for c in rows["p"][2]), rows["p"])
        self.assertEqual(code, 0)

    def test_shifted(self):
        rows, code = self._run(0.05, with_click_variant=False)
        self.assertFalse(next(c for c in rows["p"][2] if c["label"] == "onset")["ok"])
        self.assertEqual(code, 1)

    def test_click_shift_detected_both_signs(self):
        for shift in (0.012, -0.012):  # beat 0 at negative shift is dropped, so use offset truth
            rows, code = self._run(0.0, click_shift=shift, offset=0.5)
            c = rows["p-click"][2][0]
            self.assertFalse(c["ok"], c)
            self.assertAlmostEqual(c["value"], shift, delta=0.002)
            self.assertEqual(code, 1)

    def test_edge_first_sample_and_drum_events(self):
        with tempfile.TemporaryDirectory() as d:
            truth = make_truth()
            truth["drums"] = [{"t": 7.75, "inst": "CR", "strength": 1, "confidence": 1}]
            write_chords(os.path.join(d, "p.wav"), truth)
            y, _ = sf.read(os.path.join(d, "p.wav"))
            n = int(0.05 * SR)  # a drum hit off the beat grid at the end
            y[int(7.75 * SR):int(7.75 * SR) + n] += 0.3 * np.sin(2 * np.pi * 3000 * np.arange(n) / SR) * np.hanning(n)
            sf.write(os.path.join(d, "p.wav"), y.astype(np.float32), SR, subtype="PCM_16")
            with open(os.path.join(d, "p.truth.json"), "w") as f:
                json.dump(truth, f)
            v = {"name": "p", "mix": "piano", "wav": "p.wav", "truth": "p.truth.json"}
            _, checks, _ = CA.check_variant(d, v, [v])
            edge = next(c for c in checks if c["label"] == "edge")
            self.assertTrue(edge["ok"], edge)
            self.assertIn("first onset +0.0 ms", edge["text"])

    def test_click_without_partner_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            truth = make_truth()
            write_chords(os.path.join(d, "c.wav"), truth, with_clicks=True)
            items = [{"name": "c-click", "mix": "full", "click": True, "wav": "c.wav", "truth": "c.truth.json"}]
            with open(os.path.join(d, "c.truth.json"), "w") as f:
                json.dump(truth, f)
            name, checks, hard = CA.check_variant(d, items[0], items)
            self.assertTrue(checks[0]["text"].startswith("SKIP"))
            self.assertFalse(hard)

    def test_wrong_chord_fails_chroma(self):
        with tempfile.TemporaryDirectory() as d:
            truth = make_truth()
            other = json.loads(json.dumps(truth))
            other["chords"][0]["root"] = "E"
            write_chords(os.path.join(d, "p.wav"), other)
            with open(os.path.join(d, "p.truth.json"), "w") as f:
                json.dump(truth, f)
            v = {"name": "p", "mix": "piano", "wav": "p.wav", "truth": "p.truth.json"}
            _, checks, _ = CA.check_variant(d, v, [v])
            chord = next(c for c in checks if c["label"] == "chord")
            self.assertFalse(chord["ok"])
            self.assertAlmostEqual(chord["value"], 0.5, delta=0.1)


if __name__ == "__main__":
    unittest.main()
