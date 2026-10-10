import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { TransposeControl } from './TransposeControl';

function Demo(props: {
  initial: number;
  songKey?: string;
  variant?: 'inline' | 'popover';
}) {
  const [t, setT] = useState(props.initial);
  return (
    <div
      style={{ padding: 16, width: props.variant === 'popover' ? 340 : 760 }}
    >
      <TransposeControl
        transpose={t}
        onTransposeChange={setT}
        songKey={props.songKey}
        variant={props.variant}
      />
    </div>
  );
}

const meta = {
  title: 'Viewer/TransposeControl',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: { initial: 0, songKey: 'C' },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Original: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByTestId('transpose-value')).toHaveTextContent('0');
    await expect(
      c.getByRole('button', { name: '原曲キーに戻す' }),
    ).toBeDisabled();
  },
};

export const Down2: Story = {
  args: { initial: -2 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByTestId('transpose-key')).toHaveTextContent(
      'キー C → B♭（−2）',
    );
    await userEvent.click(c.getByRole('button', { name: '原曲キーに戻す' }));
    await expect(c.getByTestId('transpose-value')).toHaveTextContent('0');
  },
};

export const Up6: Story = {
  args: { initial: 6 },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByTestId('transpose-up'),
    ).toBeDisabled();
  },
};

export const MinorKey: Story = {
  args: { initial: 1, songKey: 'Am' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByTestId('transpose-key'),
    ).toHaveTextContent('キー Am → B♭m（+1）');
  },
};

export const InPopover: Story = {
  args: { initial: -2, variant: 'popover' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('button', {
        name: '原曲キーに戻す（C）',
      }),
    ).toBeEnabled();
  },
};
