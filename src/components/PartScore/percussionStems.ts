import { rendering, type model } from '@coderline/alphatab';

/**
 * Forces every beat on a percussion staff to stems/beams UP (render time
 * only — the saved alphaTex is never touched). alphaTab otherwise picks the
 * direction per beam group from the notes' staff position, so low pieces
 * (BD, SD, FT) hang their stems and beams below the staff, while drum
 * notation is conventionally one stems-up voice (like `DrumStaff`).
 * Melody (non-percussion) staves are left alone.
 *
 * Call from `api.scoreLoaded` (fired after import, before layout).
 */
export function percussionStemsUp(score: model.Score): void {
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      if (!staff.isPercussion) continue;
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            beat.preferredBeamDirection = rendering.BeamDirection.Up;
          }
        }
      }
    }
  }
}
