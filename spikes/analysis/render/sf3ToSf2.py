"""Converts MuseScore_General.sf3 (Ogg Vorbis samples) to an uncompressed .sf2.

alphaTab's synth cannot read sf3 (it skips the compressed samples and renders
NaN). Local tool only: run inside the analysis image (needs numpy, soundfile):
  docker run --rm -u 1000:1000 -e HOME=/tmp -v <repo>/spikes/analysis:/work -w /work \
    band-sheets-analysis python render/sf3ToSf2.py
Reads soundfonts/MuseScore_General.sf3, writes soundfonts/MuseScore_General.sf2.
In sf3 the sample header start/end are byte offsets of an Ogg blob and the loop
points are relative to the sample start; in sf2 all four are absolute frames.
Left/right sample types are turned into plain mono (alphaTab skips them); the
zones keep their pan generators, so the stereo image survives.
"""
import io
import struct
import sys

import numpy as np
import soundfile as sf

SRC = 'soundfonts/MuseScore_General.sf3'
DST = 'soundfonts/MuseScore_General.sf2'
ATTENUATION_FACTOR = 0.15
PAD = 46  # sf2 spec: 46 zero frames after every sample


def chunks(buf, pos, end):
    while pos + 8 <= end:
        cid = buf[pos:pos + 4]
        size = struct.unpack_from('<I', buf, pos + 4)[0]
        yield cid, pos + 8, size
        pos += 8 + size + (size & 1)


def chunk(cid, data):
    return cid + struct.pack('<I', len(data)) + data + (b'\0' if len(data) & 1 else b'')


def fix_generators(d, inst):
    """FluidSynth-isms alphaTab lacks: attenuation scaled (ATTENUATION_FACTOR; FluidSynth uses 0.4 and
    the font is still ~15 dB quieter than sonivox with it, so this is an empirical, fixed loudness
    calibration), and the piano's low-pass cutoff
    (~300 Hz) that FluidSynth opens with velocity modulators / the mod envelope: open it."""
    a = bytearray(d)
    for k in range(0, len(a) - 4 + 1, 4):
        op, amt = struct.unpack_from('<Hh', a, k)
        if op == 48:  # initialAttenuation (cB)
            struct.pack_into('<Hh', a, k, op, round(amt * ATTENUATION_FACTOR))
        elif op == 8:  # initialFilterFc: fully open (instrument level), no offset (preset level)
            struct.pack_into('<Hh', a, k, op, 13500 if inst else 0)
    return bytes(a)


def main():
    buf = open(SRC, 'rb').read()
    assert buf[:4] == b'RIFF' and buf[8:12] == b'sfbk'
    info = smpl = shdr = None
    pdta = []
    for cid, p, size in chunks(buf, 12, len(buf)):
        if cid != b'LIST':
            continue
        kind = buf[p:p + 4]
        for c2, p2, s2 in chunks(buf, p + 4, p + size):
            if kind == b'INFO':
                info = (info or []) + [(c2, buf[p2:p2 + s2])]
            elif kind == b'sdta' and c2 == b'smpl':
                smpl = buf[p2:p2 + s2]
            elif kind == b'pdta':
                if c2 == b'shdr':
                    shdr = buf[p2:p2 + s2]
                else:
                    pdta.append((c2, buf[p2:p2 + s2]))
    assert info and smpl is not None and shdr
    n = len(shdr) // 46
    out = io.BytesIO()
    new = bytearray()
    cursor = 0
    cache = {}
    for i in range(n):
        rec = list(struct.unpack_from('<20sIIIIIBbHH', shdr, i * 46))
        name, start, end, ls, le, rate, pitch, corr, link, typ = rec
        if name.startswith(b'EOS'):
            new += struct.pack('<20sIIIIIBbHH', name, cursor, cursor, cursor, cursor, rate, pitch, corr, link, typ)
            continue
        if typ & 0x10:
            key = (start, end)
            if key not in cache:
                data, _ = sf.read(io.BytesIO(smpl[start:end]), dtype='int16')
                cache[key] = data if data.ndim == 1 else data[:, 0]
            pcm = cache[key]
            typ &= ~0x10
            ls_abs, le_abs = ls, le  # relative to sample start
        else:
            pcm = np.frombuffer(smpl[start * 2:end * 2], dtype='<i2')
            ls_abs, le_abs = ls - start, le - start
        if typ in (2, 4):  # stereo halves: alphaTab only plays mono (type 1); pan generators stay
            typ, link = 1, 0
        s = cursor
        out.write(pcm.astype('<i2').tobytes())
        out.write(b'\0' * (PAD * 2))
        cursor += len(pcm) + PAD
        new += struct.pack('<20sIIIIIBbHH', name, s, s + len(pcm), s + ls_abs, s + le_abs, rate, pitch, corr, link, typ)
    pdta = [(c, fix_generators(d, c == b'igen') if c in (b'pgen', b'igen') else d) for c, d in pdta]
    info = [(c, struct.pack('<HH', 2, 1) if c == b'ifil' else d) for c, d in info]
    body = b'sfbk'
    body += chunk(b'LIST', b'INFO' + b''.join(chunk(c, d) for c, d in info))
    body += chunk(b'LIST', b'sdta' + chunk(b'smpl', out.getvalue()))
    body += chunk(b'LIST', b'pdta' + b''.join(chunk(c, d) for c, d in pdta) + chunk(b'shdr', bytes(new)))
    # keep pdta chunk order: shdr must be last (spec order), which is how sf2 writes it
    open(DST, 'wb').write(chunk(b'RIFF', body))
    print(f'{n} sample headers, {len(cache)} decoded blobs, {len(body) / 1e6:.0f} MB -> {DST}')


if __name__ == '__main__':
    sys.exit(main())
