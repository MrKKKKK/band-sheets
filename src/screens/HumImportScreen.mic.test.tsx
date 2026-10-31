import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAnalysisClient } from '../analysis/fakeAnalysisClient';
import {
  createFakeMicSession,
  type FakeMicOptions,
  type FakeMicSession,
} from '../audio/fakeMicSession';
import { TICK_MS } from '../hooks/useMicRecorder';
import { sampleSong } from '../lib/fixtures/sampleSong';
import { humSampleResult } from '../lib/import/fixtures/humResults';
import { createMemoryStorage } from '../lib/storage';
import { HumImportScreen } from './HumImportScreen';

// S2 with 「マイクで録る」 (docs/mic-recording-plan.md T6): the screen wiring with the fake mic. ♩=100 in 4/4
// (the sample song) → one bar = 2.4 s.
const T44 = { num: 4, den: 4 };
const vocal = sampleSong.parts.findIndex((p) => p.name === 'Vocal');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(
  opts: FakeMicOptions = {},
  client = createFakeAnalysisClient({ results: { hum: humSampleResult() } }),
  probeSec = 12,
  save: (blob: Blob, name: string) => void = vi.fn(),
) {
  const session = createFakeMicSession({ sampleRate: 8000, ...opts });
  const onBack = vi.fn();
  const storage = createMemoryStorage();
  const screenWith = (backRequest?: number) => (
    <HumImportScreen
      backRequest={backRequest}
      song={sampleSong}
      partIndex={vocal}
      initialLabel="B"
      ts={T44}
      keySig="C"
      storage={storage}
      onInsert={vi.fn()}
      onBack={onBack}
      client={client}
      probe={() => Promise.resolve(probeSec)}
      micSession={session}
      save={save}
      playbackDeps={{
        createTone: () => ({
          start: vi.fn(() => 0),
          stop: vi.fn(),
          playOne: vi.fn(),
          close: vi.fn(),
          now: () => 0,
        }),
      }}
    />
  );
  const view = render(screenWith());
  return { session, client, onBack, view, screenWith };
}

/** Moves the mic's clock and the timers together. */
async function step(session: FakeMicSession, sec: number) {
  const n = Math.round((sec * 1000) / TICK_MS);
  await act(async () => {
    for (let i = 0; i < n; i++) {
      session.advance(TICK_MS / 1000);
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
/** The source switch's buttons (AudioFileField has a 「ファイルを選ぶ」 of its own). */
const seg = (name: string) =>
  within(screen.getByRole('group', { name: '受け取り方' })).getByRole(
    'button',
    { name },
  );
const live = () => screen.getByTestId('import-live');
const summaryRow = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).closest('div')!;

async function chooseMic() {
  fireEvent.click(seg('マイクで録る'));
  await flush();
}

/** ● → count-in → `sec` of singing → ■ → M7. */
async function recordTake(session: FakeMicSession, sec = 3) {
  fireEvent.click(button('● 録音'));
  await step(session, 2.4 + 0.2 + sec);
  fireEvent.click(button('■ 止める'));
  await step(session, 1);
  expect(screen.getByRole('heading', { name: '録音 1 つ' })).toBeVisible();
}

async function pickFile(expectPicked = true) {
  fireEvent.change(screen.getByTestId('audio-file-input'), {
    target: { files: [new File(['x'], 'hum.wav', { type: 'audio/wav' })] },
  });
  await flush();
  if (expectPicked)
    expect(screen.getByTestId('picked-file')).toHaveTextContent('hum.wav');
}

describe('HumImportScreen: マイクで録る', () => {
  it('starts on the file; choosing the mic opens it (only then) and S2 speaks of the mic', async () => {
    const { session } = setup();
    expect(seg('ファイルを選ぶ')).toHaveAttribute('aria-pressed', 'true');
    expect(session.stats.opens).toBe(0);
    await chooseMic();
    expect(session.stats.opens).toBe(1);
    expect(
      screen.getByRole('heading', { name: '1. 歌の音を受け取る' }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: '録り方' })).toBeNull();
    expect(summaryRow('音')).toHaveTextContent('まだ録っていません');
    expect(button('下書きを作る')).toBeDisabled();
    expect(screen.getByText('先に録音してください。')).toBeVisible();
    // the hook's announcement goes to S2's one live region; focus to ● 録音 (M3)
    expect(live()).toHaveTextContent('マイクを使えるようになりました。');
    expect(button('● 録音')).toHaveFocus();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('while counting in / recording nothing can leave S2 or switch to the file', async () => {
    const { session } = setup();
    await chooseMic();
    fireEvent.click(button('● 録音'));
    await step(session, 0.5);
    expect(button(/やめる/)).toHaveFocus();
    expect(live()).toHaveTextContent('カウントを始めました');
    expect(seg('ファイルを選ぶ')).toBeDisabled();
    expect(button('‹ やめて戻る')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'やめて戻る' })).toBeNull();
    await step(session, 2.4);
    expect(button('■ 止める')).toHaveFocus();
    expect(live()).toHaveTextContent('録音を始めました。');
    expect(summaryRow('音')).toHaveTextContent('録音しています');
    expect(screen.queryByRole('button', { name: 'やめて戻る' })).toBeNull();
    fireEvent.click(button('■ 止める'));
    await step(session, 1);
    expect(screen.getByRole('heading', { name: '録音 1 つ' })).toHaveFocus();
    expect(button('やめて戻る')).toBeEnabled();
    expect(button('‹ やめて戻る')).toBeEnabled();
    expect(seg('ファイルを選ぶ')).toBeEnabled();
  });

  it('下書きを作る analyses the take at its bar 1 with the clicks’ tempo, then S4 opens', async () => {
    const { session, client } = setup();
    await chooseMic();
    await recordTake(session);
    expect(live().textContent).toMatch(/秒の録音です/);
    expect(summaryRow('音').textContent).toMatch(/マイクの録音 0:0\d/);
    // S2's tempo changed after the take: the request still uses the clicks'
    fireEvent.click(button('テンポを 1 上げる'));
    fireEvent.click(button('下書きを作る'));
    await flush();
    const req = client.requests[0];
    expect(req).toMatchObject({
      kind: 'hum',
      info: { bpm: 100, ts: [4, 4], startSec: 2.4, key: 'C' },
    });
    expect(req.kind === 'hum' && req.firstNoteAuto).toBeFalsy();
    expect(req.kind === 'hum' && req.info.firstNoteSec).toBeUndefined();
    const source = req.source as { file: File };
    expect(source.file.type).toBe('audio/wav');
    await flush();
    expect(
      screen.getByRole('heading', { name: '鼻歌の下書きを確かめる' }),
    ).toHaveFocus();
  });

  it('keeps the picked file and the take across switches; leaving the mic closes it', async () => {
    const { session, client } = setup();
    await pickFile();
    await chooseMic();
    // in M3 the mic is open; going back to the file closes it
    fireEvent.click(seg('ファイルを選ぶ'));
    await flush();
    expect(session.openMic).toBeNull();
    expect(screen.getByTestId('picked-file')).toHaveTextContent('hum.wav');
    expect(summaryRow('ファイル')).toHaveTextContent('hum.wav');
    await chooseMic();
    expect(session.stats.opens).toBe(2);
    await recordTake(session);
    expect(session.openMic).toBeNull(); // M7 closed it
    fireEvent.click(seg('ファイルを選ぶ'));
    await flush();
    expect(screen.getByTestId('picked-file')).toHaveTextContent('hum.wav');
    // back on the mic: the take is still there, the mic is not opened again
    await chooseMic();
    expect(screen.getByRole('heading', { name: '録音 1 つ' })).toBeVisible();
    expect(session.stats.opens).toBe(2);
    // the chosen source is analysed: the file, with its first note found automatically
    fireEvent.click(seg('ファイルを選ぶ'));
    await flush();
    fireEvent.click(button('解析する'));
    await flush();
    expect(client.requests[0]).toMatchObject({ firstNoteAuto: true });
    expect((client.requests[0].source as { file: File }).file.name).toBe(
      'hum.wav',
    );
  });

  it('unmounting while recording closes the mic and silences the clicks', async () => {
    const { session, view } = setup();
    await chooseMic();
    fireEvent.click(button('● 録音'));
    await step(session, 3);
    const stops = session.stats.stopClicks;
    view.unmount();
    expect(session.openMic).toBeNull();
    expect(session.stats.stopClicks).toBeGreaterThan(stops);
  });

  it('the browser back while recording leaves the screen (the take is dropped)', async () => {
    const { session, onBack, view, screenWith } = setup();
    await chooseMic();
    fireEvent.click(button('● 録音'));
    await step(session, 3);
    view.rerender(screenWith(1));
    expect(onBack).toHaveBeenCalled();
  });

  it('M2 (denied): 「ファイルを選ぶほうに切り替える」 goes to the file with focus on its button', async () => {
    setup({ openError: 'denied' });
    await chooseMic();
    expect(screen.getByTestId('mic-error')).toHaveFocus();
    expect(live()).toHaveTextContent('マイクが許可されていません。');
    fireEvent.click(button('ファイルを選ぶほうに切り替える'));
    await flush();
    expect(seg('ファイルを選ぶ')).toHaveAttribute('aria-pressed', 'true');
    expect(seg('ファイルを選ぶ')).toHaveFocus();
    expect(screen.getByTestId('audio-file-input')).toBeInTheDocument();
  });

  it('a failed draft returns to the take, whose notice offers 録り直す (M8)', async () => {
    const { session } = setup(
      {},
      createFakeAnalysisClient({ error: 'decode-failed' }),
    );
    await chooseMic();
    await recordTake(session);
    fireEvent.click(button('下書きを作る'));
    await flush();
    expect(screen.getByTestId('import-notice')).toHaveFocus();
    expect(screen.getByRole('heading', { name: '録音 1 つ' })).toBeVisible();
    fireEvent.click(
      within(screen.getByTestId('import-notice')).getByRole('button', {
        name: '録り直す',
      }),
    );
    await flush();
    expect(
      screen.getByRole('dialog', { name: '録り直しますか？' }),
    ).toBeVisible();
  });

  it('the notice belongs to its source: a file’s too-long is not shown with the mic', async () => {
    setup({}, undefined, 700);
    await pickFile(false);
    expect(screen.getByTestId('import-notice')).toHaveTextContent('長すぎます');
    await chooseMic();
    expect(screen.queryByTestId('import-notice')).toBeNull();
    fireEvent.click(seg('ファイルを選ぶ'));
    await flush();
    expect(screen.getByTestId('import-notice')).toHaveTextContent('長すぎます');
  });

  it('a file analysis’ 「もう一度試す」 is not offered with the mic; the take is analysed and its failure is the mic’s', async () => {
    const { session, client } = setup(
      {},
      createFakeAnalysisClient({ error: 'internal' }),
    );
    await pickFile();
    fireEvent.click(button('解析する'));
    await flush();
    expect(button('もう一度試す')).toBeVisible();
    await chooseMic();
    expect(screen.queryByTestId('import-notice')).toBeNull();
    await recordTake(session);
    fireEvent.click(button('下書きを作る'));
    await flush();
    expect((client.requests[1].source as { file: File }).file.type).toBe(
      'audio/wav',
    );
    expect((client.requests[1].source as { file: File }).file.name).not.toBe(
      'hum.wav',
    );
    // the take's failure is the mic's notice, worded for a recording
    expect(screen.getByTestId('import-notice')).toHaveTextContent('録り直');
    fireEvent.click(seg('ファイルを選ぶ'));
    await flush();
    expect(screen.queryByTestId('import-notice')).toBeNull();
  });

  it('a take that cannot be read says to record again, not to choose a file', async () => {
    const { session } = setup(
      {},
      createFakeAnalysisClient({ error: 'decode-failed' }),
    );
    await chooseMic();
    await recordTake(session);
    fireEvent.click(button('下書きを作る'));
    await flush();
    const notice = screen.getByTestId('import-notice');
    expect(notice).toHaveTextContent(
      '録音を読めませんでした。録り直してください。',
    );
    expect(notice).not.toHaveTextContent('ファイル');
    expect(live()).toHaveTextContent('録音を読めませんでした。');
  });

  it('with a take, the summary shows the tempo / time signature the take is analysed with', async () => {
    const { session } = setup();
    await chooseMic();
    await recordTake(session);
    fireEvent.click(button('テンポを 1 上げる'));
    expect(screen.getByTestId('hum-tempo')).toHaveValue(101);
    expect(summaryRow('テンポ / 拍子（録音）')).toHaveTextContent(
      '♩= 100 ・ 4/4',
    );
    fireEvent.click(seg('ファイルを選ぶ'));
    await flush();
    expect(summaryRow('テンポ / 拍子')).toHaveTextContent('♩= 101 ・ 4/4');
  });

  it('a file dropped on the page while on the mic does nothing', async () => {
    const { session, client } = setup();
    await chooseMic();
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(drop, {
      dataTransfer: {
        files: [new File(['x'], 'hum.wav', { type: 'audio/wav' })],
        types: ['Files'],
      },
    });
    window.dispatchEvent(drop);
    await flush();
    expect(drop.defaultPrevented).toBe(true);
    expect(session.stats.opens).toBe(1);
    expect(client.requests).toHaveLength(0);
    expect(button('下書きを作る')).toBeDisabled();
    fireEvent.click(seg('ファイルを選ぶ'));
    await flush();
    expect(screen.queryByTestId('picked-file')).toBeNull();
  });

  it('S4 offers 「録音を保存（wav）」 for a mic take: saves the take with a click-time name', async () => {
    const save = vi.fn();
    const { session } = setup({}, undefined, 12, save);
    await chooseMic();
    await recordTake(session);
    fireEvent.click(button('下書きを作る'));
    await flush();
    fireEvent.click(button('録音を保存（wav）'));
    expect(save).toHaveBeenCalledTimes(1);
    const [blob, name] = save.mock.calls[0] as [Blob, string];
    expect(blob.type).toBe('audio/wav');
    expect(name).toMatch(/\.wav$/);
  });

  it('S4 has no save button for a picked file', async () => {
    const { client } = setup();
    await pickFile();
    fireEvent.click(button('解析する'));
    await flush();
    expect(client.requests).toHaveLength(1);
    expect(
      screen.getByRole('heading', { name: '鼻歌の下書きを確かめる' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '録音を保存（wav）' }),
    ).toBeNull();
  });
});
