import { describe, expect, it } from 'vitest';
import { heldOutRefusal, type GuardSources } from './heldout_guard';

const SRC: GuardSources = {
  syn: [
    { name: 'syn-h2-a-s1', wav: 'syn-h2-a-s1.wav', split: 'dev', heldOut: false },
    { name: 'syn-h2-a-s6', wav: 'syn-h2-a-s6.wav', split: 'heldOut', heldOut: true },
  ],
  rec: [
    { name: 'hum-01-a', wav: 'recordings/hum-01-a.wav', heldOut: false },
    { name: 'hum-02-c', wav: 'recordings/hum-02-c.wav', heldOut: true },
  ],
  ids: { 'hum-01-a': { heldOut: false }, 'hum-02-c': { heldOut: true }, 'hum-04-e': { heldOut: true } },
};

describe('heldOutRefusal (single-file CLI guard, review S6)', () => {
  it('lets dev synthetic and dev recordings through', () => {
    expect(heldOutRefusal('out/hum/syn-h2-a-s1.wav', SRC)).toBeNull();
    expect(heldOutRefusal('recordings/hum-01-a.wav', SRC)).toBeNull();
    expect(heldOutRefusal('/tmp/some-other.wav', SRC)).toBeNull();
  });
  it('refuses held-out synthetic wav and truth', () => {
    expect(heldOutRefusal('out/hum/syn-h2-a-s6.wav', SRC)).toMatch(/held-out/);
    expect(heldOutRefusal('out/hum/syn-h2-a-s6.truth.json', SRC)).toMatch(/held-out/);
  });
  it('refuses held-out recordings by manifest, by ids flag, with any directory', () => {
    expect(heldOutRefusal('recordings/hum-02-c.wav', SRC)).toMatch(/held-out/);
    expect(heldOutRefusal('/elsewhere/copy/hum-02-c.wav', SRC)).toMatch(/held-out/);
    // only in the ids file (manifest has no entry)
    expect(heldOutRefusal('recordings/hum-04-e.wav', SRC)).toMatch(/held-out/);
    expect(heldOutRefusal('recordings/hum-04-e.truth.json', { ...SRC, rec: null })).toMatch(/held-out/);
  });
  it('refuses when the flag cannot be verified', () => {
    expect(heldOutRefusal('recordings/hum-09-z.wav', { ...SRC, ids: null, rec: null })).toMatch(/cannot verify/);
    expect(heldOutRefusal('x/recordings/whatever.wav', { ...SRC, ids: null, rec: null })).toMatch(/cannot verify/);
    expect(heldOutRefusal('out/hum/syn-h0-a-s7.wav', { ...SRC, syn: null })).toMatch(/cannot verify/);
  });
  it('does not block unrelated files when manifests are missing', () => {
    expect(heldOutRefusal('/tmp/my-own.wav', { syn: null, rec: null, ids: null })).toBeNull();
  });
});
