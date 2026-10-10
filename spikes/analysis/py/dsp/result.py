"""Assemble the AnalysisResult dict (render/types.ts) from the stage outputs.

Decisions: root names use sharps (score.note_to_pc accepts both); chord segments with no chord (root None)
are omitted (gaps = no chord); bass is always None; chord text carries '?' for low confidence;
beats carry bar/beat only from the first downbeat on.
"""

from __future__ import annotations

import numpy as np

from .chords import ChordSegment, chord_text
from .config import Config, config_hash, config_summary
from .types import BeatChord, BeatGrid, Downbeats, Features, Section

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def _methods(cfg: Config) -> list[str]:
    return [
        f'beats:{cfg.beats.method}',
        f'chroma:{cfg.chroma.kind}',
        f'chords:template+{cfg.chords.smoothing}',
        'downbeat:chord+bass+onset',
        'sections:novelty' if cfg.sections.enabled else 'sections:off',
        'key:krumhansl-schmuckler' if cfg.key.enabled else 'key:off',
        f'config:{config_hash(cfg)}',
    ]


def build_result(
    feat: Features,
    grid: BeatGrid,
    segments: list[ChordSegment],
    downbeats: Downbeats,
    sections: list[Section],
    key: tuple[str, str, float] | None,
    cfg: Config,
    timings: dict[str, float] | None = None,
) -> dict:
    times = [float(t) for t in grid.times]
    n = len(times)
    dur = float(feat.duration)
    bpb = downbeats.beats_per_bar
    phase = downbeats.phase

    def beat_time(i: int) -> float:
        return times[i] if 0 <= i < n else dur

    beats = []
    for i, t in enumerate(times):
        b = {'t': t, 'downbeat': i >= phase and (i - phase) % bpb == 0}
        if i >= phase:
            b['bar'] = (i - phase) // bpb
            b['beat'] = (i - phase) % bpb
        beats.append(b)

    chords = []
    for s in segments:
        if s.root is None:
            continue
        bc = BeatChord(root=s.root, quality=s.quality, confidence=s.confidence)
        chords.append({
            'start': beat_time(s.start_beat),
            'end': beat_time(s.end_beat),
            'root': NOTE_NAMES[s.root % 12],
            'quality': s.quality,
            'bass': None,
            'text': chord_text(bc, cfg),
            'confidence': float(s.confidence),
        })

    secs = [
        {'start': beat_time(phase + s.start_bar * bpb), 'end': beat_time(phase + s.end_bar * bpb), 'label': s.label}
        for s in sections
    ]

    analyzer = {
        'name': cfg.name,
        'version': config_hash(cfg),
        'methods': _methods(cfg),
        'configHash': config_hash(cfg),
        'config': config_summary(cfg),
    }
    if timings is not None:
        analyzer['timingsSec'] = {k: round(float(v), 3) for k, v in timings.items()}

    result = {
        'format': 'band-sheets-analysis',
        'version': 1,
        'source': {'kind': 'recording', 'durationSec': dur, 'click': False},
        'analyzer': analyzer,
        'beats': beats,
        'timeSignature': {'num': bpb, 'den': 4, 'confidence': float(downbeats.confidence)},
        'sections': secs,
        'chords': chords,
    }
    if key is not None:
        result['key'] = {'tonic': key[0], 'mode': key[1], 'confidence': float(key[2])}
    return result
