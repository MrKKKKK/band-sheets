import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { CHORD_STEPS } from '../../lib/import/importProgress';
import { ImportProgress } from './ImportProgress';

const meta = {
  title: 'Import/ImportProgress',
  component: ImportProgress,
  parameters: { a11y: { test: 'error' } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 760, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    fileName: 'my-demo-take3.wav',
    duration: 222,
    progress: null,
    onCancel: fn(),
    steps: CHORD_STEPS,
  },
} satisfies Meta<typeof ImportProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

const states = (c: ReturnType<typeof within>) =>
  c
    .getAllByRole('listitem')
    .map((li: HTMLElement) => li.getAttribute('data-state'));

export const Starting: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('import-step-count')).toHaveTextContent('1 / 6 段階');
    expect(c.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(states(c)).toEqual(['now', 'wait', 'wait', 'wait', 'wait', 'wait']);
  },
};

export const ChordsStep: Story = {
  args: { progress: { done: 6, total: 13 } },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('import-step-count')).toHaveTextContent('4 / 6 段階');
    expect(states(c)).toEqual(['done', 'done', 'done', 'now', 'wait', 'wait']);
    expect(c.getByText('my-demo-take3.wav ・ 3:42')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: '中止' }));
    expect(args.onCancel).toHaveBeenCalledTimes(1);
  },
};
