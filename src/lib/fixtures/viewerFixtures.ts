/**
 * Shared fixtures for the viewer (M6): `viewerSections.test.ts` (T12) checks
 * them against alphaTab's AlphaTexImporter; `SectionScore` (T13) /
 * `ViewerSheet` (T14) stories can render them (`parseSong(text)` →
 * `buildViewerSections` → `sectionScoreTex`).
 */

/**
 * T1's carry-over document (docs/m6-alphatab-findings.md §7) as one bass
 * part: `\ts`/`\ks` change in B, C has its own `\ks` line and no duration
 * on its first beat (carried `:8`), D changes `\clef`, E starts with a bare
 * note right after `\section` (T1 item 3: the whole-part read swallows
 * `D3` as the section's second argument; the section document reads it as
 * a note).
 */
export const carryOverBassBody = [
  '\\staff {score}',
  '\\ts 4 4',
  '\\ks D',
  '\\section "A"',
  ':4 D3 E3 F#3 G3 | A3 B3 C#4 D4',
  '\\section "B"',
  '\\ts 3 4',
  '\\ks Bb',
  ':8 Bb2 C3 D3 Eb3 F3 G3 | A3 Bb3 A3 G3 F3 Eb3',
  '\\section "C"',
  '\\ks F',
  'C3 D3 E3 F3 G3 A3',
  '\\section "D"',
  '\\clef bass',
  ':2 F2 :4 C3',
  '\\section "E"',
  'D3 E3 F3 G3 | A3 Bb3 C4',
].join('\n');

/** The drum side of T1's document: shuffle in B, inherited by C, off in D. */
export const carryOverDrumBody = [
  '\\instrument percussion',
  '\\section "A"',
  ':8 (HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH',
  '\\section "B"',
  '\\tf triplet8th',
  ':8 (HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH',
  '\\section "C"',
  ':4 BD SD BD SD',
  '\\section "D"',
  '\\tf none',
  ':4 BD SD BD SD',
].join('\n');

/** Chart A–E plus the two parts above. */
export const carryOverSongText = `{title: 持ち越し}
{time: 4/4}

{start_of_verse: A}
[D]あ
{end_of_verse}

{start_of_verse: B}
[Bb]い
{end_of_verse}

{start_of_verse: C}
[F]う
{end_of_verse}

{start_of_verse: D}
[F]え
{end_of_verse}

{start_of_verse: E}
[Bb]お
{end_of_verse}

{start_of_part: Bass}
${carryOverBassBody}
{end_of_part}

{start_of_part: Drums}
${carryOverDrumBody}
{end_of_part}
`;

/**
 * A realistic song for the viewer stories: chart A B A C plus an unnamed
 * closing block; Vocal (part-level `\lyrics`, dropped in the viewer), Bass
 * (bass clef) and Drums (shuffle in B, a drum-only "Fill" after B, back to
 * straight in C). Bars per section: A 4, B 4, Fill 1, C 2 → the second A
 * starts at bar 10, C at bar 14.
 */
export const viewerSongText = `{title: 閲覧のサンプル}
{key: G}
{tempo: 120}
{time: 4/4}

{start_of_verse: A}
[G]あさの[Em]ひかり[C]まどを[D]あけて
[G]かぜが[Em]そっと[C]ほおに[D]ふれる
{end_of_verse}

{start_of_chorus: B}
[C]うたを[D]うたおう[G]いま[Em]ここで
[C]こえを[D]あわせて[G]どこ[G7]までも
{end_of_chorus}

{start_of_verse: A}
[G]ゆうべの[Em]そらに[C]ほしが[D]ひとつ
[G]あすへ[Em]つづく[C]みちを[D]てらす
{end_of_verse}

{start_of_bridge: C}
[Am]しずかに[D]おわる
{end_of_bridge}

{comment: Fine}

{start_of_part: Vocal}
\\lyrics "あ さ の ひ か り"
\\section "A"
:4 B4 B4 A4 G4 | E4.2 E4.4 G4 | :4 C5 C5 B4 A4 | A4.1 |
\\section "B"
:4 E5 E5 D5 B4 | B4.2 r.2 | :4 E5 E5 D5 B4 | G4.1 |
\\section "C"
:4 C5 C5 B4 A4 | A4.1 |
{end_of_part}

{start_of_part: Bass}
\\clef bass
\\section "A"
:2 G2 G2 | E2 E2 | C3 C3 | D3 D3 |
\\section "B"
:2 C3 D3 | G2 E2 | C3 D3 | G2 G2 |
\\section "C"
:2 A2 A2 | D3 D3 |
{end_of_part}

{start_of_part: Drums}
\\instrument percussion
\\section "A"
:8 (HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH :16 SD SD SD SD SD SD (SD BD) (SD BD) |
\\section "B"
\\tf triplet8th
:8 (RD BD) RD (RD SD) RD (RD BD) RD (RD SD) RD |
(RD BD) RD (RD SD) RD (RD BD) RD (RD SD) RD |
(RD BD) RD (RD SD) RD (RD BD) RD (RD SD) RD |
(RD BD) RD (RD SD) RD (RD BD) RD (RD SD) RD |
\\section "Fill"
:8 SD SD T1 T1 T2 T2 FT FT |
\\section "C"
\\tf none
:4 (CR BD) HH (HH SD) HH | (CR BD) r r r |
{end_of_part}
`;

/** No parts at all: every section is chart-only (`bars: []`). */
export const chartOnlySongText = `{title: コード譜だけ}
{time: 3/4}

{start_of_verse: A}
[C]いち[G]に[Am]さん
{end_of_verse}

{start_of_chorus: B}
[F]し[G]ご
{end_of_chorus}
`;

/** The Guitar part cannot be read by alphaTab; Vocal still shows. */
export const unreadablePartSongText = `{title: 読めないパート}
{time: 4/4}

{start_of_verse: A}
[C]あ
{end_of_verse}

{start_of_part: Vocal}
\\section "A"
:4 C4 D4 E4 F4 |
{end_of_part}

{start_of_part: Guitar}
\\section "A"
:4 C4 ((( X9
{end_of_part}
`;
