/** Test helper (unit tests only): a PCM WAV header (+ `dataBytes` zero bytes, or fewer when `present` is given). */
export function wavBytes(opts: {
  sr: number;
  channels?: number;
  bits?: number;
  dataBytes: number;
  present?: number;
  format?: number;
}): Uint8Array<ArrayBuffer> {
  const present = opts.present ?? opts.dataBytes;
  const b = new Uint8Array(44 + present);
  const v = new DataView(b.buffer);
  const tag = (o: number, s: string) =>
    [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  const ch = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  tag(0, 'RIFF');
  v.setUint32(4, 36 + opts.dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, opts.format ?? 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, opts.sr, true);
  v.setUint32(28, (opts.sr * ch * bits) / 8, true);
  v.setUint16(32, (ch * bits) / 8, true);
  v.setUint16(34, bits, true);
  tag(36, 'data');
  v.setUint32(40, opts.dataBytes, true);
  return b;
}
