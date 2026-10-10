import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { SongMeta } from '../../lib/song';
import { SongInfoPopover, type SongInfoPopoverProps } from './SongInfoPopover';

/** Stateful wrapper so the trigger reflects applied changes. */
function Demo({ meta: initial, onChange }: SongInfoPopoverProps) {
  const [meta, setMeta] = useState<SongMeta>(initial);
  return (
    <div style={{ padding: 'var(--space-4)', minHeight: 560 }}>
      <SongInfoPopover
        meta={meta}
        onChange={(m) => {
          onChange(m);
          setMeta(m);
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Editor/SongInfoPopover',
  parameters: { a11y: { test: 'error' } },
  component: SongInfoPopover,
  render: (args) => <Demo {...args} />,
  args: {
    meta: {
      title: 'きらきら星',
      key: 'C',
      tempo: 100,
      time: '4/4',
      palette: ['C7(9,13)', 'Fmaj7'],
    },
    onChange: fn(),
  },
} satisfies Meta<typeof SongInfoPopover>;

export default meta;
type Story = StoryObj<typeof meta>;

const TRIGGER = 'キー C · ♩=100 · 4/4';

export const Closed: Story = {};

export const Empty: Story = {
  args: { meta: { title: '' } },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByRole('button', { name: '曲情報を設定' }),
    ).toBeVisible();
  },
};

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: TRIGGER });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(trigger);
    const dialog = await canvas.findByRole('dialog', { name: '曲情報' });
    const d = within(dialog);
    await waitFor(() => expect(d.getByLabelText('曲名')).toHaveFocus());
    expect(d.getByLabelText('キー')).toHaveValue('C');
    expect(d.getByLabelText('テンポ')).toHaveValue('100');
    expect(d.getByLabelText('拍子')).toHaveValue('4/4');
  },
};

export const EditTempoAndApply: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: TRIGGER }));
    const dialog = within(await canvas.findByRole('dialog'));
    const tempo = dialog.getByLabelText('テンポ');
    await userEvent.clear(tempo);
    await userEvent.type(tempo, '120');
    const key = dialog.getByLabelText('キー');
    await userEvent.clear(key);
    await userEvent.click(dialog.getByRole('button', { name: '適用' }));
    expect(args.onChange).toHaveBeenCalledOnce();
    expect(args.onChange).toHaveBeenCalledWith({
      title: 'きらきら星',
      tempo: 120,
      time: '4/4',
      palette: ['C7(9,13)', 'Fmaj7'],
    });
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    const trigger = canvas.getByRole('button', { name: '♩=120 · 4/4' });
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const InvalidKeyShowsError: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: TRIGGER }));
    const dialog = within(await canvas.findByRole('dialog'));
    const key = dialog.getByLabelText('キー');
    await userEvent.clear(key);
    await userEvent.type(key, 'H');
    await userEvent.type(dialog.getByLabelText('テンポ'), '{Enter}');
    expect(args.onChange).not.toHaveBeenCalled();
    expect(key).toHaveAttribute('aria-invalid', 'true');
    expect(key).toHaveAccessibleDescription(/キーは C、F#m、Bb/);
    await waitFor(() => expect(key).toHaveFocus());
    expect(canvas.getByRole('dialog')).toBeVisible();
  },
};

export const EscCancels: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: TRIGGER });
    await userEvent.click(trigger);
    const dialog = within(await canvas.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText('テンポ'), '5');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    expect(args.onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
    // Reopening starts from the committed values, not the discarded draft.
    await userEvent.click(trigger);
    const again = within(await canvas.findByRole('dialog'));
    expect(again.getByLabelText('テンポ')).toHaveValue('100');
    await userEvent.click(again.getByRole('button', { name: 'キャンセル' }));
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    expect(args.onChange).not.toHaveBeenCalled();
  },
};
