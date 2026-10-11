"""dsp-v1 analyzer: wav path (+ config) in, AnalysisResult dict out. Never reads a truth file.

CLI: python py/analyze.py <wav> [--config x.json] [--tempo BPM] [-o out.json]   (per-stage timings go to stderr)
`--tempo` is the click tempo the user knows (beats.tempo_hint); never taken from a truth file.

Flow (docs/audio-spike2-plan.md §5): beats -> chroma -> chords (1st pass) -> downbeat -> merge ->
sections -> key -> [key.track == 'sections': keytrack per bar] -> [chords.theory_prior > 0: 2nd chord
pass with harmony.transition, then merge again; with chords.power, harmony.resolve_power names the quality of
'5' segments from the key (T26)]. Downbeat and sections always use the 1st pass.
With every spike 2 switch off the output is the spike 1 output (tests/test_dsp_hooks.py).
"""
import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dsp.audio import load_features  # noqa: E402
from dsp.beats import track_beats  # noqa: E402
from dsp import harmony, keytrack, posterior, seventh, vocab  # noqa: E402
from dsp.chords import NOTE_NAMES, estimate_chords, merge_chords  # noqa: E402
from dsp.chroma import beat_chroma_bounds  # noqa: E402
from dsp.config import Config, apply_overrides, load_config  # noqa: E402
from dsp.downbeat import choose_downbeats  # noqa: E402
from dsp.keyest import estimate_key  # noqa: E402
from dsp.result import build_result  # noqa: E402
from dsp.sections import find_sections  # noqa: E402
from dsp.types import BarKey  # noqa: E402

_KEY_TRACKS = ('global', 'sections')


def _merge(beat_chords, chroma, cfg: Config):
    """merge -> [power: '5' per segment (T27)] -> [seventh per segment (T8)] -> [candidates (T27)]."""
    segments = merge_chords(beat_chords, cfg)
    if cfg.chords.power:
        segments = vocab.decide_power_segments(segments, chroma, cfg)
    if cfg.chords.seventh_mode == 'segment':
        segments = seventh.decide_segments(segments, chroma, cfg)
    if cfg.chords.candidates:
        segments = posterior.attach_candidates(segments, beat_chords, cfg)
    return segments


def _global_bar_keys(key, bar_of_col) -> list[BarKey]:
    """The whole-song key for every bar (the prior's keys when key.track == 'global')."""
    if key is None or len(bar_of_col) == 0:
        return []
    tonic = NOTE_NAMES.index(key[0])
    return [BarKey(b, tonic, key[1], float(key[2])) for b in range(int(max(bar_of_col)) + 1)]


def analyze(wav_path: str, cfg: Config, timings: dict | None = None) -> dict:
    tm = {} if timings is None else timings

    def stage(name, fn):
        t0 = time.perf_counter()
        out = fn()
        tm[name] = time.perf_counter() - t0
        return out

    if cfg.key.track not in _KEY_TRACKS:
        raise ValueError(f'unknown key.track: {cfg.key.track!r}')
    feat = stage('load', lambda: load_features(wav_path, cfg))
    grid = stage('beats', lambda: track_beats(feat, cfg))
    chroma, bass, bounds = stage('chroma', lambda: beat_chroma_bounds(feat, grid, cfg))
    beat_chords = stage('chords', lambda: estimate_chords(chroma, cfg, feat, bounds))
    downbeats = stage('downbeat', lambda: choose_downbeats(feat, grid, beat_chords, bass, cfg))
    segments = stage('merge', lambda: _merge(beat_chords, chroma, cfg))
    sections = stage('sections', lambda: find_sections(chroma, grid, downbeats, feat, cfg, bass))
    key = stage('key', lambda: estimate_key(chroma, cfg)) if cfg.key.enabled else None

    bar_of_col = (np.arange(chroma.shape[1]) - downbeats.phase) // downbeats.beats_per_bar
    bar_keys = None
    if cfg.key.track == 'sections':
        section_bars = [s.start_bar for s in sections]
        bar_keys = stage('keytrack', lambda: keytrack.estimate(beat_chords, bar_of_col, section_bars, cfg))
    if cfg.chords.theory_prior > 0:
        prior_keys = bar_keys if bar_keys is not None else _global_bar_keys(key, bar_of_col)
        prior = harmony.transition(vocab.states(cfg), prior_keys, bar_of_col, cfg)
        beat_chords = stage('chords2', lambda: estimate_chords(chroma, cfg, feat, bounds, prior))
        segments = stage('merge2', lambda: _merge(beat_chords, chroma, cfg))
        if cfg.chords.power:
            segments = harmony.resolve_power(segments, prior_keys, bar_of_col, cfg)
    tm['total'] = sum(v for k, v in tm.items() if k != 'total')
    return build_result(feat, grid, segments, downbeats, sections, key, cfg, tm, bar_keys)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('wav')
    ap.add_argument('--config')
    ap.add_argument('--tempo', type=float, help='click tempo in BPM (beats.tempo_hint)')
    ap.add_argument('-o', '--out')
    args = ap.parse_args(argv)
    cfg = load_config(args.config)
    if args.tempo is not None:
        cfg = apply_overrides(cfg, {'beats': {'tempo_hint': args.tempo}})
    timings: dict = {}
    result = analyze(args.wav, cfg, timings)
    for k, v in timings.items():
        print(f'{k:>9}: {v:7.2f} s', file=sys.stderr)
    text = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text + '\n')
    else:
        print(text)


if __name__ == '__main__':
    main()
