import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Root } from './Root';
import { saintsSampleText } from './lib/saintsSample';
import type { AuthStatus } from './lib/auth/gis';
import { createFakeAuth } from './lib/auth/fakeAuth';
import {
  createFakeDriveClient,
  type FakeSeedFile,
} from './lib/drive/fakeDriveClient';
import {
  baseKey,
  createMemoryStorage,
  draftKey,
  INDEX_KEY,
  loadDraftRecord,
  loadIndex,
} from './lib/storage';

const FOLDER: FakeSeedFile = {
  meta: {
    id: 'folder',
    name: 'band-sheets',
    modifiedTime: '2026-10-01T00:00:00.000Z',
  },
  text: '',
  folder: true,
};

const SONG_TEXT = '{title: きらきら星}\n{key: C}\n';

const SONG: FakeSeedFile = {
  meta: {
    id: 'f1',
    name: 'きらきら星.bandsheet',
    version: '5',
    modifiedTime: '2026-10-05T10:00:00.000Z',
    appProperties: {
      app: 'band-sheets',
      songId: 's1',
      device: 'iPad',
      format: '1',
    },
  },
  text: SONG_TEXT,
  parents: ['folder'],
};

function setHash(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
}

function setup(
  o: {
    hash?: string;
    status?: AuthStatus;
    files?: FakeSeedFile[];
    init?: Record<string, string>;
    tablet?: boolean;
    before?: (drive: ReturnType<typeof createFakeDriveClient>) => void;
  } = {},
) {
  setHash(o.hash ?? '#/');
  const auth = createFakeAuth(o.status ?? 'signedIn');
  const drive = createFakeDriveClient({ files: [FOLDER, ...(o.files ?? [])] });
  o.before?.(drive);
  const storage = createMemoryStorage(o.init);
  let n = 0;
  const user = userEvent.setup();
  render(
    <Root
      auth={auth}
      storage={storage}
      client={drive}
      tablet={o.tablet ?? false}
      mac={false}
      detectDevice={() => 'Windows PC'}
      newId={() => `new-${++n}`}
      now={() => new Date('2026-10-06T12:00:00.000Z')}
    />,
  );
  return { auth, drive, storage, user };
}

const textarea = () => screen.getByLabelText('ChordPro テキスト');

async function openTextEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'テキスト入力' }));
}

const ctrlS = (target: Element | Document = document, extra = {}) =>
  fireEvent.keyDown(target, {
    key: 's',
    code: 'KeyS',
    ctrlKey: true,
    ...extra,
  });

afterEach(() => setHash(''));

describe('Root routing', () => {
  it('replaces the M6 #view bookmark with the list', async () => {
    setup({ hash: '#view', files: [SONG] });
    expect(
      await screen.findByRole('heading', { name: '曲の一覧' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('#/');
    expect(await screen.findByText('きらきら星')).toBeInTheDocument();
  });

  it('#/new opens a new song and replaces the hash with its id', async () => {
    setup({ hash: '#/new' });
    expect(
      await screen.findByRole('heading', { level: 1, name: '無題の曲' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe('#/edit/new-1'));
  });

  it('shows the sign-in screen first when signed out with no songs', async () => {
    const { user } = setup({ status: 'signedOut' });
    expect(
      screen.getByRole('button', { name: 'Google でログイン' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新しい曲を作る →' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: '無題の曲' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('#/edit/new-1');
  });

  it('signing in from the sign-in screen shows the list', async () => {
    const { user } = setup({ status: 'signedOut', files: [SONG] });
    await user.click(screen.getByRole('button', { name: 'Google でログイン' }));
    expect(await screen.findByText('きらきら星')).toBeInTheDocument();
  });

  it('migrates the M3–M6 local draft at startup', async () => {
    const { storage } = setup({
      status: 'signedOut',
      init: { [draftKey('local')]: '{title: 古い曲}\n' },
    });
    expect(await screen.findByText('古い曲')).toBeInTheDocument();
    expect(storage.getItem(draftKey('local'))).toBeNull();
    expect(loadDraftRecord(storage, 'new-1')?.text).toBe('{title: 古い曲}\n');
  });

  it('lists a new song after its first edit (device only)', async () => {
    const { user, storage } = setup({ hash: '#/new', status: 'signedOut' });
    await openTextEditor(user);
    await user.type(textarea(), 'X');
    expect(loadIndex(storage).songs.map((s) => s.songId)).toEqual(['new-1']);
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    await user.click(
      await screen.findByRole('button', { name: '保存せずに戻る' }),
    );
    const row = await screen.findByTestId('song-row-new-1');
    expect(row).toHaveAttribute('data-status', 'localOnly');
  });
});

describe('Root sample song', () => {
  it('sign-in screen 「サンプル曲を追加」 opens a new song with the sample (device only)', async () => {
    const { user, storage } = setup({ status: 'signedOut' });
    await user.click(
      screen.getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: '聖者の行進' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('#/edit/new-1');
    await openTextEditor(user);
    expect(textarea()).toHaveValue(saintsSampleText);
    expect(loadDraftRecord(storage, 'new-1')).toMatchObject({
      text: saintsSampleText,
      baseVersion: null,
    });
    // Back on the list it is an ordinary device-only song (not on Drive
    // yet, so leaving asks like any unsaved new song).
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    await user.click(
      await screen.findByRole('button', { name: '保存せずに戻る' }),
    );
    const row = await screen.findByTestId('song-row-new-1');
    expect(row).toHaveAttribute('data-status', 'localOnly');
    expect(within(row).getByText('聖者の行進')).toBeInTheDocument();
  });

  it('list 「サンプル曲を追加」 makes a new copy each time; Ctrl+S saves it to Drive', async () => {
    const { user, drive } = setup({ files: [SONG] });
    await user.click(
      await screen.findByRole('button', { name: 'サンプル曲を追加' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: '聖者の行進' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('#/edit/new-1');
    act(() => {
      ctrlS();
    });
    await waitFor(() =>
      expect(screen.getByTestId('save-status')).toHaveAttribute(
        'data-state',
        'saved',
      ),
    );
    const saved = drive.files().filter((f) => f.text === saintsSampleText);
    expect(saved).toHaveLength(1);
    expect(saved[0].meta.appProperties?.songId).toBe('new-1');

    // A second press makes a second, separate song.
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    await user.click(
      await screen.findByRole('button', { name: 'サンプル曲を追加' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: '聖者の行進' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('#/edit/new-2');
  });
});

describe('Root viewer', () => {
  it('opening the viewer from the list never writes a draft', async () => {
    const { user, storage } = setup({ files: [SONG] });
    await user.click(
      await screen.findByRole('button', { name: 'きらきら星を閲覧で開く' }),
    );
    expect(window.location.hash).toBe('#/view/s1');
    expect(
      await screen.findByRole('button', { name: '‹ 曲の一覧' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('ChordPro テキスト')).toBeNull();
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    expect(
      await screen.findByRole('heading', { name: '曲の一覧' }),
    ).toBeInTheDocument();
    expect(storage.getItem(draftKey('s1'))).toBeNull();
  });

  it('the editor 「閲覧モード」 pushes #/view and keeps the editor mounted', async () => {
    const { user } = setup({ hash: '#/edit/s1', files: [SONG] });
    await openTextEditor(user);
    await user.type(textarea(), 'X');
    await user.click(screen.getByRole('button', { name: '閲覧モード' }));
    expect(window.location.hash).toBe('#/view/s1');
    // Ctrl+S is ignored while viewing.
    expect(ctrlS()).toBe(true);
    await user.click(await screen.findByRole('button', { name: /編集に戻る/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/edit/s1'));
    await waitFor(() => expect(textarea()).toHaveValue(SONG_TEXT + 'X'));
  });
});

describe('Root editor', () => {
  it('Ctrl+S saves to Drive (and stops the browser save dialog)', async () => {
    const { user, drive } = setup({ hash: '#/edit/s1', files: [SONG] });
    await openTextEditor(user);
    await user.type(textarea(), 'X');
    let notPrevented = true;
    act(() => {
      notPrevented = ctrlS(textarea());
    });
    expect(notPrevented).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId('save-status')).toHaveAttribute(
        'data-state',
        'saved',
      ),
    );
    expect(drive.files()[0].text).toBe(SONG_TEXT + 'X');
  });

  it('Ctrl+S right after typing (same tick) saves the latest text', async () => {
    const { user, drive } = setup({ hash: '#/edit/s1', files: [SONG] });
    await openTextEditor(user);
    act(() => {
      fireEvent.change(textarea(), { target: { value: SONG_TEXT + 'XY' } });
      ctrlS(textarea());
    });
    await waitFor(() => expect(drive.files()[0].text).toBe(SONG_TEXT + 'XY'));
  });

  it('ignores Ctrl+S during an IME composition', async () => {
    const { user, drive } = setup({ hash: '#/edit/s1', files: [SONG] });
    await openTextEditor(user);
    await user.type(textarea(), 'X');
    const before = drive.calls.length;
    expect(ctrlS(textarea(), { isComposing: true })).toBe(true);
    expect(drive.calls.length).toBe(before);
    expect(screen.getByTestId('save-status')).toHaveAttribute(
      'data-state',
      'dirty',
    );
  });

  it('saves the text edited back to the opened text (not the stale one)', async () => {
    const { user, drive } = setup({ hash: '#/edit/s1', files: [SONG] });
    await openTextEditor(user);
    await user.type(textarea(), 'X');
    act(() => {
      ctrlS();
    });
    await waitFor(() => expect(drive.files()[0].text).toBe(SONG_TEXT + 'X'));
    await user.type(textarea(), '{Backspace}');
    act(() => {
      ctrlS();
    });
    await waitFor(() => expect(drive.files()[0].text).toBe(SONG_TEXT));
  });

  it('asks before leaving with unsaved changes; the draft stays', async () => {
    const { user, storage } = setup({ hash: '#/edit/s1', files: [SONG] });
    await openTextEditor(user);
    await user.type(textarea(), 'X');
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    expect(
      await screen.findByText('保存せずに一覧に戻りますか？'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(textarea()).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    await user.click(
      await screen.findByRole('button', { name: '保存せずに戻る' }),
    );
    expect(
      await screen.findByRole('heading', { name: '曲の一覧' }),
    ).toBeInTheDocument();
    expect(loadDraftRecord(storage, 's1')?.text).toBe(SONG_TEXT + 'X');
    expect(await screen.findByTestId('song-row-s1')).toHaveAttribute(
      'data-status',
      'dirty',
    );
  });

  it('「保存して戻る」 saves, then shows the list', async () => {
    const { user, drive } = setup({ hash: '#/edit/s1', files: [SONG] });
    await openTextEditor(user);
    await user.type(textarea(), 'X');
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    await user.click(
      await screen.findByRole('button', { name: '保存して戻る' }),
    );
    expect(
      await screen.findByRole('heading', { name: '曲の一覧' }),
    ).toBeInTheDocument();
    expect(drive.files()[0].text).toBe(SONG_TEXT + 'X');
  });

  it('leaves without asking when nothing changed', async () => {
    const { user } = setup({ hash: '#/edit/s1', files: [SONG] });
    await screen.findByRole('heading', { level: 1, name: 'きらきら星' });
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    expect(
      await screen.findByRole('heading', { name: '曲の一覧' }),
    ).toBeInTheDocument();
  });

  it('shows the conflict dialog when Drive changed elsewhere', async () => {
    const { user, drive } = setup({ hash: '#/edit/s1', files: [SONG] });
    await openTextEditor(user);
    await user.type(textarea(), 'X');
    drive.externalUpdate('f1', SONG_TEXT + 'Y', 'iPad');
    act(() => {
      ctrlS();
    });
    expect(
      await screen.findByRole('button', { name: 'キャンセル' }),
    ).toBeInTheDocument();
    // While the dialog is open Ctrl+S does nothing.
    const before = drive.calls.length;
    act(() => {
      ctrlS();
    });
    expect(drive.calls.length).toBe(before);
    await user.click(screen.getByRole('radio', { name: /上書きする/ }));
    await user.click(screen.getByRole('button', { name: '上書きして保存' }));
    await waitFor(() => expect(drive.files()[0].text).toBe(SONG_TEXT + 'X'));
  });
});

/** s1 known to this device (listed, text cached at version 5). */
const CACHED = {
  [INDEX_KEY]: JSON.stringify({
    v: 1,
    folderId: 'folder',
    listedAt: '2026-10-06T10:00:00.000Z',
    songs: [
      {
        songId: 's1',
        fileId: 'f1',
        title: 'きらきら星',
        summary: '',
        parts: '',
        version: '5',
      },
    ],
  }),
  [baseKey('s1')]: JSON.stringify({
    fileId: 'f1',
    version: '5',
    modifiedTime: '2026-10-05T10:00:00.000Z',
    device: 'iPad',
    text: SONG_TEXT,
  }),
};

describe('Root review fixes (m7-review.md)', () => {
  it('R6: an unknown song id signed in → looks on Drive, then explains (no new song)', async () => {
    const { drive, storage, user } = setup({
      hash: '#/edit/nope',
      files: [SONG],
      init: CACHED,
    });
    expect(await screen.findByTestId('unknown-song')).toBeInTheDocument();
    expect(drive.calls.some((c) => c.startsWith('listFiles'))).toBe(true);
    expect(screen.queryByLabelText('ChordPro テキスト')).toBeNull();
    expect(loadDraftRecord(storage, 'nope')).toBeNull();
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    expect(
      await screen.findByRole('heading', { name: '曲の一覧' }),
    ).toBeInTheDocument();
  });

  it('R6: a song made elsewhere since the cached list → found by listing, opens', async () => {
    const other: FakeSeedFile = {
      ...SONG,
      meta: {
        ...SONG.meta,
        id: 'f2',
        name: '新曲.bandsheet',
        appProperties: { ...SONG.meta.appProperties!, songId: 's2' },
      },
      text: '{title: 新曲}\n',
    };
    const { user } = setup({
      hash: '#/edit/s2',
      files: [SONG, other],
      init: CACHED,
    });
    await openTextEditor(user);
    expect(textarea()).toHaveValue('{title: 新曲}\n');
  });

  it('R6: signed out with an unknown id → explanation with sign-in', async () => {
    setup({ hash: '#/view/nope', status: 'signedOut' });
    expect(await screen.findByTestId('unknown-song')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'ログイン' }),
    ).toBeInTheDocument();
  });

  it('R2: expired → 「前回読み込んだ版です」, 未確認; reconnect checks Drive', async () => {
    const { user, auth, drive } = setup({
      hash: '#/edit/s1',
      status: 'expired',
      files: [SONG],
      init: CACHED,
    });
    expect(await screen.findByTestId('stale-notice')).toHaveTextContent(
      '前回読み込んだ版です',
    );
    expect(screen.getByTestId('save-status')).toHaveAttribute(
      'data-state',
      'unconfirmed',
    );
    drive.externalUpdate('f1', SONG_TEXT + 'Y\n', 'iPad');
    auth.calls.length = 0;
    await user.click(screen.getByRole('button', { name: 'Drive に再接続' }));
    expect(auth.calls[0]).toBe('ensureToken');
    await waitFor(() =>
      expect(screen.queryByTestId('stale-notice')).toBeNull(),
    );
    await openTextEditor(user);
    expect(textarea()).toHaveValue(SONG_TEXT + 'Y\n');
    expect(screen.getByTestId('save-status')).toHaveAttribute(
      'data-state',
      'saved',
    );
  });

  it('R18: expired + body never downloaded → editor offers reconnect and opens', async () => {
    const { user, auth, drive } = setup({
      hash: '#/edit/s1',
      status: 'expired',
      files: [SONG],
      init: { [INDEX_KEY]: CACHED[INDEX_KEY] },
    });
    expect(await screen.findByTestId('stale-notice')).toHaveTextContent(
      'Drive に再接続すると開けます',
    );
    expect(drive.calls).toEqual([]);
    auth.calls.length = 0;
    await user.click(screen.getByRole('button', { name: 'Drive に再接続' }));
    expect(auth.calls[0]).toBe('ensureToken');
    await openTextEditor(user);
    expect(textarea()).toHaveValue(SONG_TEXT);
  });

  it('R18: signing in elsewhere reopens the editor', async () => {
    const { user, auth } = setup({
      hash: '#/edit/s1',
      status: 'expired',
      files: [SONG],
      init: { [INDEX_KEY]: CACHED[INDEX_KEY] },
    });
    expect(await screen.findByTestId('stale-notice')).toBeInTheDocument();
    act(() => auth.setStatus('signedIn'));
    await openTextEditor(user);
    expect(textarea()).toHaveValue(SONG_TEXT);
  });

  it('R19: the Drive file is gone and no draft → explains, back to the list', async () => {
    // The list still has the song, but opening finds the file gone.
    const { user } = setup({
      hash: '#/edit/s1',
      files: [SONG],
      init: CACHED,
      before: (d) => d.failNext('notFound'),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '削除されたか、アプリの許可が外れた可能性',
    );
    expect(screen.queryByText(/通信を確認/)).toBeNull();
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    expect(
      await screen.findByRole('heading', { name: '曲の一覧' }),
    ).toBeInTheDocument();
  });

  it('R2: the viewer shows the notice too', async () => {
    setup({
      hash: '#/view/s1',
      status: 'expired',
      files: [SONG],
      init: CACHED,
    });
    expect(await screen.findByTestId('stale-notice')).toBeInTheDocument();
  });

  it('R14: the Drive file is gone → asks before creating a new one', async () => {
    const { user, drive } = setup({ hash: '#/edit/s1', files: [SONG] });
    await openTextEditor(user);
    await user.type(textarea(), 'X');
    await drive.trash('f1');
    act(() => {
      ctrlS();
    });
    const dialog = await screen.findByRole('dialog', {
      name: 'Drive にこの曲のファイルが見つかりません',
    });
    expect(dialog).toHaveTextContent('アプリの許可が外れた可能性');
    expect(drive.files().filter((f) => !f.trashed)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '新しく保存する' }));
    await waitFor(() =>
      expect(drive.files().filter((f) => !f.trashed)).toHaveLength(1),
    );
    expect(drive.files().find((f) => !f.trashed)?.text).toBe(SONG_TEXT + 'X');
  });

  it('R8: tablet refresh failure is shown, and cleared by a successful refresh', async () => {
    const { user, drive } = setup({
      tablet: true,
      files: [SONG],
      init: CACHED,
    });
    const refresh = await screen.findByRole('button', { name: '更新' });
    drive.failNext('network', 5);
    await user.click(refresh);
    expect(await screen.findByTestId('refresh-failed')).toBeInTheDocument();
    drive.failNext('network', 0); // back online
    await user.click(await screen.findByRole('button', { name: '更新' }));
    await waitFor(() =>
      expect(screen.queryByTestId('refresh-failed')).toBeNull(),
    );
  });
});
