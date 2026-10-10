// Keyboard (and Bluetooth foot-pedal) mapping for the viewer. Pure: the Viewer
// decides what 'next' / 'prev' mean for the current navigation mode.
import type { NavMode } from './viewerSettings';

export type ViewerAction = 'next' | 'prev' | 'togglePlay' | 'exitPlayMode';

export interface ViewerKeyContext {
  nav: NavMode;
  playMode: boolean;
  targetIsEditable: boolean;
}

type KeyEventLike = Pick<
  KeyboardEvent,
  | 'key'
  | 'code'
  | 'shiftKey'
  | 'ctrlKey'
  | 'altKey'
  | 'metaKey'
  | 'isComposing'
  | 'keyCode'
  | 'repeat'
>;

const NEXT_KEYS = new Set(['PageDown', 'ArrowRight', 'ArrowDown']);
const PREV_KEYS = new Set(['PageUp', 'ArrowLeft', 'ArrowUp']);

export function viewerKeyToAction(
  e: KeyEventLike,
  ctx: ViewerKeyContext,
): ViewerAction | null {
  if (ctx.targetIsEditable) return null;
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  // One press = one action: a held pedal/key must not flip many pages.
  if (e.repeat) return null;

  const isSpace = e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space';

  if (e.key === 'Escape') {
    return !e.shiftKey && ctx.playMode ? 'exitPlayMode' : null;
  }

  if (isSpace || e.key === 'Enter') {
    if (ctx.nav === 'auto') return isSpace || !e.shiftKey ? 'togglePlay' : null;
    if (isSpace) return e.shiftKey ? 'prev' : 'next';
    return e.shiftKey ? null : 'next';
  }

  if (e.shiftKey) return null;
  if (NEXT_KEYS.has(e.key)) return 'next';
  if (PREV_KEYS.has(e.key)) return 'prev';
  return null;
}
