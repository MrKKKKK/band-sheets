import { describe, expect, it } from 'vitest';
import { viewerKeyToAction, type ViewerKeyContext } from './viewerKeys';

type Ev = Parameters<typeof viewerKeyToAction>[0];

const ev = (key: string, over: Partial<Ev> = {}): Ev => ({
  key,
  code: key === ' ' ? 'Space' : key,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 0,
  repeat: false,
  ...over,
});

const ctx = (over: Partial<ViewerKeyContext> = {}): ViewerKeyContext => ({
  nav: 'page',
  playMode: false,
  targetIsEditable: false,
  ...over,
});

describe('viewerKeyToAction', () => {
  it.each(['PageDown', 'ArrowRight', 'ArrowDown', ' ', 'Enter'])(
    '%j is next in page mode',
    (key) => {
      expect(viewerKeyToAction(ev(key), ctx())).toBe('next');
    },
  );

  it.each(['PageUp', 'ArrowLeft', 'ArrowUp'])(
    '%s is prev in page mode',
    (key) => {
      expect(viewerKeyToAction(ev(key), ctx())).toBe('prev');
    },
  );

  it('Shift+Space is prev', () => {
    expect(viewerKeyToAction(ev(' ', { shiftKey: true }), ctx())).toBe('prev');
  });

  it('recognizes Space by code too', () => {
    expect(viewerKeyToAction(ev('Spacebar', { code: 'Space' }), ctx())).toBe(
      'next',
    );
  });

  it('keeps next/prev for arrows and pages in scroll and auto modes', () => {
    for (const nav of ['scroll', 'auto'] as const) {
      expect(viewerKeyToAction(ev('PageDown'), ctx({ nav }))).toBe('next');
      expect(viewerKeyToAction(ev('PageUp'), ctx({ nav }))).toBe('prev');
      expect(viewerKeyToAction(ev('ArrowLeft'), ctx({ nav }))).toBe('prev');
    }
  });

  it('Space and Enter toggle play in auto mode', () => {
    expect(viewerKeyToAction(ev(' '), ctx({ nav: 'auto' }))).toBe('togglePlay');
    expect(viewerKeyToAction(ev('Enter'), ctx({ nav: 'auto' }))).toBe(
      'togglePlay',
    );
    expect(
      viewerKeyToAction(ev(' ', { shiftKey: true }), ctx({ nav: 'auto' })),
    ).toBe('togglePlay');
  });

  it('Space is next/prev (not togglePlay) in scroll mode', () => {
    expect(viewerKeyToAction(ev(' '), ctx({ nav: 'scroll' }))).toBe('next');
  });

  it('Escape exits play mode only while in play mode', () => {
    expect(viewerKeyToAction(ev('Escape'), ctx({ playMode: true }))).toBe(
      'exitPlayMode',
    );
    expect(viewerKeyToAction(ev('Escape'), ctx())).toBeNull();
  });

  it('ignores Ctrl / Alt / Meta combos', () => {
    for (const m of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      expect(
        viewerKeyToAction(ev('ArrowRight', { [m]: true }), ctx()),
      ).toBeNull();
      expect(
        viewerKeyToAction(ev('Escape', { [m]: true }), ctx({ playMode: true })),
      ).toBeNull();
    }
  });

  it('ignores Shift combos other than Shift+Space', () => {
    expect(
      viewerKeyToAction(ev('ArrowRight', { shiftKey: true }), ctx()),
    ).toBeNull();
    expect(
      viewerKeyToAction(ev('Enter', { shiftKey: true }), ctx()),
    ).toBeNull();
  });

  it('ignores IME composition (isComposing and keyCode 229)', () => {
    expect(
      viewerKeyToAction(ev('Enter', { isComposing: true }), ctx()),
    ).toBeNull();
    expect(
      viewerKeyToAction(ev('Process', { keyCode: 229 }), ctx()),
    ).toBeNull();
    expect(
      viewerKeyToAction(ev('ArrowDown', { keyCode: 229 }), ctx()),
    ).toBeNull();
  });

  it('ignores keys while typing in an editable target', () => {
    expect(
      viewerKeyToAction(ev(' '), ctx({ targetIsEditable: true })),
    ).toBeNull();
    expect(
      viewerKeyToAction(
        ev('Escape'),
        ctx({ targetIsEditable: true, playMode: true }),
      ),
    ).toBeNull();
  });

  it('ignores key repeat', () => {
    expect(
      viewerKeyToAction(ev('PageDown', { repeat: true }), ctx()),
    ).toBeNull();
    expect(
      viewerKeyToAction(ev(' ', { repeat: true }), ctx({ nav: 'auto' })),
    ).toBeNull();
  });

  it('returns null for unrelated keys', () => {
    expect(viewerKeyToAction(ev('a'), ctx())).toBeNull();
    expect(viewerKeyToAction(ev('Tab'), ctx())).toBeNull();
  });
});
