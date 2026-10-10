"""Shared data shapes between analyzer stages (docs/audio-spike1-plan.md, "共通の形")."""

from __future__ import annotations

from dataclasses import dataclass

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
class BeatChord:  # chords.estimate_chords(chroma, cfg) -> list[BeatChord] (per beat)
    root: int | None  # 0-11, None = no chord
    quality: str  # 'maj' | 'min' | '7' | 'maj7' | 'min7'
    confidence: float  # 0-1 (from the gap between 1st and 2nd)


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


# keyest.estimate_key(chroma, cfg) -> (tonic: str, mode: 'major'|'minor', confidence: float)
# result.build_result(feat, grid, chords, downbeats, sections, key, cfg) -> dict (AnalysisResult)
# analyze.analyze(wav_path: str, cfg: Config) -> dict
