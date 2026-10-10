import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorage, draftKey } from '../lib/storage';
import { useAutosave } from './useAutosave';

const KEY = draftKey('local');
const textOf = (v: string | undefined) =>
  v === undefined ? v : JSON.parse(v).text;

function setup(initial = 'a') {
  const storage = createMemoryStorage();
  const hook = renderHook(
    ({ text }: { text: string }) => useAutosave(text, 'local', storage),
    { initialProps: { text: initial } },
  );
  return { storage, ...hook };
}

describe('useAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not write the initial text', () => {
    const { storage } = setup();
    act(() => vi.advanceTimersByTime(1000));
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('saves 500ms after the last change (debounced)', () => {
    const { storage, rerender } = setup();
    rerender({ text: 'ab' });
    act(() => vi.advanceTimersByTime(300));
    rerender({ text: 'abc' });
    act(() => vi.advanceTimersByTime(300));
    expect(storage.data.has(KEY)).toBe(false);
    act(() => vi.advanceTimersByTime(200));
    expect(textOf(storage.data.get(KEY))).toBe('abc');
  });

  it('flushes a pending save on unmount', () => {
    const { storage, rerender, unmount } = setup();
    rerender({ text: 'changed' });
    unmount();
    expect(textOf(storage.data.get(KEY))).toBe('changed');
  });

  it('flushes a pending save on pagehide', () => {
    const { storage, rerender } = setup();
    rerender({ text: 'changed' });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(textOf(storage.data.get(KEY))).toBe('changed');
  });

  it('does not save when the text goes back to the saved value', () => {
    const { storage, rerender, unmount } = setup();
    rerender({ text: 'b' });
    rerender({ text: 'a' });
    act(() => vi.advanceTimersByTime(1000));
    unmount();
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('flushes a pending save under the old songId when songId changes', () => {
    const storage = createMemoryStorage();
    const { rerender } = renderHook(
      ({ text, songId }: { text: string; songId: string }) =>
        useAutosave(text, songId, storage),
      { initialProps: { text: 'a', songId: 'one' } },
    );
    rerender({ text: 'changed', songId: 'one' });
    // Switching songId before the 500ms debounce fires must still flush the
    // pending text under the OLD id, never the new one.
    rerender({ text: 'changed', songId: 'two' });
    expect(textOf(storage.data.get(draftKey('one')))).toBe('changed');
    expect(storage.data.has(draftKey('two'))).toBe(false);
  });

  it('does not later write the old text under the new songId', () => {
    const storage = createMemoryStorage();
    const { rerender } = renderHook(
      ({ text, songId }: { text: string; songId: string }) =>
        useAutosave(text, songId, storage),
      { initialProps: { text: 'a', songId: 'one' } },
    );
    rerender({ text: 'changed', songId: 'one' });
    rerender({ text: 'changed', songId: 'two' });
    act(() => vi.advanceTimersByTime(1000));
    expect(storage.data.has(draftKey('two'))).toBe(false);
  });

  it('flushes a pending save when the document becomes hidden', () => {
    const { storage, rerender } = setup();
    rerender({ text: 'changed' });
    const original = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'visibilityState',
    );
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(textOf(storage.data.get(KEY))).toBe('changed');
    } finally {
      if (original) {
        Object.defineProperty(Document.prototype, 'visibilityState', original);
      }
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it('does not flush on visibilitychange when the document becomes visible', () => {
    const { storage, rerender } = setup();
    rerender({ text: 'changed' });
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(storage.data.has(KEY)).toBe(false);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it('saves a JSON draft record with baseVersion and savedAt', () => {
    const storage = createMemoryStorage();
    const { rerender } = renderHook(
      ({ text, base }: { text: string; base: string | null }) =>
        useAutosave(text, 'one', storage, base),
      { initialProps: { text: 'a', base: '3' as string | null } },
    );
    rerender({ text: 'b', base: '3' });
    act(() => vi.advanceTimersByTime(500));
    const rec = JSON.parse(storage.data.get(draftKey('one'))!);
    expect(rec).toMatchObject({ v: 1, text: 'b', baseVersion: '3' });
    expect(Number.isNaN(Date.parse(rec.savedAt))).toBe(false);
  });

  it('uses the baseVersion of the old song when flushing on a song switch', () => {
    const storage = createMemoryStorage();
    const { rerender } = renderHook(
      ({ text, id, base }: { text: string; id: string; base: string | null }) =>
        useAutosave(text, id, storage, base),
      { initialProps: { text: 'a', id: 'one', base: '3' as string | null } },
    );
    rerender({ text: 'b', id: 'one', base: '3' });
    rerender({ text: 'b', id: 'two', base: null });
    expect(JSON.parse(storage.data.get(draftKey('one'))!).baseVersion).toBe(
      '3',
    );
  });
});
