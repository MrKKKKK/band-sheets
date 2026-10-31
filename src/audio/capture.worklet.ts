/**
 * The capture AudioWorklet (docs/mic-recording-plan.md §2.5): a thin wrapper of captureCore.ts in the
 * AudioWorkletGlobalScope. Loaded by micSession.ts through Vite's `?worker&url`, i.e. as a same-origin module
 * (`script-src 'self'`, no blob: URL); in the build its imports are bundled into this one chunk.
 * Not a `.worker.ts`: scripts/check-bundle.mjs treats `*.worker-*.js` chunks as analysis Workers (license notices).
 */
import {
  CAPTURE_PROCESSOR,
  CaptureCore,
  type CaptureCommand,
} from './captureCore';

// AudioWorkletGlobalScope (not in TypeScript's DOM lib)
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
): void;

class MicCapture extends AudioWorkletProcessor {
  private readonly core = new CaptureCore((msg, transfer) =>
    this.port.postMessage(msg, transfer ?? []),
  );

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<CaptureCommand>) =>
      this.core.command(e.data);
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0] ?? [];
    this.core.process(channels, currentFrame, channels[0]?.length ?? 128);
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR, MicCapture);
