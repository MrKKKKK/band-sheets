import { describe, expect, it } from 'vitest';
import {
  lockDownNetwork,
  NETWORK_GLOBALS,
  NetworkForbiddenError,
} from './networkLockdown';

describe('lockDownNetwork', () => {
  it('replaces every network global with a function that throws, and it cannot be put back', () => {
    const scope: Record<string, unknown> = {
      fetch: () => 'sent',
      XMLHttpRequest: class {},
    };
    lockDownNetwork(scope);
    for (const k of NETWORK_GLOBALS) {
      const f = scope[k] as () => unknown;
      expect(typeof f).toBe('function');
      expect(() => f()).toThrow(NetworkForbiddenError);
      expect(() => {
        'use strict';
        scope[k] = () => 'restored';
      }).toThrow(TypeError);
      expect(() => Object.defineProperty(scope, k, { value: 1 })).toThrow(
        TypeError,
      );
    }
  });

  it('can run twice (already locked properties are left alone)', () => {
    const scope = {};
    lockDownNetwork(scope);
    expect(() => lockDownNetwork(scope)).not.toThrow();
  });
});
