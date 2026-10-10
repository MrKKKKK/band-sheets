import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { RenameDialog } from './RenameDialog';

const meta = {
  title: 'Dialog/RenameDialog',
  component: RenameDialog,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    open: true,
    initialTitle: 'きらきら星',
    onSubmit: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof RenameDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole('dialog'),
    );
    const input = dialog.getByLabelText('曲名');
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.clear(input);
    expect(dialog.getByRole('button', { name: '変更する' })).toBeDisabled();
    expect(dialog.getByRole('alert')).toHaveTextContent(
      '曲名を入力してください',
    );
    await userEvent.type(input, '  ブルース  ');
    await userEvent.keyboard('{Enter}');
    expect(args.onSubmit).toHaveBeenCalledWith('ブルース');
  },
};

export const Cancel: Story = {
  play: async ({ canvasElement, args }) => {
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole('dialog'),
    );
    await userEvent.click(dialog.getByRole('button', { name: 'キャンセル' }));
    expect(args.onCancel).toHaveBeenCalledTimes(1);
    expect(args.onSubmit).not.toHaveBeenCalled();
  },
};
