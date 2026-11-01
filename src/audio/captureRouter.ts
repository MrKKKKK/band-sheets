/**
 * The main-thread side of the capture protocol (captureCore.ts): one capture at a time, its chunks into a fresh
 * TakeBuffer, `done` on the worklet's `end`. Shared by the real graph (micSession.ts) and fakeMicSession.ts, which
 * drives a CaptureCore directly.
 */
import { createTakeBuffer, type TakeBuffer } from '../lib/mic/takeBuffer';
import type { CaptureCommand, CaptureMessage } from './captureCore';
import type { Capture, CaptureEnd } from './micSession';

export interface CaptureRouter {
  receive(msg: CaptureMessage): void;
  startCapture(fromFrame: number, endFrame: number): Capture;
  /** Resolves the pending capture with `closed`; later messages are ignored. */
  dispose(): void;
}

export function createCaptureRouter(
  sampleRate: number,
  send: (cmd: CaptureCommand) => void,
  onLevel?: (peak: number) => void,
): CaptureRouter {
  let current: {
    id: number;
    buffer: TakeBuffer;
    finish(end: CaptureEnd): void;
  } | null = null;
  let nextId = 1;
  let disposed = false;

  const endCurrent = (reason: CaptureEnd['reason']) =>
    current?.finish({ frame: current.buffer.endFrame, reason });

  return {
    receive(msg) {
      if (disposed) return;
      if (msg.type === 'level') onLevel?.(msg.peak);
      else if (msg.id !== current?.id) return;
      else if (msg.type === 'chunk') current.buffer.add(msg);
      else current.finish({ frame: msg.frame, reason: msg.reason });
    },
    startCapture(fromFrame, endFrame) {
      endCurrent('stopped');
      const buffer = createTakeBuffer(sampleRate);
      let resolve!: (end: CaptureEnd) => void;
      const done = new Promise<CaptureEnd>((r) => (resolve = r));
      const me = {
        id: nextId++,
        buffer,
        finish(end: CaptureEnd) {
          if (current === me) current = null;
          resolve(end);
        },
      };
      if (disposed) me.finish({ frame: 0, reason: 'closed' });
      else {
        current = me;
        send({
          type: 'start',
          id: me.id,
          from: Math.round(fromFrame),
          end: Math.round(endFrame),
        });
      }
      return {
        buffer,
        done,
        stop(atFrame) {
          if (current === me) send({ type: 'stop', at: Math.round(atFrame) });
        },
      };
    },
    dispose() {
      endCurrent('closed');
      disposed = true;
    },
  };
}
