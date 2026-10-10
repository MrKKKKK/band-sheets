import { describe, expect, it } from 'vitest';
import { importer, Settings, type model } from '@coderline/alphatab';
import { parseSong } from './parseSong';
import { partsToAlphaTex } from './partsToAlphaTex';
import { partSections } from './melodyPart';
import type { Song } from './song';
import {
  buildViewerSections,
  sectionScoreTex,
  songTimeSig,
  type ViewerSection,
} from './viewerSections';
import {
  carryOverSongText,
  chartOnlySongText,
  unreadablePartSongText,
  viewerSongText,
} from './fixtures/viewerFixtures';

function read(tex: string): model.Score {
  const imp = new importer.AlphaTexImporter();
  imp.logErrors = false;
  imp.initFromString(tex, new Settings());
  return imp.readScore();
}

/** What alphaTab reads for one bar of one track, for comparison. */
function barShape(score: model.Score, bar: model.Bar) {
  const mb = score.masterBars[bar.index];
  return {
    ts: `${mb.timeSignatureNumerator}/${mb.timeSignatureDenominator}`,
    tf: mb.tripletFeel,
    ks: bar.keySignature,
    clef: bar.clef,
    beats: bar.voices[0].beats.map((b) => ({
      duration: b.duration,
      rest: b.isRest,
      // Percussion: the articulation's MIDI number (its index depends on
      // the order of first use in the document).
      notes: b.notes.map((n) =>
        n.isPercussion
          ? bar.staff.track.percussionArticulations[n.percussionArticulation]
              .outputMidiNumber
          : n.realValue,
      ),
    })),
  };
}

/**
 * The bars of section `label` (k-th instance) in alphaTab's read of the
 * WHOLE part, sliced at the master bars that start a section.
 */
function wholeSlice(song: Song, partName: string, label: string, k = 0) {
  const part = song.parts.find((p) => p.name === partName)!;
  const score = read(
    partsToAlphaTex({ meta: song.meta, chart: [], parts: [part] }),
  );
  const bars = score.tracks[0].staves[0].bars;
  const starts = score.masterBars
    .filter((mb) => mb.section)
    .map((mb) => ({
      index: mb.index,
      label: mb.section!.marker || mb.section!.text,
    }));
  const matching = starts.filter((s) => s.label === label);
  const start = matching[k].index;
  const next = starts.find((s) => s.index > start)?.index ?? bars.length;
  return bars.slice(start, next).map((b) => barShape(score, b));
}

/** The bars alphaTab reads from the section's own track document. */
function sectionRead(trackTex: string) {
  const score = read(`.\n${trackTex}\n`);
  return score.tracks[0].staves[0].bars.map((b) => barShape(score, b));
}

const sectionByLabel = (sections: ViewerSection[], label: string, k = 0) =>
  sections.filter((s) => s.label === label)[k];

const partOf = (s: ViewerSection, name: string) =>
  s.parts.find((p) => p.part === name);

describe('songTimeSig', () => {
  it('reads a valid {time:} and falls back to 4/4 otherwise', () => {
    expect(songTimeSig({ title: '', time: '6/8' })).toEqual({
      num: 6,
      den: 8,
    });
    expect(songTimeSig({ title: '' })).toEqual({ num: 4, den: 4 });
    expect(songTimeSig({ title: '', time: '4/3' })).toEqual({
      num: 4,
      den: 4,
    });
    expect(songTimeSig({ title: '', time: 'abc' })).toEqual({
      num: 4,
      den: 4,
    });
  });
});

describe('buildViewerSections: carry-over matches the whole-part read', () => {
  const song = parseSong(carryOverSongText);
  const { sections, errors } = buildViewerSections(song);

  it('reads both parts without errors, in chart order', () => {
    expect(errors).toEqual([]);
    expect(sections.map((s) => s.label)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(sections.map((s) => s.key)).toEqual([
      '0-A',
      '1-B',
      '2-C',
      '3-D',
      '4-E',
    ]);
    for (const s of sections) {
      expect(s.parts.map((p) => p.part)).toEqual(
        s.label === 'E' ? ['Bass'] : ['Bass', 'Drums'],
      );
    }
  });

  for (const label of ['A', 'B', 'C', 'D']) {
    it(`Bass section ${label}: same bars, ts, key, clef and durations`, () => {
      const p = partOf(sectionByLabel(sections, label), 'Bass')!;
      expect(sectionRead(p.trackTex)).toEqual(wholeSlice(song, 'Bass', label));
    });
    it(`Drums section ${label}: same bars, ts, triplet feel and beats`, () => {
      const p = partOf(sectionByLabel(sections, label), 'Drums')!;
      expect(sectionRead(p.trackTex)).toEqual(wholeSlice(song, 'Drums', label));
    });
  }

  it('Bass section E (bare note after \\section): reads it as a note (T1 item 3)', () => {
    const p = partOf(sectionByLabel(sections, 'E'), 'Bass')!;
    const own = sectionRead(p.trackTex);
    const whole = wholeSlice(song, 'Bass', 'E');
    // The whole-part read swallows D3 into the section header; ours keeps it.
    expect(whole[0].beats).toHaveLength(3);
    expect(own[0].beats).toHaveLength(4);
    expect(own[0].beats[0]).toEqual({ duration: 4, rest: false, notes: [50] });
    expect(own[0].beats.slice(1)).toEqual(whole[0].beats);
    expect(own.slice(1)).toEqual(whole.slice(1));
    expect({ ...own[0], beats: [] }).toEqual({ ...whole[0], beats: [] });
  });

  it('writes the carried values as alphaTex lines (golden)', () => {
    expect(partOf(sectionByLabel(sections, 'C'), 'Bass')!.trackTex).toBe(
      [
        '\\track "Bass"',
        '\\staff {score}',
        '\\ts 4 4',
        '\\ks D',
        '\\ts 3 4',
        '\\ks F',
        '\\clef treble',
        '\\ks F',
        ':8 C3 D3 E3 F3 G3 A3',
      ].join('\n'),
    );
    expect(partOf(sectionByLabel(sections, 'C'), 'Drums')!.trackTex).toBe(
      [
        '\\track "Drums"',
        '\\instrument percussion',
        '\\articulation HH 42',
        '\\articulation SD 38',
        '\\articulation BD 36',
        '\\articulation CR 49',
        '\\articulation RD 51',
        '\\articulation HO 46',
        '\\articulation T1 50',
        '\\articulation T2 48',
        '\\articulation FT 41',
        '\\ts 4 4',
        '\\ks C',
        '\\clef neutral',
        '\\tf triplet8th',
        ':4 BD SD BD SD',
      ].join('\n'),
    );
  });

  it('reports bars per part from its own read and the section maximum', () => {
    const b = sectionByLabel(sections, 'B');
    expect(partOf(b, 'Bass')!.bars).toEqual([
      { num: 3, den: 4 },
      { num: 3, den: 4 },
    ]);
    expect(partOf(b, 'Drums')!.bars).toEqual([{ num: 4, den: 4 }]);
    expect(b.bars).toEqual([
      { num: 3, den: 4 },
      { num: 3, den: 4 },
    ]);
    expect(sections.map((s) => s.firstBar)).toEqual([1, 3, 5, 6, 7]);
  });

  it('gives each drum section its effective shuffle (own or inherited)', () => {
    expect(
      sections.slice(0, 4).map((s) => partOf(s, 'Drums')!.shuffle),
    ).toEqual(['none', '8', '8', 'none']);
    expect(partOf(sections[0], 'Bass')!.shuffle).toBeUndefined();
    expect(partOf(sections[0], 'Drums')!.isDrum).toBe(true);
    expect(partOf(sections[0], 'Bass')!.isDrum).toBe(false);
  });
});

describe('buildViewerSections: order', () => {
  it('follows the chart, repeats parts for repeated labels and inserts part-only labels', () => {
    const { sections, errors } = buildViewerSections(parseSong(viewerSongText));
    expect(errors).toEqual([]);
    expect(sections.map((s) => [s.label, s.parts.map((p) => p.part)])).toEqual([
      ['A', ['Vocal', 'Bass', 'Drums']],
      ['B', ['Vocal', 'Bass', 'Drums']],
      ['Fill', ['Drums']],
      ['A', ['Vocal', 'Bass', 'Drums']],
      ['C', ['Vocal', 'Bass', 'Drums']],
      ['', []],
    ]);
    expect(sections.map((s) => s.firstBar)).toEqual([1, 5, 9, 10, 14, 16]);
    expect(sections[2].chart).toBeUndefined();
    expect(sections[3].chart?.label).toBe('A');
    expect(sections[5].chart?.kind).toBe('');
    expect(sections[5].bars).toEqual([]);
    // The second A is the same part section as the first.
    expect(sections[3].parts[0].trackTex).toBe(sections[0].parts[0].trackTex);
  });

  it('drops the part-level \\lyrics line', () => {
    const { sections } = buildViewerSections(parseSong(viewerSongText));
    expect(sections[0].parts[0].trackTex).not.toContain('\\lyrics');
  });

  const song = (chart: string[], parts: Record<string, string>): Song => ({
    meta: { title: 't' },
    chart: chart.map((label) => ({
      kind: label === '' ? '' : 'verse',
      label,
      lines: [],
    })),
    parts: Object.entries(parts).map(([name, body]) => ({ name, body })),
  });
  const labels = (s: Song) =>
    buildViewerSections(s).sections.map((v) => [
      v.label,
      v.parts.map((p) => `${p.part}:${p.trackTex.split('\n').at(-1)}`),
    ]);

  it('pairs the k-th chart occurrence with the k-th part section, else the first', () => {
    const s = song(['A', 'A', 'A'], {
      P: '\\section "A"\n:4 C4 C4 C4 C4\n\\section "A"\n:4 D4 D4 D4 D4',
    });
    expect(labels(s)).toEqual([
      ['A', ['P::4 C4 C4 C4 C4']],
      ['A', ['P::4 D4 D4 D4 D4']],
      ['A', ['P::4 C4 C4 C4 C4']],
    ]);
  });

  it('places extra part instances and part-only labels after their predecessor', () => {
    const s = song(['A', 'B'], {
      P: [
        '\\section "X"',
        ':4 E4 E4 E4 E4',
        '\\section "A"',
        ':4 C4 C4 C4 C4',
        '\\section "A"',
        ':4 D4 D4 D4 D4',
        '\\section "B"',
        ':4 F4 F4 F4 F4',
      ].join('\n'),
      Q: [
        '\\section "A"',
        ':4 G4 G4 G4 G4',
        '\\section "Y"',
        ':4 A4 A4 A4 A4',
        '\\section "X"',
        ':4 B4 B4 B4 B4',
      ].join('\n'),
    });
    expect(labels(s)).toEqual([
      ['X', ['P::4 E4 E4 E4 E4', 'Q::4 B4 B4 B4 B4']],
      ['A', ['P::4 C4 C4 C4 C4', 'Q::4 G4 G4 G4 G4']],
      // Both follow A; the earlier part's goes first.
      ['A', ['P::4 D4 D4 D4 D4']],
      ['Y', ['Q::4 A4 A4 A4 A4']],
      ['B', ['P::4 F4 F4 F4 F4']],
    ]);
  });

  it('shows notes before the first \\section as an unlabeled first section', () => {
    const s = song(['A'], {
      P: ':4 C4 C4 C4 C4 |\n\\section "A"\n:4 D4 D4 D4 D4',
      Q: '\\section "A"\n:4 E4 E4 E4 E4',
      R: ':4 F4 F4 F4 F4 | G4 G4 G4 G4',
    });
    const { sections } = buildViewerSections(s);
    expect(sections.map((v) => [v.label, v.parts.map((p) => p.part)])).toEqual([
      ['', ['P', 'R']],
      ['A', ['P', 'Q']],
    ]);
    expect(sections[0].chart).toBeUndefined();
    expect(sections[0].bars).toHaveLength(2);
    expect(sections[1].firstBar).toBe(3);
    expect(sectionRead(sections[0].parts[1].trackTex)).toEqual(
      sectionRead(`\\track "R"\n:4 F4 F4 F4 F4 | G4 G4 G4 G4`),
    );
  });

  it('leaves out empty part sections and unlabeled chart sections get no parts', () => {
    const s = song(['', 'A', 'B'], {
      P: '\\section "A"\n\\section "B"\n:4 C4 C4 C4 C4\n\\section "C"\n// nothing',
    });
    const { sections } = buildViewerSections(s);
    expect(sections.map((v) => [v.label, v.parts.length])).toEqual([
      ['', 0],
      ['A', 0],
      ['B', 1],
    ]);
    expect(sections.map((v) => v.firstBar)).toEqual([1, 1, 1]);
  });

  it('keeps chart-only songs (no parts) with empty bars', () => {
    const { sections, errors } = buildViewerSections(
      parseSong(chartOnlySongText),
    );
    expect(errors).toEqual([]);
    expect(sections.map((s) => [s.label, s.parts, s.bars, s.firstBar])).toEqual(
      [
        ['A', [], [], 1],
        ['B', [], [], 1],
      ],
    );
  });

  it('reports a part alphaTab cannot read and shows the rest', () => {
    const { sections, errors } = buildViewerSections(
      parseSong(unreadablePartSongText),
    );
    expect(errors).toEqual([
      {
        part: 'Guitar',
        message:
          'Guitar は読み込めませんでした（テキスト入力で確認してください）',
      },
    ]);
    expect(sections.map((s) => s.parts.map((p) => p.part))).toEqual([
      ['Vocal'],
    ]);
  });

  it('uses 4/4 for a part when {time:} is invalid (alphaTab default)', () => {
    const s: Song = {
      meta: { title: 't', time: '5/3' },
      chart: [{ kind: 'verse', label: 'A', lines: [] }],
      parts: [{ name: 'P', body: '\\section "A"\n:4 C4 C4 C4 C4' }],
    };
    const { sections } = buildViewerSections(s);
    expect(sections[0].bars).toEqual([{ num: 4, den: 4 }]);
    const valid = buildViewerSections({
      ...s,
      meta: { title: 't', time: '3/4' },
    });
    // alphaTab does not re-bar: the 4 quarters stay in one (full) 3/4 bar.
    expect(valid.sections[0].bars).toEqual([{ num: 3, den: 4 }]);
  });

  it('matches every section of the demo song against the whole-part read', () => {
    const demo = parseSong(viewerSongText);
    const { sections } = buildViewerSections(demo);
    const seen = new Map<string, number>();
    for (const part of demo.parts) {
      for (const sec of partSections(part.body).sections) {
        const k = seen.get(`${part.name}/${sec.label}`) ?? 0;
        seen.set(`${part.name}/${sec.label}`, k + 1);
        const v = sections.find((s) => s.label === sec.label)!;
        expect(sectionRead(partOf(v, part.name)!.trackTex)).toEqual(
          wholeSlice(demo, part.name, sec.label, k),
        );
      }
    }
  });
});

describe('sectionScoreTex', () => {
  const { sections } = buildViewerSections(parseSong(viewerSongText));
  const [a, b, fill, a2, c] = sections;

  it('joins the shown parts in song order', () => {
    const r = sectionScoreTex(a, ['Drums', 'Vocal'])!;
    expect(r.trackCount).toBe(2);
    expect(r.tex).toBe(
      `.\n${partOf(a, 'Vocal')!.trackTex}\n\n${partOf(a, 'Drums')!.trackTex}\n`,
    );
    const score = read(r.tex);
    expect(score.tracks.map((t) => t.name)).toEqual(['Vocal', 'Drums']);
    expect(score.masterBars).toHaveLength(4);
  });

  it('returns null when none of the shown parts has this section', () => {
    expect(sectionScoreTex(fill, ['Vocal', 'Bass'])).toBeNull();
    expect(sectionScoreTex(sections[5], ['Vocal'])).toBeNull();
    expect(sectionScoreTex(a, [])).toBeNull();
  });

  it('has no shuffleMarks without a drum part', () => {
    const r = sectionScoreTex(b, ['Vocal'])!;
    expect(r).toEqual({ tex: r.tex, trackCount: 1 });
  });

  it('marks shuffle on every shuffled section and Straight where it ends', () => {
    expect(sectionScoreTex(a, ['Drums'])!.shuffleMarks).toBeUndefined();
    expect(sectionScoreTex(b, ['Drums'])!.shuffleMarks).toEqual([
      { track: 0, shuffle: '8' },
    ]);
    expect(sectionScoreTex(b, ['Vocal', 'Drums'])!.shuffleMarks).toEqual([
      { track: 1, shuffle: '8' },
    ]);
    // Fill inherits the shuffle from B.
    expect(partOf(fill, 'Drums')!.shuffle).toBe('8');
    expect(sectionScoreTex(fill, ['Drums'])!.shuffleMarks).toEqual([
      { track: 0, shuffle: '8' },
    ]);
    // The second A is straight again, right after the shuffled Fill.
    expect(sectionScoreTex(a2, ['Drums'])!.shuffleMarks).toEqual([
      { track: 0, shuffle: 'none' },
    ]);
    expect(sectionScoreTex(c, ['Drums'])!.shuffleMarks).toBeUndefined();
  });

  it('gives every drum track its own mark (R5)', () => {
    const s: Song = {
      meta: { title: 't' },
      chart: [{ kind: 'verse', label: 'A', lines: [] }],
      parts: [
        { name: 'V', body: '\\section "A"\n:4 C4 D4 E4 F4' },
        {
          name: 'Dr',
          body: '\\instrument percussion\n\\section "A"\n\\tf triplet8th\n:4 BD SD BD SD',
        },
        {
          name: 'Perc',
          body: '\\instrument percussion\n\\section "A"\n\\tf triplet16th\n:4 HH HH HH HH',
        },
      ],
    };
    const { sections: v } = buildViewerSections(s);
    expect(sectionScoreTex(v[0], ['V', 'Dr', 'Perc'])!.shuffleMarks).toEqual([
      { track: 1, shuffle: '8' },
      { track: 2, shuffle: '16' },
    ]);
    expect(sectionScoreTex(v[0], ['V', 'Perc'])!.shuffleMarks).toEqual([
      { track: 1, shuffle: '16' },
    ]);
  });

  it('gives no mark for a triplet feel the app cannot show', () => {
    const s: Song = {
      meta: { title: 't' },
      chart: [
        { kind: 'verse', label: 'A', lines: [] },
        { kind: 'verse', label: 'B', lines: [] },
      ],
      parts: [
        {
          name: 'D',
          body: '\\instrument percussion\n\\section "A"\n\\tf dotted8th\n:4 BD SD BD SD\n\\section "B"\n\\tf none\n:4 BD SD BD SD',
        },
      ],
    };
    const { sections: v } = buildViewerSections(s);
    expect(v[0].parts[0].shuffle).toBe('other');
    expect(sectionScoreTex(v[0], ['D'])!.shuffleMarks).toBeUndefined();
    expect(sectionScoreTex(v[1], ['D'])!.shuffleMarks).toEqual([
      { track: 0, shuffle: 'none' },
    ]);
  });
});
