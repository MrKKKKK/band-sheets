/**
 * Spike 3 T14: the analyzer config (py/dsp/config.py), default path only (plan section 5, design decision 4).
 *
 * DEFAULT_CONFIG has every value of Python's default `Config()` (= config.json that py/tools/dump_stages.py
 * writes per variant). The TS port runs the default path only: `resolveConfig` rejects any override that is
 * not equal to the default value (unknown keys, wrong types and non-default values all raise).
 *
 * configHash() replicates py config.config_hash: SHA-256 (first 12 hex chars) over the canonical JSON
 * (json.dumps(sort_keys=True, separators=(',', ':')), ensure_ascii, Python float repr) of the config dict
 * minus the spike 2 fields at their "off" value (SPIKE1_OFF_VALUES), plus `tables` = digests of the theory
 * tables in use (key_fit when key.track == 'sections', harmony when chords.theory_prior > 0).
 *
 * Table digests: Python hashes the parsed TOML (int / float kept apart: `bars = 8` -> 8, `mid = 4.0` -> 4.0).
 * JSON.parse loses that difference, so the digests are pinned here (TABLE_DIGESTS) and config.test.ts
 * recomputes them from the raw text of ts/tables/*.json (tableDigestFromJsonText keeps number literals as
 * written by Python's json.dumps, drops `_source`) -- a regenerated table fails that test until the pin is
 * updated. sha256 is a small synchronous implementation (same code in Node and in a Worker).
 */

export type FieldType = 'int' | 'float' | 'bool' | 'str';
type Value = number | boolean | string;

export interface AnalyzerConfig {
  name: string;
  audio: { sr: number; hop: number; hpss: boolean; hpss_margin: number };
  beats: {
    method: string;
    trim: boolean;
    start_bpm: number;
    tightness: number;
    tempo_octave: string;
    tempo_hint: number;
  };
  chroma: {
    kind: string;
    n_octaves: number;
    fmin_hz: number;
    bins_per_octave: number;
    bass_fmin_hz: number;
    bass_octaves: number;
    aggregate: string;
    top_voice_discount: number;
  };
  chords: {
    smoothing: string;
    self_transition: number;
    median_width: number;
    use_seventh: boolean;
    seventh_weight: number;
    seventh_margin: number;
    low_confidence: number;
    no_chord_energy: number;
    merge_min_beats: number;
    resolution: string;
    confidence: string;
    harmonics: string;
    harmonic_decay: number;
    bass_root: string;
    bass_root_weight: number;
    slash: boolean;
    seventh_mode: string;
    vocab: string;
    vocab_weight: number;
    vocab_margin: number;
    vocab_sus4_margin: number;
    theory_prior: number;
    power: boolean;
    power_third_max: number;
    candidates: boolean;
    candidates_k: number;
  };
  downbeat: {
    beats_per_bar: number;
    w_chord_change: number;
    w_bass: number;
    w_onset: number;
    tie_break_phase: number;
    chord_conf_floor: number;
    same_root_change: number;
    anticipation_shift: number;
  };
  sections: {
    enabled: boolean;
    kernel_bars: number;
    peak_threshold: number;
    min_section_bars: number;
    snap_bars: number;
    same_label_similarity: number;
    chroma_weight: number;
    loudness_weight: number;
    min_novelty: number;
    repetition_weight: number;
    snap_min_ratio: number;
    noise_factor: number;
    percussive_weight: number;
  };
  key: {
    enabled: boolean;
    track: string;
    change_cost_mid: number;
    change_cost_boundary: number;
  };
}

export type GroupName = Exclude<keyof AnalyzerConfig, 'name'>;
export const GROUPS: readonly GroupName[] = [
  'audio',
  'beats',
  'chroma',
  'chords',
  'downbeat',
  'sections',
  'key',
];

/** Field types of py/dsp/config.py (decide int vs float in the canonical JSON, and type checks). */
export const CONFIG_TYPES: {
  [G in GroupName]: Record<keyof AnalyzerConfig[G], FieldType>;
} = {
  audio: { sr: 'int', hop: 'int', hpss: 'bool', hpss_margin: 'float' },
  beats: {
    method: 'str',
    trim: 'bool',
    start_bpm: 'float',
    tightness: 'float',
    tempo_octave: 'str',
    tempo_hint: 'float',
  },
  chroma: {
    kind: 'str',
    n_octaves: 'int',
    fmin_hz: 'float',
    bins_per_octave: 'int',
    bass_fmin_hz: 'float',
    bass_octaves: 'int',
    aggregate: 'str',
    top_voice_discount: 'float',
  },
  chords: {
    smoothing: 'str',
    self_transition: 'float',
    median_width: 'int',
    use_seventh: 'bool',
    seventh_weight: 'float',
    seventh_margin: 'float',
    low_confidence: 'float',
    no_chord_energy: 'float',
    merge_min_beats: 'int',
    resolution: 'str',
    confidence: 'str',
    harmonics: 'str',
    harmonic_decay: 'float',
    bass_root: 'str',
    bass_root_weight: 'float',
    slash: 'bool',
    seventh_mode: 'str',
    vocab: 'str',
    vocab_weight: 'float',
    vocab_margin: 'float',
    vocab_sus4_margin: 'float',
    theory_prior: 'float',
    power: 'bool',
    power_third_max: 'float',
    candidates: 'bool',
    candidates_k: 'int',
  },
  downbeat: {
    beats_per_bar: 'int',
    w_chord_change: 'float',
    w_bass: 'float',
    w_onset: 'float',
    tie_break_phase: 'int',
    chord_conf_floor: 'float',
    same_root_change: 'float',
    anticipation_shift: 'float',
  },
  sections: {
    enabled: 'bool',
    kernel_bars: 'int',
    peak_threshold: 'float',
    min_section_bars: 'int',
    snap_bars: 'int',
    same_label_similarity: 'float',
    chroma_weight: 'float',
    loudness_weight: 'float',
    min_novelty: 'float',
    repetition_weight: 'float',
    snap_min_ratio: 'float',
    noise_factor: 'float',
    percussive_weight: 'float',
  },
  key: {
    enabled: 'bool',
    track: 'str',
    change_cost_mid: 'float',
    change_cost_boundary: 'float',
  },
};

/** Python's default Config() (py/dsp/config.py at f087ca3; config hash adec583eb3c6). */
export const DEFAULT_CONFIG: AnalyzerConfig = deepFreeze({
  name: 'dsp-v1',
  audio: { sr: 22050, hop: 512, hpss: true, hpss_margin: 1.0 },
  beats: {
    method: 'ellis',
    trim: false,
    start_bpm: 120.0,
    tightness: 100.0,
    tempo_octave: 'rule',
    tempo_hint: 0.0,
  },
  chroma: {
    kind: 'cqt',
    n_octaves: 6,
    fmin_hz: 32.7,
    bins_per_octave: 36,
    bass_fmin_hz: 32.7,
    bass_octaves: 3,
    aggregate: 'median',
    top_voice_discount: 0.0,
  },
  chords: {
    smoothing: 'viterbi',
    self_transition: 0.6,
    median_width: 3,
    use_seventh: true,
    seventh_weight: 0.98,
    seventh_margin: 0.0,
    low_confidence: 0.93,
    no_chord_energy: 0.02,
    merge_min_beats: 1,
    resolution: 'eighth',
    confidence: 'posterior',
    harmonics: 'none',
    harmonic_decay: 0.6,
    bass_root: 'none',
    bass_root_weight: 0.0,
    slash: false,
    seventh_mode: 'beat',
    vocab: 'v2',
    vocab_weight: 1.0,
    vocab_margin: 0.05,
    vocab_sus4_margin: 0.2,
    theory_prior: 1.0,
    power: false,
    power_third_max: 0.2,
    candidates: true,
    candidates_k: 3,
  },
  downbeat: {
    beats_per_bar: 4,
    w_chord_change: 1.0,
    w_bass: 0.5,
    w_onset: 0.5,
    tie_break_phase: 0,
    chord_conf_floor: 0.3,
    same_root_change: 0.5,
    anticipation_shift: 1.0,
  },
  sections: {
    enabled: true,
    kernel_bars: 4,
    peak_threshold: 0.3,
    min_section_bars: 4,
    snap_bars: 4,
    same_label_similarity: 0.85,
    chroma_weight: 1.0,
    loudness_weight: 0.5,
    min_novelty: 0.25,
    repetition_weight: 0.5,
    snap_min_ratio: 0.8,
    noise_factor: 2.5,
    percussive_weight: 0.5,
  },
  key: {
    enabled: true,
    track: 'sections',
    change_cost_mid: 0.0,
    change_cost_boundary: 0.0,
  },
});

/** py config.SPIKE1_OFF_VALUES: fields left out of the hash when at these values. */
export const SPIKE1_OFF_VALUES: { [G in GroupName]?: Record<string, Value> } = {
  beats: { tempo_octave: 'none', tempo_hint: 0.0 },
  chroma: { top_voice_discount: 0.0 },
  chords: {
    resolution: 'beat',
    confidence: 'margin',
    harmonics: 'none',
    harmonic_decay: 0.6,
    bass_root: 'none',
    bass_root_weight: 0.0,
    slash: false,
    seventh_mode: 'beat',
    vocab: 'v1',
    vocab_weight: 1.0,
    vocab_margin: 0.02,
    vocab_sus4_margin: 0.1,
    theory_prior: 0.0,
    power: false,
    power_third_max: 0.2,
    candidates: false,
    candidates_k: 3,
  },
  sections: { percussive_weight: 0.0 },
  key: { track: 'global', change_cost_mid: 0.0, change_cost_boundary: 0.0 },
};

/**
 * 12-hex digests of the parsed theory tables (py config._table_digest). Pinned (see the header); checked
 * against ts/tables/*.json by config.test.ts.
 */
export const TABLE_DIGESTS = {
  key_fit: '0f1348d3fc17',
  harmony: '3ee1fcdc5999',
} as const;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
// overrides (py apply_overrides, restricted to the default path)

function typeOk(t: FieldType, v: unknown): boolean {
  if (t === 'bool') return typeof v === 'boolean';
  if (t === 'str') return typeof v === 'string';
  if (t === 'int') return typeof v === 'number' && Number.isInteger(v);
  return typeof v === 'number' && Number.isFinite(v); // float: int accepted, as in Python
}

/**
 * Defaults with a (partial, nested) override object applied, like py load_config / apply_overrides.
 * The TS port has the default path only, so every override must equal the default: unknown keys,
 * wrong types and non-default values raise an Error.
 */
export function resolveConfig(overrides: unknown = {}): AnalyzerConfig {
  if (
    overrides === null ||
    typeof overrides !== 'object' ||
    Array.isArray(overrides)
  ) {
    throw new Error(
      `config overrides must be an object, got ${JSON.stringify(overrides)}`,
    );
  }
  for (const [g, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (g === 'name') {
      if (v !== DEFAULT_CONFIG.name)
        throw new Error(
          `config name=${JSON.stringify(v)}: only ${DEFAULT_CONFIG.name} is supported`,
        );
      continue;
    }
    if (!(GROUPS as readonly string[]).includes(g))
      throw new Error(`unknown config key: ${JSON.stringify(g)}`);
    if (v === null || typeof v !== 'object' || Array.isArray(v))
      throw new Error(`config ${g}: expected an object`);
    const types = CONFIG_TYPES[g as GroupName] as Record<string, FieldType>;
    const defs = DEFAULT_CONFIG[g as GroupName] as unknown as Record<
      string,
      Value
    >;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!(k in types))
        throw new Error(`unknown config key: ${JSON.stringify(k)} in ${g}`);
      if (!typeOk(types[k], x))
        throw new Error(
          `${g}.${k}: expected ${types[k]}, got ${JSON.stringify(x)}`,
        );
      if (x !== defs[k]) {
        throw new Error(
          `${g}.${k}=${JSON.stringify(x)} is not supported by the TS port (default path only; default ${JSON.stringify(defs[k])})`,
        );
      }
    }
  }
  return DEFAULT_CONFIG;
}

/** Throws unless `cfg` has exactly the default values (and nothing else). */
export function checkDefaultConfig(cfg: AnalyzerConfig): void {
  const known = new Set<string>(['name', ...GROUPS]);
  for (const k of Object.keys(cfg))
    if (!known.has(k))
      throw new Error(`unknown config key: ${JSON.stringify(k)}`);
  for (const g of GROUPS) {
    const grp = (cfg as unknown as Record<string, unknown>)[g];
    if (!grp || typeof grp !== 'object') throw new Error(`config ${g} missing`);
    for (const k of Object.keys(CONFIG_TYPES[g]))
      if (!(k in grp)) throw new Error(`config ${g}.${k} missing`);
  }
  resolveConfig(cfg);
}

/** py config_summary: values that differ from the defaults (always {} on the TS default path). */
export function configSummary(cfg: AnalyzerConfig): Record<string, unknown> {
  checkDefaultConfig(cfg);
  return {};
}

// ---------------------------------------------------------------------------------------------
// canonical JSON (Python json.dumps(sort_keys=True, separators=(',', ':')), ensure_ascii=True)

/** Python repr() of a float ('1.0', '0.02', '1e-05', '1e+16'). */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mant, expS] = Math.abs(x).toExponential().split('e'); // shortest round-trip digits
  const digits = mant.replace('.', '');
  const e = Number(expS);
  if (e < -4 || e >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const ee = Math.abs(e) < 10 ? `0${Math.abs(e)}` : `${Math.abs(e)}`;
    return `${sign}${m}e${e < 0 ? '-' : '+'}${ee}`;
  }
  if (e < 0) return `${sign}0.${'0'.repeat(-e - 1)}${digits}`;
  const intPart = digits.slice(0, e + 1).padEnd(e + 1, '0');
  const frac = digits.slice(e + 1);
  return `${sign}${intPart}.${frac || '0'}`;
}

/** Python json string encoding with ensure_ascii (\uXXXX lowercase for anything outside ' '..'~'). */
export function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || c > 0x7e)
      out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/** A number literal kept as written (int vs float), for canonical dumps of parsed JSON text. */
export class RawNumber {
  readonly raw: string;
  constructor(raw: string) {
    this.raw = raw;
  }
}

/** Typed float marker for pyCanonicalJson (plain JS numbers are written as ints when integral). */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** json.dumps(v, sort_keys=True, separators=(',', ':')) */
export function pyCanonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof RawNumber) return v.raw;
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number')
    return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === 'string') return pyJsonString(v);
  if (Array.isArray(v)) return `[${v.map(pyCanonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map((k) => `${pyJsonString(k)}:${pyCanonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  throw new Error(`cannot encode ${typeof v}`);
}

/** JSON.parse that keeps number literals as RawNumber (Python's json.dumps writes floats with a '.' or 'e'). */
export function parseJsonKeepNumbers(text: string): unknown {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        const k = value();
        if (typeof k !== 'string')
          throw new Error(`JSON: object key expected at ${i}`);
        ws();
        if (text[i++] !== ':')
          throw new Error(`JSON: ':' expected at ${i - 1}`);
        o[k] = value();
        ws();
        const d = text[i++];
        if (d === '}') return o;
        if (d !== ',') throw new Error(`JSON: ',' or '}' expected at ${i - 1}`);
      }
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        const d = text[i++];
        if (d === ']') return a;
        if (d !== ',') throw new Error(`JSON: ',' or ']' expected at ${i - 1}`);
      }
    }
    if (c === '"') {
      const start = i++;
      while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      return JSON.parse(text.slice(start, i)) as string;
    }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (m) {
      i += m[0].length;
      return new RawNumber(m[0]);
    }
    for (const [lit, val] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return val;
      }
    }
    throw new Error(`JSON: unexpected ${JSON.stringify(c)} at ${i}`);
  };
  const v = value();
  ws();
  if (i !== text.length) throw new Error(`JSON: trailing data at ${i}`);
  return v;
}

/** py config._table_digest from the text of ts/tables/<name>.json (the parsed TOML + `_source`). */
export function tableDigestFromJsonText(text: string): string {
  const t = parseJsonKeepNumbers(text) as Record<string, unknown>;
  const { _source: _ignored, ...table } = t;
  void _ignored;
  return sha256Hex(utf8(pyCanonicalJson(table))).slice(0, 12);
}

// ---------------------------------------------------------------------------------------------
// hash

/** py config._hash_dict for `cfg` (with the int / float typing of CONFIG_TYPES). */
export function hashDict(cfg: AnalyzerConfig): Record<string, unknown> {
  const d: Record<string, unknown> = { name: cfg.name };
  for (const g of GROUPS) {
    const types = CONFIG_TYPES[g] as Record<string, FieldType>;
    const grp = cfg[g] as unknown as Record<string, Value>;
    const offs = SPIKE1_OFF_VALUES[g] ?? {};
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(types)) {
      const v = grp[k];
      if (k in offs && offs[k] === v) continue;
      out[k] = types[k] === 'float' ? new PyFloat(v as number) : v;
    }
    d[g] = out;
  }
  const tables: Record<string, string> = {};
  if (cfg.key.track === 'sections') tables.key_fit = TABLE_DIGESTS.key_fit;
  if (cfg.chords.theory_prior > 0) tables.harmony = TABLE_DIGESTS.harmony;
  if (Object.keys(tables).length) d.tables = tables;
  return d;
}

/** py config.config_hash: 12 hex chars (adec583eb3c6 for the default config). */
export function configHash(cfg: AnalyzerConfig = DEFAULT_CONFIG): string {
  return sha256Hex(utf8(pyCanonicalJson(hashDict(cfg)))).slice(0, 12);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4) of `msg`, lowercase hex. */
export function sha256Hex(msg: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
  dv.setUint32(padded.length - 4, (len << 3) >>> 0, false);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(off + 4 * t, false);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15];
      const b = w[t - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
