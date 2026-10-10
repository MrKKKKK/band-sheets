import type { Song } from './song';

export interface SectionLabel {
  label: string;
  /** True when a chart section {start_of_x: label} uses this label. */
  inChart: boolean;
  /** Names of parts with a \section marker of this label, in song order. */
  parts: string[];
}

// \section "A", \section "A" "Verse" (first string is the label), \section A
const SECTION = /\\section\s+(?:"([^"]*)"|'([^']*)'|([^\s"'{}|]+))/g;

/** Labels of the \section markers in an alphaTex body, in order. */
export function partSectionLabels(body: string): string[] {
  const labels: string[] = [];
  for (const line of body.split('\n')) {
    const code = line.trimStart().startsWith('//') ? '' : line;
    for (const m of code.matchAll(SECTION)) {
      labels.push(m[1] ?? m[2] ?? m[3]);
    }
  }
  return labels;
}

/**
 * Collects section labels from the chart and every part and matches them by
 * exact name. Chart labels come first (chart order), then labels that only
 * appear in parts (part order). Empty labels are ignored.
 */
export function sectionLabels(song: Song): SectionLabel[] {
  const byLabel = new Map<string, SectionLabel>();
  const entry = (label: string) => {
    let e = byLabel.get(label);
    if (!e) {
      e = { label, inChart: false, parts: [] };
      byLabel.set(label, e);
    }
    return e;
  };

  for (const section of song.chart) {
    if (section.label !== '') entry(section.label).inChart = true;
  }
  for (const part of song.parts) {
    for (const label of partSectionLabels(part.body)) {
      if (label === '') continue;
      const e = entry(label);
      if (!e.parts.includes(part.name)) e.parts.push(part.name);
    }
  }
  return [...byLabel.values()];
}
