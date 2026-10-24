import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { AnalysisErrorCode } from '../../analysis/types';
import { IMPORT_ERROR_MESSAGES } from '../../lib/import/importErrors';
import { ImportPicker, type ImportNotice } from './ImportPicker';

const meta = {
  title: 'Import/ImportPicker',
  component: ImportPicker,
  parameters: { a11y: { test: 'error' } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 760, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
  args: { file: null, onPick: fn(), onStart: fn(), onRetry: fn() },
} satisfies Meta<typeof ImportPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

const FILE = { name: 'my-demo-take3.wav', size: 38_200_000, duration: 222 };

function errorNotice(code: AnalysisErrorCode, retry = false): ImportNotice {
  return { severity: 'error', message: IMPORT_ERROR_MESSAGES[code], retry };
}

export const Idle: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText('音声ファイルをここにドロップ')).toBeVisible();
    expect(c.getByText('音はこの端末の外に出ません')).toBeVisible();
    expect(c.getByText(/耳コピの補助/)).toBeVisible();
    expect(c.getByRole('button', { name: '解析を始める' })).toBeDisabled();
    expect(c.queryByTestId('import-notice')).toBeNull();
  },
};

export const FileChosen: Story = {
  args: { file: FILE },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const card = c.getByTestId('picked-file');
    expect(card).toHaveTextContent('my-demo-take3.wav');
    expect(card).toHaveTextContent('長さ 3:42 ・ 38.2 MB');
    expect(c.getByRole('button', { name: 'ファイルを変える' })).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: '解析を始める' }));
    expect(args.onStart).toHaveBeenCalledTimes(1);
  },
};

export const LengthUnknown: Story = {
  args: { file: { ...FILE, name: 'take.m4a', duration: null } },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByTestId('picked-file')).toHaveTextContent(
      '長さは解析のときに確かめます',
    );
  },
};

export const ErrorUnreadable: Story = {
  args: { file: FILE, notice: errorNotice('decode-failed') },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const n = c.getByTestId('import-notice');
    expect(n).toHaveTextContent(IMPORT_ERROR_MESSAGES['decode-failed']);
    expect(n).toHaveAttribute('data-severity', 'error');
    expect(
      within(n).getByRole('button', { name: '別のファイルを選ぶ' }),
    ).toBeVisible();
    expect(
      within(n).queryByRole('button', { name: 'もう一度試す' }),
    ).toBeNull();
  },
};

export const ErrorTooLong: Story = {
  args: { file: null, notice: errorNotice('too-long') },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('import-notice')).toHaveTextContent(
      IMPORT_ERROR_MESSAGES['too-long'],
    );
    expect(c.getByText('音声ファイルをここにドロップ')).toBeVisible();
  },
};

export const ErrorNoBeats: Story = {
  args: { file: FILE, notice: errorNotice('no-beats') },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByTestId('import-notice'),
    ).toHaveTextContent(IMPORT_ERROR_MESSAGES['no-beats']);
  },
};

export const ErrorCrashed: Story = {
  args: { file: FILE, notice: errorNotice('worker-crashed', true) },
  play: async ({ canvasElement, args }) => {
    const n = within(within(canvasElement).getByTestId('import-notice'));
    expect(n.getByText(IMPORT_ERROR_MESSAGES['worker-crashed'])).toBeVisible();
    await userEvent.click(n.getByRole('button', { name: 'もう一度試す' }));
    expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const Cancelled: Story = {
  args: {
    file: FILE,
    notice: {
      severity: 'notice',
      message: IMPORT_ERROR_MESSAGES.cancelled,
      retry: true,
    },
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const n = c.getByTestId('import-notice');
    expect(n).toHaveAttribute('data-severity', 'notice');
    expect(n).toHaveTextContent('中止しました。');
    expect(
      within(n).queryByRole('button', { name: '別のファイルを選ぶ' }),
    ).toBeNull();
    await userEvent.click(
      within(n).getByRole('button', { name: 'もう一度解析する' }),
    );
    expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const PickAFile: Story = {
  play: async ({ canvasElement, args }) => {
    const file = new File(['x'], 'take.wav', { type: 'audio/wav' });
    await userEvent.upload(
      within(canvasElement).getByTestId('audio-file-input'),
      file,
    );
    expect(args.onPick).toHaveBeenCalledWith(file);
  },
};
