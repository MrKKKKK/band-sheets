/**
 * The built-in sample song 「聖者の行進」 (When the Saints Go Marching In).
 *
 * The tune and lyrics are traditional (public domain); the chords, the
 * drum groove and this arrangement are the project's own. The 「サンプル曲を
 * 追加」 buttons (SignInScreen, SongList) create a NEW song from this text
 * (a device-only draft, like 「新しい曲」), so it is the user's own editable
 * copy.
 *
 * Must stay inside the editors' strict alphaTex subsets and in canonical
 * form (parseSong → serializeSong, serializeMelody, serializeDrums all give
 * this text back unchanged) — see saintsSample.test.ts.
 *
 * Pickup (弱起): the melody/drum models have no anacrusis bar, so each
 * section's first bar is a full bar that starts with a quarter rest
 * (「Oh when the」 on beats 2–4).
 */
export const SAINTS_SAMPLE_TITLE = '聖者の行進';

export const saintsSampleText = `{title: 聖者の行進}
{key: C}
{tempo: 116}
{time: 4/4}

{start_of_chorus: A}
Oh when the [C]saints go march-ing in
Oh when the saints go march-ing [G7]in
Oh Lord I [C]want to [C7]be in that [F]num-ber
Oh when the [C]saints go march-[G7]ing [C]in
{end_of_chorus}

{start_of_verse: B}
Oh when the [C]sun re-fuse to shine
Oh when the sun re-fuse to [G7]shine
Oh Lord I [C]want to [C7]be in that [F]num-ber
Oh when the [C]sun re-fuse [G7]to [C]shine
{end_of_verse}

{start_of_part: Vocal}
\\section "A"
:4 r C4{lyrics "Oh"} E4{lyrics "when"} F4{lyrics "the"} |
:1 G4{lyrics "saints"} |
:4 r C4{lyrics "go"} E4{lyrics "march-"} F4{lyrics "ing"} |
:1 G4{lyrics "in"} |
:4 r C4{lyrics "Oh"} E4{lyrics "when"} F4{lyrics "the"} |
:2 G4{lyrics "saints"} E4{lyrics "go"} |
C4{lyrics "march-"} E4{lyrics "ing"} |
:1 D4{lyrics "in"} |
:4 r E4{lyrics "Oh"} E4{lyrics "Lord"} D4{lyrics "I"} |
:2 C4{d lyrics "want"} :4 C4{lyrics "to"} |
:2 E4{lyrics "be"} :4 G4{lyrics "in"} G4{lyrics "that"} |
G4{lyrics "num-"} :2 F4{d lyrics "ber"} |
:4 r C4{lyrics "Oh"} E4{lyrics "when"} F4{lyrics "the"} |
:2 G4{lyrics "saints"} E4{lyrics "go"} |
C4{lyrics "march-"} D4{lyrics "ing"} |
:1 C4{lyrics "in"} |
\\section "B"
:4 r C4{lyrics "Oh"} E4{lyrics "when"} F4{lyrics "the"} |
:1 G4{lyrics "sun"} |
:4 r C4{lyrics "re-"} E4{lyrics "fuse"} F4{lyrics "to"} |
:1 G4{lyrics "shine"} |
:4 r C4{lyrics "Oh"} E4{lyrics "when"} F4{lyrics "the"} |
:2 G4{lyrics "sun"} E4{lyrics "re-"} |
C4{lyrics "fuse"} E4{lyrics "to"} |
:1 D4{lyrics "shine"} |
:4 r E4{lyrics "Oh"} E4{lyrics "Lord"} D4{lyrics "I"} |
:2 C4{d lyrics "want"} :4 C4{lyrics "to"} |
:2 E4{lyrics "be"} :4 G4{lyrics "in"} G4{lyrics "that"} |
G4{lyrics "num-"} :2 F4{d lyrics "ber"} |
:4 r C4{lyrics "Oh"} E4{lyrics "when"} F4{lyrics "the"} |
:2 G4{lyrics "sun"} E4{lyrics "re-"} |
C4{lyrics "fuse"} D4{lyrics "to"} |
:1 C4{lyrics "shine"} |
{end_of_part}

{start_of_part: Drums}
\\instrument percussion
\\section "A"
\\tf triplet8th
:4 HH HH HH HH |
:8 (CR BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
\\section "B"
\\tf triplet8th
:8 (HH BD) HH (HH SD) HH SD SD SD SD |
(CR BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
(HH BD) HH (HH SD) HH (HH BD) HH (HH SD) HH |
:2 (CR BD) r |
{end_of_part}
`;
