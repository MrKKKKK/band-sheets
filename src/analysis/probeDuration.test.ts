import { describe, expect, it, vi } from 'vitest';
import { probeDuration, type MetadataElement } from './probeDuration';
import { wavBytes } from './testing/wavBytes';

function fakeElement(duration: number, outcome: 'load' | 'error' | 'never') {
  const el: MetadataElement & { srcSet: string[] } = {
    preload: '',
    srcSet: [],
    get src() {
      return this.srcSet.at(-1) ?? '';
    },
    set src(v: string) {
      this.srcSet.push(v);
      queueMicrotask(() => {
        if (outcome === 'load') el.onloadedmetadata?.();
        if (outcome === 'error') el.onerror?.();
      });
    },
    duration,
    onloadedmetadata: null,
    onerror: null,
    removeAttribute: vi.fn(),
    load: vi.fn(),
  };
  return el;
}

describe('probeDuration', () => {
  it('reads a WAV header (no media element)', async () => {
    const bytes = wavBytes({
      sr: 22050,
      channels: 2,
      dataBytes: 22050 * 4 * 3,
    });
    const createElement = vi.fn();
    const d = await probeDuration(new Blob([bytes]), { createElement });
    expect(d).toBe(3);
    expect(createElement).not.toHaveBeenCalled();
  });

  it('uses the media metadata for other formats and revokes the URL', async () => {
    const el = fakeElement(222.4, 'load');
    const revokeUrl = vi.fn();
    const d = await probeDuration(new Blob(['ID3 not a wav']), {
      createElement: () => el,
      createUrl: () => 'blob:x',
      revokeUrl,
    });
    expect(d).toBe(222.4);
    expect(el.preload).toBe('metadata');
    expect(revokeUrl).toHaveBeenCalledWith('blob:x');
    expect(el.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('is null when the browser cannot read it', async () => {
    const revokeUrl = vi.fn();
    const d = await probeDuration(new Blob(['nope']), {
      createElement: () => fakeElement(NaN, 'error'),
      createUrl: () => 'blob:y',
      revokeUrl,
    });
    expect(d).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith('blob:y');
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const p = probeDuration(new Blob(['slow']), {
        createElement: () => fakeElement(10, 'never'),
        createUrl: () => 'blob:z',
        revokeUrl: () => undefined,
        timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('infinite duration (streams) counts as unknown', async () => {
    const d = await probeDuration(new Blob(['x']), {
      createElement: () => fakeElement(Infinity, 'load'),
      createUrl: () => 'blob:w',
      revokeUrl: () => undefined,
    });
    expect(d).toBeNull();
  });
});
