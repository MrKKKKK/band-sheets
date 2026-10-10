import type { Song } from '../song';

/** Canonical text of the sample song (serializeSong output must equal it). */
export const sampleSongText = `{title: きらきら星}
{key: C}
{tempo: 100}
{time: 4/4}

{start_of_verse: A}
[C]きらきら[F]ひか[C]る
[F]おそら[C]の[G]ほし[C]よ
{end_of_verse}

{start_of_chorus: B}
[C]みんなの[G]うたが
[C]とどくと[G]いいな
{end_of_chorus}

{start_of_part: Vocal}
\\lyrics "き ら き ら ひ か る お そ ら の ほ し よ"
\\section "A"
:4 C4 C4 G4 G4 | A4 A4 G4.2 | :4 F4 F4 E4 E4 | D4 D4 C4.2 |
\\section "B"
:4 G4 G4 F4 F4 | E4 E4 D4.2 | :4 G4 G4 F4 F4 | E4 E4 D4.2 |
{end_of_part}

{start_of_part: Drums}
\\instrument percussion
\\section "A"
:8 (HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH :16 SD SD SD SD SD SD (SD BD) (SD BD) |
{end_of_part}
`;

export const sampleSong: Song = {
  meta: { title: 'きらきら星', key: 'C', tempo: 100, time: '4/4' },
  chart: [
    {
      kind: 'verse',
      label: 'A',
      lines: [
        {
          segments: [
            { chord: 'C', lyrics: 'きらきら' },
            { chord: 'F', lyrics: 'ひか' },
            { chord: 'C', lyrics: 'る' },
          ],
        },
        {
          segments: [
            { chord: 'F', lyrics: 'おそら' },
            { chord: 'C', lyrics: 'の' },
            { chord: 'G', lyrics: 'ほし' },
            { chord: 'C', lyrics: 'よ' },
          ],
        },
      ],
    },
    {
      kind: 'chorus',
      label: 'B',
      lines: [
        {
          segments: [
            { chord: 'C', lyrics: 'みんなの' },
            { chord: 'G', lyrics: 'うたが' },
          ],
        },
        {
          segments: [
            { chord: 'C', lyrics: 'とどくと' },
            { chord: 'G', lyrics: 'いいな' },
          ],
        },
      ],
    },
  ],
  parts: [
    {
      name: 'Vocal',
      body: [
        '\\lyrics "き ら き ら ひ か る お そ ら の ほ し よ"',
        '\\section "A"',
        ':4 C4 C4 G4 G4 | A4 A4 G4.2 | :4 F4 F4 E4 E4 | D4 D4 C4.2 |',
        '\\section "B"',
        ':4 G4 G4 F4 F4 | E4 E4 D4.2 | :4 G4 G4 F4 F4 | E4 E4 D4.2 |',
      ].join('\n'),
    },
    {
      name: 'Drums',
      body: [
        '\\instrument percussion',
        '\\section "A"',
        ':8 (HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |',
        '(HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |',
        '(HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |',
        '(HH BD) HH (HH SD) HH :16 SD SD SD SD SD SD (SD BD) (SD BD) |',
      ].join('\n'),
    },
  ],
};
