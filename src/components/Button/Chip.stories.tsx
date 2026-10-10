import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Chip } from './Chip';

const meta = {
  title: 'UI/Chip',
  parameters: { a11y: { test: 'error' } },
  component: Chip,
  args: { children: 'Am7' },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {};
export const Selected: Story = { args: { selected: true } };

function ToggleDemo() {
  const chords = ['C', 'Dm', 'Em', 'F', 'G7', 'Am', 'Bm7(b5)'];
  const [sel, setSel] = useState<string | null>(null);
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      {chords.map((c) => (
        <Chip
          key={c}
          selected={sel === c}
          onClick={() => setSel((s) => (s === c ? null : c))}
        >
          {c}
        </Chip>
      ))}
    </div>
  );
}

export const Toggle: Story = {
  render: () => <ToggleDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const am = canvas.getByRole('button', { name: 'Am' });
    expect(am).toHaveAttribute('aria-pressed', 'false');
    expect(am.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(am);
    expect(am).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'F' }));
    expect(am).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(canvas.getByRole('button', { name: 'F' }));
    expect(canvas.getByRole('button', { name: 'F' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  },
};
