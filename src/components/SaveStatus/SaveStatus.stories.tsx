import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SaveStatus } from './SaveStatus';

const at = (h: number, m: number) => new Date(2026, 9, 6, h, m).toISOString();

const meta = {
  title: 'Sync/SaveStatus',
  component: SaveStatus,
  parameters: { a11y: { test: 'error' } },
  args: {
    state: { kind: 'saved', at: at(14, 32) },
    onSave: fn(),
  },
  render: (args) => (
    <div style={{ padding: 'var(--space-4)', display: 'flex' }}>
      <SaveStatus {...args} />
    </div>
  ),
} satisfies Meta<typeof SaveStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    expect(c.getByText('保存済み')).toBeVisible();
    expect(c.getByText('14:32 に Drive へ保存')).toBeVisible();
    expect(c.getByText('Ctrl+S')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: /^保存/ }));
    expect(args.onSave).toHaveBeenCalledTimes(1);
  },
};

export const Unconfirmed: Story = {
  args: { state: { kind: 'unconfirmed', at: at(14, 32) } },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('save-status')).toHaveAttribute(
      'data-state',
      'unconfirmed',
    );
    expect(c.getByText('未確認')).toBeVisible();
    expect(c.queryByText('保存済み')).not.toBeInTheDocument();
    expect(c.getByText('14:32 保存の版（Drive の最新か未確認）')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: /^保存/ }));
    expect(args.onSave).toHaveBeenCalledTimes(1);
  },
};

export const Dirty: Story = {
  args: { state: { kind: 'dirty', draftAt: at(14, 35) } },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('未保存の変更あり')).toBeVisible();
    expect(c.getByText('下書きは自動保存済み（14:35）')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: /^保存/ }));
    expect(args.onSave).toHaveBeenCalledTimes(1);
  },
};

export const Saving: Story = {
  args: { state: { kind: 'saving' } },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('保存中…')).toBeVisible();
    const b = c.getByRole('button', { name: '保存中' });
    expect(b).toBeDisabled();
    expect(c.queryByText('Ctrl+S')).not.toBeInTheDocument();
    await userEvent.click(b);
    expect(args.onSave).not.toHaveBeenCalled();
  },
};

export const FailedNetwork: Story = {
  args: { state: { kind: 'failed', reason: 'network' } },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('保存に失敗')).toBeVisible();
    expect(
      c.getByText('通信できませんでした。下書きは残っています'),
    ).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: /^もう一度保存/ }));
    expect(args.onSave).toHaveBeenCalledTimes(1);
  },
};

export const FailedAuth: Story = {
  args: { state: { kind: 'failed', reason: 'auth' } },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByText(
        'ログインの期限が切れました。下書きは残っています',
      ),
    ).toBeVisible();
  },
};

export const FailedOther: Story = {
  args: { state: { kind: 'failed', reason: 'other' } },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByText(
        '保存できませんでした。下書きは残っています',
      ),
    ).toBeVisible();
  },
};

export const LocalOnlySignedOut: Story = {
  args: {
    state: { kind: 'localOnly', draftAt: at(9, 5) },
    signedIn: false,
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('この端末だけに保存')).toBeVisible();
    expect(c.getByText('下書きは自動保存済み（9:05）')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: /^ログインして保存/ }));
    expect(args.onSave).toHaveBeenCalledTimes(1);
  },
};

export const LocalOnlySignedIn: Story = {
  args: { state: { kind: 'localOnly' }, signedIn: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText('下書きは自動保存済み')).toBeVisible();
    expect(c.getByRole('button', { name: /^保存/ })).toBeVisible();
  },
};

export const MacShortcut: Story = {
  args: { shortcutLabel: '⌘S' },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText('⌘S')).toBeVisible();
    expect(c.queryByText('Ctrl+S')).not.toBeInTheDocument();
  },
};

export const NoShortcut: Story = {
  args: { shortcutLabel: '' },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByRole('button', { name: '保存' }),
    ).toBeVisible();
  },
};
