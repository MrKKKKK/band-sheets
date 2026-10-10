import { parseSong } from './parseSong';
import { serializeSong } from './serializeSong';
import type {
  BaseRecord,
  DraftRecord,
  DriveFileMeta,
  OpenDecision,
  SaveState,
} from './syncTypes';

/** Unsaved changes = a draft exists and differs from the last synced text. */
export function isDirty(
  draft: DraftRecord | null,
  base: BaseRecord | null,
): boolean {
  if (draft === null) return false;
  if (base === null) return true;
  return draft.text !== base.text;
}

/**
 * Which way to open a song for editing (A/B/C of m7-plan.md).
 * A: no unsaved draft -> Drive's version. B: draft made on Drive's current
 * version (or legacy raw-text draft with baseVersion null) -> ask to resume.
 * C: draft's base is older than Drive's -> Drive is newer.
 */
export function decideOpen(a: {
  draft: DraftRecord | null;
  base: BaseRecord | null;
  remote: DriveFileMeta | null;
  online: boolean;
  hasFile: boolean;
}): OpenDecision {
  const { draft, base, remote, online, hasFile } = a;
  if (!hasFile) return { kind: 'draftOnly' };
  // The song is known to be on Drive but the lookup found nothing: the file
  // was deleted. Keep whatever the user has locally; otherwise nothing to open.
  if (online && remote === null) {
    return draft !== null ? { kind: 'draftOnly' } : { kind: 'unavailable' };
  }
  if (!isDirty(draft, base)) {
    if (online) return { kind: 'drive' };
    return base !== null ? { kind: 'drive' } : { kind: 'unavailable' };
  }
  // dirty draft (draft is non-null here)
  if (draft!.baseVersion === null) return { kind: 'askResume' };
  if (!online || remote === null) return { kind: 'askResume' };
  return draft!.baseVersion === remote.version
    ? { kind: 'askResume' }
    : { kind: 'driveNewer' };
}

/**
 * The header's save indicator. A failure the caller recorded wins.
 * `unconfirmed`: the text came from this device's cache and Drive has not
 * been checked (sign-in expired / offline) → 'unconfirmed' instead of
 * 'saved' (m7-review.md R2).
 */
export function saveStateOf(a: {
  signedIn: boolean;
  hasFile: boolean;
  draft: DraftRecord | null;
  base: BaseRecord | null;
  saving: boolean;
  failed: SaveState | null;
  unconfirmed?: boolean;
}): SaveState {
  const { signedIn, hasFile, draft, base, saving, failed } = a;
  if (saving) return { kind: 'saving' };
  if (failed !== null && failed.kind === 'failed') return failed;
  if (!signedIn || !hasFile) {
    return draft !== null
      ? { kind: 'localOnly', draftAt: draft.savedAt }
      : { kind: 'localOnly' };
  }
  if (isDirty(draft, base)) return { kind: 'dirty', draftAt: draft!.savedAt };
  if (base === null) return { kind: 'localOnly' };
  if (a.unconfirmed) return { kind: 'unconfirmed', at: base.modifiedTime };
  return { kind: 'saved', at: base.modifiedTime };
}

/** Replaces `{title:}` (parse -> set -> serialize, so the text is normalized). */
export function withTitle(text: string, title: string): string {
  const song = parseSong(text);
  return serializeSong({ ...song, meta: { ...song.meta, title } });
}
