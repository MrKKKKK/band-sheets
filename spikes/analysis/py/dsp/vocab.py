"""Chord vocabulary (spike 2 T21; docs/audio-spike2-plan.md design decision 8).

    states(cfg) -> list[(root 0-11, quality)]   the chord states the decoder chooses from
    intervals(quality) -> tuple[int, ...]       chord tones as semitones above the root
    suffix(quality) -> str                      chord-name suffix ('' for maj, 'm', '7', ...)

T0 stub: 'v1' (spike 1: maj / min, plus 7 / maj7 / min7 with chords.use_seventh) for every
cfg.chords.vocab value. T21 adds 'v2' (dim / aug / m7b5 / dim7 / sus4); 'v1' must stay unchanged.
A quality with 4 tones counts as a seventh (chords.py applies seventh_weight / seventh_margin).
"""

from __future__ import annotations

from .config import Config

_INTERVALS: dict[str, tuple[int, ...]] = {
    'maj': (0, 4, 7),
    'min': (0, 3, 7),
    '7': (0, 4, 7, 10),
    'maj7': (0, 4, 7, 11),
    'min7': (0, 3, 7, 10),
}
_SUFFIX = {'maj': '', 'min': 'm', '7': '7', 'maj7': 'maj7', 'min7': 'm7'}
_TRIADS = ('maj', 'min')
_SEVENTHS = ('7', 'maj7', 'min7')


def states(cfg: Config) -> list[tuple[int, str]]:
    quals = _TRIADS + (_SEVENTHS if cfg.chords.use_seventh else ())
    return [(r, q) for q in quals for r in range(12)]


def intervals(quality: str) -> tuple[int, ...]:
    return _INTERVALS[quality]


def suffix(quality: str) -> str:
    return _SUFFIX[quality]
