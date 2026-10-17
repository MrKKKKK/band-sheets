// Tables are generated from py/dsp/tables/*.toml by py/tools/tables_to_json.py. Drift against the TOML is
// guarded by py/tests/test_tables_to_json.py (Python side); here: the committed JSON loads and keeps provenance.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

const EXPECTED: Record<string, string[]> = {
  harmony: ['_source', 'family', 'tier'],
  key_fit: ['_source', 'change', 'minor', 'phrase', 'resolution', 'stage'],
};

describe('tables JSON', () => {
  for (const [name, keys] of Object.entries(EXPECTED)) {
    it(`${name}: loads, has the expected top-level keys`, () => {
      const t = load(name);
      for (const k of keys) expect(Object.keys(t)).toContain(k);
    });
    it(`${name}: carries the source line`, () => {
      const s = load(name)._source;
      expect(typeof s).toBe('string');
      expect(s).toContain('和声法ノート v3（band-sheets 音声解析用）');
      expect(s).toContain('books: なし');
    });
  }
});
