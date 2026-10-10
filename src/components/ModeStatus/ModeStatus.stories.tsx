import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ModeStatus, type ModeStatusProps } from './ModeStatus';

/** Holds `selected` like an editor would, so 入力に戻る can be exercised. */
function Demo({
  onClearSelection,
  ...props
}: Omit<ModeStatusProps, 'selected' | 'onClearSelection'> & {
  initialSelected: number | null;
  onClearSelection: () => void;
}) {
  const [selected, setSelected] = useState(props.initialSelected);
  return (
    <ModeStatus
      {...props}
      selected={selected}
      onClearSelection={() => {
        onClearSelection();
        setSelected(null);
      }}
    />
  );
}

const meta = {
  title: 'Melody/ModeStatus',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: {
    readOnly: false,
    unit: '音',
    initialSelected: null,
    onClearSelection: fn(),
  },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Input: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByTestId('mode-status');
    expect(status).toHaveAttribute('data-mode', 'input');
    expect(status).toHaveTextContent('入力中（カーソル位置に音を追加）');
    expect(
      canvas.queryByRole('button', { name: '入力に戻る' }),
    ).not.toBeInTheDocument();
  },
};

export const Selected: Story = {
  args: { initialSelected: 1 },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByTestId('mode-status');
    expect(status).toHaveAttribute('data-mode', 'select');
    expect(status).toHaveTextContent('2 音目を選択中');
    expect(status).toHaveTextContent('Esc または五線の空いた所をクリック');

    await userEvent.click(canvas.getByRole('button', { name: '入力に戻る' }));
    expect(args.onClearSelection).toHaveBeenCalledOnce();
    expect(status).toHaveAttribute('data-mode', 'input');
    expect(
      canvas.queryByRole('button', { name: '入力に戻る' }),
    ).not.toBeInTheDocument();
  },
};

/**
 * Drums say 「拍」 and 「N 番目」 (not 「N 拍目」, which reads as a musical
 * beat; m5-review.md R8) via `unit` / `ordinal`.
 */
export const DrumUnit: Story = {
  args: { initialSelected: 2, unit: '拍', ordinal: '番目' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByTestId('mode-status');
    expect(status).toHaveTextContent('3 番目を選択中');
    expect(status).not.toHaveTextContent('拍目');
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true, initialSelected: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByTestId('mode-status');
    expect(status).toHaveAttribute('data-mode', 'readonly');
    expect(status).toHaveTextContent('読み取り専用');
    expect(
      canvas.queryByRole('button', { name: '入力に戻る' }),
    ).not.toBeInTheDocument();
  },
};
