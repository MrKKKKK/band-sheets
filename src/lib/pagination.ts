// Viewer page turning (M6 T3): pack the measured "units" of one long content
// column into screen-high pages, and keep the reading position across zoom /
// part changes via a unit + ratio anchor. Pure functions, no DOM.

export interface FlowUnit {
  /** Position from the top of the content column (px). */
  top: number;
  height: number;
  /** Keep on the same page as the next unit (last chord line -> first staff system). */
  keepWithNext?: boolean;
}

export interface Page {
  top: number;
  /** Exclusive. */
  bottom: number;
}

export interface Anchor {
  unit: number;
  /** 0..1 inside the unit. */
  ratio: number;
}

const EPS = 1e-6;

interface Block {
  top: number;
  end: number;
}

/** Chains of `keepWithNext` units become one block, unless the chain is taller than a page. */
function blocks(units: readonly FlowUnit[], viewportHeight: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < units.length) {
    let j = i;
    while (j < units.length - 1 && units[j].keepWithNext) j++;
    const top = units[i].top;
    const end = Math.max(...units.slice(i, j + 1).map((u) => u.top + u.height));
    if (j > i && end - top > viewportHeight + EPS) {
      for (let k = i; k <= j; k++) {
        out.push({ top: units[k].top, end: units[k].top + units[k].height });
      }
    } else {
      out.push({ top, end });
    }
    i = j + 1;
  }
  return out;
}

export function paginate(
  units: readonly FlowUnit[],
  viewportHeight: number,
): Page[] {
  const vh = Math.max(1, viewportHeight);
  if (units.length === 0) return [{ top: 0, bottom: vh }];

  const pages: Page[] = [];
  let cur: Page = { top: 0, bottom: 0 };
  let hasContent = false;
  const flush = () => {
    if (hasContent) pages.push(cur);
  };

  for (const b of blocks(units, vh)) {
    if (b.end - cur.top <= vh + EPS) {
      cur.bottom = Math.max(cur.bottom, b.end);
      hasContent = true;
      continue;
    }
    flush();
    let t = b.top;
    // A block taller than a page is cut every viewport height.
    while (b.end - t > vh + EPS) {
      pages.push({ top: t, bottom: t + vh });
      t += vh;
    }
    cur = { top: t, bottom: b.end };
    hasContent = true;
  }
  flush();
  return pages;
}

/** The page containing y (a gap between pages belongs to the page before it). */
export function pageIndexAt(pages: readonly Page[], y: number): number {
  let idx = 0;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].top <= y + EPS) idx = i;
    else break;
  }
  return idx;
}

export function anchorOf(units: readonly FlowUnit[], y: number): Anchor {
  if (units.length === 0) return { unit: 0, ratio: 0 };
  let last = -1;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.top > y) break;
    last = i;
    if (u.height > 0 && y < u.top + u.height) {
      return { unit: i, ratio: (y - u.top) / u.height };
    }
  }
  if (last < 0) return { unit: 0, ratio: 0 };
  const u = units[last];
  return { unit: last, ratio: u.height > 0 ? 1 : 0 };
}

export function anchorY(units: readonly FlowUnit[], a: Anchor): number {
  if (units.length === 0) return 0;
  const u = units[Math.min(Math.max(a.unit, 0), units.length - 1)];
  const ratio = Math.min(Math.max(a.ratio, 0), 1);
  return u.top + ratio * u.height;
}
