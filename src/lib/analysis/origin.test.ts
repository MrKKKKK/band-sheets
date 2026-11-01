import { describe, expect, it } from 'vitest';
import { configHash } from './chords/config';
import { humConfigHash } from './hum/config';
import { CHORDS_CONFIG_HASH, HUM_CONFIG_HASH, ORIGIN_COMMIT } from './origin';

describe('origin', () => {
  it('records a full commit hash', () => {
    expect(ORIGIN_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
  it('the chords config hash of the ported code is the recorded one', () => {
    expect(configHash()).toBe(CHORDS_CONFIG_HASH);
  });
  it('the hum config hash of the ported code is the recorded one', () => {
    expect(humConfigHash()).toBe(HUM_CONFIG_HASH);
  });
});
