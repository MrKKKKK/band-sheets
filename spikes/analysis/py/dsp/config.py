"""All dsp-v1 settings in one place: nested frozen dataclasses with defaults,
partial override from JSON / dict, summary and hash for recording in results.

    cfg = Config()                              # defaults
    cfg = load_config('x.json')                 # defaults + overrides from a JSON file
    cfg = apply_overrides(cfg, {'beats': {'method': 'plp'}})
    config_hash(cfg)  # 12 hex chars, stable for equal values
    config_summary(cfg)  # dict with the non-default values (for analyzer record)
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field, fields, is_dataclass, replace
from typing import Any


@dataclass(frozen=True)
class AudioConfig:
    sr: int = 22050
    hop: int = 512
    hpss: bool = True
    hpss_margin: float = 1.0


@dataclass(frozen=True)
class BeatsConfig:
    method: str = 'ellis'  # 'ellis' | 'plp'
    trim: bool = False
    start_bpm: float = 120.0
    tightness: float = 100.0
    tempo_octave: str = 'none'  # 'none' | 'rule' (spike 2 T6: tempo.choose_octave)
    tempo_hint: float = 0.0  # BPM the user knows (click tempo, `--tempo`); 0 = none. Never from truth.


@dataclass(frozen=True)
class ChromaConfig:
    kind: str = 'cqt'  # 'cqt' | 'cens'
    n_octaves: int = 6
    fmin_hz: float = 32.7  # C1
    bins_per_octave: int = 36
    bass_fmin_hz: float = 32.7
    bass_octaves: int = 3  # bass chroma = lowest octaves only
    aggregate: str = 'median'  # per-beat aggregation: 'median' | 'mean'
    top_voice_discount: float = 0.0  # 0 = off (spike 2 T12: voicing.discount_top_voice)


@dataclass(frozen=True)
class ChordsConfig:
    smoothing: str = 'viterbi'  # 'viterbi' | 'median' | 'none'
    self_transition: float = 0.6  # P(same chord continues) for Viterbi (T12: 0.9 -> 0.6)
    median_width: int = 3  # beats (odd), for 'median'
    use_seventh: bool = True
    seventh_weight: float = 0.98  # template weight (< 1) for 7th chords (T12: 0.95 -> 0.98)
    seventh_margin: float = 0.0  # 7th only if it beats the best triad by this (T12: 0.05 -> 0)
    low_confidence: float = 0.1  # below this, text gets '?'
    no_chord_energy: float = 0.02  # chroma total below this -> no chord
    merge_min_beats: int = 1  # merge into spans; spans shorter than this get absorbed
    # spike 2 switches (docs/audio-spike2-plan.md §5 "共通の形"); every default = spike 1 behaviour
    resolution: str = 'beat'  # 'beat' | 'eighth' (T13)
    confidence: str = 'margin'  # 'margin' | 'posterior' (T9: posterior.chord_posterior)
    harmonics: str = 'none'  # 'none' | 'fixed' | 'profile' (T11: harmonics.templates)
    harmonic_decay: float = 0.6  # 'fixed': weight of harmonic n = decay**(n-1)
    bass_root: str = 'none'  # 'none' | 'lowest' | 'first' | 'octave' (T10: bassroot.root_evidence)
    bass_root_weight: float = 0.0
    slash: bool = False  # output slash chords (T10: bassroot.bass_notes)
    seventh_mode: str = 'beat'  # 'beat' | 'segment' (T8: seventh.decide_segments)
    vocab: str = 'v1'  # 'v1' (maj/min/7/maj7/min7) | 'v2' (design decision 8, T21: vocab.states)
    vocab_weight: float = 1.0  # 'v2': score weight of dim/aug/sus4/m7b5/dim7 (T21; T14 tunes)
    vocab_margin: float = 0.02  # 'v2': those only if they beat the best v1 chord by this (T21; T14 tunes)
    vocab_sus4_margin: float = 0.1  # 'v2': the same margin for sus4 alone (passing 4ths on chord changes; T21 sweep, T14 tunes)
    theory_prior: float = 0.0  # 0 = off; strength of the theory prior (T26: harmony.transition, 2nd pass)
    power: bool = False  # T27: power chord quality '5' (root + 5th) when the 3rd is not sounded (vocab.gate_power)
    power_third_max: float = 0.2  # T27: '5' only if the stronger 3rd (m3 / M3) <= this x the mean of root and 5th (0.3 lowered L1, T27 eval)
    candidates: bool = False  # T27: chords[].candidates = top-k chords of the posterior over the segment
    candidates_k: int = 3  # T27: k of the candidates


@dataclass(frozen=True)
class DownbeatConfig:
    beats_per_bar: int = 4
    w_chord_change: float = 1.0
    w_bass: float = 0.5
    w_onset: float = 0.5
    tie_break_phase: int = 0  # phase chosen on a tie
    chord_conf_floor: float = 0.3  # chord-change weight = floor + (1-floor)*confidence
    same_root_change: float = 0.5  # weight of a quality-only change (C -> C7)
    anticipation_shift: float = 1.0  # 0 = off; move credit of an early (blended) change to the next beat


@dataclass(frozen=True)
class SectionsConfig:
    enabled: bool = True
    kernel_bars: int = 4  # Foote checkerboard kernel half-width (bars)
    peak_threshold: float = 0.3  # relative to max novelty
    min_section_bars: int = 4
    snap_bars: int = 4  # snap boundaries to multiples of this (0 = off)
    same_label_similarity: float = 0.85  # >= this -> same label
    chroma_weight: float = 1.0
    loudness_weight: float = 0.5  # T12 tried 0.25; reverted in T15 (no evidence, broke tests; matters for real loud choruses)
    min_novelty: float = 0.25  # absolute novelty floor (guards songs with no real change)
    repetition_weight: float = 0.5  # weight of the repetition-structure (lag) novelty
    snap_min_ratio: float = 0.8  # a loudness step at the grid bar < this x the step at the peak keeps the peak (0 = always snap)
    noise_factor: float = 2.5  # a peak must be >= this x the median valley of the novelty curve
    percussive_weight: float = 0.0  # 0 = off (spike 2 T7)


@dataclass(frozen=True)
class KeyConfig:
    enabled: bool = True
    track: str = 'global'  # 'global' (spike 1) | 'sections' (per-bar key HMM, T22: keytrack.estimate)
    change_cost_mid: float = 0.0  # key change cost inside a section (T22 sets the value)
    change_cost_boundary: float = 0.0  # key change cost at a section boundary


@dataclass(frozen=True)
class Config:
    name: str = 'dsp-v1'
    audio: AudioConfig = field(default_factory=AudioConfig)
    beats: BeatsConfig = field(default_factory=BeatsConfig)
    chroma: ChromaConfig = field(default_factory=ChromaConfig)
    chords: ChordsConfig = field(default_factory=ChordsConfig)
    downbeat: DownbeatConfig = field(default_factory=DownbeatConfig)
    sections: SectionsConfig = field(default_factory=SectionsConfig)
    key: KeyConfig = field(default_factory=KeyConfig)


def config_to_dict(cfg: Config) -> dict[str, Any]:
    return asdict(cfg)


def apply_overrides(cfg: Any, overrides: dict[str, Any]) -> Any:
    """Return a copy of `cfg` with a (possibly partial, nested) dict applied.

    Unknown keys and wrongly-typed values raise ValueError (so typos in a JSON
    file are never silently ignored). int is accepted where float is expected.
    """
    if not isinstance(overrides, dict):
        raise ValueError(f'overrides must be an object, got {type(overrides).__name__}')
    known = {f.name: f for f in fields(cfg)}
    changes: dict[str, Any] = {}
    for key, value in overrides.items():
        if key not in known:
            raise ValueError(f'unknown config key: {key!r} in {type(cfg).__name__}')
        current = getattr(cfg, key)
        if is_dataclass(current):
            changes[key] = apply_overrides(current, value)
        else:
            changes[key] = _coerce(key, current, value)
    return replace(cfg, **changes)


def _coerce(key: str, current: Any, value: Any) -> Any:
    if isinstance(current, bool):
        if not isinstance(value, bool):
            raise ValueError(f'{key}: expected bool, got {value!r}')
        return value
    if isinstance(current, int):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f'{key}: expected int, got {value!r}')
        return value
    if isinstance(current, float):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f'{key}: expected number, got {value!r}')
        return float(value)
    if isinstance(current, str):
        if not isinstance(value, str):
            raise ValueError(f'{key}: expected string, got {value!r}')
        return value
    raise ValueError(f'{key}: unsupported config type {type(current).__name__}')


def load_config(path: str | None) -> Config:
    """Defaults, with a JSON file's (partial) values applied when `path` is given."""
    cfg = Config()
    if path is None:
        return cfg
    with open(path, encoding='utf-8') as f:
        return apply_overrides(cfg, json.load(f))


# Spike 2 fields and the value that means "off" (= spike 1 behaviour). A field at its off value is
# left out of config_hash, so a config with every switch off keeps its spike 1 hash (results and
# baselines stay comparable). Fixed values, not the current defaults: if T14 turns a switch on by
# default, the hash changes as it should.
SPIKE1_OFF_VALUES: dict[str, dict[str, Any]] = {
    'beats': {'tempo_octave': 'none', 'tempo_hint': 0.0},
    'chroma': {'top_voice_discount': 0.0},
    'chords': {
        'resolution': 'beat',
        'confidence': 'margin',
        'harmonics': 'none',
        'harmonic_decay': 0.6,
        'bass_root': 'none',
        'bass_root_weight': 0.0,
        'slash': False,
        'seventh_mode': 'beat',
        'vocab': 'v1',
        'vocab_weight': 1.0,
        'vocab_margin': 0.02,
        'vocab_sus4_margin': 0.1,
        'theory_prior': 0.0,
        'power': False,
        'power_third_max': 0.2,
        'candidates': False,
        'candidates_k': 3,
    },
    'sections': {'percussive_weight': 0.0},
    'key': {'track': 'global', 'change_cost_mid': 0.0, 'change_cost_boundary': 0.0},
}


def _hash_dict(cfg: Config) -> dict[str, Any]:
    d = config_to_dict(cfg)
    for group, offs in SPIKE1_OFF_VALUES.items():
        for k, off in offs.items():
            if d[group][k] == off:
                del d[group][k]
    return d


def config_hash(cfg: Config) -> str:
    """12 hex chars of SHA-256 over the canonical JSON of all values (name included).

    Spike 2 fields at their off value (SPIKE1_OFF_VALUES) are left out, so spike 1 hashes are kept.
    """
    canon = json.dumps(_hash_dict(cfg), sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canon.encode('utf-8')).hexdigest()[:12]


def _diff(cfg: Any, default: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in fields(cfg):
        a, b = getattr(cfg, f.name), getattr(default, f.name)
        if is_dataclass(a):
            d = _diff(a, b)
            if d:
                out[f.name] = d
        elif a != b:
            out[f.name] = a
    return out


def config_summary(cfg: Config) -> dict[str, Any]:
    """Only the values that differ from the defaults (empty dict = all defaults)."""
    return _diff(cfg, Config())
