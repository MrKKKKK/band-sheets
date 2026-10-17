# Third-party code in `spikes/analysis/ts/`

Rule: no GPL / LGPL / AGPL code (plan section 0). NumPy / SciPy (BSD) processing may be rewritten.

## librosa 0.11.0 (ISC)

The TS port follows librosa's implementation line by line where it must reproduce librosa's numbers
(see `docs/audio-spike3-librosa-notes.md`), so those parts are a translation of librosa and carry
its notice:

- Every TS file that follows librosa code starts with a one-line comment:
  `// Follows librosa 0.11.0 (ISC, (c) 2013--2023 librosa development team); see ts/THIRD_PARTY.md.`
- When this code is shipped in the app later, the built JS must keep the notice (a `/*! ... */`
  comment or a bundled license list).

License text (from the librosa 0.11.0 distribution in the analysis image):

```text
ISC License

Copyright (c) 2013--2023, librosa development team.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## fft.js (MIT)

Planned (T4): FFT library, exact version pinned in `spikes/analysis/package.json`.
