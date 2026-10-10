import { describe, expect, it } from 'vitest';
import { layoutTupletBracket } from './tupletLayout';

const S = 10; // staff space, px — chosen so every constant in the module
// (0.9, 0.35, 0.4, 1.0, 0.6 staff spaces) lands on an exact number here.

describe('layoutTupletBracket: bracket line (even tip heights)', () => {
  const xs = [0, 20, 40];
  const tipYs = [100, 100, 100];

  it('above: bracket sits 1 staff space above the tips, hooks drop back down toward them', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs,
      tipYs,
      side: 'above',
      staffSpace: S,
    });
    const bracketY = 100 - S; // CLEARANCE
    const [leftHook, leftArm, rightArm, rightHook] = l.line;
    expect(leftHook).toEqual({
      x1: 0,
      y1: bracketY,
      x2: 0,
      y2: bracketY + 0.6 * S,
    });
    expect(rightHook).toEqual({
      x1: 40,
      y1: bracketY,
      x2: 40,
      y2: bracketY + 0.6 * S,
    });
    expect(leftArm.y1).toBe(bracketY);
    expect(leftArm.y2).toBe(bracketY);
    expect(rightArm.y1).toBe(bracketY);
    expect(rightArm.y2).toBe(bracketY);
  });

  it('below: bracket sits 1 staff space below the tips, hooks pull back up toward them', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs,
      tipYs,
      side: 'below',
      staffSpace: S,
    });
    const bracketY = 100 + S;
    const [leftHook, , , rightHook] = l.line;
    expect(leftHook).toEqual({
      x1: 0,
      y1: bracketY,
      x2: 0,
      y2: bracketY - 0.6 * S,
    });
    expect(rightHook).toEqual({
      x1: 40,
      y1: bracketY,
      x2: 40,
      y2: bracketY - 0.6 * S,
    });
  });

  it('hooks start exactly at the first/last x', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs,
      tipYs,
      side: 'above',
      staffSpace: S,
    });
    expect(l.line[0].x1).toBe(0);
    expect(l.line[3].x1).toBe(40);
  });

  it('left and right arms run from the hooks to the number gap, centered on the group', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs,
      tipYs,
      side: 'above',
      staffSpace: S,
    });
    const [, leftArm, rightArm] = l.line;
    const centerX = 20;
    const halfGap = ((1 * 0.9 + 2 * 0.35) * S) / 2; // 1-digit gap width / 2 = 8
    expect(leftArm.x1).toBe(0);
    expect(leftArm.x2).toBeCloseTo(centerX - halfGap);
    expect(rightArm.x1).toBeCloseTo(centerX + halfGap);
    expect(rightArm.x2).toBe(40);
  });
});

describe('layoutTupletBracket: mixed stem heights', () => {
  it('above: the flat bracket follows the HIGHEST tip (smallest y), not an average or a slope', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs: [0, 20, 40],
      tipYs: [100, 40, 100], // the middle note's stem is much taller
      side: 'above',
      staffSpace: S,
    });
    const bracketY = 40 - S; // clears the tallest (smallest-y) tip
    expect(l.line[1].y1).toBe(bracketY);
    // both end hooks are at the SAME y (flat line), fixed length, even
    // though the end tips (100) are far from the bracket line.
    expect(l.line[0].y1).toBe(bracketY);
    expect(l.line[3].y1).toBe(bracketY);
    expect(l.line[0].y2).toBe(bracketY + 0.6 * S);
    expect(l.line[3].y2).toBe(bracketY + 0.6 * S);
  });

  it('below: the flat bracket follows the LOWEST tip (largest y)', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs: [0, 20, 40],
      tipYs: [60, 120, 60],
      side: 'below',
      staffSpace: S,
    });
    const bracketY = 120 + S;
    expect(l.line[0].y1).toBe(bracketY);
    expect(l.line[1].y1).toBe(bracketY);
    expect(l.line[3].y1).toBe(bracketY);
  });

  it('a tip only at one end still sets the bracket height for the whole group', () => {
    const l = layoutTupletBracket({
      n: 5,
      xs: [0, 10, 20, 30, 40],
      tipYs: [100, 100, 100, 100, 10], // last beat's stem is tall
      side: 'above',
      staffSpace: S,
    });
    expect(l.line[0].y1).toBe(10 - S);
  });
});

describe('layoutTupletBracket: the number', () => {
  it('is centered on the group and uses the SMuFL Tuplets glyphs (tuplet0=U+E880..tuplet9=U+E889)', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs: [0, 20, 40],
      tipYs: [100, 100, 100],
      side: 'above',
      staffSpace: S,
    });
    expect(l.number.text).toBe(''); // tuplet3
    expect(l.number.x).toBe(20);
  });

  it('renders every digit of a 2-digit n left to right', () => {
    const l = layoutTupletBracket({
      n: 13,
      xs: [0, 100],
      tipYs: [50, 50],
      side: 'above',
      staffSpace: S,
    });
    expect(l.number.text).toBe(''); // tuplet1, tuplet3
  });

  it('sits just below the bracket line (baseline offset), on the above side', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs: [0, 40],
      tipYs: [100, 100],
      side: 'above',
      staffSpace: S,
    });
    const bracketY = 100 - S;
    expect(l.number.y).toBeCloseTo(bracketY + 0.35 * S);
  });

  it('a 2-digit number reserves a wider gap than a 1-digit number', () => {
    const wide = [0, 200] as const;
    const one = layoutTupletBracket({
      n: 3,
      xs: [...wide],
      tipYs: [50, 50],
      side: 'above',
      staffSpace: S,
    });
    const two = layoutTupletBracket({
      n: 13,
      xs: [...wide],
      tipYs: [50, 50],
      side: 'above',
      staffSpace: S,
    });
    const gapOf = (l: ReturnType<typeof layoutTupletBracket>) =>
      l.line[2].x1 - l.line[1].x2;
    expect(gapOf(two)).toBeGreaterThan(gapOf(one));
  });
});

describe('layoutTupletBracket: single-beat and narrow groups', () => {
  it('a single beat (xs.length === 1) still produces a bracket with two visible arms + hooks', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs: [50],
      tipYs: [100],
      side: 'above',
      staffSpace: S,
    });
    const [leftHook, leftArm, rightArm, rightHook] = l.line;
    // widened symmetrically around the single x
    expect(leftHook.x1).toBeLessThan(50);
    expect(rightHook.x1).toBeGreaterThan(50);
    expect(50 - leftHook.x1).toBeCloseTo(rightHook.x1 - 50);
    // both arms are at least the minimum arm length
    expect(leftArm.x2 - leftArm.x1).toBeGreaterThanOrEqual(0.4 * S - 1e-6);
    expect(rightArm.x2 - rightArm.x1).toBeGreaterThanOrEqual(0.4 * S - 1e-6);
    // number still centered on the (widened) group
    expect(l.number.x).toBe(50);
  });

  it('two beats too close together to fit both arms are widened the same way', () => {
    const l = layoutTupletBracket({
      n: 13,
      xs: [50, 52],
      tipYs: [100, 100],
      side: 'above',
      staffSpace: S,
    });
    const [leftHook, , , rightHook] = l.line;
    expect(leftHook.x1).toBeLessThan(50);
    expect(rightHook.x1).toBeGreaterThan(52);
    expect(l.number.x).toBe(51); // centered on the original xs midpoint
  });

  it('does not widen a group that already has room for both arms', () => {
    const l = layoutTupletBracket({
      n: 3,
      xs: [0, 200],
      tipYs: [100, 100],
      side: 'above',
      staffSpace: S,
    });
    expect(l.line[0].x1).toBe(0);
    expect(l.line[3].x1).toBe(200);
  });
});

describe('layoutTupletBracket: wide groups', () => {
  it('a wide group keeps hooks at the exact end xs and a centered number', () => {
    const l = layoutTupletBracket({
      n: 7,
      xs: [0, 100, 200, 300, 400, 500, 600],
      tipYs: new Array(7).fill(50),
      side: 'above',
      staffSpace: S,
    });
    expect(l.line[0].x1).toBe(0);
    expect(l.line[3].x1).toBe(600);
    expect(l.number.x).toBe(300);
  });
});

describe('layoutTupletBracket: staffSpace scaling', () => {
  it('every metric scales linearly with staffSpace', () => {
    const base = layoutTupletBracket({
      n: 3,
      xs: [0, 40],
      tipYs: [100, 100],
      side: 'above',
      staffSpace: 10,
    });
    const doubled = layoutTupletBracket({
      n: 3,
      xs: [0, 40],
      tipYs: [100, 100],
      side: 'above',
      staffSpace: 20,
    });
    // clearance above the (unscaled, shared) tip is 1 staff space either way
    expect(100 - base.line[0].y1).toBe(10);
    expect(100 - doubled.line[0].y1).toBe(20);
    // hook length likewise doubles
    const baseHook = base.line[0].y2 - base.line[0].y1;
    const doubledHook = doubled.line[0].y2 - doubled.line[0].y1;
    expect(doubledHook).toBeCloseTo(baseHook * 2);
  });
});

describe('layoutTupletBracket: validation', () => {
  it('throws on a non-positive or non-integer n', () => {
    expect(() =>
      layoutTupletBracket({
        n: 0,
        xs: [0],
        tipYs: [0],
        side: 'above',
        staffSpace: S,
      }),
    ).toThrow(RangeError);
    expect(() =>
      layoutTupletBracket({
        n: 3.5,
        xs: [0],
        tipYs: [0],
        side: 'above',
        staffSpace: S,
      }),
    ).toThrow(RangeError);
  });

  it('throws on empty xs/tipYs', () => {
    expect(() =>
      layoutTupletBracket({
        n: 3,
        xs: [],
        tipYs: [],
        side: 'above',
        staffSpace: S,
      }),
    ).toThrow(RangeError);
  });

  it('throws when xs and tipYs have different lengths', () => {
    expect(() =>
      layoutTupletBracket({
        n: 3,
        xs: [0, 10],
        tipYs: [0],
        side: 'above',
        staffSpace: S,
      }),
    ).toThrow(RangeError);
  });
});
