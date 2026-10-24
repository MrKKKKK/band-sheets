import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeAnalysisClient } from '../analysis/fakeAnalysisClient';
import { reviewSampleResult } from '../lib/import/fixtures/chordResults';
import { IMPORT_ERROR_MESSAGES } from '../lib/import/importErrors';
import { ImportScreen } from './ImportScreen';

const file = () =>
  new File(['not really audio'], 'take.m4a', { type: 'audio/mp4' });

function setup(
  client = createFakeAnalysisClient({
    results: { chords: reviewSampleResult() },
  }),
  duration: number | null = 120,
) {
  const onCreate = vi.fn();
  const onBackToList = vi.fn();
  const user = userEvent.setup();
  render(
    <ImportScreen
      client={client}
      onCreate={onCreate}
      onBackToList={onBackToList}
      probe={() => Promise.resolve(duration)}
      now={() => new Date(2026, 9, 24)}
    />,
  );
  return { user, onCreate, onBackToList, client };
}

async function pickAndStart(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByTestId('audio-file-input'), file());
  await screen.findByTestId('picked-file');
  await user.click(screen.getByRole('button', { name: '解析を始める' }));
}

describe('ImportScreen', () => {
  it('focuses the heading and keeps 「解析を始める」 off until a file is picked', () => {
    setup();
    expect(
      screen.getByRole('heading', { level: 1, name: '録音から新しい曲' }),
    ).toHaveFocus();
    expect(screen.getByRole('button', { name: '解析を始める' })).toBeDisabled();
  });

  it('rejects a file over 10 minutes before analysing', async () => {
    const { user, client } = setup(undefined, 750);
    await user.upload(screen.getByTestId('audio-file-input'), file());
    expect(await screen.findByTestId('import-notice')).toHaveTextContent(
      IMPORT_ERROR_MESSAGES['too-long'],
    );
    expect(screen.queryByTestId('picked-file')).toBeNull();
    expect(client.requests).toHaveLength(0);
  });

  it('cancel stops the run and shows a neutral notice with 「もう一度解析する」', async () => {
    const client = createFakeAnalysisClient({ holdAfterStages: 3 });
    const { user } = setup(client);
    await pickAndStart(user);
    expect(
      await screen.findByRole('heading', { name: '解析しています' }),
    ).toHaveFocus();
    await waitFor(() =>
      expect(screen.getByTestId('import-step-count')).toHaveTextContent(
        '3 / 6 段階',
      ),
    );
    await user.click(screen.getByRole('button', { name: '中止' }));
    const notice = await screen.findByTestId('import-notice');
    expect(notice).toHaveAttribute('data-severity', 'notice');
    expect(notice).toHaveTextContent('中止しました。');
    expect(notice).toHaveFocus();
    expect(client.cancelCount).toBe(1);
    expect(screen.getByTestId('import-live')).toHaveTextContent(
      '中止しました。',
    );
    expect(
      screen.getByRole('button', { name: 'もう一度解析する' }),
    ).toBeInTheDocument();
  });

  it('shows the analyzer error above the picker, the file kept', async () => {
    const client = createFakeAnalysisClient({
      error: 'no-beats',
      failAfterStages: 4,
    });
    const { user } = setup(client);
    await pickAndStart(user);
    const notice = await screen.findByTestId('import-notice');
    expect(notice).toHaveAttribute('data-severity', 'error');
    expect(notice).toHaveTextContent(IMPORT_ERROR_MESSAGES['no-beats']);
    expect(screen.getByTestId('picked-file')).toHaveTextContent('take.m4a');
    expect(
      screen.getByRole('button', { name: '別のファイルを選ぶ' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'もう一度試す' })).toBeNull();
  });

  it('offers 「もう一度試す」 after a crash, and it runs again', async () => {
    const client = createFakeAnalysisClient({ error: 'worker-crashed' });
    const { user } = setup(client);
    await pickAndStart(user);
    await user.click(
      await screen.findByRole('button', { name: 'もう一度試す' }),
    );
    await screen.findByTestId('import-notice');
    expect(client.requests).toHaveLength(2);
  });

  it('review → create hands over the song text with the draft marks', async () => {
    const { user, onCreate } = setup();
    await pickAndStart(user);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'コード譜の下書きを確かめる',
      }),
    ).toHaveFocus();
    await user.click(
      screen.getByRole('button', { name: 'この内容で曲を作る' }),
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
    const text = onCreate.mock.calls[0][0] as string;
    expect(text.split('\n')[0]).toBe('{title: take（下書き）}');
    expect(text).toContain(
      '{comment: 自動解析の下書き 2026-10-24 コード adec583eb3c6}',
    );
  });

  it('「やめて戻る」 asks only after a change', async () => {
    const { user, onBackToList } = setup();
    await pickAndStart(user);
    await screen.findByRole('heading', { name: 'コード譜の下書きを確かめる' });
    await user.click(screen.getByRole('button', { name: '‹ やめて戻る' }));
    expect(onBackToList).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /倍 192/ }));
    await user.click(screen.getByRole('button', { name: '‹ やめて戻る' }));
    expect(
      await screen.findByRole('dialog', {
        name: 'ここでの直しを捨てて戻りますか？',
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onBackToList).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'やめて戻る' }));
    await user.click(screen.getByRole('button', { name: '捨てて戻る' }));
    expect(onBackToList).toHaveBeenCalledTimes(2);
  });
});
