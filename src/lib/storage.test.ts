import { describe, expect, it } from 'vitest';
import {
  EDITOR_MODE_KEY,
  createMemoryStorage,
  draftKey,
  loadEditorMode,
  saveEditorMode,
  loadViewerSettings,
  saveViewerSettings,
  viewerSettingsKey,
  loadAuth,
  loadBase,
  loadDeviceName,
  loadDraftRecord,
  loadIndex,
  migrateLegacyLocal,
  removeDraft,
  removeSongData,
  saveAuth,
  saveBase,
  saveDraftRecord,
  saveIndex,
  type KeyValueStorage,
} from './storage';

const throwing: KeyValueStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

describe('draftKey', () => {
  it('namespaces drafts per song id', () => {
    expect(draftKey('local')).toBe('band-sheets:draft:local');
    expect(draftKey('abc')).toBe('band-sheets:draft:abc');
  });
});

describe('loadEditorMode / saveEditorMode', () => {
  it('defaults to easy', () => {
    expect(loadEditorMode(createMemoryStorage())).toBe('easy');
    expect(loadEditorMode(null)).toBe('easy');
    expect(loadEditorMode(throwing)).toBe('easy');
  });

  it('round-trips the mode', () => {
    const storage = createMemoryStorage();
    expect(saveEditorMode(storage, 'text')).toBe(true);
    expect(loadEditorMode(storage)).toBe('text');
    saveEditorMode(storage, 'easy');
    expect(loadEditorMode(storage)).toBe('easy');
  });

  it('ignores unknown stored values', () => {
    const storage = createMemoryStorage({ [EDITOR_MODE_KEY]: 'bogus' });
    expect(loadEditorMode(storage)).toBe('easy');
  });

  it('never throws when storage throws', () => {
    expect(saveEditorMode(throwing, 'text')).toBe(false);
  });
});

describe('viewer settings storage', () => {
  const settings = {
    layout: 'score',
    part: null,
    scoreHidden: ['ドラム'],
    scoreChart: false,
    nav: 'auto',
    zoom: 1.2,
    speedPct: 80,
    countIn: false,
  } as const;

  it('namespaces the key per song id', () => {
    expect(viewerSettingsKey('local')).toBe('band-sheets:viewer:local');
  });

  it('round-trips per song id', () => {
    const st = createMemoryStorage();
    expect(saveViewerSettings(st, 'a', { ...settings, scoreHidden: [] })).toBe(
      true,
    );
    expect(
      saveViewerSettings(st, 'b', { ...settings, scoreHidden: ['x'] }),
    ).toBe(true);
    expect(loadViewerSettings(st, 'a')).toEqual({
      ...settings,
      scoreHidden: [],
    });
    expect(loadViewerSettings(st, 'b')).toEqual({
      ...settings,
      scoreHidden: ['x'],
    });
  });

  it('returns undefined when missing, broken JSON, or storage is null', () => {
    const st = createMemoryStorage({ [viewerSettingsKey('a')]: '{oops' });
    expect(loadViewerSettings(st, 'a')).toBeUndefined();
    expect(loadViewerSettings(st, 'zzz')).toBeUndefined();
    expect(loadViewerSettings(null, 'a')).toBeUndefined();
  });

  it('never throws when storage throws', () => {
    expect(loadViewerSettings(throwing, 'a')).toBeUndefined();
    expect(
      saveViewerSettings(throwing, 'a', { ...settings, scoreHidden: [] }),
    ).toBe(false);
    expect(
      saveViewerSettings(null, 'a', { ...settings, scoreHidden: [] }),
    ).toBe(false);
  });
});

describe('draft records', () => {
  const rec = {
    v: 1 as const,
    text: '{title: A}\n',
    baseVersion: '7',
    savedAt: '2026-10-06T00:00:00.000Z',
  };

  it('round-trips as JSON', () => {
    const st = createMemoryStorage();
    expect(saveDraftRecord(st, 'a', rec)).toBe(true);
    expect(loadDraftRecord(st, 'a')).toEqual(rec);
    expect(JSON.parse(st.data.get(draftKey('a')) as string)).toEqual(rec);
    expect(saveDraftRecord(st, 'b', { ...rec, baseVersion: null })).toBe(true);
    expect(loadDraftRecord(st, 'b')?.baseVersion).toBeNull();
  });

  it('reads legacy raw text as a draft with baseVersion null', () => {
    const st = createMemoryStorage({ [draftKey('a')]: '{title: X}\nあ' });
    expect(loadDraftRecord(st, 'a')).toEqual({
      v: 1,
      text: '{title: X}\nあ',
      baseVersion: null,
      savedAt: '',
    });
  });

  it('treats JSON-looking or malformed values as raw text', () => {
    for (const raw of ['123', '{"v":2,"text":"x"}', '{oops', '', 'null']) {
      const st = createMemoryStorage({ [draftKey('a')]: raw });
      expect(loadDraftRecord(st, 'a')?.text).toBe(raw);
      expect(loadDraftRecord(st, 'a')?.baseVersion).toBeNull();
    }
  });

  it('returns null when missing, and removeDraft removes', () => {
    const st = createMemoryStorage();
    expect(loadDraftRecord(st, 'a')).toBeNull();
    saveDraftRecord(st, 'a', rec);
    removeDraft(st, 'a');
    expect(loadDraftRecord(st, 'a')).toBeNull();
  });

  it('never throws on failing storage', () => {
    expect(loadDraftRecord(throwing, 'a')).toBeNull();
    expect(saveDraftRecord(throwing, 'a', rec)).toBe(false);
    expect(saveDraftRecord(null, 'a', rec)).toBe(false);
    expect(() => removeDraft(throwing, 'a')).not.toThrow();
    expect(() => removeDraft(null, 'a')).not.toThrow();
  });
});

describe('base records', () => {
  const base = {
    fileId: 'f1',
    version: '3',
    modifiedTime: '2026-10-06T00:00:00.000Z',
    device: 'PC',
    text: 'hello',
  };

  it('round-trips and rejects broken values', () => {
    const st = createMemoryStorage();
    expect(loadBase(st, 'a')).toBeNull();
    expect(saveBase(st, 'a', base)).toBe(true);
    expect(loadBase(st, 'a')).toEqual(base);
    st.setItem('band-sheets:base:b', '{oops');
    expect(loadBase(st, 'b')).toBeNull();
    st.setItem('band-sheets:base:c', JSON.stringify({ fileId: 'x' }));
    expect(loadBase(st, 'c')).toBeNull();
  });

  it('never throws on failing storage', () => {
    expect(loadBase(throwing, 'a')).toBeNull();
    expect(saveBase(throwing, 'a', base)).toBe(false);
  });
});

describe('removeSongData', () => {
  it('removes draft, base and viewer settings of that song only', () => {
    const st = createMemoryStorage({
      'band-sheets:draft:a': 'x',
      'band-sheets:base:a': '{}',
      'band-sheets:viewer:a': '{}',
      'band-sheets:draft:b': 'y',
    });
    removeSongData(st, 'a');
    expect([...st.data.keys()]).toEqual(['band-sheets:draft:b']);
    expect(() => removeSongData(throwing, 'a')).not.toThrow();
  });
});

describe('index', () => {
  it('round-trips', () => {
    const st = createMemoryStorage();
    const idx = {
      v: 1 as const,
      folderId: 'F',
      listedAt: '2026-10-06T00:00:00.000Z',
      songs: [{ songId: 's', title: 'T', summary: '', parts: '' }],
    };
    expect(saveIndex(st, idx)).toBe(true);
    expect(loadIndex(st)).toEqual(idx);
  });

  it('returns an empty index when missing or broken', () => {
    const empty = { v: 1, songs: [] };
    expect(loadIndex(createMemoryStorage())).toEqual(empty);
    expect(loadIndex(null)).toEqual(empty);
    expect(loadIndex(throwing)).toEqual(empty);
    for (const raw of ['{oops', '[]', '{"v":2,"songs":[]}', '{"v":1}']) {
      expect(
        loadIndex(createMemoryStorage({ 'band-sheets:index': raw })),
      ).toEqual(empty);
    }
  });

  it('drops malformed song entries', () => {
    const st = createMemoryStorage({
      'band-sheets:index': JSON.stringify({
        v: 1,
        songs: [{ songId: 's', title: 'T', summary: '', parts: '' }, 1, {}],
      }),
    });
    expect(loadIndex(st).songs).toHaveLength(1);
  });

  it('reports quota failure', () => {
    expect(saveIndex(throwing, { v: 1, songs: [] })).toBe(false);
  });
});

describe('auth', () => {
  it('round-trips and null removes', () => {
    const st = createMemoryStorage();
    expect(loadAuth(st)).toBeNull();
    saveAuth(st, { accessToken: 't', expiresAt: 123 });
    expect(loadAuth(st)).toEqual({ accessToken: 't', expiresAt: 123 });
    saveAuth(st, null);
    expect(loadAuth(st)).toBeNull();
    expect(st.data.size).toBe(0);
  });

  it('ignores broken values and never throws', () => {
    expect(
      loadAuth(createMemoryStorage({ 'band-sheets:auth': '{oops' })),
    ).toBeNull();
    expect(
      loadAuth(
        createMemoryStorage({
          'band-sheets:auth': '{"accessToken":"t","expiresAt":"x"}',
        }),
      ),
    ).toBeNull();
    expect(() =>
      saveAuth(throwing, { accessToken: 't', expiresAt: 1 }),
    ).not.toThrow();
    expect(() => saveAuth(throwing, null)).not.toThrow();
    expect(loadAuth(throwing)).toBeNull();
  });
});

describe('loadDeviceName', () => {
  it('detects once and then keeps the stored name', () => {
    const st = createMemoryStorage();
    expect(loadDeviceName(st, () => 'iPad')).toBe('iPad');
    expect(loadDeviceName(st, () => 'PC')).toBe('iPad');
  });

  it('falls back to detect when storage is unusable', () => {
    expect(loadDeviceName(null, () => 'PC')).toBe('PC');
    expect(loadDeviceName(throwing, () => 'PC')).toBe('PC');
  });
});

describe('migrateLegacyLocal', () => {
  const now = new Date('2026-10-06T06:00:00.000Z');
  const legacy = () =>
    createMemoryStorage({
      'band-sheets:draft:local': '{title: きらきら星}\nC G',
      'band-sheets:viewer:local': '{"zoom":1.2}',
    });

  it('moves draft, viewer settings and indexes the song', () => {
    const st = legacy();
    expect(migrateLegacyLocal(st, () => 'new-id', now)).toBe('new-id');
    expect(loadDraftRecord(st, 'new-id')).toEqual({
      v: 1,
      text: '{title: きらきら星}\nC G',
      baseVersion: null,
      savedAt: now.toISOString(),
    });
    expect(st.data.get('band-sheets:viewer:new-id')).toBe('{"zoom":1.2}');
    expect(st.data.has('band-sheets:draft:local')).toBe(false);
    expect(st.data.has('band-sheets:viewer:local')).toBe(false);
    const idx = loadIndex(st);
    expect(idx.songs).toEqual([
      {
        songId: 'new-id',
        title: 'きらきら星',
        summary: '',
        parts: '',
        modifiedTime: now.toISOString(),
      },
    ]);
  });

  it('is idempotent: the second call does nothing', () => {
    const st = legacy();
    migrateLegacyLocal(st, () => 'id1', now);
    const snapshot = [...st.data.entries()];
    expect(migrateLegacyLocal(st, () => 'id2', now)).toBeNull();
    expect([...st.data.entries()]).toEqual(snapshot);
  });

  it('does nothing without a legacy draft (viewer settings alone stay)', () => {
    const st = createMemoryStorage({ 'band-sheets:viewer:local': '{}' });
    expect(migrateLegacyLocal(st, () => 'x', now)).toBeNull();
    expect(st.data.size).toBe(1);
  });

  it('keeps existing index entries and drops broken viewer settings', () => {
    const st = createMemoryStorage({
      'band-sheets:draft:local': 'plain',
      'band-sheets:viewer:local': '{oops',
      'band-sheets:index': JSON.stringify({
        v: 1,
        folderId: 'F',
        songs: [{ songId: 'o', title: 'O', summary: '', parts: '' }],
      }),
    });
    expect(migrateLegacyLocal(st, () => 'n', now)).toBe('n');
    expect(st.data.has('band-sheets:viewer:n')).toBe(false);
    const idx = loadIndex(st);
    expect(idx.folderId).toBe('F');
    expect(idx.songs.map((s) => s.songId)).toEqual(['o', 'n']);
    expect(idx.songs[1]?.title).toBe('無題の曲');
  });

  it('keeps the legacy keys when a write fails', () => {
    const st = legacy();
    const failing: KeyValueStorage = {
      getItem: st.getItem,
      removeItem: st.removeItem,
      setItem: (k, v) => {
        if (k.startsWith('band-sheets:index')) throw new Error('Quota');
        st.setItem(k, v);
      },
    };
    expect(migrateLegacyLocal(failing, () => 'n', now)).toBeNull();
    expect(st.data.get('band-sheets:draft:local')).toBe(
      '{title: きらきら星}\nC G',
    );
    expect(st.data.has('band-sheets:draft:n')).toBe(false);
    expect(st.data.has('band-sheets:viewer:n')).toBe(false);
  });

  it('never throws on null / throwing storage', () => {
    expect(migrateLegacyLocal(null, () => 'n', now)).toBeNull();
    expect(migrateLegacyLocal(throwing, () => 'n', now)).toBeNull();
  });
});
