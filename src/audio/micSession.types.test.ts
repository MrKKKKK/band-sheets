import { describe, expect, it } from 'vitest';
import { isMicError, micErrorOf } from './micSession.types';

describe('micErrorOf', () => {
  it('classifies by name, also a plain object (OverconstrainedError is not an Error everywhere)', () => {
    expect(micErrorOf({ name: 'OverconstrainedError' }).kind).toBe('notFound');
    expect(micErrorOf('x').kind).toBe('unknown');
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'notFound'],
    ['OverconstrainedError', 'notFound'],
    ['NotReadableError', 'busy'],
    ['AbortError', 'busy'],
    ['TypeError', 'unknown'],
  ])('%s → %s', (name, kind) => {
    const e = new DOMException('x', name);
    const m = micErrorOf(e);
    expect(isMicError(m)).toBe(true);
    expect(m.kind).toBe(kind);
    expect(m.cause).toBe(e);
  });
});
