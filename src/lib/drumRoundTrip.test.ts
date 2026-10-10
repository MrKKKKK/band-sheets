import { describe, expect, it } from 'vitest';
import { parseDrums } from './drumParse';
import { serializeDrums } from './drumTex';
import { drumFixtures, drumReadVariants } from './fixtures/drumFixtures';

describe('drum round trip: parseDrums(serializeDrums(fixture))', () => {
  it.each(drumFixtures.map((f) => [f.name, f] as const))('%s', (_, f) => {
    const tex = serializeDrums(f.events, f.shuffle, f.ts);
    expect(tex).toBe(f.tex);
    expect(parseDrums(tex, f.ts)).toEqual({
      ok: true,
      events: f.events,
      // An empty section writes nothing, so its shuffle reads back as none.
      shuffle: f.events.length === 0 ? 'none' : f.shuffle,
    });
  });
});

describe('drum round trip: serializeDrums(parseDrums(variant)) = canonical', () => {
  it.each(drumReadVariants.map((v) => [v.name, v] as const))('%s', (_, v) => {
    const res = parseDrums(v.tex, v.ts);
    if (!res.ok) throw new Error(`unexpected read-only: ${res.reason}`);
    const canonical = serializeDrums(res.events, res.shuffle, v.ts);
    expect(canonical).toBe(v.canonical);
    // The canonical text reads back to the same model.
    expect(parseDrums(canonical, v.ts)).toEqual(res);
  });
});
