import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { SongEntry, SongStatus } from '../../lib/syncTypes';
import { SongList } from './SongList';

const NOW = new Date(2026, 9, 6, 15, 0);
const at = (m: number, d: number, h: number, min: number) =>
  new Date(2026, m - 1, d, h, min).toISOString();

const songs: SongEntry[] = [
  {
    songId: 's1',
    fileId: 'f1',
    title: 'きらきら星',
    summary: 'C ・ ♩=100 ・ 4/4',
    parts: 'コード譜・メロディ・ドラム',
    modifiedTime: at(10, 6, 14, 32),
    device: 'PC（自宅）',
  },
  {
    songId: 's2',
    fileId: 'f2',
    title: '週末ブルース',
    summary: 'A ・ ♩=92 ・ 12/8',
    parts: 'コード譜・ドラム',
    modifiedTime: at(10, 5, 21, 5),
    device: 'iPad',
  },
  {
    songId: 's3',
    fileId: 'f3',
    title: '新曲デモ A',
    summary: 'Em ・ ♩=128 ・ 4/4',
    parts: 'コード譜',
    modifiedTime: at(10, 3, 18, 20),
    device: 'PC（自宅）',
  },
  {
    songId: 's4',
    fileId: 'f4',
    title: 'シャッフル練習',
    summary: 'G ・ ♩=110 ・ 4/4',
    parts: 'ドラム',
    modifiedTime: at(9, 28, 10, 12),
    device: 'PC（自宅）',
  },
  {
    songId: 's5',
    fileId: 'f5',
    title: 'ライブ用 アレンジ',
    summary: 'D ・ ♩=96 ・ 3/4',
    parts: 'コード譜・メロディ',
    modifiedTime: at(9, 20, 23, 40),
    device: 'iPad',
  },
];
const statuses: Record<string, SongStatus> = {
  s1: 'dirty',
  s2: 'synced',
  s3: 'driveNewer',
  s4: 'synced',
  s5: 'synced',
};

const localSongs: SongEntry[] = [
  {
    songId: 'l1',
    title: '無題の曲',
    summary: 'C ・ ♩=100 ・ 4/4',
    parts: 'コード譜',
    modifiedTime: at(10, 6, 13, 0),
  },
  {
    songId: 'l2',
    title: '練習メモ',
    summary: '',
    parts: '',
    modifiedTime: at(10, 4, 9, 0),
  },
];

const meta = {
  title: 'Sync/SongList',
  component: SongList,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    songs,
    statuses,
    signedIn: true,
    accountName: 'Mr K5',
    now: NOW,
    onSignIn: fn(),
    onSignOut: fn(),
    onRefresh: fn(),
    onNew: fn(),
    onAddSample: fn(),
    onOpen: fn(),
    onOpenView: fn(),
    onRename: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
  },
} satisfies Meta<typeof SongList>;

export default meta;
type Story = StoryObj<typeof meta>;

const titles = (c: ReturnType<typeof within>) =>
  c
    .getAllByRole('row')
    .slice(1)
    .map(
      (r: HTMLElement) =>
        within(r).getAllByRole('cell')[0].querySelector('div')!.textContent,
    );

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('マイドライブ / band-sheets')).toBeVisible();
    expect(c.getByTestId('song-count')).toHaveTextContent(
      '5 曲 ・ 2 曲は未保存の変更あり',
    );
    // newest first by default
    expect(titles(c)).toEqual([
      'きらきら星',
      '週末ブルース',
      '新曲デモ A',
      'シャッフル練習',
      'ライブ用 アレンジ',
    ]);
    const row = within(c.getByTestId('song-row-s1'));
    expect(row.getByText('今日 14:32')).toBeVisible();
    expect(row.getByText('未保存の変更あり')).toBeVisible();
    expect(
      within(c.getByTestId('song-row-s2')).getByText('同期済み'),
    ).toBeVisible();
    expect(
      within(c.getByTestId('song-row-s3')).getByText('Drive が新しい'),
    ).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'きらきら星を開く' }));
    expect(args.onOpen).toHaveBeenCalledWith('s1');
    await userEvent.click(
      c.getByRole('button', { name: '週末ブルースを閲覧で開く' }),
    );
    expect(args.onOpenView).toHaveBeenCalledWith('s2');
    await userEvent.click(c.getByRole('button', { name: '新しい曲' }));
    expect(args.onNew).toHaveBeenCalledTimes(1);
    await userEvent.click(c.getByRole('button', { name: 'サンプル曲を追加' }));
    expect(args.onAddSample).toHaveBeenCalledTimes(1);
    await userEvent.click(c.getByRole('button', { name: '最新の状態に更新' }));
    expect(args.onRefresh).toHaveBeenCalledTimes(1);
  },
};

export const Empty: Story = {
  args: { songs: [], statuses: {} },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('まだ曲がありません')).toBeVisible();
    expect(c.getByTestId('song-count')).toHaveTextContent('0 曲');
    expect(c.queryByRole('table')).not.toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: '新しい曲を作る' }));
    expect(args.onNew).toHaveBeenCalledTimes(1);
    // The sample button stays in the toolbar of an empty list.
    await userEvent.click(c.getByRole('button', { name: 'サンプル曲を追加' }));
    expect(args.onAddSample).toHaveBeenCalledTimes(1);
  },
};

/** Without `onAddSample` the button is not shown. */
export const NoSampleButton: Story = {
  args: { onAddSample: undefined },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(
      c.queryByRole('button', { name: 'サンプル曲を追加' }),
    ).not.toBeInTheDocument();
  },
};

export const Offline: Story = {
  args: {
    connection: {
      kind: 'offline',
      listedAt: at(10, 6, 14, 40),
      onRetry: fn(),
    },
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const banner = c.getByTestId('connection-banner');
    expect(banner).toHaveAttribute('data-kind', 'offline');
    // banner sits between the top bar and the list
    const header = canvasElement.querySelector('header')!;
    const main = canvasElement.querySelector('main')!;
    expect(
      header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(c.getAllByRole('row')).toHaveLength(6);
    await userEvent.click(c.getByRole('button', { name: 'もう一度つなぐ' }));
    expect(args.connection?.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const SignedOutWithLocalSongs: Story = {
  args: {
    signedIn: false,
    songs: localSongs,
    statuses: { l1: 'localOnly', l2: 'localOnly' },
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('この端末の曲')).toBeVisible();
    expect(c.getByTestId('signed-out-note')).toBeVisible();
    expect(c.queryByRole('button', { name: '最新の状態に更新' })).toBeNull();
    expect(c.getAllByText('この端末だけ')).toHaveLength(2);
    expect(c.getByTestId('song-row-l1')).toHaveAttribute(
      'data-status',
      'localOnly',
    );
    await userEvent.click(c.getByRole('button', { name: 'ログイン' }));
    expect(args.onSignIn).toHaveBeenCalledTimes(1);
  },
};

export const SignedOutEmpty: Story = {
  args: { signedIn: false, songs: [], statuses: {} },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText(/この端末に保存されます/)).toBeVisible();
  },
};

export const MenuDuplicate: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(
      c.getByRole('button', { name: 'シャッフル練習のその他の操作' }),
    );
    const menu = within(
      await c.findByRole('dialog', { name: 'シャッフル練習の操作' }),
    );
    await userEvent.click(menu.getByRole('button', { name: '複製する' }));
    expect(args.onDuplicate).toHaveBeenCalledWith('s4');
    await waitFor(() => expect(c.queryByRole('dialog')).toBeNull());
  },
};

export const MenuRename: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(
      c.getByRole('button', { name: '週末ブルースのその他の操作' }),
    );
    await userEvent.click(
      within(await c.findByRole('dialog')).getByRole('button', {
        name: '名前を変える',
      }),
    );
    const body = within(document.body);
    const input = await body.findByLabelText('曲名');
    expect(input).toHaveValue('週末ブルース');
    await userEvent.clear(input);
    await userEvent.type(input, '週末ブルース 改');
    await userEvent.click(body.getByRole('button', { name: '変更する' }));
    expect(args.onRename).toHaveBeenCalledWith('s2', '週末ブルース 改');
  },
};

export const MenuDeleteConfirm: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(
      c.getByRole('button', { name: '新曲デモ Aのその他の操作' }),
    );
    await userEvent.click(
      within(await c.findByRole('dialog')).getByRole('button', {
        name: '削除する…',
      }),
    );
    const body = within(document.body);
    expect(
      await body.findByText('「新曲デモ A」を削除しますか？'),
    ).toBeVisible();
    expect(body.getByText(/Drive のゴミ箱に移します/)).toBeVisible();
    // cancel first: nothing deleted
    await userEvent.click(body.getByRole('button', { name: 'キャンセル' }));
    expect(args.onDelete).not.toHaveBeenCalled();
    await userEvent.click(
      c.getByRole('button', { name: '新曲デモ Aのその他の操作' }),
    );
    await userEvent.click(
      within(await c.findByRole('dialog')).getByRole('button', {
        name: '削除する…',
      }),
    );
    await userEvent.click(
      await body.findByRole('button', { name: '削除する' }),
    );
    expect(args.onDelete).toHaveBeenCalledWith('s3');
  },
};

export const UnsavedSongCannotBeRenamed: Story = {
  args: {
    signedIn: true,
    songs: [...songs, localSongs[0]],
    statuses: { ...statuses, l1: 'localOnly' },
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(
      c.getByRole('button', { name: '無題の曲のその他の操作' }),
    );
    const menu = within(await c.findByRole('dialog'));
    expect(menu.getByRole('button', { name: '名前を変える' })).toBeDisabled();
    expect(menu.getByText(/未保存の曲は名前を変えられません/)).toBeVisible();
    expect(menu.getByRole('button', { name: '複製する' })).toBeEnabled();
    expect(args.onRename).not.toHaveBeenCalled();
    // deleting a local-only song says so
    await userEvent.click(menu.getByRole('button', { name: '削除する…' }));
    expect(
      await within(document.body).findByText(/この端末の曲と下書きを消します/),
    ).toBeVisible();
  },
};

/** dirty / driveNewer songs: rename is off (it would rename the Drive text, not the draft). */
export const DirtySongCannotBeRenamed: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    for (const title of ['きらきら星', '新曲デモ A']) {
      await userEvent.click(
        c.getByRole('button', { name: `${title}のその他の操作` }),
      );
      const menu = within(await c.findByRole('dialog'));
      expect(menu.getByRole('button', { name: '名前を変える' })).toBeDisabled();
      expect(
        menu.getByText(
          /未保存の変更があるときは、編集画面で曲名を変えてください/,
        ),
      ).toBeVisible();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(c.queryByRole('dialog')).toBeNull());
    }
  },
};

/** The caller's `canRename` (library.canRename) decides, not the status chip. */
export const CanRenameFromCaller: Story = {
  args: { canRename: (id: string) => id !== 's2' && id !== 's1' },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      c.getByRole('button', { name: '週末ブルースのその他の操作' }),
    );
    let menu = within(await c.findByRole('dialog'));
    expect(menu.getByRole('button', { name: '名前を変える' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(c.queryByRole('dialog')).toBeNull());
    await userEvent.click(
      c.getByRole('button', { name: 'シャッフル練習のその他の操作' }),
    );
    menu = within(await c.findByRole('dialog'));
    expect(menu.getByRole('button', { name: '名前を変える' })).toBeEnabled();
  },
};

export const SearchAndSort: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const sort = c.getByTestId('sort-toggle');
    expect(sort).toHaveTextContent('並び順: 更新が新しい順');
    await userEvent.click(sort);
    expect(sort).toHaveTextContent('並び順: 曲名順');
    // Intl.Collator('ja'): kana before latin/kanji handled by songIndex
    const sorted = titles(c);
    expect(sorted).toHaveLength(5);
    expect(sorted.indexOf('きらきら星')).toBeLessThan(
      sorted.indexOf('シャッフル練習'),
    );
    await userEvent.click(sort);
    expect(titles(c)[0]).toBe('きらきら星');

    const search = c.getByRole('searchbox', { name: '曲を検索' });
    // katakana query matches hiragana title
    await userEvent.type(search, 'キラキラ');
    expect(titles(c)).toEqual(['きらきら星']);
    expect(c.getByTestId('song-count')).toHaveTextContent(
      '1 曲が見つかりました（全 5 曲）',
    );
    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(c.getByTestId('song-list-no-match')).toBeVisible();
    expect(c.getByText('「zzz」に合う曲がありません')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: '検索をやめる' }));
    expect(c.getAllByRole('row')).toHaveLength(6);
  },
};

export const OrderChangeCallback: Story = {
  args: { onOrderChange: fn() },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByTestId('sort-toggle'));
    expect(args.onOrderChange).toHaveBeenCalledWith('title');
  },
};

export const Unconfigured: Story = {
  args: {
    signedIn: false,
    configured: false,
    songs: localSongs,
    statuses: { l1: 'localOnly', l2: 'localOnly' },
    connection: { kind: 'unconfigured' },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('connection-banner')).toHaveAttribute(
      'data-kind',
      'unconfigured',
    );
    expect(c.getByTestId('account-menu')).toHaveTextContent('Drive 未設定');
  },
};
