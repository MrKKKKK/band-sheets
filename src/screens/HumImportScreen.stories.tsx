import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { createFakeAnalysisClient } from '../analysis/fakeAnalysisClient';
import { sampleSong } from '../lib/fixtures/sampleSong';
import { humSampleResult } from '../lib/import/fixtures/humResults';
import { IMPORT_ERROR_MESSAGES } from '../lib/import/importErrors';
import { createMemoryStorage } from '../lib/storage';
import { HumImportScreen } from './HumImportScreen';

/** The whole S2 → S4 flow with the FAKE analysis client (no Worker, no decoding). */
const meta = {
  title: 'Import/HumImportScreen',
  component: HumImportScreen,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    song: sampleSong,
    partIndex: sampleSong.parts.findIndex((p) => p.name === 'Vocal'),
    initialLabel: 'A',
    ts: { num: 4, den: 4 },
    keySig: 'C',
    storage: createMemoryStorage(),
    onInsert: fn(),
    onBack: fn(),
    probe: () => Promise.resolve(12),
    playbackDeps: {
      createTone: () => ({
        start: fn(() => 0),
        stop: fn(),
        playOne: fn(),
        close: fn(),
        now: () => 0,
      }),
    },
  },
} satisfies Meta<typeof HumImportScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

async function pickAndStart(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  await userEvent.upload(
    c.getByTestId('audio-file-input'),
    new File(['fake'], 'hum.wav', { type: 'audio/wav' }),
  );
  await c.findByTestId('picked-file');
  await userEvent.click(c.getByRole('button', { name: '解析する' }));
}

export const Idle: Story = {
  args: { client: createFakeAnalysisClient() },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByRole('heading', {
        level: 1,
        name: '鼻歌から下書きを作る',
      }),
    ).toHaveFocus();
  },
};

export const Analyzing: Story = {
  args: { client: createFakeAnalysisClient({ holdAfterStages: 3 }) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await pickAndStart(canvasElement);
    await waitFor(() =>
      expect(c.getByTestId('import-step-count')).toHaveTextContent(
        '2 / 3 段階',
      ),
    );
    expect(c.getByTestId('import-live')).toHaveTextContent('声の高さを調べる');
  },
};

export const Cancelled: Story = {
  args: { client: createFakeAnalysisClient({ holdAfterStages: 2 }) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await pickAndStart(canvasElement);
    await userEvent.click(await c.findByRole('button', { name: '中止' }));
    const n = await c.findByTestId('import-notice');
    expect(n).toHaveTextContent(IMPORT_ERROR_MESSAGES.cancelled);
    await waitFor(() => expect(n).toHaveFocus());
  },
};

export const AnalyzerError: Story = {
  args: {
    client: createFakeAnalysisClient({ error: 'silent', failAfterStages: 3 }),
  },
  play: async ({ canvasElement }) => {
    await pickAndStart(canvasElement);
    expect(
      await within(canvasElement).findByTestId('import-notice'),
    ).toHaveTextContent(IMPORT_ERROR_MESSAGES.silent);
  },
};

export const Review: Story = {
  args: {
    client: createFakeAnalysisClient({ results: { hum: humSampleResult() } }),
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await pickAndStart(canvasElement);
    expect(
      await c.findByRole('heading', { name: '鼻歌の下書きを確かめる' }),
    ).toHaveFocus();
    expect(c.getByTestId('replace-note')).toBeVisible();
  },
};
