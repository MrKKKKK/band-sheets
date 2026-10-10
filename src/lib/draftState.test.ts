import { describe, expect, it } from 'vitest';
import { decideOpen, isDirty, saveStateOf, withTitle } from './draftState';
import { parseSong } from './parseSong';
import type { BaseRecord, DraftRecord, DriveFileMeta } from './syncTypes';

const base = (o: Partial<BaseRecord> = {}): BaseRecord => ({
  fileId: 'f1',
  version: '5',
  modifiedTime: '2026-10-06T05:00:00Z',
  text: '{title: A}\n',
  ...o,
});
const draft = (o: Partial<DraftRecord> = {}): DraftRecord => ({
  v: 1,
  text: '{title: B}\n',
  baseVersion: '5',
  savedAt: '2026-10-06T06:00:00Z',
  ...o,
});
const remote = (version = '5'): DriveFileMeta => ({
  id: 'f1',
  name: 'A.bandsheet',
  version,
  modifiedTime: '2026-10-06T05:00:00Z',
});
const open = (o: Partial<Parameters<typeof decideOpen>[0]>) =>
  decideOpen({
    draft: null,
    base: base(),
    remote: remote(),
    online: true,
    hasFile: true,
    ...o,
  }).kind;

describe('isDirty', () => {
  it('is false without a draft', () => {
    expect(isDirty(null, base())).toBe(false);
    expect(isDirty(null, null)).toBe(false);
  });
  it('is false when the draft equals the base text', () => {
    expect(isDirty(draft({ text: base().text }), base())).toBe(false);
  });
  it('is true when the text differs', () => {
    expect(isDirty(draft(), base())).toBe(true);
  });
  it('is true for a draft with no base (never on Drive)', () => {
    expect(isDirty(draft({ baseVersion: null }), null)).toBe(true);
  });
});

describe('decideOpen', () => {
  it('A: no draft -> drive', () => {
    expect(open({})).toBe('drive');
  });
  it('A: draft equal to base -> drive, even if Drive moved on', () => {
    expect(
      open({ draft: draft({ text: base().text }), remote: remote('9') }),
    ).toBe('drive');
  });
  it('A: no draft and no base while online -> drive', () => {
    expect(open({ base: null })).toBe('drive');
  });
  it('B: draft made on the current Drive version -> askResume', () => {
    expect(open({ draft: draft() })).toBe('askResume');
  });
  it('C: Drive moved past the draft base -> driveNewer', () => {
    expect(open({ draft: draft(), remote: remote('6') })).toBe('driveNewer');
  });
  it('legacy raw-text draft (baseVersion null) on a Drive song -> askResume', () => {
    expect(
      open({ draft: draft({ baseVersion: null }), remote: remote('9') }),
    ).toBe('askResume');
  });
  it('legacy draft with no base -> askResume', () => {
    expect(open({ draft: draft({ baseVersion: null }), base: null })).toBe(
      'askResume',
    );
  });
  it('song not on Drive -> draftOnly', () => {
    expect(
      open({
        hasFile: false,
        remote: null,
        base: null,
        draft: draft({ baseVersion: null }),
      }),
    ).toBe('draftOnly');
  });
  it('file vanished from Drive -> draftOnly with a draft, unavailable without', () => {
    expect(open({ remote: null, draft: draft() })).toBe('draftOnly');
    expect(open({ remote: null })).toBe('unavailable');
  });
  it('offline, no draft, base cached -> drive (opens the base)', () => {
    expect(open({ online: false, remote: null })).toBe('drive');
  });
  it('offline, no draft and no base -> unavailable', () => {
    expect(open({ online: false, remote: null, base: null })).toBe(
      'unavailable',
    );
  });
  it('offline with a dirty draft -> askResume', () => {
    expect(open({ online: false, remote: null, draft: draft() })).toBe(
      'askResume',
    );
  });
  it('offline with a draft equal to base -> drive', () => {
    expect(
      open({
        online: false,
        remote: null,
        draft: draft({ text: base().text }),
      }),
    ).toBe('drive');
  });
});

describe('saveStateOf', () => {
  const s = (o: Partial<Parameters<typeof saveStateOf>[0]> = {}) =>
    saveStateOf({
      signedIn: true,
      hasFile: true,
      draft: null,
      base: base(),
      saving: false,
      failed: null,
      ...o,
    });
  it('saved at the base time', () => {
    expect(s()).toEqual({ kind: 'saved', at: base().modifiedTime });
  });
  it('unconfirmed instead of saved while Drive is not checked (R2)', () => {
    expect(s({ unconfirmed: true })).toEqual({
      kind: 'unconfirmed',
      at: base().modifiedTime,
    });
  });
  it('unconfirmed does not hide unsaved changes or saving', () => {
    expect(s({ unconfirmed: true, draft: draft({ text: 'x' }) }).kind).toBe(
      'dirty',
    );
    expect(s({ unconfirmed: true, saving: true }).kind).toBe('saving');
  });
  it('saved when the draft equals the base', () => {
    expect(s({ draft: draft({ text: base().text }) }).kind).toBe('saved');
  });
  it('dirty with the draft time', () => {
    expect(s({ draft: draft() })).toEqual({
      kind: 'dirty',
      draftAt: draft().savedAt,
    });
  });
  it('saving wins over everything', () => {
    expect(
      s({
        saving: true,
        draft: draft(),
        failed: { kind: 'failed', reason: 'network' },
      }),
    ).toEqual({ kind: 'saving' });
  });
  it('a recorded failure wins over dirty', () => {
    const failed = { kind: 'failed', reason: 'auth' } as const;
    expect(s({ draft: draft(), failed })).toEqual(failed);
  });
  it('a non-failure `failed` value is ignored', () => {
    expect(s({ failed: { kind: 'saving' } }).kind).toBe('saved');
  });
  it('localOnly when signed out (with and without a draft)', () => {
    expect(s({ signedIn: false, draft: draft() })).toEqual({
      kind: 'localOnly',
      draftAt: draft().savedAt,
    });
    expect(s({ signedIn: false })).toEqual({ kind: 'localOnly' });
  });
  it('localOnly when the song has no Drive file', () => {
    expect(s({ hasFile: false, base: null, draft: draft() }).kind).toBe(
      'localOnly',
    );
  });
  it('localOnly when on Drive but no base is known and no draft', () => {
    expect(s({ base: null })).toEqual({ kind: 'localOnly' });
  });
});

describe('withTitle', () => {
  it('replaces the title and keeps the rest', () => {
    const out = withTitle('{title: A}\n{key: C}\n\n[C]la\n', 'B');
    const song = parseSong(out);
    expect(song.meta.title).toBe('B');
    expect(song.meta.key).toBe('C');
    expect(out).toContain('[C]la');
  });
  it('adds a title when there was none', () => {
    expect(parseSong(withTitle('[C]la\n', 'X')).meta.title).toBe('X');
  });
  it('is idempotent', () => {
    const once = withTitle('{title: A}\n', 'B');
    expect(withTitle(once, 'B')).toBe(once);
  });
});
