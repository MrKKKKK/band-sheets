import unittest

import numpy as np

from py.dsp.config import Config, DownbeatConfig, apply_overrides
from py.dsp.downbeat import (
    bass_change_strength,
    beat_onset_strength,
    choose_downbeats,
    chord_change_strength,
    estimate_downbeats,
)
from py.dsp.types import BeatChord, BeatGrid, Features

PROG = [0, 5, 7, 9, 2, 7, 0, 5]  # bar roots (C F G A D G C F)


def bar_roots(n_bars, mid=None):
    """Per-beat chord roots, 4 beats per bar. `mid` = (beat index, root offset):
    a second chord inside each bar from that beat on."""
    roots = []
    for b in range(n_bars):
        r = PROG[b % len(PROG)]
        bar = [r] * 4
        if mid is not None:
            k, off = mid
            for j in range(k, 4):
                bar[j] = (r + off) % 12
        roots += bar
    return roots


def bass_chroma(roots_per_beat, downbeat_idx, accent=1.0):
    """Bass chroma (12, n): the bar's root held through the bar, louder on beat 1."""
    n = len(roots_per_beat)
    b = np.zeros((12, n))
    cur = None
    for i in range(n):
        if roots_per_beat[i] is None:
            continue
        if i in downbeat_idx or cur is None:
            cur = roots_per_beat[i]
        b[cur, i] = 1.0 + (accent if i in downbeat_idx else 0.0)
    return b


def shift(seq, k, fill=None):
    """Prepend k beats (pickup / lead-in)."""
    return [fill] * k + list(seq)


def run(roots, conf=None, bass=None, onset=None, cfg=None, qualities=None):
    cfg = cfg or DownbeatConfig()
    cc = chord_change_strength(roots, qualities, conf, cfg)
    return estimate_downbeats(len(roots), cc, bass_change_strength(bass), onset, cfg)


class ChordChangeStrengthTest(unittest.TestCase):
    def test_change_none_and_quality(self):
        cc = chord_change_strength([None, 0, 0, 5, 5, 5], ['maj', 'maj', 'maj', 'maj', 'maj', '7'])
        self.assertEqual(cc[1], 0.0)  # None -> C does not count
        self.assertAlmostEqual(cc[3], 1.0)
        self.assertAlmostEqual(cc[5], 0.5)  # F -> F7: quality-only change

    def test_confidence_floor(self):
        cfg = DownbeatConfig(chord_conf_floor=0.3)
        cc = chord_change_strength([0, 0, 5, 5], None, [0.0, 0.0, 0.0, 0.0], cfg)
        self.assertAlmostEqual(cc[2], 0.3)

    def test_anticipation_moves_credit(self):
        # Beat 3 is a blend (labelled with the new chord, low confidence).
        cc = chord_change_strength([0, 0, 0, 5, 5, 5], None, [1, 1, 1, 0.2, 1, 1])
        self.assertAlmostEqual(cc[3] + cc[4], 1.0)
        self.assertGreater(cc[4], cc[3])
        off = chord_change_strength(
            [0, 0, 0, 5, 5, 5], None, [1, 1, 1, 0.2, 1, 1], DownbeatConfig(anticipation_shift=0.0)
        )
        self.assertEqual(off[4], 0.0)


class EstimateDownbeatsTest(unittest.TestCase):
    def test_chords_and_bass_on_beat_one(self):
        roots = bar_roots(8)
        db = run(roots, bass=bass_chroma(roots, set(range(0, 32, 4))))
        self.assertEqual(db.phase, 0)
        self.assertEqual(db.beats_per_bar, 4)
        self.assertEqual(len(db.scores), 4)
        self.assertGreater(db.confidence, 0.5)
        self.assertEqual(int(np.argmax(db.scores)), 0)

    def test_shift_follows(self):
        for k in (1, 2, 3):
            roots = shift(bar_roots(8), k, fill=PROG[-1])  # last bar's chord before
            down = set(range(k, len(roots), 4))
            db = run(roots, bass=bass_chroma(roots, down))
            self.assertEqual(db.phase, k, f'shift {k}')
            self.assertGreater(db.confidence, 0.3)

    def test_no_evidence(self):
        n = 32
        db = estimate_downbeats(n, np.zeros(n), np.zeros(n), np.zeros(n))
        self.assertEqual(db.confidence, 0.0)
        self.assertEqual(db.scores, [0.0, 0.0, 0.0, 0.0])
        self.assertEqual(db.phase, 0)
        db = estimate_downbeats(n)  # nothing at all
        self.assertEqual(db.confidence, 0.0)
        # One chord all the way, steady bass, flat onsets: also no evidence.
        roots = [0] * n
        db = run(roots, bass=bass_chroma(roots, set()), onset=np.ones(n))
        self.assertEqual(db.confidence, 0.0)

    def test_too_few_beats(self):
        db = estimate_downbeats(3, np.array([0, 1.0, 0]))
        self.assertEqual(db.confidence, 0.0)

    def test_pickup_three_beats(self):
        # 3-beat pickup on the V chord, then bars from beat 3.
        roots = shift(bar_roots(8), 3, fill=7)
        db = run(roots, bass=bass_chroma(roots, set(range(3, len(roots), 4))))
        self.assertEqual(db.phase, 3)
        self.assertGreater(db.confidence, 0.3)
        # Pickup with no chord at all (melody only).
        roots = shift(bar_roots(8), 3)
        db = run(roots, bass=bass_chroma(roots, set(range(3, len(roots), 4))))
        self.assertEqual(db.phase, 3)

    def test_lead_in_silence(self):
        roots = shift(bar_roots(8), 6)  # 6 silent beats -> first bar on beat 6
        onset = np.array([0.0] * 6 + [1.0] * 32)
        db = run(roots, bass=bass_chroma(roots, set(range(6, 38, 4))), onset=onset)
        self.assertEqual(db.phase, 2)

    def test_mid_bar_change_tie_broken_by_bass(self):
        # Every bar changes on beat 1 AND on beat 3 (index 2): chords alone tie.
        roots = bar_roots(8, mid=(2, 9))  # e.g. C | Am
        chords_only = run(roots)
        self.assertAlmostEqual(chords_only.scores[0], chords_only.scores[2])
        self.assertEqual(chords_only.confidence, 0.0)
        self.assertEqual(chords_only.phase, 0)  # tie_break_phase
        self.assertEqual(run(roots, cfg=DownbeatConfig(tie_break_phase=2)).phase, 2)
        # Bass on beat 1 decides.
        down = set(range(0, 32, 4))
        db = run(roots, bass=bass_chroma(roots, down))
        self.assertEqual(db.phase, 0)
        self.assertGreater(db.confidence, 0.0)
        # ...and the same when shifted by one beat.
        roots1 = shift(roots, 1, fill=(PROG[-1] + 9) % 12)
        db = run(roots1, bass=bass_chroma(roots1, {d + 1 for d in down}))
        self.assertEqual(db.phase, 1)

    def test_anticipation_and_of_two(self):
        # User's recording: 1st chord 3 eighths, 2nd from the and-of-2. The beat-2
        # column is a blend (low confidence, labelled with either chord).
        for blend_label in ('old', 'new'):
            roots, conf = [], []
            for b in range(8):
                r, s = PROG[b % 8], (PROG[b % 8] + 9) % 12
                roots += [r, r if blend_label == 'old' else s, s, s]
                conf += [0.9, 0.2, 0.9, 0.9]
            down = set(range(0, 32, 4))
            db = run(roots, conf=conf, bass=bass_chroma(roots, down), onset=np.tile([1.2, 1, 1, 1], 8))
            self.assertEqual(db.phase, 0, blend_label)

    def test_anticipation_and_of_four_chords_only(self):
        # One chord per bar, each anticipated: beat 4 is a blend labelled with the
        # NEXT chord. Without the shift rule this would say phase 3.
        roots, conf = [], []
        for b in range(8):
            r, nxt = PROG[b % 8], PROG[(b + 1) % 8]
            roots += [r, r, r, nxt if b < 7 else r]
            conf += [0.9, 0.9, 0.9, 0.25 if b < 7 else 0.9]
        self.assertEqual(run(roots, conf=conf).phase, 0)
        self.assertEqual(run(roots, conf=conf, cfg=DownbeatConfig(anticipation_shift=0.0)).phase, 3)

    def test_walking_bass_alone_gives_no_evidence(self):
        n = 32
        b = np.zeros((12, n))
        for i in range(n):
            b[(i * 2) % 12, i] = 1.0  # a new note every beat
        db = estimate_downbeats(n, None, bass_change_strength(b), None)
        self.assertLess(db.confidence, 0.05)

    def test_onset_accent_only(self):
        onset = np.tile([1.0, 0.5, 0.5, 0.5], 8)[1:]  # starts on beat 2 of a bar
        db = estimate_downbeats(len(onset), None, None, onset)
        self.assertEqual(db.phase, 3)
        self.assertGreater(db.confidence, 0.0)
        self.assertLess(db.confidence, 0.5)  # onset alone is weak evidence

    def test_scores_bounded(self):
        roots = bar_roots(8)
        db = run(roots, bass=bass_chroma(roots, set(range(0, 32, 4))), onset=np.tile([2.0, 0, 0, 0], 8))
        self.assertAlmostEqual(db.confidence, 1.0)
        self.assertTrue(all(-1.0 <= s <= 1.0 for s in db.scores))

    def test_length_mismatch(self):
        with self.assertRaises(ValueError):
            estimate_downbeats(8, np.zeros(7))


class ChooseDownbeatsTest(unittest.TestCase):
    def test_pipeline_adapter(self):
        sr, hop, bpm = 22050, 512, 120.0
        k = 1  # one pickup beat
        roots = shift(bar_roots(8), k, fill=7)
        n = len(roots)
        times = 0.5 + np.arange(n) * 60.0 / bpm
        grid = BeatGrid(times=times, tempo=bpm, method='test')
        chords = [BeatChord(root=r, quality='maj', confidence=0.8) for r in roots]
        n_frames = int((times[-1] + 1.0) * sr / hop)
        env = np.zeros(n_frames)
        for i, t in enumerate(times):
            env[int(round(t * sr / hop))] = 2.0 if (i - k) % 4 == 0 else 1.0
        y = np.zeros(10)
        feat = Features(sr=sr, hop=hop, duration=float(times[-1] + 1), y=y, y_harm=y, y_perc=y, onset_env=env)
        down = set(range(k, n, 4))
        db = choose_downbeats(feat, grid, chords, bass_chroma(roots, down), Config())
        self.assertEqual(db.phase, k)
        self.assertGreater(db.confidence, 0.3)
        # Missing pieces are tolerated.
        self.assertEqual(choose_downbeats(None, grid, chords, None, Config()).phase, k)
        self.assertEqual(choose_downbeats(feat, grid, None, None, Config()).phase, k)

    def test_config_override(self):
        cfg = apply_overrides(Config(), {'downbeat': {'w_bass': 0.0, 'anticipation_shift': 0.5}})
        self.assertEqual(cfg.downbeat.w_bass, 0.0)

    def test_beat_onset_strength(self):
        env = np.zeros(100)
        env[43] = 3.0
        out = beat_onset_strength(env, np.array([1.0, 2.0]), 22050, 512)
        self.assertEqual(out[0], 3.0)  # frame 43.07 -> 43
        self.assertEqual(out[1], 0.0)


if __name__ == '__main__':
    unittest.main()


class DownbeatChordsTest(unittest.TestCase):
    """The downbeat rule reads beat-level chords with margin confidence whatever chords.resolution /
    chords.confidence / chords.candidates say (R2 fix). Fixture: the downbeat inputs of the synthetic LR-hard
    variant piano-t124-straight-rec-hard (song saints) -- beat and half-beat chord chroma, bass chroma, onset
    envelope, beat times. Under eighth + posterior the on-beat posterior column weighted spurious mid-bar
    changes ~1 and phase 2 beat phase 0 by 0.003 (truth: phase 0, which every switch alone still finds)."""

    FIX = __import__('os').path.join(__import__('os').path.dirname(__file__), 'fixtures', 'downbeat_lrhard_saints.npz')
    B = {'chords': {'resolution': 'eighth', 'theory_prior': 1.0, 'confidence': 'posterior', 'low_confidence': 0.93,
                    'candidates': True, 'candidates_k': 3},
         'key': {'track': 'sections'}, 'beats': {'tempo_octave': 'rule'}, 'sections': {'percussive_weight': 0.5}}

    @classmethod
    def setUpClass(cls):
        z = np.load(cls.FIX)
        cls.z = {k: z[k] for k in z.files}
        cls.feat = Features(int(z['sr']), int(z['hop']), float(z['duration']), np.zeros(0), np.zeros(0), np.zeros(0),
                            z['onset_env'].astype(float))
        cls.grid = BeatGrid(z['times'], 124.0, 'fixture')

    def _phase(self, ov, fixed: bool):
        from py.dsp.chords import beat_level, estimate_chords
        from py.dsp.downbeat import downbeat_chords
        cfg = apply_overrides(Config(), ov)
        pb = 2 if cfg.chords.resolution == 'eighth' else 1
        chroma = self.z['chroma'].astype(float)
        cols = estimate_chords((self.z['cc'] if pb == 2 else self.z['chroma']).astype(float), cfg, per_beat=pb)
        chords = downbeat_chords(cols, chroma, cfg, pb) if fixed else beat_level(cols, pb)
        return choose_downbeats(self.feat, self.grid, chords, self.z['bass'].astype(float), cfg)

    def test_combined_config_flip_reproduces_without_the_fix(self):
        self.assertEqual(self._phase(self.B, fixed=False).phase, 2)  # guards that the fixture still shows the bug

    def test_combined_config_keeps_the_true_downbeat(self):
        self.assertEqual(self._phase(self.B, fixed=True).phase, 0)

    def test_same_downbeat_as_all_off_under_any_chord_switch(self):
        ref = self._phase({}, fixed=True)
        for ov in ({'chords': {'resolution': 'eighth'}}, {'chords': {'confidence': 'posterior'}},
                   {'chords': {'candidates': True}}, self.B):
            d = self._phase(ov, fixed=True)
            self.assertEqual((d.phase, d.scores, d.confidence), (ref.phase, ref.scores, ref.confidence), ov)

    def test_default_path_returns_the_chords_unchanged(self):
        from py.dsp.chords import estimate_chords
        from py.dsp.downbeat import downbeat_chords
        cols = estimate_chords(self.z['chroma'].astype(float), Config())
        self.assertIs(downbeat_chords(cols, self.z['chroma'].astype(float), Config(), 1), cols)
