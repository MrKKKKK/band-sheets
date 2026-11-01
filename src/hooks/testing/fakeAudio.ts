/**
 * A fake <audio> for the unit tests of useAudioPlayer / useHumPlayback, as strict as a browser where the hooks
 * depend on it: events arrive later as tasks (setTimeout 0), never inside the call that causes them. The order is
 * what headless Chromium does with a local WAV (measured 2026-10-25):
 * - `play()` (when paused): `paused` turns false at once, then `play`, then `playing` once data is there
 *   (at once when the metadata is loaded and no seek is pending, else `waiting` first).
 * - `pause()` (when playing): `paused` turns true at once, then `pause`.
 * - every `currentTime` assignment on a loaded element seeks, even to the same second: `seeking` (+ `waiting`
 *   when not paused), then `seeked`, then `playing` when not paused — so `seeked` comes BEFORE `playing`.
 *   Before the metadata it only sets the start position, which is sought after `loadMetadata()`.
 * The playback position moving by itself is `advance(sec)` (no events), the end of the file `end()`.
 */

type Handler = (() => void) | null;

export interface FakeAudio {
  preload: string;
  src: string;
  muted: boolean;
  readonly paused: boolean;
  currentTime: number;
  readonly duration: number;
  /** 0 = nothing, 1 = metadata (enough for this fake: data is there with the metadata). */
  readonly readyState: number;
  onloadedmetadata: Handler;
  onplay: Handler;
  onplaying: Handler;
  onwaiting: Handler;
  onpause: Handler;
  onended: Handler;
  onseeking: Handler;
  onseeked: Handler;
  onerror: Handler;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  /** The browser read the metadata: `loadedmetadata` (now), then a pending start position is sought. */
  loadMetadata(): void;
  /** The position moves as playing does (no seek, no events). */
  advance(sec: number): void;
  /** The file played to its end: `pause` then `ended`. */
  end(): void;
  /** The browser cannot play the file: `error`. */
  fail(): void;
  /** Event names in the order they were dispatched (for assertions). */
  readonly log: string[];
}

export function fakeAudio(opts: { duration?: number } = {}): FakeAudio {
  const fileDuration = opts.duration ?? 8;
  let paused = true;
  let position = 0;
  let readyState = 0;
  let waitingToPlay = false;
  let seekPending = false;
  let pending: ReturnType<typeof setTimeout>[] = [];
  const log: string[] = [];

  const fire = (name: string) => {
    log.push(name);
    (el as unknown as Record<string, Handler>)[`on${name}`]?.();
  };
  const later = (...steps: (string | (() => void))[]) => {
    const id = setTimeout(() => {
      pending = pending.filter((p) => p !== id);
      steps.forEach((s) => (typeof s === 'string' ? fire(s) : s()));
    }, 0);
    pending.push(id);
  };
  const clamp = (sec: number) => Math.min(Math.max(0, sec), fileDuration);

  const el: FakeAudio = {
    preload: '',
    src: '',
    muted: false,
    get paused() {
      return paused;
    },
    get currentTime() {
      return position;
    },
    set currentTime(sec: number) {
      if (readyState === 0) {
        position = Math.max(0, sec);
        return;
      }
      position = clamp(sec);
      seekPending = true;
      later('seeking', ...(paused ? [] : ['waiting']));
      later(() => {
        seekPending = false;
        fire('seeked');
        if (!paused) fire('playing');
      });
    },
    get duration() {
      return readyState === 0 ? NaN : fileDuration;
    },
    get readyState() {
      return readyState;
    },
    onloadedmetadata: null,
    onplay: null,
    onplaying: null,
    onwaiting: null,
    onpause: null,
    onended: null,
    onseeking: null,
    onseeked: null,
    onerror: null,
    play() {
      if (paused) {
        paused = false;
        if (readyState === 0) {
          waitingToPlay = true;
          later('play', 'waiting');
        } else if (seekPending)
          later('play', 'waiting'); // `playing` follows `seeked`
        else later('play', 'playing');
      }
      return Promise.resolve();
    },
    pause() {
      if (paused) return;
      paused = true;
      waitingToPlay = false;
      later('pause');
    },
    load() {
      pending.forEach(clearTimeout);
      pending = [];
      paused = true;
      waitingToPlay = false;
      seekPending = false;
      position = 0;
      readyState = 0;
    },
    removeAttribute(name: string) {
      if (name === 'src') el.src = '';
    },
    loadMetadata() {
      readyState = 1;
      fire('loadedmetadata');
      const resume = waitingToPlay && !paused;
      waitingToPlay = false;
      if (position > 0) {
        // the start position is sought; `playing` then follows `seeked`
        position = clamp(position);
        seekPending = true;
        later('seeking', () => {
          seekPending = false;
          fire('seeked');
          if (!paused) fire('playing');
        });
      } else if (resume) later('playing');
    },
    advance(sec: number) {
      position = clamp(sec);
    },
    end() {
      position = fileDuration;
      paused = true;
      later('pause', 'ended');
    },
    fail() {
      fire('error');
    },
    log,
  };
  return el;
}
