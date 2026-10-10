import { importer, rendering, Settings, type model } from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { partsToAlphaTex } from '../../lib/partsToAlphaTex';
import { parseSong } from '../../lib/parseSong';
import { percussionStemsUp } from './percussionStems';

const songText = [
  '{title: t}',
  '{time: 4/4}',
  '{start_of_part: Drums}',
  '\\instrument percussion',
  ':8 (HH BD) HH (HH SD) HH :4 FT {tu 3} FT {tu 3} FT {tu 3} r',
  '{end_of_part}',
  '{start_of_part: Vocal}',
  ':4 C4 D4 E4 F4',
  '{end_of_part}',
].join('\n');

function load(): model.Score {
  const imp = new importer.AlphaTexImporter();
  imp.initFromString(partsToAlphaTex(parseSong(songText)), new Settings());
  return imp.readScore();
}

const beats = (track: model.Track) =>
  track.staves.flatMap((s) =>
    s.bars.flatMap((b) => b.voices.flatMap((v) => v.beats)),
  );

describe('percussionStemsUp', () => {
  it('sets every percussion beat to stems up and leaves melody alone', () => {
    const score = load();
    const [drums, vocal] = score.tracks;
    expect(drums.staves[0].isPercussion).toBe(true);
    expect(vocal.staves[0].isPercussion).toBe(false);

    percussionStemsUp(score);

    const drumBeats = beats(drums);
    expect(drumBeats.length).toBeGreaterThan(0);
    for (const b of drumBeats) {
      expect(b.preferredBeamDirection).toBe(rendering.BeamDirection.Up);
    }
    for (const b of beats(vocal)) {
      expect(b.preferredBeamDirection).toBeNull();
    }
  });
});
