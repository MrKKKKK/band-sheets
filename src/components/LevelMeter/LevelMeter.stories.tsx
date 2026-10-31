import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { LevelMeter } from './LevelMeter';

const meta = {
  title: 'Mic/LevelMeter',
  component: LevelMeter,
  parameters: { a11y: { test: 'error' } },
  args: { label: '音の大きさ', level: 0.3 },
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', width: 480 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LevelMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Quiet: Story = {
  args: { level: 0 },
  play: ({ canvasElement }) => {
    const m = within(canvasElement).getByRole('meter', { name: '音の大きさ' });
    expect(m).toHaveAttribute('aria-valuenow', '0');
  },
};

export const Speaking: Story = {
  args: { level: 0.3 },
  play: ({ canvasElement }) => {
    const m = within(canvasElement).getByRole('meter', { name: '音の大きさ' });
    expect(m).toHaveAttribute('aria-valuenow', '55');
  },
};

export const Full: Story = { args: { level: 1 } };
