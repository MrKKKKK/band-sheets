import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button } from './Button';

const meta = {
  title: 'UI/Button',
  parameters: { a11y: { test: 'error' } },
  component: Button,
  args: { children: '保存', onClick: fn() },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: 'primary' } };
export const Secondary: Story = { args: { variant: 'secondary' } };
export const Ghost: Story = { args: { variant: 'ghost', children: '戻す' } };
export const Danger: Story = { args: { variant: 'danger', children: '削除' } };
export const Disabled: Story = { args: { variant: 'primary', disabled: true } };

export const IconOnly: Story = {
  args: {
    variant: 'ghost',
    'aria-label': 'コードを追加',
    children: (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
  },
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole('button', {
      name: 'コードを追加',
    });
    expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(button);
    expect(args.onClick).toHaveBeenCalledOnce();
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
      <Button variant="primary">保存</Button>
      <Button variant="secondary">キャンセル</Button>
      <Button variant="ghost">戻す</Button>
      <Button variant="danger">削除</Button>
    </div>
  ),
};
