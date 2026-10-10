/**
 * The time source of the viewer's auto-scroll loop. The Viewer only needs
 * "now" and a per-frame callback; stories pass a manual clock so play tests
 * can step time without waiting (e2e uses Playwright's `page.clock`, which
 * drives the default browser clock).
 */
export interface ViewerClock {
  /** Milliseconds, monotonic. */
  now(): number;
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
}

export const browserClock: ViewerClock = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(() => cb()),
  cancelFrame: (id) => cancelAnimationFrame(id),
};

export interface ManualClock extends ViewerClock {
  /** Moves time forward, running the pending frames every `stepMs`. */
  advance(ms: number, stepMs?: number): void;
}

/** A clock that only moves when `advance` is called (tests / stories). */
export function createManualClock(): ManualClock {
  let time = 0;
  let nextId = 1;
  let queue = new Map<number, () => void>();
  return {
    now: () => time,
    requestFrame(cb) {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    cancelFrame(id) {
      queue.delete(id);
    },
    advance(ms, stepMs = 16) {
      let left = ms;
      while (left > 0) {
        const step = Math.min(stepMs, left);
        time += step;
        left -= step;
        const due = queue;
        queue = new Map();
        due.forEach((cb) => cb());
      }
    },
  };
}
