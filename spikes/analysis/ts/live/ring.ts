/**
 * LT2 of the live chord-check tool (docs/live-chord-tool-plan.md section 4): the pure buffers of the capture side.
 *
 * - `FloatRing`: the last `capacity` samples of a stream, addressed by ABSOLUTE index (samples since the start), so the
 *   Worker can say "the window ending at index e" without caring what was dropped.
 * - `StreamResampler`: device rate -> 22,050 Hz ONCE, when the samples arrive (LT0: calling `resampleSinc` per window
 *   costs 30-60 ms). `resampleSinc` itself is not streaming, so it is called on blocks that are cut so the result is the
 *   same as one call on the whole signal: a block starts at a multiple of `down` input samples (so every output keeps its
 *   polyphase phase, output index = k * up / down exactly), carries `pad` >= half the filter width of earlier input as
 *   left context and waits for `pad` later input samples as right context (the cost: a few ms of delay at 48 kHz). Only
 *   the outputs of the block's own samples are kept. Before the first sample the context is 0, as in resampleSinc.
 */
import { resampleSinc, sincPlan } from '../dsp/core/resample';

export class FloatRing {
  private readonly buf: Float32Array;
  private total = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  /** Absolute index one past the newest sample (= samples pushed so far). */
  get end(): number {
    return this.total;
  }

  /** Absolute index of the oldest sample still held. */
  get start(): number {
    return Math.max(0, this.total - this.capacity);
  }

  push(x: Float32Array): void {
    const src = x.length > this.capacity ? x.subarray(x.length - this.capacity) : x;
    let i = this.total + x.length - src.length; // absolute index of src[0]
    let o = 0;
    while (o < src.length) {
      const pos = i % this.capacity;
      const n = Math.min(src.length - o, this.capacity - pos);
      this.buf.set(src.subarray(o, o + n), pos);
      o += n;
      i += n;
    }
    this.total += x.length;
  }

  /** Samples [from, to) by absolute index, a copy. Throws when they are not (or no longer) all held. */
  slice(from: number, to: number): Float32Array {
    if (!(from >= this.start && to <= this.total && from <= to)) throw new Error(`ring: [${from}, ${to}) is not held (${this.start}..${this.total})`);
    const out = new Float32Array(to - from);
    let o = 0;
    while (o < out.length) {
      const pos = (from + o) % this.capacity;
      const n = Math.min(out.length - o, this.capacity - pos);
      out.set(this.buf.subarray(pos, pos + n), o);
      o += n;
    }
    return out;
  }
}

export class StreamResampler {
  private readonly passthrough: boolean;
  private readonly up: number;
  private readonly down: number;
  /** left / right context in input samples, a multiple of `down` >= the filter's half width */
  private readonly pad: number;
  private hist: Float32Array;
  private pending: Float32Array = new Float32Array(0);

  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    this.passthrough = from === to;
    const plan = sincPlan(from, to);
    this.up = plan.up;
    this.down = plan.down;
    this.pad = Math.ceil((plan.half + 1) / plan.down) * plan.down;
    this.hist = new Float32Array(this.pad);
  }

  /** Input samples that arrived but are not yet in an output (the context wait). */
  get pendingInput(): number {
    return this.passthrough ? 0 : this.pending.length;
  }

  /** Adds input samples; returns the output samples that are now complete (possibly none). */
  push(x: Float32Array): Float32Array {
    if (this.passthrough) return x;
    const all = new Float32Array(this.pending.length + x.length);
    all.set(this.pending);
    all.set(x, this.pending.length);
    const take = Math.floor((all.length - this.pad) / this.down) * this.down;
    if (take <= 0) {
      this.pending = all;
      return new Float32Array(0);
    }
    const block = new Float32Array(this.pad + take + this.pad);
    block.set(this.hist);
    block.set(all.subarray(0, take + this.pad), this.pad);
    const out = resampleSinc(block, this.from, this.to).subarray((this.pad / this.down) * this.up, ((this.pad + take) / this.down) * this.up);
    this.hist = block.slice(take, take + this.pad);
    this.pending = all.slice(take);
    return out.slice();
  }
}
