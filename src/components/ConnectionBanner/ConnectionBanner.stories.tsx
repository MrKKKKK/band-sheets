import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ConnectionBanner } from './ConnectionBanner';

const meta = {
  title: 'Sync/ConnectionBanner',
  component: ConnectionBanner,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: { kind: 'offline', onRetry: fn() },
} satisfies Meta<typeof ConnectionBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Offline: Story = {
  args: { listedAt: new Date(2026, 9, 6, 14, 40).toISOString() },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('connection-banner')).toHaveAttribute(
      'data-kind',
      'offline',
    );
    expect(c.getByText('Drive につながりません。')).toBeVisible();
    expect(
      c.getByText(/前回読み込んだ一覧（10\/6 14:40 時点）を表示しています/),
    ).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'もう一度つなぐ' }));
    expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const OfflineWithoutList: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.queryByText(/前回読み込んだ一覧/)).not.toBeInTheDocument();
    expect(c.getByText(/保存はつながってからになります/)).toBeVisible();
  },
};

export const Retrying: Story = {
  args: { retrying: true },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByRole('button', { name: '接続中…' }),
    ).toBeDisabled();
  },
};

export const Reconnect: Story = {
  args: { kind: 'reconnect' },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('Drive への接続の期限が切れました。')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'Drive に再接続' }));
    expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const Unconfigured: Story = {
  args: { kind: 'unconfigured', onRetry: undefined },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText('Drive は設定されていません。')).toBeVisible();
    expect(c.queryByRole('button')).not.toBeInTheDocument();
  },
};
