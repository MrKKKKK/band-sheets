import { describe, expect, it } from 'vitest';
import { DEFAULT_CHORDS_CONFIG } from './chords';
import harmonyRaw from '../tables/harmony.json?raw';
import keyFitRaw from '../tables/key_fit.json?raw';
import {
  CONFIG_TYPES,
  configHash,
  DEFAULT_CONFIG,
  GROUPS,
  hashDict,
  parseJsonKeepNumbers,
  pyCanonicalJson,
  pyFloatRepr,
  pyJsonString,
  RawNumber,
  resolveConfig,
  sha256Hex,
  TABLE_DIGESTS,
  tableDigestFromJsonText,
} from './config';
import { DEFAULT_DOWNBEAT_CONFIG } from './downbeat';
import { DEFAULT_KEY_CONFIG } from './keytrack';
import { DEFAULT_SECTIONS_CONFIG } from './sections';

const TABLE_TEXT = { key_fit: keyFitRaw, harmony: harmonyRaw } as const;
const enc = (s: string) => new TextEncoder().encode(s);

describe('config hash', () => {
  it('default config hash is adec583eb3c6 (Python config_hash)', () => {
    expect(configHash()).toBe('adec583eb3c6');
    expect(configHash(DEFAULT_CONFIG)).toBe('adec583eb3c6');
  });

  it('hash dict canonical JSON equals Python json.dumps(_hash_dict(Config()), sort_keys, compact)', () => {
    // printed by: python -c "from dsp.config import *; print(json.dumps(_hash_dict(Config()), sort_keys=True, separators=(',',':')))"
    const py =
      '{"audio":{"hop":512,"hpss":true,"hpss_margin":1.0,"sr":22050},"beats":{"method":"ellis","start_bpm":120.0,' +
      '"tempo_octave":"rule","tightness":100.0,"trim":false},"chords":{"candidates":true,"confidence":"posterior",' +
      '"low_confidence":0.93,"median_width":3,"merge_min_beats":1,"no_chord_energy":0.02,"resolution":"eighth",' +
      '"self_transition":0.6,"seventh_margin":0.0,"seventh_weight":0.98,"smoothing":"viterbi","theory_prior":1.0,' +
      '"use_seventh":true,"vocab":"v2","vocab_margin":0.05,"vocab_sus4_margin":0.2},"chroma":{"aggregate":"median",' +
      '"bass_fmin_hz":32.7,"bass_octaves":3,"bins_per_octave":36,"fmin_hz":32.7,"kind":"cqt","n_octaves":6},' +
      '"downbeat":{"anticipation_shift":1.0,"beats_per_bar":4,"chord_conf_floor":0.3,"same_root_change":0.5,' +
      '"tie_break_phase":0,"w_bass":0.5,"w_chord_change":1.0,"w_onset":0.5},"key":{"enabled":true,"track":"sections"},' +
      '"name":"dsp-v1","sections":{"chroma_weight":1.0,"enabled":true,"kernel_bars":4,"loudness_weight":0.5,' +
      '"min_novelty":0.25,"min_section_bars":4,"noise_factor":2.5,"peak_threshold":0.3,"percussive_weight":0.5,' +
      '"repetition_weight":0.5,"same_label_similarity":0.85,"snap_bars":4,"snap_min_ratio":0.8},' +
      '"tables":{"harmony":"3ee1fcdc5999","key_fit":"0f1348d3fc17"}}';
    expect(pyCanonicalJson(hashDict(DEFAULT_CONFIG))).toBe(py);
  });

  it('pinned table digests match the committed ts/tables/*.json (Python _table_digest)', () => {
    for (const name of ['key_fit', 'harmony'] as const) {
      const text = TABLE_TEXT[name];
      expect(tableDigestFromJsonText(text), name).toBe(TABLE_DIGESTS[name]);
    }
  });

  it('sha256 matches FIPS test vectors', () => {
    expect(sha256Hex(enc(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(enc('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      sha256Hex(
        enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      ),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(sha256Hex(enc('a'.repeat(1000)))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });
});

describe('Python JSON formatting', () => {
  it('pyFloatRepr follows repr(float)', () => {
    const cases: [number, string][] = [
      [1, '1.0'],
      [0, '0.0'],
      [-0, '-0.0'],
      [0.02, '0.02'],
      [32.7, '32.7'],
      [100, '100.0'],
      [0.0001, '0.0001'],
      [1e-5, '1e-05'],
      [1.5e-7, '1.5e-07'],
      [-2.5e-10, '-2.5e-10'],
      [1e16, '1e+16'],
      [1.2345e21, '1.2345e+21'],
      [123456789012345.6, '123456789012345.6'],
      [0.1 + 0.2, '0.30000000000000004'],
    ];
    for (const [x, s] of cases) expect(pyFloatRepr(x), String(x)).toBe(s);
  });

  it('pyJsonString escapes like ensure_ascii', () => {
    expect(pyJsonString('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
    expect(pyJsonString('§3.1 和')).toBe('"\\u00a73.1 \\u548c"');
    expect(pyJsonString('\u007f\u0001')).toBe('"\\u007f\\u0001"');
    expect(pyJsonString('😀')).toBe('"\\ud83d\\ude00"');
  });

  it('parseJsonKeepNumbers keeps int / float literals', () => {
    const v = parseJsonKeepNumbers(
      '{"b": [1, 2.0, -3e-05], "a": {"x": "y", "t": true, "n": null}}',
    );
    expect(pyCanonicalJson(v)).toBe(
      '{"a":{"n":null,"t":true,"x":"y"},"b":[1,2.0,-3e-05]}',
    );
    expect((v as { b: RawNumber[] }).b[1]).toBeInstanceOf(RawNumber);
    expect(() => parseJsonKeepNumbers('{"a": 1} x')).toThrow();
  });
});

describe('default config', () => {
  it('matches the module defaults of the ported stages', () => {
    const { chords } = DEFAULT_CONFIG;
    for (const [k, v] of Object.entries(DEFAULT_CHORDS_CONFIG))
      expect((chords as unknown as Record<string, unknown>)[k], k).toBe(v);
    expect({ ...DEFAULT_CONFIG.downbeat }).toEqual(DEFAULT_DOWNBEAT_CONFIG);
    expect({ ...DEFAULT_CONFIG.sections }).toEqual(DEFAULT_SECTIONS_CONFIG);
    expect({
      change_cost_mid: DEFAULT_CONFIG.key.change_cost_mid,
      change_cost_boundary: DEFAULT_CONFIG.key.change_cost_boundary,
    }).toEqual(DEFAULT_KEY_CONFIG);
  });

  it('every field has a type, and the types fit the values', () => {
    for (const g of GROUPS) {
      expect(Object.keys(CONFIG_TYPES[g]).sort()).toEqual(
        Object.keys(DEFAULT_CONFIG[g]).sort(),
      );
    }
  });
});

describe('resolveConfig (default path only)', () => {
  it('accepts no overrides and overrides equal to the defaults (int for float, too)', () => {
    expect(resolveConfig()).toBe(DEFAULT_CONFIG);
    expect(
      resolveConfig({
        chords: { theory_prior: 1, low_confidence: 0.93 },
        name: 'dsp-v1',
      }),
    ).toBe(DEFAULT_CONFIG);
  });

  it('rejects non-default values, unknown keys and wrong types', () => {
    expect(() => resolveConfig({ beats: { method: 'plp' } })).toThrow(
      /beats.method="plp" is not supported/,
    );
    expect(() => resolveConfig({ beats: { tempo_hint: 120 } })).toThrow(
      /tempo_hint=120/,
    );
    expect(() => resolveConfig({ key: { track: 'global' } })).toThrow(
      /key.track/,
    );
    expect(() => resolveConfig({ chords: { theory_prior: 0 } })).toThrow(
      /theory_prior/,
    );
    expect(() => resolveConfig({ chords: { nope: 1 } })).toThrow(
      /unknown config key: "nope" in chords/,
    );
    expect(() => resolveConfig({ nope: {} })).toThrow(/unknown config key/);
    expect(() => resolveConfig({ audio: { sr: 22050.5 } })).toThrow(
      /expected int/,
    );
    expect(() => resolveConfig({ chords: { slash: 0 } })).toThrow(
      /expected bool/,
    );
    expect(() => resolveConfig({ name: 'x' })).toThrow(/name/);
    expect(() => resolveConfig([])).toThrow(/object/);
  });
});
