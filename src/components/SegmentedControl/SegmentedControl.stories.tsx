import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SegmentedControl } from './SegmentedControl';

type Mode = 'easy' | 'text';

function Demo({ onChange }: { onChange: (mode: Mode) => void }) {
  const [value, setValue] = useState<Mode>('easy');
  return (
    <SegmentedControl
      label="入力方法"
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
      options={[
        { value: 'easy', label: 'かんたん入力' },
        { value: 'text', label: 'テキスト入力' },
      ]}
    />
  );
}

const meta = {
  title: 'UI/SegmentedControl',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: { onChange: fn() },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Toggle: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const easy = canvas.getByRole('button', { name: 'かんたん入力' });
    const text = canvas.getByRole('button', { name: 'テキスト入力' });
    await expect(easy).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(easy);
    await expect(args.onChange).not.toHaveBeenCalled();
    await userEvent.click(text);
    await expect(args.onChange).toHaveBeenCalledOnce();
    await expect(args.onChange).toHaveBeenCalledWith('text');
    await expect(text).toHaveAttribute('aria-pressed', 'true');
    await expect(easy).toHaveAttribute('aria-pressed', 'false');
  },
};
