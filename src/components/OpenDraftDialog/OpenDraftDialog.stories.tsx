import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { OpenDraftDialog } from './OpenDraftDialog';

const at = (h: number, m: number) => new Date(2026, 9, 6, h, m).toISOString();

const meta = {
  title: 'Dialog/OpenDraftDialog',
  component: OpenDraftDialog,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    open: true,
    kind: 'draftNewer',
    songTitle: 'きらきら星',
    draft: { savedAt: at(15, 12), device: 'この PC' },
    drive: { modifiedTime: at(14, 32) },
    onChoose: fn(),
    onCancel: fn(),
    now: new Date(2026, 9, 6, 16, 0),
  },
} satisfies Meta<typeof OpenDraftDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const open = async (el: HTMLElement) =>
  within(await within(el.ownerDocument.body).findByRole('dialog'));

export const DraftNewer: Story = {
  play: async ({ canvasElement, args }) => {
    const d = await open(canvasElement);
    expect(
      within(canvasElement.ownerDocument.body).getByRole('dialog', {
        name: '保存していない下書きが残っています',
      }),
    ).toBeVisible();
    expect(
      d.getByText(
        /下書き（今日 15:12・この PC）は、Drive の版（今日 14:32）より新しい/,
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(d.getByRole('button', { name: '下書きから続ける' })).toHaveFocus(),
    );
    await userEvent.click(d.getByRole('button', { name: '下書きから続ける' }));
    expect(args.onChoose).toHaveBeenCalledWith('resumeDraft');
    await userEvent.click(
      d.getByRole('button', { name: 'Drive の版を開く（下書きは破棄）' }),
    );
    expect(args.onChoose).toHaveBeenLastCalledWith('openDrive');
  },
};

export const DriveNewer: Story = {
  args: {
    kind: 'driveNewer',
    draft: { savedAt: at(14, 40), device: 'この PC' },
    drive: { modifiedTime: at(15, 8), device: 'iPad' },
  },
  play: async ({ canvasElement, args }) => {
    const d = await open(canvasElement);
    expect(
      within(canvasElement.ownerDocument.body).getByRole('dialog', {
        name: 'Drive の版が新しくなっています',
      }),
    ).toBeVisible();
    // R1: nothing is lost by default — Enter keeps the draft as a copy.
    const keep = d.getByRole('button', { name: '下書きも別の曲として残す' });
    await waitFor(() => expect(keep).toHaveFocus());
    expect(d.getByText(/この端末の下書きは消えます/)).toBeVisible();
    await userEvent.click(keep);
    expect(args.onChoose).toHaveBeenCalledWith('keepDraftCopy');
    await userEvent.click(
      d.getByRole('button', { name: 'Drive の版を開く（下書きは破棄）' }),
    );
    expect(args.onChoose).toHaveBeenLastCalledWith('openDrive');
    await userEvent.keyboard('{Escape}');
    expect(args.onCancel).toHaveBeenCalledTimes(1);
  },
};

export const BusyCannotCancel: Story = {
  args: { kind: 'driveNewer', busy: true },
  play: async ({ canvasElement, args }) => {
    const d = await open(canvasElement);
    expect(d.getByRole('button', { name: 'キャンセル' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(args.onCancel).not.toHaveBeenCalled();
  },
};
