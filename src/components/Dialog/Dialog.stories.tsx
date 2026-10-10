import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '../Button/Button';
import { Dialog } from './Dialog';

function Demo({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        開く
      </button>
      <Dialog
        open={open}
        title="確認"
        description="説明の文です。"
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        footer={
          <>
            <Button>左</Button>
            <Button variant="primary">右</Button>
          </>
        }
      >
        <input aria-label="入力" />
      </Dialog>
    </div>
  );
}

const meta = {
  title: 'Dialog/Dialog',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: { onClose: fn() },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FocusAndEsc: Story = {
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    const opener = body.getByRole('button', { name: '開く' });
    await userEvent.click(opener);
    const dialog = await body.findByRole('dialog', { name: '確認' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('説明の文です。');
    await waitFor(() =>
      expect(within(dialog).getByLabelText('入力')).toHaveFocus(),
    );
    // Tab cycles: 入力 → 左 → 右 → 入力; Shift+Tab goes back to 右.
    await userEvent.tab();
    await userEvent.tab();
    expect(within(dialog).getByRole('button', { name: '右' })).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByLabelText('入力')).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: '右' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(args.onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(body.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  },
};
