import type { HumAnalysisResult } from '../analysis/hum/types';
import type { TimeSig } from '../melody';
import {
  humDraftEvents,
  proposeOctave,
  type HumChoice,
  type HumChosen,
  type HumDraftOk,
  type HumDraftOptions,
  type HumNoteCandidates,
} from './humDraft';
import { octaveLabel, shiftLabel } from './humImport';
import {
  HUM_TUPLET_SHIFT_MESSAGE,
  IMPORT_ERROR_MESSAGES,
} from './importErrors';

/**
 * The fixes S4 (the humming review screen) lets the user make: the whole-draft ones and the per-note choices,
 * i.e. `HumDraftOptions` without the song key (the key is the editor's, not a fix). The pure logic of the
 * screen's state lives here, like `chordReview.ts` does for S3.
 */
export type HumFixes = Omit<HumDraftOptions, 'key'>;

/** Nothing fixed yet: the proposed octave (`proposeOctave`), no transpose / shift / choices. */
export function initialFixes(result: HumAnalysisResult): HumFixes {
  return {
    octave: proposeOctave(result),
    transpose: 0,
    shiftTicks: 0,
    chosen: {},
  };
}

/**
 * `chosen` after the user picked `choice` on a note. A pitch / position equal to the analyzer's own reading
 * (the first candidate) is no choice at all and is dropped; a note with nothing left is removed.
 */
export function mergeChoice(
  chosen: HumChosen,
  cand: HumNoteCandidates,
  choice: HumChoice,
): HumChosen {
  const id = cand.id;
  const merged: HumChoice = { ...chosen[id], ...choice };
  const orig = cand.position[0];
  if (merged.midi === cand.pitch[0].midi) delete merged.midi;
  if (
    merged.position &&
    merged.position.startTick === orig.startTick &&
    merged.position.ticks === orig.ticks
  )
    delete merged.position;
  const { [id]: _old, ...others } = chosen;
  return merged.midi === undefined && merged.position === undefined
    ? others
    : { ...others, [id]: merged };
}

/** Whether anything differs from the start (`proposed` = the initial octave). */
export function fixesChanged(fixes: HumFixes, proposed: number): boolean {
  return (
    fixes.octave !== proposed ||
    fixes.transpose !== 0 ||
    fixes.shiftTicks !== 0 ||
    Object.keys(fixes.chosen).length > 0
  );
}

/** One short text per fix made, for 「全体の直し」: octave, transpose, shift, 「候補 N 音」. */
export function fixSummary(
  fixes: HumFixes,
  proposed: number,
  ts: TimeSig,
): string[] {
  const chosen = Object.keys(fixes.chosen).length;
  return [
    fixes.octave !== proposed ? octaveLabel(fixes.octave - proposed) : '',
    fixes.transpose !== 0
      ? `${fixes.transpose > 0 ? '+' : '−'}${Math.abs(fixes.transpose)} 半音`
      : '',
    fixes.shiftTicks !== 0 ? shiftLabel(fixes.shiftTicks, ts) : '',
    chosen > 0 ? `候補 ${chosen} 音` : '',
  ].filter(Boolean);
}

/** The draft with these fixes, or why the fixes cannot be applied (the message to tell the user). */
export function applyFixes(
  result: HumAnalysisResult,
  fixes: HumFixes,
  key?: string,
): { ok: true; draft: HumDraftOk } | { ok: false; message: string } {
  const d = humDraftEvents(result, { ...fixes, key });
  if (d.ok) return { ok: true, draft: d };
  return {
    ok: false,
    message:
      d.reason === 'tupletCrossesBar'
        ? HUM_TUPLET_SHIFT_MESSAGE
        : IMPORT_ERROR_MESSAGES.internal,
  };
}
