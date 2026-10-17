"""Spike 3 T1: dump the analyzer's intermediate values for the TS port's parity tests.

Usage (Docker image, see CLAUDE.md "Audio analysis spike"):
  python py/tools/dump_stages.py <variant> [<variant> ...] [--out DIR] [--parity-dir DIR] [--commit SHA[-dirty]]
Variants are names from the manifests under DIR (default spikes/analysis/out); output goes to
<parity-dir>/<variant>/ (default DIR/parity, gitignored). The commit comes from --commit or env
BAND_SHEETS_COMMIT (no .git in the container), or from git when available.

Targets: tuning (dev) synthetic variants only. A held-out variant (heldOut flag, or its take / base is a held-out
take) and anything that is a real recording (level REC, song "rec", wav under recordings/ or rec/, names rec-NN)
raise an error before any audio is read. Private chart syntheses (level CH) are allowed by the plan (section 4)
but stay inside gitignored out/.

How it works: py/dsp/ is untouched. The stage functions that py/analyze.py calls are wrapped (pass-through
monkeypatches, restored afterwards) while `analyze.analyze` runs once, so the result is exactly the one analyze.py
gives. STFT / HPSS internals that dsp does not expose are recomputed with the same librosa calls as
librosa.effects.hpss (the recomputed y_harm / y_perc are compared with the analyzer's; the max abs diff goes to
meta.json as hpssRecomputeMaxAbsDiff).

File format (ts/parity/stageFile.ts): <stage>.f32 = headerless little-endian float32, row-major, byte length
4 * prod(shape). Integers are written as float32 too (checked < 2^24); None -> -1. Float64 values are rounded to
float32. Scalars have shape []. meta.json = {commit, configHash, stages: {name: {file, dtype, shape}}, ...extras}.

Stages (n = samples, F = STFT/CQT frames, nb = beats, nc = chord columns, S = chord states, K = bars):
  signal      y [n]   y_harm [n]   y_perc [n]        (22050 Hz float32, what librosa.load returns)
  STFT        stft_re, stft_im [1025, F]  (librosa.stft(y) defaults, i.e. n_fft 2048, hop 512, centred)
              hpss_harm_mag, hpss_perc_mag [1025, F]  (|masked STFT| before the inverse STFT)
  onset       onset_env [F]
  beats       beat_frames_raw [nb0] (librosa beat_track frames, before the refinement), beat_times [nb] (s),
              beat_tempo []
  chroma      frame_chroma [12, F], frame_bass [12, F] (after the 1/80 scale), beat_chroma [12, nb],
              beat_bass [12, nb], beat_bounds [nb+1], col_chroma [12, nc], col_bounds [nc+1], per_beat []
  chords      chords1_{root,quality,confidence,bass} [nc], chords1_posterior [S, nc] (if present); chords2_* the
              same for the 2nd pass (theory prior), chord_prior [nc, S, S]; root/bass -1 = None; quality = index
              into meta "qualities"; meta "states" = [[root, quality], ...] is the posterior's row order
  downbeat    downbeat_chords_{root,quality,confidence} [nb] (the beat-level chords the rule sees),
              downbeat_phase [], downbeat_beats_per_bar [], downbeat_confidence [], downbeat_scores [k]
  merge       segments [m, 7] = start, end, root, quality idx, confidence, low_confidence, bass
  sections    sections [s, 2] = start_bar, end_bar (labels in meta "sectionLabels")
  key         key_tonic [], key_mode [] (0 major, 1 minor), key_confidence []
  keytrack    bar_of_col [nb], bar_keys [K, 4] = bar, tonic, mode (0/1), confidence
Not dumped: the CQT itself and its filter-bank internals (the plan compares chroma only), candidates (in the result
JSON), per-stage timings.
Also written: result.json (identical to `analyze.py -o`, timingsSec aside), config.json, and meta.json.
"""
import argparse
import contextlib
import json
import os
import re
import sys
from unittest import mock

import numpy as np

PY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PY not in sys.path:
    sys.path.insert(0, PY)

import librosa  # noqa: E402

import analyze as A  # noqa: E402
import run_all  # noqa: E402
from dsp import chroma as chroma_mod  # noqa: E402
from dsp import harmony, keytrack, vocab  # noqa: E402
from dsp.config import config_hash, config_to_dict, load_config  # noqa: E402
from tools import common  # noqa: E402

F32_INT_LIMIT = 2 ** 24
_REC_NAME = re.compile(r'(^|[-_/])rec[-_]?\d|(^|[-_/])REC([-_/]|$)')


class NotTuningVariantError(ValueError):
    """The variant is a real recording (or otherwise not a synthetic dev variant)."""


def check_allowed(v, held_takes):
    """Raise unless `v` (a manifest entry from run_all.load_variants) is a tuning synthetic variant."""
    name, wav = v['name'], v.get('wav', '')
    if common.is_held_out(v, held_takes):
        raise run_all.HeldOutError(f'{name}: held-out variants must not be dumped (R10 / plan decision 5)')
    parts = set(re.split(r'[\\/]', wav))
    if (str(v.get('level')) == 'REC' or v.get('song') == 'rec' or {'recordings', 'rec'} & parts
            or _REC_NAME.search(name) or _REC_NAME.search(wav)):
        raise NotTuningVariantError(f'{name}: real recordings must not be dumped (synthetic dev variants only)')


def _f32(a, integer=False):
    a = np.asarray(a)
    if integer:
        a = np.where(a == None, -1, a) if a.dtype == object else a  # noqa: E711
        if a.size and np.abs(a.astype(np.float64)).max() >= F32_INT_LIMIT:
            raise ValueError('integer stage does not fit float32 exactly')
    return np.asarray(a, dtype='<f4', order='C')  # (not ascontiguousarray: it makes 0-d arrays 1-d)


class StageWriter:
    def __init__(self, directory):
        self.dir = directory
        self.stages = {}
        os.makedirs(directory, exist_ok=True)

    def put(self, name, a, integer=False):
        a = _f32(a, integer)
        with open(os.path.join(self.dir, f'{name}.f32'), 'wb') as f:
            f.write(a.tobytes(order='C'))
        self.stages[name] = {'file': f'{name}.f32', 'dtype': 'float32', 'shape': list(a.shape)}


def _opt(x):
    return -1 if x is None else int(x)


def _hpss_internals(y, margin):
    """Same calls as librosa.effects.hpss; returns (stft, harm_stft, perc_stft, y_harm, y_perc)."""
    d = librosa.stft(y)
    h, p = librosa.decompose.hpss(d, margin=margin)
    n = y.shape[-1]
    return d, h, p, librosa.istft(h, dtype=y.dtype, length=n), librosa.istft(p, dtype=y.dtype, length=n)


def run_stages(wav, cfg):
    """analyze.analyze(wav, cfg) with recording wrappers. Returns (result, recorded dict)."""
    rec = {'chords': [], 'beat_frames': None, 'frame_chroma': []}

    def spy(owner, attr, key=None, many=False):
        orig = getattr(owner, attr)

        def wrapper(*a, **k):
            out = orig(*a, **k)
            if many:
                rec.setdefault(key or attr, []).append((a, k, out))
            else:
                rec[key or attr] = (a, k, out)
            return out
        return mock.patch.object(owner, attr, wrapper)

    def beat_track(*a, **k):
        out = orig_beat_track(*a, **k)
        rec['beat_frames'] = np.asarray(out[1])
        return out

    def frame_chroma(*a, **k):
        out = orig_frame_chroma(*a, **k)
        rec['frame_chroma'].append(out)
        return out

    orig_beat_track = librosa.beat.beat_track
    orig_frame_chroma = chroma_mod._frame_chroma
    with contextlib.ExitStack() as st:
        for owner, attr, key, many in [
            (A, 'load_features', None, False), (A, 'track_beats', None, False), (A, 'chord_columns', None, False),
            (A, 'estimate_chords', 'estimate_chords', True), (A, 'downbeat_chords', None, False),
            (A, 'choose_downbeats', None, False), (A, '_merge', 'merge', True), (A, 'find_sections', None, False),
            (A, 'estimate_key', None, False), (keytrack, 'estimate', 'keytrack', False),
            (harmony, 'transition', 'prior', False),
        ]:
            st.enter_context(spy(owner, attr, key, many))
        st.enter_context(mock.patch.object(librosa.beat, 'beat_track', beat_track))
        st.enter_context(mock.patch.object(chroma_mod, '_frame_chroma', frame_chroma))
        result = A.analyze(wav, cfg)
    return result, rec


def write_stages(w, cfg, rec, extras):
    """Turn what run_stages recorded into stage files (+ fills `extras` with the meta extras)."""
    feat = rec['load_features'][2]
    grid = rec['track_beats'][2]
    chroma, bass, bounds, cc, cb, pb = rec['chord_columns'][2]
    states = vocab.states(cfg)
    qualities = []

    def qi(q):
        if q not in qualities:
            qualities.append(q)
        return qualities.index(q)

    for _, q in states:
        qi(q)

    a = cfg.audio
    d, h, p, yh, yp = _hpss_internals(feat.y, a.hpss_margin) if a.hpss and len(feat.y) else (None,) * 5
    w.put('y', feat.y)
    w.put('y_harm', feat.y_harm)
    w.put('y_perc', feat.y_perc)
    if d is not None:
        w.put('stft_re', d.real)
        w.put('stft_im', d.imag)
        w.put('hpss_harm_mag', np.abs(h))
        w.put('hpss_perc_mag', np.abs(p))
        extras['hpssRecomputeMaxAbsDiff'] = float(max(np.abs(yh - feat.y_harm).max(), np.abs(yp - feat.y_perc).max()))
    w.put('onset_env', feat.onset_env)

    if rec['beat_frames'] is not None:
        w.put('beat_frames_raw', rec['beat_frames'], integer=True)
    w.put('beat_times', grid.times)
    w.put('beat_tempo', grid.tempo)

    for name, arr in zip(('frame_chroma', 'frame_bass'), rec['frame_chroma']):
        w.put(name, arr)
    w.put('beat_chroma', chroma)
    w.put('beat_bass', bass)
    w.put('beat_bounds', bounds, integer=True)
    w.put('col_chroma', cc)
    w.put('col_bounds', cb, integer=True)
    w.put('per_beat', pb, integer=True)

    def put_chords(prefix, chords, posterior=True):
        w.put(f'{prefix}_root', [_opt(c.root) for c in chords], integer=True)
        w.put(f'{prefix}_quality', [qi(c.quality) for c in chords], integer=True)
        w.put(f'{prefix}_confidence', [c.confidence for c in chords])
        if hasattr(chords[0], 'bass') if chords else False:
            w.put(f'{prefix}_bass', [_opt(c.bass) for c in chords], integer=True)
        if posterior and chords and all(c.posterior is not None for c in chords):
            w.put(f'{prefix}_posterior', np.stack([c.posterior for c in chords], axis=1))

    calls = rec['estimate_chords']
    put_chords('chords1', calls[0][2])
    second = [c for c in calls if len(c[0]) > 4 or 'prior' in c[1]]
    if second:
        put_chords('chords2', second[0][2])
    if 'prior' in rec:
        w.put('chord_prior', rec['prior'][2])
    put_chords('downbeat_chords', rec['downbeat_chords'][2], posterior=False)

    db = rec['choose_downbeats'][2]
    w.put('downbeat_phase', db.phase, integer=True)
    w.put('downbeat_beats_per_bar', db.beats_per_bar, integer=True)
    w.put('downbeat_confidence', db.confidence)
    w.put('downbeat_scores', db.scores)

    segs = rec['merge'][-1][2]  # the last _merge call is the one whose segments reach the result
    w.put('segments', np.array([[s.start_beat, s.end_beat, _opt(s.root), qi(s.quality), s.confidence,
                                 float(s.low_confidence), _opt(s.bass)] for s in segs]).reshape(-1, 7))
    secs = rec['find_sections'][2]
    w.put('sections', np.array([[s.start_bar, s.end_bar] for s in secs]).reshape(-1, 2), integer=True)
    extras['sectionLabels'] = [s.label for s in secs]
    extras['segmentsColumns'] = ['start', 'end', 'root', 'quality', 'confidence', 'lowConfidence', 'bass']

    if 'estimate_key' in rec:
        tonic, mode, conf = rec['estimate_key'][2]
        w.put('key_tonic', A.NOTE_NAMES.index(tonic), integer=True)
        w.put('key_mode', 0 if mode == 'major' else 1, integer=True)
        w.put('key_confidence', conf)
    bar_of_col = (np.arange(chroma.shape[1]) - db.phase) // db.beats_per_bar
    w.put('bar_of_col', bar_of_col, integer=True)
    if 'keytrack' in rec:
        bk = rec['keytrack'][2]
        w.put('bar_keys', np.array([[b.bar, b.tonic, 0 if b.mode == 'major' else 1, b.confidence]
                                    for b in bk]).reshape(-1, 4))
    extras['qualities'] = qualities
    extras['states'] = [[r, q] for r, q in states]
    extras['sr'] = feat.sr
    extras['hop'] = feat.hop


def dump_variant(variant, out_dir, parity_dir, commit):
    """Dump one variant; `commit` is the already-resolved short SHA string (may carry -dirty)."""
    variants = {v['name']: v for v in run_all.load_variants(out_dir)}
    if variant not in variants:
        raise KeyError(f'unknown variant {variant!r} (not in the manifests under {out_dir})')
    v = variants[variant]
    check_allowed(v, common.held_out_takes(out_dir))
    wav = os.path.join(out_dir, v['wav'])
    cfg = load_config(None)
    result, rec = run_stages(wav, cfg)
    w = StageWriter(os.path.join(parity_dir, variant))
    extras = {}
    write_stages(w, cfg, rec, extras)
    with open(os.path.join(w.dir, 'result.json'), 'w', encoding='utf-8') as f:
        f.write(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    with open(os.path.join(w.dir, 'config.json'), 'w', encoding='utf-8') as f:
        f.write(json.dumps(config_to_dict(cfg), indent=2, sort_keys=True) + '\n')
    meta = {'commit': commit, 'configHash': config_hash(cfg), 'variant': variant, **extras, 'stages': w.stages}
    with open(os.path.join(w.dir, 'meta.json'), 'w', encoding='utf-8') as f:
        f.write(json.dumps(meta, indent=2) + '\n')
    return meta


def resolve_commit(arg):
    git = run_all.resolve_git(run_all.git_state(), arg)
    if git.get('commit') is None:
        raise SystemExit(f'commit unknown (no .git here): pass --commit or set {run_all.COMMIT_ENV}')
    return git['commit'] + ('-dirty' if git.get('dirty') else '')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('variants', nargs='+')
    ap.add_argument('--out', default=common.OUT)
    ap.add_argument('--parity-dir', help='default: <out>/parity')
    ap.add_argument('--commit', help=f'commit of the code (SHA[-dirty]); default env {run_all.COMMIT_ENV}')
    args = ap.parse_args(argv)
    commit = resolve_commit(args.commit)
    parity = args.parity_dir or os.path.join(args.out, 'parity')
    for name in args.variants:
        meta = dump_variant(name, args.out, parity, commit)
        print(f'{name}: {len(meta["stages"])} stages -> {os.path.join(parity, name)} (config {meta["configHash"]})')


if __name__ == '__main__':
    sys.exit(main())
