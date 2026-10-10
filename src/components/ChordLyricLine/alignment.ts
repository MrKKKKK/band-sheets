/**
 * Test helper (stories / browser checks): for every chord in `root`, the
 * horizontal offset between the chord element's left edge and the left edge
 * of the first lyric character of the same segment. Chord-only segments are
 * skipped.
 */
export function chordOffsets(root: HTMLElement): number[] {
  const offsets: number[] = [];
  for (const chord of root.querySelectorAll<HTMLElement>(
    '[data-testid^="chord-"]',
  )) {
    const seg = chord.closest<HTMLElement>('[data-testid^="seg-"]');
    const lyricRow = seg?.lastElementChild;
    if (!lyricRow) continue;
    const firstButton = lyricRow.querySelector('button');
    let left: number | undefined;
    if (firstButton) {
      left = firstButton.getBoundingClientRect().left;
    } else {
      const text = lyricRow.firstChild;
      if (text?.nodeType === Node.TEXT_NODE && text.textContent) {
        const range = document.createRange();
        const first = Array.from(text.textContent)[0];
        range.setStart(text, 0);
        range.setEnd(text, first.length);
        left = range.getBoundingClientRect().left;
      }
    }
    if (left !== undefined)
      offsets.push(chord.getBoundingClientRect().left - left);
  }
  return offsets;
}
