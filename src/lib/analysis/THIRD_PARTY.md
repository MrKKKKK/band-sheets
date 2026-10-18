# Third-party code in `src/lib/analysis/`

Ported from `spikes/analysis/ts/` of the research branch `research/audio-analysis` (commit in `origin.ts`). Paths below are the app's: `ts/dsp/core/*` is `core/`, `ts/dsp/*` is `chords/`.

Rule: no GPL / LGPL / AGPL code (plan section 0). NumPy / SciPy (BSD) processing may be rewritten.

## librosa 0.11.0 (ISC)

The TS port follows librosa's implementation line by line where it must reproduce librosa's numbers
(see `docs/audio-spike3-librosa-notes.md` on the research branch), so those parts are a translation of librosa and carry
its notice:

- Every TS file that follows librosa code (`core/cqt.ts`, `core/mel.ts`, `core/stft.ts`, `chords/audio.ts`, `chords/beats.ts`, `chords/chroma.ts`, `chords/tempo.ts`) starts with a one-line comment:
  `// Follows librosa 0.11.0 (ISC, (c) 2013--2023 librosa development team); see ts/THIRD_PARTY.md.` (kept verbatim from the research branch; the file is this one: `src/lib/analysis/THIRD_PARTY.md`)
- The built JS must keep the notice (a `/*! ... */` comment or a bundled license list; plan section 2.2, task T2).

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

`fft.js` 4.0.4 (npm, exact version pinned in the app's `package.json` `dependencies`), no dependencies.
Used as a library (not copied) by `core/fft.ts` (and `core/cqt.ts`).

License: MIT. Copyright Fedor Indutny, 2017.

```text
Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
```
