import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { createFakeAnalysisClient } from '../analysis/fakeAnalysisClient';
import { reviewSampleResult } from '../lib/import/fixtures/chordResults';
import { IMPORT_ERROR_MESSAGES } from '../lib/import/importErrors';
import { ImportScreen } from './ImportScreen';

/** The whole S1 → S3 flow with the FAKE analysis client (no Worker, no decoding). */
const meta = {
  title: 'Import/ImportScreen',
  component: ImportScreen,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    onBackToList: fn(),
    onCreate: fn(),
    probe: () => Promise.resolve(222),
    now: () => new Date(2026, 9, 24),
  },
} satisfies Meta<typeof ImportScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const file = () =>
  new File(['fake'], 'my-demo-take3.wav', { type: 'audio/wav' });

async function pickAndStart(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  await userEvent.upload(c.getByTestId('audio-file-input'), file());
  await c.findByTestId('picked-file');
  await userEvent.click(c.getByRole('button', { name: '解析を始める' }));
}

export const Idle: Story = {
  args: { client: createFakeAnalysisClient() },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(
      c.getByRole('heading', { level: 1, name: '録音から新しい曲' }),
    ).toHaveFocus();
  },
};

export const Analyzing: Story = {
  args: { client: createFakeAnalysisClient({ holdAfterStages: 6 }) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await pickAndStart(canvasElement);
    await waitFor(() =>
      expect(c.getByTestId('import-step-count')).toHaveTextContent(
        '4 / 6 段階',
      ),
    );
    expect(c.getByTestId('import-live')).toHaveTextContent(
      '4 / 6 段階: コードを調べる',
    );
  },
};

export const CancelThenNotice: Story = {
  args: { client: createFakeAnalysisClient({ holdAfterStages: 3 }) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await pickAndStart(canvasElement);
    await userEvent.click(await c.findByRole('button', { name: '中止' }));
    const n = await c.findByTestId('import-notice');
    expect(n).toHaveAttribute('data-severity', 'notice');
    await waitFor(() => expect(n).toHaveFocus());
  },
};

export const AnalyzerError: Story = {
  args: {
    client: createFakeAnalysisClient({ error: 'silent', failAfterStages: 5 }),
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await pickAndStart(canvasElement);
    expect(await c.findByTestId('import-notice')).toHaveTextContent(
      IMPORT_ERROR_MESSAGES.silent,
    );
  },
};

export const ToReview: Story = {
  args: {
    client: createFakeAnalysisClient({
      results: { chords: reviewSampleResult() },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await pickAndStart(canvasElement);
    const h1 = await c.findByRole('heading', {
      level: 1,
      name: 'コード譜の下書きを確かめる',
    });
    await waitFor(() => expect(h1).toHaveFocus());
    await userEvent.click(
      c.getByRole('button', { name: 'この内容で曲を作る' }),
    );
    expect(args.onCreate).toHaveBeenCalledWith(
      expect.stringContaining('{title: my-demo-take3（下書き）}'),
    );
  },
};
