import { useEffect, useRef } from 'react';
import { saveDraftRecord, type KeyValueStorage } from '../lib/storage';

export const AUTOSAVE_DELAY_MS = 500;

/**
 * Saves `text` as the draft record (JSON `DraftRecord`, with `baseVersion`:
 * the Drive version editing started from, null for a song not on Drive) of
 * `songId` after `delay` ms without changes
 * (docs/m3-plan.md, decision 9). A pending save is flushed on unmount, on
 * `pagehide` (tab close / reload / navigation) and when the document becomes
 * hidden (tab switch / app switch — `pagehide` alone misses these), so the
 * last keystrokes are not lost. The text the hook starts with is not written
 * back. If `songId` (or `storage`) changes, a pending save is flushed under
 * the OLD id first — it is never written under the new one.
 */
export function useAutosave(
  text: string,
  songId: string,
  storage: KeyValueStorage | null,
  baseVersion: string | null = null,
  delay = AUTOSAVE_DELAY_MS,
): void {
  const saved = useRef(text);
  const pending = useRef<string | null>(null);
  const target = useRef({ storage, songId, baseVersion });
  const prevKey = useRef({ storage, songId, baseVersion });

  const flush = useRef(() => {
    const value = pending.current;
    if (value === null) return;
    pending.current = null;
    saved.current = value;
    const t = target.current;
    saveDraftRecord(t.storage, t.songId, {
      v: 1,
      text: value,
      baseVersion: t.baseVersion,
      savedAt: new Date().toISOString(),
    });
  });

  useEffect(() => {
    const prev = prevKey.current;
    if (prev.storage !== storage || prev.songId !== songId) {
      // Flush under the OLD id/storage before switching targets, then reset
      // so the new id's baseline is the text as of the switch (never
      // resaving it right back, and never saving it under the old id).
      const value = pending.current;
      if (value !== null) {
        pending.current = null;
        saveDraftRecord(prev.storage, prev.songId, {
          v: 1,
          text: value,
          baseVersion: prev.baseVersion,
          savedAt: new Date().toISOString(),
        });
      }
      saved.current = text;
      prevKey.current = { storage, songId, baseVersion };
    }
    target.current = { storage, songId, baseVersion };
    prevKey.current.baseVersion = baseVersion;
  });

  useEffect(() => {
    if (text === saved.current) {
      pending.current = null;
      return;
    }
    pending.current = text;
    const timer = setTimeout(flush.current, delay);
    return () => clearTimeout(timer);
  }, [text, delay]);

  useEffect(() => {
    const onPageHide = flush.current;
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      onPageHide();
    };
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush.current();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);
}
