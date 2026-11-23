import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { stubNoNetwork } from '../parity/noNetwork';
import { analyzeWindow, calibrate, WAIT_SEC } from './core';
import { chordSignal, C_CHORD } from './synth';
import { VARIANTS } from './variants';

describe('no network from the analysis code (privacy rule)', () => {
  beforeEach(stubNoNetwork);
  afterEach(() => vi.unstubAllGlobals());
  it('calibrate and analyzeWindow of every available variant run with fetch / XHR / WebSocket / EventSource / sendBeacon forbidden', () => {
    const y = chordSignal(C_CHORD, 22050, 1 + 2 * WAIT_SEC, -22);
    const ctx = { ...calibrate(y), colStart: WAIT_SEC, colEnd: WAIT_SEC + 1 };
    for (const v of VARIANTS) expect(analyzeWindow(v, y, ctx).kind).toBe(v.logic ? 'chord' : 'unavailable');
  });
});
