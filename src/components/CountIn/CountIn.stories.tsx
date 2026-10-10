import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CountIn } from './CountIn';

const meta = {
  title: 'Viewer/CountIn',
  component: CountIn,
  parameters: { a11y: { test: 'error' } },
  decorators: [
    (Story) => (
      <div style={{ position: 'relative', height: 300 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CountIn>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Beat3: Story = {
  args: { beat: 3 },
  play: async ({ canvasElement }) => {
    const overlay = within(canvasElement).getByTestId('count-in');
    await expect(overlay).toHaveAttribute('aria-hidden', 'true');
    await expect(overlay).toHaveTextContent('3');
    await expect(overlay.querySelector('[aria-live]')).toBeNull();
    await expect(overlay.hasAttribute('aria-live')).toBe(false);
  },
};

export const SixEight: Story = {
  args: { beat: 6 },
};

export const Hidden: Story = {
  args: { beat: null },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByTestId('count-in'),
    ).not.toBeInTheDocument();
  },
};
