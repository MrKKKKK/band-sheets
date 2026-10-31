import { createRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import {
  HUM_NO_VOICE_MESSAGE,
  IMPORT_ERROR_MESSAGES,
} from '../../lib/import/importErrors';
import { ImportProgress } from '../ImportProgress/ImportProgress';
import { HUM_STEPS } from '../../lib/import/humImport';
import { fileHumSource } from '../../screens/humFileSource';
import { HumSetup } from './HumSetup';

const fileSource = (
  file: { name: string; size: number; duration: number } | null,
) =>
  fileHumSource({
    pickedFile: file && { ...file, probing: false },
    onPick: fn(),
    inputRef: createRef(),
    tempo: 96,
    beats: 4,
  });

const meta = {
  title: 'Import/HumSetup',
  component: HumSetup,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    songTitle: '聖者の行進',
    targets: [
      { label: 'Aメロ', writable: true, notes: 24, bars: 8 },
      { label: 'Bメロ', writable: true, notes: 0, bars: 0 },
      { label: 'サビ', writable: false, notes: 0, bars: 0 },
    ],
    ts: { num: 4, den: 4 },
    value: { label: 'Aメロ', tempo: 96, key: 'G', bar: 1, beat: 1 },
    onChange: fn(),
    source: fileSource(null),
    notice: null,
    onStart: fn(),
    onBack: fn(),
  },
} satisfies Meta<typeof HumSetup>;

export default meta;
type Story = StoryObj<typeof meta>;

const FILE = { name: 'humming-take2.wav', size: 3_200_000, duration: 38 };

export const Idle: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByRole('button', { name: '解析する' })).toBeDisabled();
    expect(c.getByRole('heading', { name: '録り方' })).toBeVisible();
    expect(c.getByText(/音の候補を並べる順番/)).toBeVisible();
    expect(c.getByRole('option', { name: /サビ/ })).toBeDisabled();
    await userEvent.click(c.getByRole('button', { name: 'テンポを 1 上げる' }));
    expect(args.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tempo: 97 }),
    );
  },
};

export const FileChosen: Story = {
  args: { source: fileSource(FILE) },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: '解析する' }));
    expect(args.onStart).toHaveBeenCalled();
  },
};

export const Analyzing: Story = {
  args: {
    source: fileSource(FILE),
    progress: (
      <ImportProgress
        fileName={FILE.name}
        duration={FILE.duration}
        progress={{ done: 3, total: 7 }}
        onCancel={fn()}
        steps={HUM_STEPS}
        footnote="数秒かかります。「中止」を押すと、すぐ止めてこの画面に戻ります。"
      />
    ),
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('import-step-count')).toHaveTextContent('2 / 3 段階');
    expect(c.getByRole('button', { name: '解析しています…' })).toBeDisabled();
    expect(c.getByLabelText('セクション')).toBeDisabled();
    expect(c.getByRole('button', { name: '中止' })).toBeEnabled();
  },
};

export const NoVoiceError: Story = {
  args: {
    source: fileSource(FILE),
    notice: { severity: 'error', message: HUM_NO_VOICE_MESSAGE },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('import-notice')).toHaveTextContent(
      '歌の声が見つかりませんでした',
    );
    expect(c.getByRole('button', { name: '別のファイルを選ぶ' })).toBeVisible();
  },
};

export const Cancelled: Story = {
  args: {
    source: fileSource(FILE),
    notice: {
      severity: 'notice',
      message: IMPORT_ERROR_MESSAGES.cancelled,
      retry: true,
    },
  },
  play: async ({ canvasElement }) => {
    const n = within(canvasElement).getByTestId('import-notice');
    expect(n).toHaveTextContent('中止しました。');
    expect(within(n).queryByRole('button')).toBeNull();
  },
};
