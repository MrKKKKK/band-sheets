import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ConflictDialog } from './ConflictDialog';

const NOW = new Date(2026, 9, 6, 16, 0);
const at = (h: number, m: number) => new Date(2026, 9, 6, h, m).toISOString();

const meta = {
  title: 'Dialog/ConflictDialog',
  component: ConflictDialog,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    open: true,
    songTitle: 'きらきら星',
    drive: { modifiedTime: at(15, 8), device: 'iPad' },
    local: {
      editedAt: at(15, 12),
      device: 'PC',
      baseModifiedTime: at(14, 32),
    },
    changedLines: 12,
    onChoose: fn(),
    onCancel: fn(),
    now: NOW,
  },
} satisfies Meta<typeof ConflictDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const open = async (el: HTMLElement) =>
  within(await within(el.ownerDocument.body).findByRole('dialog'));

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const d = await open(canvasElement);
    expect(d.getByText('今日 15:08 ・ iPad')).toBeVisible();
    expect(d.getByText('今日 15:12 まで編集 ・ PC')).toBeVisible();
    expect(d.getByText('変更の目安: 12 行が違います')).toBeVisible();
    expect(d.getAllByRole('radio')).toHaveLength(3);
    expect(
      d.getByRole('radio', { name: /手元の変更は別の曲として残す/ }),
    ).toBeChecked();
    expect(d.getByRole('button', { name: '読み直す' })).toBeVisible();
  },
};

export const ChooseOverwrite: Story = {
  play: async ({ canvasElement, args }) => {
    const d = await open(canvasElement);
    await userEvent.click(d.getByRole('radio', { name: /^上書きする/ }));
    await userEvent.click(d.getByRole('button', { name: '上書きして保存' }));
    expect(args.onChoose).toHaveBeenCalledWith('overwrite');
  },
};

export const ChooseDiscard: Story = {
  play: async ({ canvasElement, args }) => {
    const d = await open(canvasElement);
    await userEvent.click(d.getByRole('radio', { name: /捨てる/ }));
    await userEvent.click(d.getByRole('button', { name: '読み直して破棄' }));
    expect(args.onChoose).toHaveBeenCalledWith('reloadDiscard');
  },
};

export const KeepCopyDefaultAndCancel: Story = {
  play: async ({ canvasElement, args }) => {
    const d = await open(canvasElement);
    await userEvent.click(d.getByRole('button', { name: '読み直す' }));
    expect(args.onChoose).toHaveBeenCalledWith('reloadKeepCopy');
    await userEvent.click(d.getByRole('button', { name: 'キャンセル' }));
    expect(args.onCancel).toHaveBeenCalledTimes(1);
  },
};

export const WithoutLineCount: Story = {
  args: { changedLines: undefined },
  play: async ({ canvasElement }) => {
    const d = await open(canvasElement);
    expect(d.queryByText(/変更の目安/)).toBeNull();
  },
};

/** R5: while a choice runs, cancel and Esc do nothing. R2: wording. */
export const BusyCannotCancel: Story = {
  args: { busy: true },
  play: async ({ canvasElement, args }) => {
    const d = await open(canvasElement);
    expect(d.getByRole('button', { name: 'キャンセル' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(args.onCancel).not.toHaveBeenCalled();
    expect(
      d.getByText(/この画面の版のもとにした Drive の版のあとに/),
    ).toBeVisible();
    expect(d.queryByText(/このページを開いたあと/)).toBeNull();
  },
};
