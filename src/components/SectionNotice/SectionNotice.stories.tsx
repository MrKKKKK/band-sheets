import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SectionNotice } from './SectionNotice';

const meta = {
  title: 'Melody/SectionNotice',
  component: SectionNotice,
  parameters: { a11y: { test: 'error' }, layout: 'padded' },
} satisfies Meta<typeof SectionNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Read-only, no onRequestTextEdit: plain instruction text. */
export const ReadOnlyPlain: Story = {
  args: {
    id: 'notice',
    status: 'readonly',
    reason: '連符が入っています',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(/このセクションはアプリでは編集できません（理由: /),
    ).toHaveTextContent('理由: 連符が入っています');
    expect(canvas.getByText(/テキスト入力で編集してください/)).toBeVisible();
    expect(
      canvas.queryByRole('button', { name: 'テキスト入力で編集する' }),
    ).not.toBeInTheDocument();
  },
};

/** Read-only with onRequestTextEdit: a button instead of plain text. */
const onRequestTextEdit = fn();
export const ReadOnlyWithButton: Story = {
  args: {
    id: 'notice',
    status: 'readonly',
    reason: 'セクション（\\section）がありません',
    onRequestTextEdit,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', {
      name: 'テキスト入力で編集する',
    });
    await userEvent.click(button);
    expect(onRequestTextEdit).toHaveBeenCalledOnce();
  },
};

/** Bar mismatch: confirm/cancel popover, onReflow only on confirm. */
const onReflow = fn();
export const BarMismatch: Story = {
  args: {
    id: 'notice',
    status: 'barMismatch',
    reason: '拍子が 4/4 から 3/4 になりました',
    timeSigLabel: '3/4',
    onReflow,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(/拍子が変わったため小節が合いません（.+）/),
    ).toBeInTheDocument();
    const open = canvas.getByRole('button', {
      name: '新しい拍子で小節を引き直す',
    });

    // Cancel first: nothing happens, dialog closes.
    await userEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    let dialog = await canvas.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'このセクションの小節線を 3/4 で引き直します。よろしいですか？',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'キャンセル' }),
    );
    expect(onReflow).not.toHaveBeenCalled();
    expect(canvas.queryByRole('dialog')).toBeNull();
    expect(open).toHaveAttribute('aria-expanded', 'false');

    // Confirm: onReflow fires once, dialog closes.
    await userEvent.click(open);
    dialog = await canvas.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '引き直す' }),
    );
    expect(onReflow).toHaveBeenCalledOnce();
    expect(canvas.queryByRole('dialog')).toBeNull();
  },
};
