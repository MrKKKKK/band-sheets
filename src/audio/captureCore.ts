/**
 * The logic of the capture AudioWorklet (capture.worklet.ts), kept free of worklet globals so it runs in unit tests
 * (docs/mic-recording-plan.md §2.5). Fed one render quantum at a time with the context frame of its first sample
 * (`currentFrame`), it
 * - always reports the input's peak every LEVEL_FRAMES frames (the meter, also before / after a capture);
 * - while a capture runs, sends the mono samples of frames [from, min(end, stopAt)) in chunks of about CHUNK_FRAMES,
 *   each with the context frame of its first sample (takeBuffer.ts's `{frame, data}`);
 * - ends the capture ITSELF at `end` (the 10-minute limit, exact even when the main thread's timers lag in a hidden
 *   tab) or at the frame given by `stop`, flushes the last partial chunk and then sends `end` — on the same port, so
 *   every chunk is delivered before it.
 * More than one input channel is averaged into mono.
 */

/** Main thread → worklet. */
export type CaptureCommand =
  /** `id` comes back on this capture's chunks and end, so late messages of an earlier capture are told apart. */
  | { type: 'start'; id: number; from: number; end: number }
  /** End at context frame `at` (now or in the past = at the next quantum). */
  | { type: 'stop'; at: number };

/** Worklet → main thread. */
export type CaptureMessage =
  | { type: 'level'; peak: number }
  | { type: 'chunk'; id: number; frame: number; data: Float32Array }
  /** `frame` = the end of the data sent (exclusive; `from` when nothing was); `limit` = stopped by the `end` given to `start`. */
  | { type: 'end'; id: number; frame: number; reason: 'stopped' | 'limit' };

/** The processor's registered name; scripts/check-bundle.mjs also uses it as the marker of the mic code. */
export const CAPTURE_PROCESSOR = 'band-sheets-mic-capture';

export const CHUNK_FRAMES = 4096;
/** About 43 ms at 48 kHz. */
export const LEVEL_FRAMES = 2048;

export type Post = (msg: CaptureMessage, transfer?: Transferable[]) => void;

export class CaptureCore {
  private readonly post: Post;
  private levelPeak = 0;
  private levelFrames = 0;
  private capturing = false;
  private id = 0;
  private from = 0;
  private limit = 0;
  private limitIsEnd = true;
  private chunk = new Float32Array(CHUNK_FRAMES);
  private chunkFrame = 0;
  private chunkLength = 0;
  private sentEnd = 0;
  private mono = new Float32Array(128);

  constructor(post: Post) {
    this.post = post;
  }

  command(cmd: CaptureCommand): void {
    if (cmd.type === 'start') {
      this.flush();
      this.capturing = true;
      this.id = cmd.id;
      this.from = cmd.from;
      this.limit = cmd.end;
      this.limitIsEnd = true;
      this.chunkLength = 0;
      this.sentEnd = cmd.from;
    } else if (this.capturing && cmd.at < this.limit) {
      this.limit = cmd.at;
      this.limitIsEnd = false;
    }
  }

  /** One render quantum: `channels` = the input's channels (none when nothing is connected), starting at `frame`. */
  process(
    channels: readonly Float32Array[],
    frame: number,
    length: number,
  ): void {
    const n = channels.length;
    let peak = this.levelPeak;
    if (this.mono.length < length) this.mono = new Float32Array(length);
    const mono = this.mono; // reused: no allocation per render quantum
    for (let i = 0; i < length; i++) {
      let s = 0;
      for (let c = 0; c < n; c++) s += channels[c][i];
      s = n > 1 ? s / n : s;
      mono[i] = s;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    this.levelPeak = peak;
    this.levelFrames += length;
    if (this.levelFrames >= LEVEL_FRAMES) {
      this.post({ type: 'level', peak: this.levelPeak });
      this.levelPeak = 0;
      this.levelFrames = 0;
    }
    if (!this.capturing) return;
    const a = Math.max(frame, this.from);
    const b = Math.min(frame + length, this.limit);
    for (let f = a; f < b; f++) this.push(f, mono[f - frame]);
    if (frame + length >= this.limit) {
      this.flush();
      this.capturing = false;
      this.post({
        type: 'end',
        id: this.id,
        frame: this.sentEnd,
        reason: this.limitIsEnd ? 'limit' : 'stopped',
      });
    }
  }

  private push(frame: number, sample: number): void {
    if (this.chunkLength > 0 && frame !== this.chunkFrame + this.chunkLength)
      this.flush();
    if (this.chunkLength === 0) this.chunkFrame = frame;
    this.chunk[this.chunkLength++] = sample;
    this.sentEnd = frame + 1;
    if (this.chunkLength === CHUNK_FRAMES) this.flush();
  }

  private flush(): void {
    if (this.chunkLength === 0) return;
    const data = this.chunk.slice(0, this.chunkLength);
    this.post({ type: 'chunk', id: this.id, frame: this.chunkFrame, data }, [
      data.buffer,
    ]);
    this.chunkLength = 0;
  }
}
