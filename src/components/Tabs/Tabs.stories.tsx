import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Tabs } from './Tabs';

type Id = 'a' | 'b' | 'c';

function Demo() {
  const [selected, setSelected] = useState<Id>('a');
  return (
    <Tabs
      label="楽器"
      selected={selected}
      onSelect={setSelected}
      tabs={[
        { id: 'a', label: 'コード譜', content: <p>コード譜の中身</p> },
        { id: 'b', label: 'メロディ', content: <p>メロディの中身</p> },
        { id: 'c', label: 'ドラム', content: <p>ドラムの中身</p> },
      ]}
    />
  );
}

const meta = {
  title: 'UI/Tabs',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const KeyboardNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = canvas.getByRole('tab', { name: 'コード譜' });
    await userEvent.click(first);
    await userEvent.keyboard('{ArrowLeft}');
    const last = canvas.getByRole('tab', { name: 'ドラム' });
    await expect(last).toHaveFocus();
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getByRole('tabpanel')).toHaveTextContent(
      'ドラムの中身',
    );
    await userEvent.keyboard('{End}{ArrowRight}');
    await expect(first).toHaveFocus();
  },
};
