import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureCommand, CaptureMessage } from './captureCore';
import {
  connectCapture,
  createMicSession,
  foldDevices,
  isMicError,
  micErrorOf,
  type CaptureGraph,
  type Capture,
  type MicHandlers,
} from './micSession';

const dev = (
  deviceId: string,
  groupId: string,
  label = deviceId,
  kind: MediaDeviceKind = 'audioinput',
) => ({ deviceId, groupId, label, kind }) as MediaDeviceInfo;

describe('foldDevices', () => {
  it('folds default / communications into the real devices and marks the default', () => {
    const list = [
      dev('default', 'g2', '既定 - USB Mic'),
      dev('communications', 'g1', '通信 - Built-in'),
      dev('real-1', 'g1', 'Built-in'),
      dev('real-2', 'g2', 'USB Mic'),
      dev('out-1', 'g2', 'Speaker', 'audiooutput'),
    ];
    expect(foldDevices(list)).toEqual([
      { deviceId: 'real-1', label: 'Built-in', isDefault: false },
      { deviceId: 'real-2', label: 'USB Mic', isDefault: true },
    ]);
  });

  it('without a shared groupId, the twin is found by the label after " - "', () => {
    expect(
      foldDevices([
        dev('default', 'gx', 'Default - USB Mic'),
        dev('real-1', 'g1', 'Built-in'),
        dev('real-2', 'g2', 'USB Mic'),
      ]),
    ).toEqual([
      { deviceId: 'real-1', label: 'Built-in', isDefault: false },
      { deviceId: 'real-2', label: 'USB Mic', isDefault: true },
    ]);
  });

  it('a groupId shared by two real inputs falls back to the label', () => {
    expect(
      foldDevices([
        dev('default', 'g1', '既定 - In 2'),
        dev('in-1', 'g1', 'In 1'),
        dev('in-2', 'g1', 'In 2'),
      ]).find((d) => d.isDefault)?.deviceId,
    ).toBe('in-2');
  });

  it('keeps a default without a real twin (Chromium fake device); drops a lonely communications', () => {
    expect(
      foldDevices([
        dev('default', 'gx', 'Default'),
        dev('communications', 'gy'),
      ]),
    ).toEqual([{ deviceId: 'default', label: 'Default', isDefault: true }]);
  });

  it('before the permission (one entry, empty ids) the first input is the default', () => {
    expect(foldDevices([dev('', '', '')])).toEqual([
      { deviceId: '', label: '', isDefault: true },
    ]);
  });

  it('no inputs → []', () => {
    expect(foldDevices([])).toEqual([]);
  });
});

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

// --- fakes for the real session -------------------------------------------------------------------------------

class FakeTrack extends EventTarget {
  stopped = false;
  readyState: MediaStreamTrackState = 'live';
  label: string;
  settings: MediaTrackSettings;
  constructor(settings: MediaTrackSettings, label = 'Mic') {
    super();
    this.settings = settings;
    this.label = label;
  }
  getSettings() {
    return this.settings;
  }
  stop() {
    this.stopped = true;
  }
}

function fakeStream(track: FakeTrack) {
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/** `default` (group g1) → real `mic-1`; getUserMedia without an exact id lands on `default`. */
function fakeMediaDevices(opts: { error?: string; permitted?: boolean } = {}) {
  const tracks: FakeTrack[] = [];
  const requests: MediaStreamConstraints[] = [];
  let permitted = opts.permitted ?? false;
  const target = new EventTarget();
  const md = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    async enumerateDevices() {
      return permitted
        ? [dev('default', 'g1', '既定 - Mic'), dev('mic-1', 'g1', 'Mic')]
        : [dev('', '', '')];
    },
    async getUserMedia(c: MediaStreamConstraints) {
      requests.push(c);
      if (opts.error) throw new DOMException('no', opts.error);
      permitted = true;
      const exact = (
        (c.audio as MediaTrackConstraints).deviceId as { exact?: string }
      )?.exact;
      const t = new FakeTrack({
        deviceId: exact ?? 'default',
        groupId: 'g1',
        sampleRate: 44100,
      });
      tracks.push(t);
      return fakeStream(t);
    },
  };
  return { md: md as unknown as MediaDevices, tracks, requests };
}

class FakeSource {
  started: number | null = null;
  stoppedCalls = 0;
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect() {}
  disconnect() {}
  start(t: number) {
    this.started = t;
  }
  stop() {
    this.stoppedCalls++;
  }
}

class FakeContext extends EventTarget {
  state: AudioContextState = 'suspended';
  currentTime = 1.5;
  baseLatency = 0.01;
  outputLatency = 0.04;
  sampleRate: number;
  resumes = 0;
  resumeHangs = false;
  sourceError: unknown = null;
  closed = false;
  sources: FakeSource[] = [];
  destination = {};
  constructor(o: AudioContextOptions) {
    super();
    this.sampleRate = o.sampleRate ?? 48000;
  }
  createMediaStreamSource() {
    if (this.sourceError) throw this.sourceError;
    return {};
  }
  setState(state: string) {
    this.state = state as AudioContextState;
    this.dispatchEvent(new Event('statechange'));
  }
  createBuffer(_c: number, length: number) {
    return { length, copyToChannel() {} };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  resume() {
    this.resumes++;
    if (this.resumeHangs) return new Promise<void>(() => {}); // the autoplay rule refused: never settles
    this.setState('running');
    return Promise.resolve();
  }
  async close() {
    this.closed = true;
    this.state = 'closed';
    this.dispatchEvent(new Event('statechange'));
  }
}

function fakeGraph() {
  const g = {
    disposed: 0,
    captures: [] as [number, number][],
    onError: undefined as undefined | (() => void),
  };
  const connect = (async (_ctx, _src, handlers) => {
    g.onError = handlers?.onError;
    return {
      startCapture(from: number, end: number) {
        g.captures.push([from, end]);
        return {} as Capture;
      },
      dispose() {
        g.disposed++;
      },
    } satisfies CaptureGraph;
  }) as typeof connectCapture;
  return { g, connect };
}

function setup(
  opts: Parameters<typeof fakeMediaDevices>[0] & {
    /** runs on the new context before anything else */
    initContext?: (c: FakeContext) => void;
    /** replaces the graph's connect (e.g. to fail like addModule) */
    connect?: typeof connectCapture;
  } = {},
) {
  const media = fakeMediaDevices(opts);
  const contexts: FakeContext[] = [];
  const { g, connect } = fakeGraph();
  const session = createMicSession({
    mediaDevices: media.md,
    createContext: (o) => {
      const c = new FakeContext(o);
      opts.initContext?.(c);
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    connect: opts.connect ?? connect,
  });
  const handlers: MicHandlers & { reasons: string[] } = {
    reasons: [],
    onInterrupted(r) {
      handlers.reasons.push(r);
    },
  };
  return { session, media, contexts, g, handlers };
}

describe('createMicSession', () => {
  it('opens the default with processing off, then re-opens the REAL device exactly', async () => {
    const { session, media, contexts, handlers } = setup();
    const mic = await session.open(null, handlers);
    expect(media.requests).toHaveLength(2);
    expect(media.requests[0].audio).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    });
    expect(media.requests[1].audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      deviceId: { exact: 'mic-1' },
    });
    expect(media.tracks[0].stopped).toBe(true);
    expect(media.tracks[1].stopped).toBe(false);
    expect(mic.deviceId).toBe('mic-1');
    // the context runs at the track's rate and was resumed after the awaits
    expect(contexts).toHaveLength(1);
    expect(mic.sampleRate).toBe(44100);
    expect(contexts[0].resumes).toBe(1);
  });

  it('with an earlier permission, the default is opened by its real id at once', async () => {
    const { session, media, handlers } = setup({ permitted: true });
    const mic = await session.open(null, handlers);
    expect(media.requests).toHaveLength(1);
    expect(media.requests[0].audio).toMatchObject({
      deviceId: { exact: 'mic-1' },
    });
    expect(mic.deviceId).toBe('mic-1');
  });

  it('a default with no real twin is opened and kept as `default`', async () => {
    const media = fakeMediaDevices({ permitted: true });
    const md = media.md as unknown as {
      enumerateDevices(): Promise<MediaDeviceInfo[]>;
      getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
    };
    const gum = md.getUserMedia;
    md.getUserMedia = async (c) => {
      const stream = await gum(c);
      media.tracks.at(-1)!.settings.groupId = 'gd';
      return stream;
    };
    md.enumerateDevices = async () => [
      dev('default', 'gd', 'Fake Default Audio Input'),
      dev('mic-1', 'g1', 'Fake Audio Input 1'),
    ];
    const s = createMicSession({
      mediaDevices: media.md,
      createContext: (o) => new FakeContext(o) as unknown as AudioContext,
      connect: fakeGraph().connect,
    });
    const mic = await s.open(null, { onInterrupted() {} });
    expect(media.requests).toHaveLength(1);
    expect(mic.deviceId).toBe('default');
  });

  it('a chosen device is opened exactly', async () => {
    const { session, media, handlers } = setup({ permitted: true });
    await session.open('mic-1', handlers);
    expect(media.requests[0].audio).toMatchObject({
      deviceId: { exact: 'mic-1' },
    });
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['NotFoundError', 'notFound'],
    ['NotReadableError', 'busy'],
  ])('getUserMedia %s → MicError %s, no context made', async (name, kind) => {
    const { session, contexts, handlers } = setup({ error: name });
    await expect(session.open(null, handlers)).rejects.toMatchObject({ kind });
    expect(contexts).toHaveLength(0);
  });

  it('no mediaDevices → unsupported', async () => {
    const s = createMicSession({
      mediaDevices: {} as MediaDevices,
      connect: fakeGraph().connect,
    });
    await expect(s.open(null, { onInterrupted() {} })).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });

  it('listDevices folds the virtual entries', async () => {
    const { session } = setup({ permitted: true });
    expect(await session.listDevices()).toEqual([
      { deviceId: 'mic-1', label: 'Mic', isDefault: true },
    ]);
  });

  it('onDeviceChange subscribes and unsubscribes', () => {
    const { session, media } = setup();
    const fn = vi.fn();
    const off = session.onDeviceChange(fn);
    media.md.dispatchEvent(new Event('devicechange'));
    off();
    media.md.dispatchEvent(new Event('devicechange'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports the latency, the clock, and forwards captures', async () => {
    const { session, g, handlers } = setup();
    const mic = await session.open(null, handlers);
    expect(mic.latencyNow()).toEqual({
      baseLatencySec: 0.01,
      outputLatencySec: 0.04,
    });
    expect(mic.now()).toBe(1.5);
    mic.startCapture(100, 200);
    expect(g.captures).toEqual([[100, 200]]);
  });

  it('schedules every click at its time and stops them all', async () => {
    const { session, contexts, handlers } = setup();
    const mic = await session.open(null, handlers);
    mic.scheduleClicks([
      { time: 2, strong: true },
      { time: 2.5, strong: false },
      { time: 3, strong: false },
    ]);
    const srcs = contexts[0].sources;
    expect(srcs.map((s) => s.started)).toEqual([2, 2.5, 3]);
    expect(srcs[0].buffer).not.toBe(srcs[1].buffer);
    expect(srcs[1].buffer).toBe(srcs[2].buffer);
    srcs[2].onended?.(); // one already played
    mic.stopClicks();
    expect(srcs.map((s) => s.stoppedCalls)).toEqual([1, 1, 0]);
  });

  it('interruptions: track ended once, a closed context; none after close()', async () => {
    const { session, media, contexts, g, handlers } = setup();
    const mic = await session.open(null, handlers);
    media.tracks[1].dispatchEvent(new Event('ended'));
    media.tracks[1].dispatchEvent(new Event('ended'));
    expect(handlers.reasons).toEqual(['ended']);

    const b = setup();
    await b.session.open(null, b.handlers);
    await b.contexts[0].close(); // closed by the browser, not by us
    expect(b.handlers.reasons).toEqual(['contextClosed']);
    expect(b.g.disposed).toBe(1);

    const c = setup();
    await c.session.open(null, c.handlers);
    c.g.onError?.();
    expect(c.handlers.reasons).toEqual(['workletError']);

    await mic.close();
    expect(contexts[0].closed).toBe(true);
    expect(media.tracks[1].stopped).toBe(true);
    expect(g.disposed).toBeGreaterThan(0);
    const d = setup();
    const m2 = await d.session.open(null, d.handlers);
    await m2.close();
    d.media.tracks[1].dispatchEvent(new Event('ended'));
    expect(d.handlers.reasons).toEqual([]);
  });
});

describe('createMicSession: failures after getUserMedia', () => {
  // addModule's fetch / CSP failure (AbortError) is NOT "busy", nor any other name "denied" etc.
  it.each(['AbortError', 'NotAllowedError'])(
    'connect (addModule) failing with %s → unknown, track stopped, context closed',
    async (name) => {
      const { session, media, contexts, handlers } = setup({
        connect: async () => {
          throw new DOMException('x', name);
        },
      });
      await expect(session.open(null, handlers)).rejects.toMatchObject({
        kind: 'unknown',
      });
      expect(media.tracks.every((t) => t.stopped)).toBe(true);
      expect(contexts[0].closed).toBe(true);
      expect(handlers.reasons).toEqual([]);
    },
  );

  it('createMediaStreamSource failing → unknown, cleaned up', async () => {
    const { session, media, contexts, handlers } = setup({
      initContext: (c) =>
        (c.sourceError = new DOMException('x', 'NotSupportedError')),
    });
    await expect(session.open(null, handlers)).rejects.toMatchObject({
      kind: 'unknown',
    });
    expect(media.tracks.every((t) => t.stopped)).toBe(true);
    expect(contexts[0].closed).toBe(true);
  });

  it('the context cannot be made → unsupported, track stopped', async () => {
    const media = fakeMediaDevices();
    const s = createMicSession({
      mediaDevices: media.md,
      createContext: () => {
        throw new DOMException('x', 'NotSupportedError');
      },
      connect: fakeGraph().connect,
    });
    await expect(s.open(null, { onInterrupted() {} })).rejects.toMatchObject({
      kind: 'unsupported',
    });
    expect(media.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('open returns even when resume() never settles (autoplay rule); the caller resumes again', async () => {
    const { session, contexts, handlers } = setup({
      initContext: (c) => (c.resumeHangs = true),
    });
    const mic = await session.open(null, handlers);
    expect(contexts[0].resumes).toBe(1);
    void mic.resume();
    expect(contexts[0].resumes).toBe(2);
  });
});

describe('createMicSession: interruptions by state', () => {
  it("'interrupted' → contextInterrupted", async () => {
    const { session, contexts, handlers } = setup();
    await session.open(null, handlers);
    contexts[0].setState('interrupted');
    expect(handlers.reasons).toEqual(['contextInterrupted']);
  });

  it('suspended after running → contextInterrupted; suspended before ever running → nothing', async () => {
    const a = setup();
    await a.session.open(null, a.handlers);
    a.contexts[0].setState('suspended');
    expect(a.handlers.reasons).toEqual(['contextInterrupted']);

    const b = setup({ initContext: (c) => (c.resumeHangs = true) });
    await b.session.open(null, b.handlers);
    b.contexts[0].setState('suspended');
    expect(b.handlers.reasons).toEqual([]);
  });

  it('a track that ended during the awaits is reported right after open', async () => {
    const media = { tracks: [] as FakeTrack[] };
    const t = setup({
      connect: (async () => {
        media.tracks.at(-1)!.readyState = 'ended';
        return fakeGraph().connect({} as BaseAudioContext, {} as AudioNode);
      }) as typeof connectCapture,
    });
    media.tracks = t.media.tracks;
    await t.session.open(null, t.handlers);
    expect(t.handlers.reasons).toEqual(['ended']);
  });
});

// --- connectCapture with a fake worklet node ---------------------------------------------------------------------

class FakePort {
  sent: CaptureCommand[] = [];
  onmessage: ((e: MessageEvent<CaptureMessage>) => void) | null = null;
  postMessage(m: CaptureCommand) {
    this.sent.push(m);
  }
  deliver(m: CaptureMessage) {
    this.onmessage?.({ data: m } as MessageEvent<CaptureMessage>);
  }
}

describe('connectCapture', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function graph(onLevel?: (p: number) => void) {
    const port = new FakePort();
    const added: string[] = [];
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        port = port;
        onprocessorerror = null;
        connect() {}
      },
    );
    const ctx = {
      sampleRate: 48000,
      destination: {},
      audioWorklet: { addModule: async (u: string) => void added.push(u) },
    } as unknown as BaseAudioContext;
    const source = { connect: vi.fn() } as unknown as AudioNode;
    const g = await connectCapture(ctx, source, { onLevel });
    return { g, port, added };
  }

  it('loads the worklet module by URL and passes levels on', async () => {
    const levels: number[] = [];
    const { port, added } = await graph((p) => levels.push(p));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/capture\.worklet/);
    port.deliver({ type: 'level', peak: 0.3 });
    expect(levels).toEqual([0.3]);
  });

  it('chunks land in the capture buffer; done resolves on end; stale ids are ignored', async () => {
    const { g, port } = await graph();
    const a = g.startCapture(1000.4, 5000);
    expect(port.sent[0]).toEqual({
      type: 'start',
      id: 1,
      from: 1000,
      end: 5000,
    });
    const b = g.startCapture(2000, 6000);
    expect(await a.done).toEqual({ frame: 0, reason: 'stopped' });
    // a late chunk of the first capture
    port.deliver({
      type: 'chunk',
      id: 1,
      frame: 1000,
      data: new Float32Array(10),
    });
    port.deliver({
      type: 'chunk',
      id: 2,
      frame: 2000,
      data: new Float32Array(256).fill(0.5),
    });
    expect(b.buffer.firstFrame).toBe(2000);
    expect(b.buffer.endFrame).toBe(2256);
    b.stop(2256);
    expect(port.sent.at(-1)).toEqual({ type: 'stop', at: 2256 });
    port.deliver({ type: 'end', id: 2, frame: 2256, reason: 'stopped' });
    expect(await b.done).toEqual({ frame: 2256, reason: 'stopped' });
    b.stop(3000); // after the end: nothing sent
    expect(port.sent.at(-1)).toEqual({ type: 'stop', at: 2256 });
  });

  it('dispose resolves a pending capture with closed', async () => {
    const { g, port } = await graph();
    const c = g.startCapture(0, 48000);
    port.deliver({
      type: 'chunk',
      id: 1,
      frame: 0,
      data: new Float32Array(128),
    });
    g.dispose();
    expect(await c.done).toEqual({ frame: 128, reason: 'closed' });
  });
});
