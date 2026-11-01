import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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

  it('shows a newly chosen file at once and keeps 「解析を始める」 off until its length is known', async () => {
    let resolve!: (n: number) => void;
    const probe = vi
      .fn<(f: Blob) => Promise<number | null>>()
      .mockResolvedValueOnce(60)
      .mockImplementationOnce(
        () => new Promise<number | null>((r) => (resolve = r)),
      );
    const client = createFakeAnalysisClient({
      results: { chords: reviewSampleResult() },
    });
    const user = userEvent.setup();
    render(
      <ImportScreen
        client={client}
        onCreate={vi.fn()}
        onBackToList={vi.fn()}
        probe={probe}
        now={() => new Date(2026, 9, 24)}
      />,
    );
    const input = screen.getByTestId('audio-file-input');
    await user.upload(input, new File(['a'], 'old.m4a', { type: 'audio/mp4' }));
    await screen.findByText('old.m4a');
    expect(screen.getByRole('button', { name: '解析を始める' })).toBeEnabled();

    await user.upload(input, new File(['b'], 'new.m4a', { type: 'audio/mp4' }));
    expect(screen.getByTestId('picked-file')).toHaveTextContent('new.m4a');
    expect(screen.getByTestId('picked-file')).toHaveTextContent(
      '長さを調べています',
    );
    expect(screen.getByRole('button', { name: '解析を始める' })).toBeDisabled();

    resolve(90);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '解析を始める' }),
      ).toBeEnabled(),
    );
    expect(screen.getByTestId('picked-file')).toHaveTextContent('長さ 1:30');
    await user.click(screen.getByRole('button', { name: '解析を始める' }));
    expect(client.requests).toHaveLength(1);
    expect((client.requests[0].source as { file: File }).file.name).toBe(
      'new.m4a',
    );
  });

  it('a too-long file still blocks after the probe', async () => {
    let resolve!: (n: number) => void;
    const user = userEvent.setup();
    render(
      <ImportScreen
        client={createFakeAnalysisClient()}
        onCreate={vi.fn()}
        onBackToList={vi.fn()}
        probe={() => new Promise<number | null>((r) => (resolve = r))}
      />,
    );
    await user.upload(screen.getByTestId('audio-file-input'), file());
    expect(screen.getByTestId('picked-file')).toBeInTheDocument();
    resolve(750);
    expect(await screen.findByTestId('import-notice')).toHaveTextContent(
      IMPORT_ERROR_MESSAGES['too-long'],
    );
    expect(screen.queryByTestId('picked-file')).toBeNull();
  });

  it('a file dropped anywhere on the page is taken (and the browser does not open it)', async () => {
    setup();
    const notPrevented = fireEvent.drop(document.body, {
      dataTransfer: { files: [file()] },
    });
    expect(notPrevented).toBe(false);
    expect(await screen.findByTestId('picked-file')).toHaveTextContent(
      'take.m4a',
    );
    // and again once a file is chosen: the drop is still not handed to the browser
    expect(fireEvent.dragOver(document.body, { dataTransfer: {} })).toBe(false);
    expect(
      fireEvent.drop(document.body, { dataTransfer: { files: [file()] } }),
    ).toBe(false);
  });

  it('a drop while analysing is ignored but does not navigate away', async () => {
    const client = createFakeAnalysisClient({ holdAfterStages: 3 });
    const { user } = setup(client);
    await pickAndStart(user);
    await screen.findByTestId('import-step-count');
    expect(
      fireEvent.drop(document.body, { dataTransfer: { files: [file()] } }),
    ).toBe(false);
    expect(client.requests).toHaveLength(1);
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

  it('「曲の一覧」 during a run leaves the screen and cancels the analysis once', async () => {
    const client = createFakeAnalysisClient({ holdAfterStages: 3 });
    const user = userEvent.setup();
    const onBackToList = vi.fn();
    // Like Root: going back unmounts the screen.
    function Host() {
      const [shown, setShown] = useState(true);
      if (!shown) return <p>list</p>;
      return (
        <ImportScreen
          client={client}
          onCreate={vi.fn()}
          onBackToList={() => {
            onBackToList();
            setShown(false);
          }}
          probe={() => Promise.resolve(120)}
        />
      );
    }
    render(<Host />);
    await pickAndStart(user);
    await screen.findByRole('heading', { name: '解析しています' });
    await user.click(screen.getByRole('button', { name: '‹ 曲の一覧' }));
    expect(onBackToList).toHaveBeenCalledTimes(1);
    expect(screen.getByText('list')).toBeInTheDocument();
    expect(client.cancelCount).toBe(1);
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

  it('announces the pick, the start and the end of a run in the one live region', async () => {
    const { user } = setup();
    await user.upload(screen.getByTestId('audio-file-input'), file());
    await screen.findByTestId('picked-file');
    expect(screen.getByTestId('import-live')).toHaveTextContent(
      'take.m4a を選びました。長さ 2 分 0 秒',
    );
    // Picking the same file again: an unchanged message is made different (a trailing NBSP) so it is read again.
    await user.upload(screen.getByTestId('audio-file-input'), file());
    await waitFor(() =>
      expect(screen.getByTestId('import-live').textContent).toBe(
        'take.m4a を選びました。長さ 2 分 0 秒\u00a0',
      ),
    );
    await user.click(screen.getByRole('button', { name: '解析を始める' }));
    await screen.findByRole('heading', {
      level: 1,
      name: 'コード譜の下書きを確かめる',
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByTestId('import-live')).toHaveTextContent(
      '解析が終わりました。コード譜の下書きを確かめてください',
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
