"""dsp-v1 analyzer: wav path (+ config) in, AnalysisResult dict out. Never reads a truth file.

CLI: python py/analyze.py <wav> [--config x.json] [-o out.json]   (per-stage timings go to stderr)
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dsp.audio import load_features  # noqa: E402
from dsp.beats import track_beats  # noqa: E402
from dsp.chords import estimate_chords, merge_chords  # noqa: E402
from dsp.chroma import beat_chroma  # noqa: E402
from dsp.config import Config, load_config  # noqa: E402
from dsp.downbeat import choose_downbeats  # noqa: E402
from dsp.keyest import estimate_key  # noqa: E402
from dsp.result import build_result  # noqa: E402
from dsp.sections import find_sections  # noqa: E402


def analyze(wav_path: str, cfg: Config, timings: dict | None = None) -> dict:
    tm = {} if timings is None else timings

    def stage(name, fn):
        t0 = time.perf_counter()
        out = fn()
        tm[name] = time.perf_counter() - t0
        return out

    feat = stage('load', lambda: load_features(wav_path, cfg))
    grid = stage('beats', lambda: track_beats(feat, cfg))
    chroma, bass = stage('chroma', lambda: beat_chroma(feat, grid, cfg))
    beat_chords = stage('chords', lambda: estimate_chords(chroma, cfg))
    downbeats = stage('downbeat', lambda: choose_downbeats(feat, grid, beat_chords, bass, cfg))
    segments = stage('merge', lambda: merge_chords(beat_chords, cfg))
    sections = stage('sections', lambda: find_sections(chroma, grid, downbeats, feat, cfg, bass))
    key = stage('key', lambda: estimate_key(chroma, cfg)) if cfg.key.enabled else None
    tm['total'] = sum(v for k, v in tm.items() if k != 'total')
    return build_result(feat, grid, segments, downbeats, sections, key, cfg, tm)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('wav')
    ap.add_argument('--config')
    ap.add_argument('-o', '--out')
    args = ap.parse_args(argv)
    cfg = load_config(args.config)
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
