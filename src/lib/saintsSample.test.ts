import { describe, expect, it } from 'vitest';
import { barTicks, melodyTimeSignature } from './melody';
import { serializeMelody } from './melodyTex';
import { chartOrder } from './melodyEditor';
import { melodyParts, preambleOverrides, readSection } from './melodyPart';
import { drumBars } from './drum';
import { drumParts, readDrumSection } from './drumPart';
import { serializeDrums } from './drumTex';
import { parseSong } from './parseSong';
import { partSectionLabels } from './sections';
import { serializeSong } from './serializeSong';
import { SAINTS_SAMPLE_TITLE, saintsSampleText } from './saintsSample';
import { chartSyllables } from './syllables';
import { buildViewerSections } from './viewerSections';

const song = parseSong(saintsSampleText);
const ts = melodyTimeSignature(song.meta.time);
const LABELS = ['A', 'B'];
const BARS_PER_SECTION = 16;

describe('saintsSample (built-in sample song)', () => {
  it('has the expected meta', () => {
    expect(song.meta).toEqual({
      title: SAINTS_SAMPLE_TITLE,
      key: 'C',
      tempo: 116,
      time: '4/4',
    });
  });

  it('is canonical: parseSong → serializeSong gives the exact text back', () => {
    expect(serializeSong(song)).toBe(saintsSampleText);
  });

  it('has one Vocal (melody) part and one Drums part, no part preamble overrides', () => {
    expect(melodyParts(song).map((p) => p.name)).toEqual(['Vocal']);
    expect(drumParts(song).map((p) => p.name)).toEqual(['Drums']);
    for (const p of song.parts) expect(preambleOverrides(p.body)).toEqual({});
  });

  it('chart and every part have the same sections, in the same order', () => {
    expect(chartOrder(song)).toEqual(LABELS);
    for (const p of song.parts)
      expect(partSectionLabels(p.body)).toEqual(LABELS);
  });

  describe.each(LABELS)('section %s', (label) => {
    it('melody is editable, canonical, 16 full bars, one lyric per note matching the chart', () => {
      const body = melodyParts(song)[0].body;
      const read = readSection(body, label, ts);
      if (read.status !== 'ok') throw new Error(JSON.stringify(read));
      const total = read.events.reduce((n, e) => n + e.ticks, 0);
      expect(total).toBe(BARS_PER_SECTION * barTicks(ts));
      // Re-serializing (what the editor writes) changes nothing.
      const own = body
        .split(`\\section "${label}"\n`)[1]
        .split('\n\\section')[0];
      expect(serializeMelody(read.events, ts, label)).toBe(own);
      // Every note sings exactly one syllable of the chart lyrics.
      const notes = read.events.filter((e) => e.kind === 'note');
      expect(notes.every((n) => n.lyric !== undefined)).toBe(true);
      expect(notes.map((n) => n.lyric)).toEqual(chartSyllables(song, label));
    });

    it('drums are editable, canonical, 16 full bars, 8th shuffle', () => {
      const body = drumParts(song)[0].body;
      const read = readDrumSection(body, label, ts, chartOrder(song));
      if (read.status !== 'ok') throw new Error(JSON.stringify(read));
      expect(read.shuffle).toBe('8');
      const bars = drumBars(read.events, ts);
      expect(bars).toHaveLength(BARS_PER_SECTION);
      expect(bars.every((b) => b.ticks === barTicks(ts))).toBe(true);
      const own = body
        .split(`\\section "${label}"\n`)[1]
        .split('\n\\section')[0];
      expect(serializeDrums(read.events, read.shuffle, ts)).toBe(own);
    });
  });

  it('the viewer reads every part (no errors), 16 bars per section', () => {
    const { sections, errors } = buildViewerSections(song);
    expect(errors).toEqual([]);
    expect(sections.map((s) => [s.label, s.bars.length])).toEqual([
      ['A', BARS_PER_SECTION],
      ['B', BARS_PER_SECTION],
    ]);
  });
});
