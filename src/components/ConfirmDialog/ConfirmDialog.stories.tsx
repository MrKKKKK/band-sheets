import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { ConfirmDialog } from './ConfirmDialog';

const meta = {
  title: 'Dialog/ConfirmDialog',
  component: ConfirmDialog,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    open: true,
    onConfirm: fn(),
    onCancel: fn(),
    onSecondary: fn(),
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const dialogOf = (el: HTMLElement) =>
  within(el.ownerDocument.body).findByRole('dialog');

export const Delete: Story = {
  args: {
    title: '「きらきら星」を削除しますか？',
    message:
      'Drive のゴミ箱に移します（30 日以内なら Drive から戻せます）。この端末の下書きも消えます。',
    confirmLabel: '削除する',
    danger: true,
  },
  play: async ({ canvasElement, args }) => {
    const dialog = within(await dialogOf(canvasElement));
    // Safe default: focus starts on cancel.
    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'キャンセル' })).toHaveFocus(),
    );
    await userEvent.click(dialog.getByRole('button', { name: '削除する' }));
    expect(args.onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(dialog.getByRole('button', { name: 'キャンセル' }));
    expect(args.onCancel).toHaveBeenCalledTimes(1);
  },
};

export const BackToList: Story = {
  args: {
    title: '未保存の変更があります',
    message: 'Drive に保存してから一覧に戻りますか？',
    confirmLabel: '保存して戻る',
    secondaryLabel: '保存せずに戻る',
  },
  play: async ({ canvasElement, args }) => {
    const dialog = within(await dialogOf(canvasElement));
    expect(dialog.getAllByRole('button')).toHaveLength(3);
    await userEvent.click(
      dialog.getByRole('button', { name: '保存せずに戻る' }),
    );
    expect(args.onSecondary).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(args.onCancel).toHaveBeenCalledTimes(1);
  },
};
