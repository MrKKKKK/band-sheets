"""Deterministic short test signal for tests/test_dsp_hooks.py (spike 2 T0).

Kept apart from the test so the golden fixture can be regenerated with the spike 1 analyzer:
8 bars at 120 BPM (C Am F G C Am F G), click on every beat, bass on every beat, triad held per bar.
Numpy only; no randomness.
"""

import numpy as np

SR = 22050
BPM = 120
BI = 60.0 / BPM
PROG = [(0, 'maj'), (9, 'min'), (5, 'maj'), (7, 'maj')] * 2
TRIADS = {'maj': (0, 4, 7), 'min': (0, 3, 7)}


def _tone(midi, dur, amp):
    t = np.arange(int(dur * SR)) / SR
    f = 440.0 * 2 ** ((midi - 69) / 12)
    env = np.minimum(1.0, t * 100) * np.exp(-t * 0.3)
    return amp * env * (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t))


def synth() -> np.ndarray:
    y = np.zeros(int(len(PROG) * 4 * BI * SR) + SR)
    kn = int(0.03 * SR)
    kt = np.arange(kn) / SR
    click = np.sin(2 * np.pi * 1500 * kt) * np.exp(-kt * 150)
    for bar, (pc, q) in enumerate(PROG):
        t0 = bar * 4 * BI
        for k in range(4):
            s = int((t0 + k * BI) * SR)
            y[s:s + kn] += click * (1.0 if k == 0 else 0.5)
            bass = _tone(36 + pc, BI, 0.15)
            y[s:s + len(bass)] += bass
        for iv in TRIADS[q]:
            c = _tone(55 + (pc + iv - 7) % 12, 4 * BI, 0.4)
            s = int(t0 * SR)
            y[s:s + len(c)] += c
    return (y / np.abs(y).max() * 0.8).astype(np.float32)
