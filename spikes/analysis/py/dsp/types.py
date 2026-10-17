"""Shared data shapes between analyzer stages (docs/audio-spike1-plan.md, "共通の形")."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass(frozen=True)
class Features:  # audio.load_features(path, cfg)
    sr: int
    hop: int
    duration: float
    y: np.ndarray
    y_harm: np.ndarray
    y_perc: np.ndarray
    onset_env: np.ndarray  # per frame


@dataclass(frozen=True)
class BeatGrid:  # beats.track_beats(feat, cfg)
    times: np.ndarray  # seconds, ascending
    tempo: float
    method: str


# chroma.beat_chroma(feat, grid, cfg) -> (chroma, bass)
#   both shape (12, len(times)); column i = [times[i], times[i+1])


@dataclass(frozen=True)
class BeatChord:  # chords.estimate_chords(chroma, cfg, ...) -> list[BeatChord] (per column)
    root: int | None  # 0-11, None = no chord
    quality: str  # vocab.states: v1 'maj' | 'min' | '7' | 'maj7' | 'min7' (+ v2 qualities, '5' with chords.power)
    confidence: float  # 0-1 (margin: gap between 1st and 2nd; or posterior, chords.confidence)
    bass: int | None = None  # 0-11 slash-chord bass (chords.slash); None = root position / unknown
    # (n_states,) posterior of this column over vocab.states(cfg) (T27, chords.candidates); not part of equality
    posterior: np.ndarray | None = field(default=None, compare=False, repr=False)


@dataclass(frozen=True)
class Downbeats:  # downbeat.choose_downbeats(feat, grid, chords, bass, cfg)
    phase: int  # index (0-3) of the first beat that starts a bar
    beats_per_bar: int
    confidence: float
    scores: list[float]


@dataclass(frozen=True)
class Section:  # sections.find_sections(chroma, grid, downbeats, feat, cfg) -> list[Section]
    start_bar: int
    end_bar: int  # exclusive; bars are counted from `phase`
    label: str


@dataclass(frozen=True)
class BarKey:  # keytrack.estimate(chords, bar_of_col, section_bars, cfg) -> list[BarKey] (spike 2 T22)
    bar: int  # bar index counted from the downbeat phase (0 = first full bar)
    tonic: int  # 0-11
    mode: str  # 'major' | 'minor'
    confidence: float  # 0-1


# Spike 2 hooks (docs/audio-spike2-plan.md §5 "共通の形"; T0 ships do-nothing stubs):
#   tempo.choose_octave(feat, grid, cfg) -> BeatGrid
#   voicing.discount_top_voice(frame_chroma, feat, cfg) -> frame_chroma
#   bassroot.root_evidence(feat, bounds, cfg) -> (12, n_cols)  bonus per root
#   bassroot.bass_notes(feat, bounds, cfg) -> list[int | None]  bass pitch class per column
#   vocab.states(cfg) -> list[(root, quality)]; vocab.intervals(quality) -> tuple[int, ...]
#   harmonics.templates(states, feat, cfg) -> (n_states, 12)
#   posterior.chord_posterior(emis, stay, trans=None, n_move=None) -> (n_states, n_cols) | None (None = keep margin confidence)
#   seventh.decide_segments(segments, chroma, cfg) -> segments
#   keytrack.estimate(chords, bar_of_col, section_bars, cfg) -> list[BarKey]
#   harmony.transition(states, bar_keys, bar_of_col, cfg) -> (n_cols, n_states, n_states) log prior, 0 = none
# `bounds`: frame index boundaries of the columns, length n_cols + 1 (chroma.beat_chroma_bounds).
# `bar_of_col`: bar index of each column, (i - phase) // beats_per_bar (negative = pickup).


# keyest.estimate_key(chroma, cfg) -> (tonic: str, mode: 'major'|'minor', confidence: float)
# result.build_result(feat, grid, chords, downbeats, sections, key, cfg) -> dict (AnalysisResult)
# analyze.analyze(wav_path: str, cfg: Config) -> dict
