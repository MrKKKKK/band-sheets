import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { DashHelp } from './DashHelp';

const meta = {
  title: 'Chart/DashHelp',
  parameters: { a11y: { test: 'error' } },
  component: DashHelp,
  decorators: [
    (Story) => (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: 'var(--space-4)',
          minHeight: 420,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DashHelp>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: '? 書き方' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(canvas.queryByRole('dialog')).toBeNull();
  },
};

export const OpenAndEscCloses: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: '? 書き方' });
    await userEvent.click(button);
    const dialog = await canvas.findByRole('dialog', {
      name: 'コードだけの行の書き方',
    });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(dialog).toHaveTextContent('八分音符');
    expect(dialog).toHaveTextContent('十六分音符');
    expect(dialog).toHaveTextContent('[N.C.]');
    expect(dialog).toHaveTextContent('半角');
    expect(dialog).toHaveTextContent('[Am?]');
    expect(within(dialog).getByTestId('dash-help-example')).toHaveTextContent(
      '|[C]--------|[C]----[F]----|',
    );
    expect(
      within(dialog).getByRole('button', { name: '閉じる' }),
    ).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  },
};
