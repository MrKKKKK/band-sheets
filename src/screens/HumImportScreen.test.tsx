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
  HUM_NO_VOICE_MESSAGE,
  IMPORT_ERROR_MESSAGES,
} from '../lib/import/importErrors';
import { readSection } from '../lib/melodyPart';
import { createMemoryStorage, NOTE_NAMES_KEY } from '../lib/storage';
import { HumImportScreen } from './HumImportScreen';

const T44 = { num: 4, den: 4 };
const vocal = sampleSong.parts.findIndex((p) => p.name === 'Vocal');
const file = () => new File(['x'], 'hum.wav', { type: 'audio/wav' });

function setup(
  client = createFakeAnalysisClient({ results: { hum: humSampleResult() } }),
  label = 'B',
) {
  const onInsert = vi.fn();
  const onBack = vi.fn();
  const storage = createMemoryStorage();
  render(
    <HumImportScreen
      song={sampleSong}
      partIndex={vocal}
      initialLabel={label}
      ts={T44}
      keySig="C"
      storage={storage}
      onInsert={onInsert}
      onBack={onBack}
      client={client}
      probe={() => Promise.resolve(12)}
    />,
  );
  return { user: userEvent.setup(), onInsert, onBack, client, storage };
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

  it('S4: whole-draft fixes and a candidate change the draft; the note-name mode is remembered', async () => {
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

  it('S2: cancel shows the neutral notice; no sung note shows the hum error', async () => {
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
});
