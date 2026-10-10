import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AccountMenu } from './AccountMenu';

const meta = {
  title: 'Sync/AccountMenu',
  component: AccountMenu,
  parameters: { a11y: { test: 'error' } },
  args: { signedIn: false, onSignIn: fn(), onSignOut: fn() },
  render: (args) => (
    <div
      style={{
        padding: 'var(--space-4)',
        minHeight: 220,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <AccountMenu {...args} />
    </div>
  ),
} satisfies Meta<typeof AccountMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'ログイン' }));
    expect(args.onSignIn).toHaveBeenCalledTimes(1);
  },
};

export const SigningIn: Story = {
  args: { busy: true },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByRole('button', { name: 'ログイン中…' }),
    ).toBeDisabled();
  },
};

export const Unconfigured: Story = {
  args: { configured: false },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText('Drive 未設定')).toBeVisible();
    expect(c.queryByRole('button')).not.toBeInTheDocument();
  },
};

export const SignedIn: Story = {
  args: { signedIn: true, accountName: 'Mika' },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const trigger = c.getByRole('button', { name: /ログイン中/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(c.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(trigger);
    const menu = await c.findByRole('dialog', { name: 'アカウント' });
    expect(within(menu).getByText('Mika')).toBeVisible();
    expect(
      within(menu).getByText('ログアウトしても、この端末の下書きは残ります。'),
    ).toBeVisible();
    await userEvent.click(
      within(menu).getByRole('button', { name: 'ログアウト' }),
    );
    expect(args.onSignOut).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(c.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  },
};

export const SignedInNoName: Story = {
  args: { signedIn: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: /ログイン中/ }));
    const menu = await c.findByRole('dialog', { name: 'アカウント' });
    expect(
      within(menu).getByRole('button', { name: 'ログアウト' }),
    ).toBeVisible();
  },
};

export const EscapeCloses: Story = {
  args: { signedIn: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: /ログイン中/ }));
    await c.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(c.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  },
};
