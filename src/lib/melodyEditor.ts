import type { Song } from './song';

/**
 * Small pure helpers for the MelodyEditor component (M4 T16).
 */

/** Labels of the chart's sections, in chart order (for `writeSection`). */
export function chartOrder(song: Song): string[] {
  return song.chart.map((s) => s.label).filter((l) => l !== '');
}
