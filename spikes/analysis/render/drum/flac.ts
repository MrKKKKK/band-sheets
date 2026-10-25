// Spike 5 T2: a small FLAC decoder (no dependency, no network) for the CC0 drum kits B and C
// (spikes/analysis/DRUM_SAMPLES.md). Written from the FLAC format specification (RFC 9639): STREAMINFO, frame
// header, CONSTANT / VERBATIM / FIXED / LPC subframes, Rice-coded residuals (incl. escape codes), wasted bits and
// the three stereo decorrelations. CRCs are not checked (the archives are SHA-256 pinned by fetch-drum-samples.sh).
// Output: one Float32Array per channel, scaled to [-1, 1) by 2^(bps-1). Bit-exactness against libsndfile is pinned
// by render/drum/audioFile.test.ts (PCM hashes computed in the analysis image).

export interface DecodedAudio {
  sampleRate: number;
  bitsPerSample: number;
  channels: Float32Array[];
}

class BitReader {
  pos = 0; // bit position
  constructor(private readonly b: Uint8Array) {}
  get bytePos(): number {
    return this.pos >> 3;
  }
  bit(): number {
    const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  /** Unsigned, n <= 32 (exact in a double). */
  bits(n: number): number {
    let v = 0;
    while (n > 0) {
      const off = this.pos & 7;
      const avail = 8 - off;
      const take = Math.min(avail, n);
      const byte = this.b[this.pos >> 3];
      const chunk = (byte >> (avail - take)) & ((1 << take) - 1);
      v = v * (1 << take) + chunk;
      this.pos += take;
      n -= take;
    }
    return v;
  }
  signed(n: number): number {
    if (n === 0) return 0;
    const u = this.bits(n);
    return u >= 2 ** (n - 1) ? u - 2 ** n : u;
  }
  /** Count of 0 bits before the next 1 (consumes the 1). */
  unary(): number {
    let n = 0;
    for (;;) {
      const off = this.pos & 7;
      const byte = (this.b[this.pos >> 3] << off) & 0xff;
      if (byte === 0) {
        n += 8 - off;
        this.pos += 8 - off;
        continue;
      }
      const lead = Math.clz32(byte) - 24; // zeros before the first 1 in this byte (from `off`)
      n += lead;
      this.pos += lead + 1;
      return n;
    }
  }
  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }
}

const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const FIXED: number[][] = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function residual(r: BitReader, blockSize: number, order: number, out: Float64Array): void {
  const method = r.bits(2);
  if (method > 1) throw new Error('flac: reserved residual coding method');
  const paramBits = method === 0 ? 4 : 5;
  const escape = method === 0 ? 15 : 31;
  const partOrder = r.bits(4);
  const parts = 1 << partOrder;
  let i = order;
  for (let p = 0; p < parts; p++) {
    const n = partOrder === 0 ? blockSize - order : p === 0 ? (blockSize >> partOrder) - order : blockSize >> partOrder;
    const k = r.bits(paramBits);
    if (k === escape) {
      const raw = r.bits(5);
      for (let j = 0; j < n; j++) out[i++] = r.signed(raw);
    } else {
      const pk = 2 ** k;
      for (let j = 0; j < n; j++) {
        const u = r.unary() * pk + (k ? r.bits(k) : 0);
        out[i++] = u % 2 ? -(u + 1) / 2 : u / 2;
      }
    }
  }
}

function subframe(r: BitReader, blockSize: number, bps: number): Float64Array {
  if (r.bit() !== 0) throw new Error('flac: bad subframe padding');
  const type = r.bits(6);
  let wasted = 0;
  if (r.bit()) wasted = r.unary() + 1;
  const sbps = bps - wasted;
  const x = new Float64Array(blockSize);
  if (type === 0) {
    x.fill(r.signed(sbps));
  } else if (type === 1) {
    for (let i = 0; i < blockSize; i++) x[i] = r.signed(sbps);
  } else if (type >= 8 && type <= 12) {
    const order = type - 8;
    for (let i = 0; i < order; i++) x[i] = r.signed(sbps);
    residual(r, blockSize, order, x);
    const c = FIXED[order];
    for (let i = order; i < blockSize; i++) {
      let s = 0;
      for (let j = 0; j < order; j++) s += c[j] * x[i - 1 - j];
      x[i] += s;
    }
  } else if (type >= 32) {
    const order = type - 31;
    for (let i = 0; i < order; i++) x[i] = r.signed(sbps);
    const precision = r.bits(4) + 1;
    if (precision === 16) throw new Error('flac: invalid LPC precision');
    const shift = r.signed(5);
    if (shift < 0) throw new Error('flac: negative LPC shift');
    const coef: number[] = [];
    for (let j = 0; j < order; j++) coef.push(r.signed(precision));
    residual(r, blockSize, order, x);
    const div = 2 ** shift;
    for (let i = order; i < blockSize; i++) {
      let s = 0;
      for (let j = 0; j < order; j++) s += coef[j] * x[i - 1 - j];
      x[i] += Math.floor(s / div);
    }
  } else throw new Error(`flac: reserved subframe type ${type}`);
  if (wasted) {
    const m = 2 ** wasted;
    for (let i = 0; i < blockSize; i++) x[i] *= m;
  }
  return x;
}

/** Skips the UTF-8-like coded frame / sample number. */
function skipCodedNumber(r: BitReader): void {
  const first = r.bits(8);
  let extra = 0;
  for (let m = 0x80; first & m; m >>= 1) extra++;
  if (extra === 1 || extra > 7) throw new Error('flac: bad coded number');
  for (let i = 1; i < extra; i++) r.bits(8);
}

export function decodeFlac(buf: Uint8Array): DecodedAudio {
  if (buf[0] !== 0x66 || buf[1] !== 0x4c || buf[2] !== 0x61 || buf[3] !== 0x43) throw new Error('flac: missing fLaC marker');
  const r = new BitReader(buf);
  r.pos = 32;
  let sampleRate = 0;
  let nch = 0;
  let bps = 0;
  let total = 0;
  for (;;) {
    const last = r.bit();
    const type = r.bits(7);
    const len = r.bits(24);
    const start = r.bytePos;
    if (type === 0) {
      r.bits(16); // min block
      r.bits(16); // max block
      r.bits(24);
      r.bits(24);
      sampleRate = r.bits(20);
      nch = r.bits(3) + 1;
      bps = r.bits(5) + 1;
      total = r.bits(4) * 2 ** 32 + r.bits(32);
    }
    r.pos = (start + len) * 8;
    if (last) break;
  }
  if (!sampleRate) throw new Error('flac: no STREAMINFO');
  const chans: Float64Array[][] = Array.from({ length: nch }, () => []);
  let got = 0;
  const scale = 1 / 2 ** (bps - 1);
  while (r.bytePos + 2 < buf.length && (total === 0 || got < total)) {
    const sync = r.bits(14);
    if (sync !== 0x3ffe) throw new Error(`flac: lost frame sync at byte ${r.bytePos}`);
    r.bit();
    r.bit(); // blocking strategy (the coded number is skipped either way)
    const bsCode = r.bits(4);
    const srCode = r.bits(4);
    const chCode = r.bits(4);
    const ssCode = r.bits(3);
    r.bit();
    skipCodedNumber(r);
    let blockSize = BLOCK_SIZES[bsCode];
    if (bsCode === 6) blockSize = r.bits(8) + 1;
    else if (bsCode === 7) blockSize = r.bits(16) + 1;
    if (srCode === 12) r.bits(8);
    else if (srCode === 13 || srCode === 14) r.bits(16);
    r.bits(8); // CRC-8
    const fbps = ssCode === 0 ? bps : [0, 8, 12, 0, 16, 20, 24, 32][ssCode];
    if (!fbps) throw new Error('flac: reserved sample size');
    const sub: Float64Array[] = [];
    if (chCode < 8) {
      for (let c = 0; c <= chCode; c++) sub.push(subframe(r, blockSize, fbps));
    } else {
      const a = subframe(r, blockSize, fbps + (chCode === 9 ? 1 : 0));
      const b = subframe(r, blockSize, fbps + (chCode === 9 ? 0 : 1));
      if (chCode === 8) for (let i = 0; i < blockSize; i++) b[i] = a[i] - b[i]; // left/side
      else if (chCode === 9) for (let i = 0; i < blockSize; i++) a[i] = a[i] + b[i]; // side/right
      else if (chCode === 10) {
        for (let i = 0; i < blockSize; i++) {
          const side = b[i];
          const mid = a[i] * 2 + (side % 2 !== 0 ? 1 : 0); // (mid << 1) | (side & 1), sign-safe
          a[i] = (mid + side) / 2;
          b[i] = (mid - side) / 2;
        }
      } else throw new Error('flac: reserved channel assignment');
      sub.push(a, b);
    }
    if (sub.length !== nch) throw new Error('flac: channel count changed');
    r.align();
    r.bits(16); // CRC-16
    for (let c = 0; c < nch; c++) chans[c].push(sub[c]);
    got += blockSize;
  }
  const n = total || got;
  const channels = chans.map((blocks) => {
    const out = new Float32Array(n);
    let o = 0;
    for (const b of blocks) {
      for (let i = 0; i < b.length && o < n; i++) out[o++] = b[i] * scale;
    }
    return out;
  });
  return { sampleRate, bitsPerSample: bps, channels };
}
