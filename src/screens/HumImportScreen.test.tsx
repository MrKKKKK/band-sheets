import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeAnalysisClient } from '../analysis/fakeAnalysisClient';
import { sampleSong } from '../lib/fixtures/sampleSong';
import {
  humSampleResult,
  humSilentResult,
} from '../lib/import/fixtures/humResults';
import {
  HUM_DRAFT_FAILED_MESSAGE,
  HUM_NO_VOICE_MESSAGE,
  IMPORT_ERROR_MESSAGES,
} from '../lib/import/importErrors';
import { readSection } from '../lib/melodyPart';
import { createMemoryStorage, NOTE_NAMES_KEY } from '../lib/storage';
import { HumImportScreen } from './HumImportScreen';

const T44 = { num: 4, den: 4 };
const vocal = sampleSong.parts.findIndex((p) => p.name === 'Vocal');
const file = () => new File(['x'], 'hum.wav', { type: 'audio/wav' });

const tone = () => ({
  start: vi.fn(() => 0),
  stop: vi.fn(),
  playOne: vi.fn(),
  close: vi.fn(),
  now: () => 0,
});

function setup(
  client = createFakeAnalysisClient({ results: { hum: humSampleResult() } }),
  label = 'B',
  song = sampleSong,
) {
  const onInsert = vi.fn();
  const onBack = vi.fn();
  const storage = createMemoryStorage();
  const t = tone();
  const view = render(
    <HumImportScreen
      song={song}
      partIndex={vocal}
      initialLabel={label}
      ts={T44}
      keySig="C"
      storage={storage}
      onInsert={onInsert}
      onBack={onBack}
      client={client}
      probe={() => Promise.resolve(12)}
      playbackDeps={{ createTone: () => t }}
    />,
  );
  return {
    user: userEvent.setup(),
    onInsert,
    onBack,
    client,
    storage,
    tone: t,
    view,
  };
}

async function analyse(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByTestId('audio-file-input'), file());
  await screen.findByTestId('picked-file');
  await user.click(screen.getByRole('button', { name: '解析する' }));
}

describe('HumImportScreen', () => {
  it('S2: the song info is prefilled, 「解析する」 waits for a file, and the request carries the bar position', async () => {
    const { user, client } = setup();
    expect(
      screen.getByRole('heading', { level: 1, name: '鼻歌から下書きを作る' }),
    ).toHaveFocus();
    expect(screen.getByTestId('hum-tempo')).toHaveValue(100);
    expect(screen.getByLabelText('セクション')).toHaveValue('B');
    expect(screen.getByLabelText('キー')).toHaveValue('C');
    expect(screen.getByRole('button', { name: '解析する' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('歌い始めの拍'), '2');
    await analyse(user);
    expect(client.requests[0]).toMatchObject({
      kind: 'hum',
      firstNoteAuto: true,
      info: { bpm: 100, ts: [4, 4], firstNoteTick: 16, key: 'C' },
    });
    expect(
      await screen.findByRole('heading', { name: '鼻歌の下書きを確かめる' }),
    ).toHaveFocus();
  });

  it('S4 → insert: confirms before replacing notes, then hands over one song with the section rewritten', async () => {
    const { user, onInsert } = setup();
    await analyse(user);
    await screen.findByRole('heading', { name: '鼻歌の下書きを確かめる' });
    expect(screen.getByTestId('hum-summary')).toHaveTextContent(
      'B ・ 4 小節 ・ 音 8 個 ・ 自信がない音 2 個',
    );
    await user.click(
      screen.getByRole('button', { name: 'このセクションに下書きを入れる' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Bの音符を置き換えますか',
    });
    expect(
      within(dialog).getByRole('button', { name: 'キャンセル' }),
    ).toHaveFocus();
    await user.click(
      within(dialog).getByRole('button', { name: 'キャンセル' }),
    );
    expect(onInsert).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'このセクションに下書きを入れる' }),
    );
    await user.click(screen.getByRole('button', { name: '置き換えて入れる' }));
    expect(onInsert).toHaveBeenCalledTimes(1);
    const [song, label] = onInsert.mock.calls[0];
    expect(label).toBe('B');
    const read = readSection(song.parts[vocal].body, 'B', T44);
    expect(read.status).toBe('ok');
    expect(read.status === 'ok' && read.events[1]).toEqual({
      kind: 'note',
      pitch: 'E4',
      ticks: 16,
    });
  });

  it('S4: whole-draft fixes change the draft; the note-name mode is remembered', async () => {
    const { user, onInsert, storage } = setup(undefined, 'A');
    await analyse(user);
    await screen.findByRole('heading', { name: '鼻歌の下書きを確かめる' });
    await user.click(
      screen.getByRole('button', { name: '1 オクターブ上げる' }),
    );
    expect(screen.getByTestId('hum-octave')).toHaveTextContent(
      '1 オクターブ上',
    );
    await user.click(screen.getByRole('button', { name: '1 拍後へ ›' }));
    expect(screen.getByTestId('hum-start')).toHaveTextContent(
      '1 小節目の 3 拍目',
    );
    await user.click(screen.getByRole('button', { name: '16 分後へ ›' }));
    await user.click(screen.getByRole('button', { name: '16 分後へ ›' }));
    expect(screen.getByTestId('hum-shift')).toHaveTextContent(
      '1 拍と 16 分 2 つ後',
    );
    expect(screen.getByTestId('hum-start')).toHaveTextContent(
      '1 小節目の 3 拍目のすこし後',
    );
    expect(screen.getByTestId('hum-fixes')).toHaveTextContent(
      '1 拍と 16 分 2 つ後',
    );
    await user.click(screen.getByRole('button', { name: '‹ 16 分前へ' }));
    expect(screen.getByTestId('hum-shift')).toHaveTextContent(
      '1 拍と 16 分 1 つ後',
    );
    await user.click(screen.getByRole('button', { name: '‹ 16 分前へ' }));
    await user.click(screen.getByRole('button', { name: 'C D E' }));
    expect(storage.data.get(NOTE_NAMES_KEY)).toBe('letter');
    await user.click(
      screen.getByRole('button', { name: 'このセクションに下書きを入れる' }),
    );
    await user.click(screen.getByRole('button', { name: '置き換えて入れる' }));
    const read = readSection(
      onInsert.mock.calls[0][0].parts[vocal].body,
      'A',
      T44,
    );
    expect(read.status === 'ok' && read.events.slice(0, 2)).toEqual([
      { kind: 'rest', ticks: 32 },
      { kind: 'note', pitch: 'E5', ticks: 16 },
    ]);
  });

  it('announces the pick, a repeated pick and the end of a run in the live region', async () => {
    const { user } = setup();
    await user.upload(screen.getByTestId('audio-file-input'), file());
    await screen.findByTestId('picked-file');
    expect(screen.getByTestId('import-live').textContent).toBe(
      'hum.wav を選びました。長さ 12 秒',
    );
    await user.upload(screen.getByTestId('audio-file-input'), file());
    await vi.waitFor(() =>
      expect(screen.getByTestId('import-live').textContent).toBe(
        'hum.wav を選びました。長さ 12 秒\u00a0',
      ),
    );
    await user.click(screen.getByRole('button', { name: '解析する' }));
    await screen.findByRole('heading', { name: '鼻歌の下書きを確かめる' });
    expect(screen.getByTestId('staff-live')).toHaveTextContent(
      '解析が終わりました。鼻歌の下書きを確かめてください',
    );
  });

  it('S2: cancel shows the neutral notice', async () => {
    const hold = createFakeAnalysisClient({ holdAfterStages: 2 });
    const { user } = setup(hold);
    await analyse(user);
    await user.click(await screen.findByRole('button', { name: '中止' }));
    const notice = await screen.findByTestId('import-notice');
    expect(notice).toHaveTextContent(IMPORT_ERROR_MESSAGES.cancelled);
    expect(notice).toHaveAttribute('data-severity', 'notice');
  });

  it('S2: a recording without a sung note', async () => {
    const { user } = setup(
      createFakeAnalysisClient({ results: { hum: humSilentResult() } }),
    );
    await analyse(user);
    expect(await screen.findByTestId('import-notice')).toHaveTextContent(
      HUM_NO_VOICE_MESSAGE,
    );
  });

  it('S4: a candidate click plays it and applies it at once; the original reading takes it back', async () => {
    const { user, tone } = setup(undefined, 'A');
    await analyse(user);
    await screen.findByRole('heading', { name: '鼻歌の下書きを確かめる' });
    screen.getByRole('application').focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    const panel = await screen.findByTestId('candidate-panel');
    expect(panel).toHaveTextContent('1 小節目の 3 つ目の音');
    await user.click(within(panel).getByRole('button', { name: /ソ♯ 31%/ }));
    expect(tone.playOne).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('lyric-3')).toHaveTextContent('ソ♯');
    expect(screen.getByText('候補 1 音')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: '▶ ラ' }));
    expect(tone.playOne).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('lyric-3')).toHaveTextContent('ラ?');
    // back to the analyzer's reading: no change counted
    expect(screen.queryByText('候補 1 音')).toBeNull();
  });

  it('S2: leaving the screen during the analysis cancels it', async () => {
    const hold = createFakeAnalysisClient({ holdAfterStages: 2 });
    const { user, view } = setup(hold);
    await analyse(user);
    await screen.findByRole('button', { name: '中止' });
    view.unmount();
    expect(hold.cancelCount).toBe(1);
  });

  it('S2: a read-only section cannot be chosen; the first writable one is the default', () => {
    const song = {
      ...sampleSong,
      parts: sampleSong.parts.map((p, i) =>
        i === vocal
          ? {
              ...p,
              body: p.body.replace(
                '\\section "B"',
                '\\section "B"\n:4 (C4 E4) C4 C4 C4 |\n\\section "X"',
              ),
            }
          : p,
      ),
    };
    setup(undefined, 'B', song);
    const select = screen.getByRole('combobox', { name: 'セクション' });
    expect(select).toHaveValue('A');
    expect(within(select).getByRole('option', { name: /^B（/ })).toBeDisabled();
  });

  it('S2: the tempo field takes typed digits and is checked when leaving it', async () => {
    const { user } = setup();
    const field = screen.getByTestId('hum-tempo');
    await user.clear(field);
    expect(field).toHaveValue(null); // empty while typing
    await user.type(field, '90');
    expect(field).toHaveValue(90);
    await user.tab();
    expect(field).toHaveValue(90);
    expect(screen.getByText(/♩= 90 ・ 4\/4/)).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '500{Enter}');
    expect(field).toHaveValue(240);
    await user.clear(field);
    await user.tab();
    expect(field).toHaveValue(240);
  });

  it('S4: a result that cannot become a draft says so instead of an empty staff', async () => {
    const broken = humSampleResult();
    broken.melody.quantized.ts = [4, 3];
    const { user } = setup(
      createFakeAnalysisClient({ results: { hum: broken } }),
    );
    await analyse(user);
    expect(await screen.findByTestId('draft-error')).toHaveTextContent(
      HUM_DRAFT_FAILED_MESSAGE,
    );
  });

  it('S4: the browser back asks first when something was fixed; cancelling stays (onStay), confirming leaves', async () => {
    const onStay = vi.fn();
    const onBack = vi.fn();
    const client = createFakeAnalysisClient({
      results: { hum: humSampleResult() },
    });
    const props = {
      song: sampleSong,
      partIndex: vocal,
      initialLabel: 'A',
      ts: T44,
      storage: createMemoryStorage(),
      onInsert: vi.fn(),
      onBack,
      onStay,
      client,
      probe: () => Promise.resolve(12),
      playbackDeps: { createTone: tone },
    };
    const { rerender } = render(<HumImportScreen {...props} backRequest={0} />);
    const user = userEvent.setup();
    await analyse(user);
    await screen.findByRole('heading', { name: '鼻歌の下書きを確かめる' });
    await user.click(
      screen.getByRole('button', { name: '1 オクターブ上げる' }),
    );
    rerender(<HumImportScreen {...props} backRequest={1} />);
    const dialog = await screen.findByRole('dialog', {
      name: 'ここでの直しを捨てて戻りますか？',
    });
    await user.click(
      within(dialog).getByRole('button', { name: 'キャンセル' }),
    );
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    rerender(<HumImportScreen {...props} backRequest={2} />);
    await user.click(await screen.findByRole('button', { name: '捨てて戻る' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
