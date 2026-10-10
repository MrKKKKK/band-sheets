import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SignInScreen } from './SignInScreen';

const onSignIn = fn();
const onStartWithoutSignIn = fn();
const onAddSample = fn();

const meta = {
  title: 'Sync/SignInScreen',
  component: SignInScreen,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    configured: true,
    onSignIn,
    onStartWithoutSignIn,
    onAddSample,
  },
  beforeEach: () => {
    onSignIn.mockClear();
    onStartWithoutSignIn.mockClear();
    onAddSample.mockClear();
  },
} satisfies Meta<typeof SignInScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      canvas.getByRole('heading', {
        level: 2,
        name: 'Google ドライブに保存する（任意）',
      }),
    ).toBeVisible();
    // The scope explanation is collapsed until opened.
    expect(
      canvas.getByText(/サードパーティのアプリとサービス/),
    ).not.toBeVisible();
    await userEvent.click(canvas.getByText('このアプリがさわれるもの'));
    expect(canvas.getByText(/サードパーティのアプリとサービス/)).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Google でログイン' }),
    );
    expect(onSignIn).toHaveBeenCalledOnce();
    await userEvent.click(
      canvas.getByRole('button', { name: '新しい曲を作る →' }),
    );
    expect(onStartWithoutSignIn).toHaveBeenCalledOnce();
    await userEvent.click(
      canvas.getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' }),
    );
    expect(onAddSample).toHaveBeenCalledOnce();
    expect(canvas.queryByRole('status')).not.toBeInTheDocument();
  },
};

/** Popup open: button disabled with a waiting label, guidance shown. */
export const SigningIn: Story = {
  args: { signingIn: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', {
      name: 'Google の画面を開いています…',
    });
    expect(button).toBeDisabled();
    expect(canvas.getByRole('status')).toHaveTextContent(
      'ポップアップが出ないときは、ブロックを解除してください',
    );
    // Starting without signing in stays available while waiting.
    await userEvent.click(
      canvas.getByRole('button', { name: '新しい曲を作る →' }),
    );
    expect(onStartWithoutSignIn).toHaveBeenCalledOnce();
  },
};

export const SignInFailed: Story = {
  args: {
    error: 'Google に接続できません。通信を確認してもう一度試してください。',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('alert')).toHaveTextContent(
      'Google に接続できません',
    );
    expect(
      canvas.getByRole('button', { name: 'Google でログイン' }),
    ).toBeEnabled();
  },
};

/** No client ID: no sign-in button, local-only notice. */
export const NotConfigured: Story = {
  args: { configured: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.queryByRole('button', { name: /Google/ }),
    ).not.toBeInTheDocument();
    expect(canvas.getByRole('status')).toHaveTextContent(
      'Drive は設定されていません',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: '新しい曲を作る →' }),
    );
    expect(onStartWithoutSignIn).toHaveBeenCalledOnce();
  },
};

/** Without `onAddSample` the primary button starts a new song. */
export const NoSampleButton: Story = {
  args: { onAddSample: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.queryByRole('button', { name: /サンプル曲/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: '新しい曲を作る' }),
    );
    expect(onStartWithoutSignIn).toHaveBeenCalledOnce();
  },
};

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
