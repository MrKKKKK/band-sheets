import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no ResizeObserver (M4): MelodyStaff uses one to measure its
// container width, and App's Tabs keeps every tab panel mounted (just
// `hidden`), so MelodyStaff mounts on every App render, even outside the
// melody tab. The stub never fires; MelodyStaff falls back to its MIN_WIDTH.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
});
