import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { stateOf } from '../MicRecorder/micStoryFixtures';
import { LatencyDialog } from './LatencyDialog';

const meta = {
  title: 'Mic/LatencyDialog',
  component: LatencyDialog,
  parameters: { a11y: { test: 'error' } },
  args: {
    state: stateOf({ phase: 'measuring', heard: 1 }),
    onClose: fn(),
    onMeasure: fn(),
  },
} satisfies Meta<typeof LatencyDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const dialog = (el: HTMLElement) =>
  within(el.ownerDocument.body).findByRole('dialog');

export const Measuring: Story = {
  play: async ({ canvasElement, args }) => {
    const d = within(await dialog(canvasElement));
    expect(d.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(d.getByRole('button', { name: '中止' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(args.onClose).toHaveBeenCalled();
  },
};

export const Measured: Story = {
  args: {
    state: stateOf({ phase: 'measured', spreadMs: 3 }, { remainderMs: 48 }),
  },
  play: async ({ canvasElement }) => {
    const d = within(await dialog(canvasElement));
    expect(d.getByRole('button', { name: '閉じる' })).toHaveFocus();
    expect(d.getByText('48 ms')).toBeVisible();
  },
};

export const Failed: Story = {
  args: { state: stateOf({ phase: 'measureFailed' }) },
  play: async ({ canvasElement }) => {
    const d = within(await dialog(canvasElement));
    expect(d.getByRole('button', { name: 'もう一度測る' })).toHaveFocus();
  },
};

export const ClosedInOtherPhases: Story = {
  args: { state: stateOf({ phase: 'ready', notice: null }) },
  play: ({ canvasElement }) => {
    expect(
      within(canvasElement.ownerDocument.body).queryByRole('dialog'),
    ).toBeNull();
  },
};
