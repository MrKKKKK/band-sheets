import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { SongEntry, SortOrder } from '../../lib/syncTypes';
import { TabletSongList, type TabletSongListProps } from './TabletSongList';

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
  },
  {
    songId: 's2',
    fileId: 'f2',
    title: '週末ブルース',
    summary: 'A ・ ♩=92 ・ 12/8',
    parts: 'コード譜・ドラム',
    modifiedTime: at(10, 5, 21, 5),
  },
  {
    songId: 's3',
    fileId: 'f3',
    title: '新曲デモ A',
    summary: 'Em ・ ♩=128 ・ 4/4',
    parts: 'コード譜',
    modifiedTime: at(10, 3, 18, 20),
  },
  {
    songId: 's4',
    fileId: 'f4',
    title: 'シャッフル練習',
    summary: 'G ・ ♩=110 ・ 4/4',
    parts: 'ドラム',
    modifiedTime: at(9, 28, 10, 12),
  },
  {
    songId: 's5',
    fileId: 'f5',
    title: 'ライブ用 アレンジ',
    summary: 'D ・ ♩=96 ・ 3/4',
    parts: 'コード譜・メロディ',
    modifiedTime: at(9, 20, 23, 40),
  },
  {
    songId: 's6',
    fileId: 'f6',
    title: '春の練習曲',
    summary: 'F ・ ♩=84 ・ 4/4',
    parts: 'メロディ',
    modifiedTime: at(9, 12, 19, 3),
  },
];

const cachedIds = new Set(['s1', 's2', 's4', 's6']);

function Stateful(
  props: Omit<
    TabletSongListProps,
    'query' | 'onQueryChange' | 'order' | 'onOrderChange'
  > & { initialOrder?: SortOrder },
) {
  const { initialOrder = 'modified', ...rest } = props;
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<SortOrder>(initialOrder);
  return (
    <TabletSongList
      {...rest}
      query={query}
      onQueryChange={setQuery}
      order={order}
      onOrderChange={setOrder}
    />
  );
}

const meta = {
  title: 'Sync/TabletSongList',
  component: Stateful,
  parameters: { a11y: { test: 'error' }, layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ width: 1194, height: 834, overflow: 'hidden' }}>
        <Story />
      </div>
    ),
  ],
  args: {
    songs,
    cachedIds,
    now: NOW,
    listedAt: at(10, 6, 14, 40),
    onRefresh: fn(),
    onOpenView: fn(),
  },
} satisfies Meta<typeof Stateful>;

export default meta;
type Story = StoryObj<typeof meta>;

const titles = (c: ReturnType<typeof within>) =>
  c
    .getAllByRole('button', { name: /閲覧/ })
    .map((b: HTMLElement) => b.textContent);

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('Drive と同期済み（14:40）')).toBeVisible();
    expect(c.getByText('更新 今日 14:32')).toBeVisible();
    expect(c.getByText('更新 昨日 21:05')).toBeVisible();
    expect(c.getAllByText('この iPad に保存済み')).toHaveLength(4);
    expect(c.getAllByText('Drive から取得します')).toHaveLength(2);
    expect(c.queryByText(/編集に入れ|閲覧画面の「編集」/)).toBeNull();
    expect(c.getByText('曲の編集は PC で行います。')).toBeVisible();
    // 44px touch targets
    for (const b of c.getAllByRole('button')) {
      expect(b.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await userEvent.click(c.getByTestId('song-row-s3'));
    expect(args.onOpenView).toHaveBeenCalledWith('s3');
    await userEvent.click(c.getByRole('button', { name: '更新' }));
    expect(args.onRefresh).toHaveBeenCalledTimes(1);
  },
};

export const Opening: Story = {
  args: { openingId: 's3' },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const row = c.getByTestId('song-row-s3');
    expect(row).toHaveAttribute('data-cache', 'fetching');
    expect(row).toHaveAttribute('aria-busy', 'true');
    expect(within(row).getByText('Drive から読み込み中…')).toBeVisible();
    expect(within(row).getByText('開いています')).toBeVisible();
    // other rows are inert while one is opening
    expect(c.getByTestId('song-row-s1')).toBeDisabled();
    await userEvent.click(c.getByTestId('song-row-s1'));
    expect(args.onOpenView).not.toHaveBeenCalled();
  },
};

export const Search: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(
      c.getByRole('searchbox', { name: '曲名で探す' }),
      'れんしゅう',
    );
    expect(c.queryAllByRole('button', { name: /閲覧/ })).toHaveLength(0);
    expect(c.getByTestId('empty')).toHaveTextContent('見つかりませんでした。');
    await userEvent.clear(c.getByRole('searchbox'));
    // katakana query matches hiragana title
    await userEvent.type(c.getByRole('searchbox'), 'キラキラ');
    expect(c.getAllByRole('button', { name: /閲覧/ })).toHaveLength(1);
    expect(c.getByText('きらきら星')).toBeVisible();
  },
};

export const SortByTitle: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(titles(c)[0]).toContain('きらきら星');
    expect(c.getByRole('button', { name: '更新が新しい順' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(c.getByRole('button', { name: '曲名順' }));
    expect(c.getByRole('button', { name: '曲名順' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const order = c
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span span')?.textContent);
    expect(order).toEqual([
      'きらきら星',
      'シャッフル練習',
      'ライブ用 アレンジ',
      '週末ブルース',
      '春の練習曲',
      '新曲デモ A',
    ]);
  },
};

export const Refreshing: Story = {
  args: { refreshing: true },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByRole('button', { name: '更新中…' }),
    ).toBeDisabled();
  },
};

export const Offline: Story = {
  args: { offline: true },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('connection-banner')).toHaveAttribute(
      'data-kind',
      'offline',
    );
    expect(c.getByTestId('sync-state')).toHaveAttribute(
      'data-state',
      'offline',
    );
    // cached songs open, uncached ones cannot
    await userEvent.click(c.getByTestId('song-row-s1'));
    expect(args.onOpenView).toHaveBeenCalledWith('s1');
    const remote = c.getByTestId('song-row-s3');
    expect(remote).toBeDisabled();
    expect(
      within(remote).getByText('オフラインのため開けません'),
    ).toBeVisible();
  },
};

export const OfflineRetry: Story = {
  args: { offline: true, refreshFailed: true },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('refresh-failed')).toBeVisible();
    const refresh = c.getByRole('button', { name: '更新' });
    expect(refresh).toBeEnabled();
    await userEvent.click(refresh);
    expect(args.onRefresh).toHaveBeenCalledTimes(1);
    await userEvent.click(c.getByRole('button', { name: 'もう一度つなぐ' }));
    expect(args.onRefresh).toHaveBeenCalledTimes(2);
  },
};

export const OfflineRetrying: Story = {
  args: { offline: true, refreshing: true, refreshFailed: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole('button', { name: '更新中…' })).toBeDisabled();
    expect(c.queryByTestId('refresh-failed')).toBeNull();
  },
};

export const Empty: Story = {
  args: { songs: [] },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByTestId('empty')).toHaveTextContent(
      'まだ曲がありません',
    );
  },
};
