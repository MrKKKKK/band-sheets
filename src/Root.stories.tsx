import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Root } from './Root';
import type { AuthStatus } from './lib/auth/gis';
import { createFakeAuth } from './lib/auth/fakeAuth';
import {
  createFakeDriveClient,
  type FakeDriveClient,
  type FakeSeedFile,
} from './lib/drive/fakeDriveClient';
import {
  baseKey,
  createMemoryStorage,
  draftKey,
  INDEX_KEY,
} from './lib/storage';

/**
 * The whole app on a fake Drive + fake sign-in + in-memory storage: never
 * touches Google or the browser's localStorage. The URL hash is reset on
 * every mount (stories share one iframe).
 */

const FOLDER: FakeSeedFile = {
  meta: {
    id: 'folder',
    name: 'band-sheets',
    modifiedTime: '2026-10-01T00:00:00.000Z',
  },
  text: '',
  folder: true,
};

const SONG_TEXT = '{title: きらきら星}\n{key: C}\n{tempo: 100}\n{time: 4/4}\n';

function songFile(id: string, songId: string, title: string, text: string) {
  return {
    meta: {
      id,
      name: `${title}.bandsheet`,
      version: '5',
      modifiedTime: '2026-10-05T10:00:00.000Z',
      appProperties: {
        app: 'band-sheets',
        songId,
        device: 'iPad',
        format: '1',
      },
    },
    text,
    parents: ['folder'],
  } satisfies FakeSeedFile;
}

const SONGS = [
  songFile('f1', 's1', 'きらきら星', SONG_TEXT),
  songFile('f2', 's2', '週末ブルース', '{title: 週末ブルース}\n{key: A}\n'),
];

/** The fake Drive of the story being shown (for play functions). */
let currentDrive: FakeDriveClient | null = null;

function Demo({
  status,
  files,
  init,
  tablet = false,
  hash = '#/',
}: {
  status: AuthStatus;
  files: FakeSeedFile[];
  init?: Record<string, string>;
  tablet?: boolean;
  hash?: string;
}) {
  const [env] = useState(() => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    );
    const drive = createFakeDriveClient({ files: [FOLDER, ...files] });
    currentDrive = drive;
    return {
      auth: createFakeAuth(status),
      drive,
      storage: createMemoryStorage(init),
    };
  });
  return (
    <Root
      auth={env.auth}
      storage={env.storage}
      client={env.drive}
      tablet={tablet}
      mac={false}
      detectDevice={() => 'Windows PC'}
    />
  );
}

const meta = {
  title: 'Root',
  component: Demo,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: { status: 'signedIn', files: SONGS },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** First visit: never signed in, no songs on this device. */
export const FirstVisit: Story = {
  args: { status: 'signedOut', files: [] },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(
      c.getByRole('button', { name: 'Google でログイン' }),
    ).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'Google でログイン' }));
    // Signed in (fake): the (empty) list.
    await expect(await c.findByTestId('song-list-empty')).toBeVisible();
  },
};

/** 一覧 → 開く → 編集 → 保存 → 別の端末の保存 → Ctrl+S → 衝突 → 上書き. */
export const ListEditSaveConflict: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const body = within(document.body);
    await userEvent.click(
      await c.findByRole('button', { name: 'きらきら星を開く' }),
    );
    await expect(
      await c.findByRole('heading', { level: 1, name: 'きらきら星' }),
    ).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'テキスト入力' }));
    const textarea = c.getByLabelText('ChordPro テキスト');
    await userEvent.type(textarea, '{End}X');
    const status = c.getByTestId('save-status');
    await waitFor(() => expect(status).toHaveAttribute('data-state', 'dirty'));
    await userEvent.click(within(status).getByRole('button'));
    await waitFor(() => expect(status).toHaveAttribute('data-state', 'saved'));
    expect(currentDrive!.files()[0].text).toBe(SONG_TEXT + 'X');

    // Saved on another device meanwhile.
    currentDrive!.externalUpdate('f1', SONG_TEXT + 'Y', 'iPad');
    await userEvent.type(textarea, 'Z');
    await userEvent.keyboard('{Control>}s{/Control}');
    const dialog = await body.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('radio', { name: /上書きする/ }),
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: '上書きして保存' }),
    );
    await waitFor(() => expect(status).toHaveAttribute('data-state', 'saved'));
    expect(currentDrive!.files()[0].text).toBe(SONG_TEXT + 'XZ');
  },
};

/** Leaving with unsaved changes asks first; the draft stays. */
export const LeaveWithUnsavedChanges: Story = {
  args: { hash: '#/edit/s1' },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const body = within(document.body);
    await c.findByRole('heading', { level: 1, name: 'きらきら星' });
    await userEvent.click(c.getByRole('button', { name: 'テキスト入力' }));
    await userEvent.type(c.getByLabelText('ChordPro テキスト'), '{End}X');
    await userEvent.click(c.getByRole('button', { name: '‹ 曲の一覧' }));
    await expect(
      await body.findByText('保存せずに一覧に戻りますか？'),
    ).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: '保存せずに戻る' }));
    const row = await c.findByTestId('song-row-s1');
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'dirty'));
  },
};

/** Not signed in: device-only songs (incl. the migrated M3–M6 draft). */
export const SignedOutWithLocalSong: Story = {
  args: {
    status: 'signedOut',
    files: [],
    init: { [draftKey('local')]: '{title: 前からある曲}\n{key: G}\n' },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(await c.findByText('前からある曲')).toBeVisible();
    await expect(c.getByTestId('signed-out-note')).toBeVisible();
  },
};

/** No client id: local only, with the 「Drive 未設定」 banner. */
export const Unconfigured: Story = {
  args: {
    status: 'unconfigured',
    files: [],
    init: { [draftKey('local')]: '{title: 前からある曲}\n' },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(await c.findByTestId('connection-banner')).toHaveAttribute(
      'data-kind',
      'unconfigured',
    );
    await userEvent.click(
      c.getByRole('button', { name: '前からある曲を開く' }),
    );
    await expect(
      await c.findByTestId('save-status-unconfigured'),
    ).toBeVisible();
  },
};

/** Touch-only device: the tablet list; a tap opens the viewer. */
export const Tablet: Story = {
  args: { tablet: true },
  decorators: [
    (Story) => (
      <div style={{ width: 1194, height: 834, overflow: 'auto' }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(await c.findByTestId('tablet-song-list')).toBeVisible();
    await userEvent.click(await c.findByTestId('song-row-s1'));
    await expect(
      await c.findByRole('button', { name: '‹ 曲の一覧' }),
    ).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: '‹ 曲の一覧' }));
    await expect(await c.findByTestId('tablet-song-list')).toBeVisible();
  },
};

/**
 * Sign-in expired, a cached song opened (m7-review.md R2): 「前回読み込んだ
 * 版です」 + 「Drive に再接続」, the header says 「未確認」 instead of 保存済み.
 */
export const ExpiredEditorUnconfirmed: Story = {
  args: {
    status: 'expired',
    hash: '#/edit/s1',
    init: {
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
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const notice = await c.findByTestId('stale-notice');
    await expect(notice).toHaveTextContent('前回読み込んだ版です');
    await expect(c.getByTestId('save-status')).toHaveAttribute(
      'data-state',
      'unconfirmed',
    );
    await userEvent.click(
      within(notice).getByRole('button', { name: 'Drive に再接続' }),
    );
    await waitFor(() => expect(c.queryByTestId('stale-notice')).toBeNull());
    await expect(c.getByTestId('save-status')).toHaveAttribute(
      'data-state',
      'saved',
    );
  },
};
