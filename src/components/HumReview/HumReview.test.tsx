import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fakeAudio } from '../../hooks/testing/fakeAudio';
import type { HumAnalysisResult } from '../../lib/analysis/hum/types';
import { humSampleResult } from '../../lib/import/fixtures/humResults';
import { HUM_TUPLET_SHIFT_MESSAGE } from '../../lib/import/importErrors';
import { HumReview } from './HumReview';

/**
 * Characterization of S4's "whole-draft fixes" and candidate choices through the component (the behaviour that
 * `lib/import/humReview.ts` now owns): summary texts, the "anything changed?" check, re-choosing the
 * analyzer's own reading, and the rejection messages.
 */

function setup(
  result: HumAnalysisResult = humSampleResult(),
  props: {
    onBack?: () => void;
    backRequest?: number;
    onSaveTake?: () => void;
  } = {},
) {
  const onBack = props.onBack ?? vi.fn();
  const onInsert = vi.fn();
  const el = fakeAudio();
  const tone = {
    start: vi.fn(() => 0),
    stop: vi.fn(),
    playOne: vi.fn(),
    close: vi.fn(),
    now: () => 0,
  };
  function Host() {
    const [live, setLive] = useState('');
    return (
      <HumReview
        result={result}
        file={new File(['x'], 'hum.wav')}
        songTitle="曲"
        label="A"
        keySig="C"
        existingNotes={0}
        initialNoteNames="doremi"
        onNoteNamesChange={() => undefined}
        onInsert={onInsert}
        onBack={onBack}
        backRequest={props.backRequest}
        onSaveTake={props.onSaveTake}
        live={live}
        say={setLive}
        playbackDeps={{
          audio: {
            createElement: () => el as unknown as HTMLAudioElement,
            createUrl: () => 'blob:x',
            revokeUrl: () => undefined,
          },
          createTone: () => tone,
        }}
      />
    );
  }
  const view = render(<Host />);
  return { onBack, onInsert, tone, ...view };
}

const fixes = () => screen.getByTestId('hum-fixes').textContent;
const press = (name: string | RegExp) =>
  userEvent.click(screen.getByRole('button', { name }));

/** The sample result with every pitch 2 octaves lower (so the proposed octave is not 0). */
function lowResult(): HumAnalysisResult {
  const r = humSampleResult();
  return {
    ...r,
    melody: {
      ...r.melody,
      quantized: {
        ...r.melody.quantized,
        events: r.melody.quantized.events.map((e) =>
          e.kind === 'note'
            ? {
                ...e,
                midi: e.midi - 36,
                candidates: e.candidates.map((c) => ({
                  ...c,
                  midi: c.midi - 36,
                })),
              }
            : e,
        ),
      },
    },
  };
}

/** One note, then a triplet beat at the end of bar 1: a 16th shift later pushes it over the barline. */
function tripletResult(): HumAnalysisResult {
  const r = humSampleResult();
  const t = (slot: number) => ({ n: 3 as const, slot });
  const n = (startTick: number, midi: number, slot: number) => ({
    kind: 'note' as const,
    startTick,
    ticks: 8,
    midi,
    src: 0,
    confidence: 1,
    candidates: [],
    gridCandidates: [],
    tuplet: t(slot),
  });
  return {
    ...r,
    melody: {
      ...r.melody,
      quantized: {
        ...r.melody.quantized,
        events: [
          { kind: 'rest', startTick: 0, ticks: 48 },
          n(48, 64, 0),
          n(48 + 16 / 3, 66, 1),
          n(48 + 32 / 3, 67, 2),
          { kind: 'rest', startTick: 64, ticks: 64 },
        ],
      },
    },
  };
}

describe('HumReview fixes (characterization)', () => {
  it('starts with no fixes; the octave is shown relative to the proposal', () => {
    setup(lowResult());
    expect(fixes()).toBe('なし');
    expect(screen.getByTestId('hum-octave')).toHaveTextContent('そのまま');
    expect(screen.getByTestId('hum-transpose')).toHaveTextContent('0 半音');
    expect(screen.getByTestId('hum-shift')).toHaveTextContent('なし');
  });

  it('octave: summary is relative to the proposal; going back to it clears the summary', async () => {
    setup(lowResult());
    await press('1 オクターブ上げる');
    expect(screen.getByTestId('hum-octave')).toHaveTextContent(
      '1 オクターブ上',
    );
    expect(fixes()).toBe('1 オクターブ上');
    await press('1 オクターブ下げる');
    expect(fixes()).toBe('なし');
    await press('1 オクターブ下げる');
    expect(fixes()).toBe('1 オクターブ下');
  });

  it('transpose: signed semitones in the summary, none at 0', async () => {
    setup();
    await press('半音上げる');
    expect(fixes()).toBe('+1 半音');
    await press('半音下げる');
    expect(fixes()).toBe('なし');
    await press('半音下げる');
    expect(fixes()).toBe('−1 半音');
    expect(screen.getByTestId('hum-transpose')).toHaveTextContent('-1 半音');
  });

  it('shift: a 16th and a beat, joined with 「・」 after the other fixes', async () => {
    setup();
    await press('半音上げる');
    await press('16 分後へ ›');
    expect(screen.getByTestId('hum-shift')).toHaveTextContent('16 分 1 つ後');
    expect(fixes()).toBe('+1 半音・16 分 1 つ後');
    await press('‹ 1 拍前へ');
    expect(fixes()).toBe('+1 半音・16 分 3 つ前');
  });

  it('a candidate pitch counts as 「候補 1 音」; choosing the original again removes it', async () => {
    setup();
    await openNote3();
    const panel = within(screen.getByTestId('candidate-panel'));
    await userEvent.click(panel.getByRole('button', { name: /ソ♯/ }));
    expect(fixes()).toBe('候補 1 音');
    await userEvent.click(panel.getByRole('button', { name: '▶ ラ' }));
    expect(fixes()).toBe('なし');
  });

  it('pitch and length of the same note are one 「候補」; each goes back on its own', async () => {
    setup();
    await openNote3();
    const panel = within(screen.getByTestId('candidate-panel'));
    await userEvent.click(panel.getByRole('button', { name: /ソ♯/ }));
    await userEvent.click(panel.getByRole('button', { name: /半拍/ }));
    expect(fixes()).toBe('候補 1 音');
    await userEvent.click(panel.getByRole('button', { name: '▶ ラ' }));
    expect(fixes()).toBe('候補 1 音');
    await userEvent.click(panel.getByRole('button', { name: '▶ 1 拍' }));
    expect(fixes()).toBe('なし');
  });

  it('the live region says what a fix did', async () => {
    setup(lowResult());
    await press('1 オクターブ上げる');
    expect(document.body).toHaveTextContent('全体の高さ: 1 オクターブ上');
    await press('半音上げる');
    expect(document.body).toHaveTextContent('1 半音');
  });

  it('a shift that pushes a triplet over the barline is refused with its message, nothing changes', async () => {
    setup(tripletResult());
    await press('16 分後へ ›');
    expect(document.body).toHaveTextContent(HUM_TUPLET_SHIFT_MESSAGE);
    expect(fixes()).toBe('なし');
    expect(screen.getByTestId('hum-shift')).toHaveTextContent('なし');
  });

  describe('「やめて戻る」', () => {
    it('leaves at once when nothing was fixed (re-picking the original is nothing)', async () => {
      const { onBack } = setup();
      await openNote3();
      const panel = within(screen.getByTestId('candidate-panel'));
      await userEvent.click(panel.getByRole('button', { name: /ソ♯/ }));
      await userEvent.click(panel.getByRole('button', { name: '▶ ラ' }));
      await press('‹ やめて戻る');
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('asks first when something was fixed', async () => {
      const { onBack } = setup();
      await press('半音上げる');
      await press('‹ やめて戻る');
      expect(onBack).not.toHaveBeenCalled();
      expect(
        screen.getByText('ここでの直しを捨てて戻りますか？'),
      ).toBeInTheDocument();
    });

    it('a candidate alone counts as a fix', async () => {
      const { onBack } = setup();
      await openNote3();
      await userEvent.click(
        within(screen.getByTestId('candidate-panel')).getByRole('button', {
          name: /ソ♯/,
        }),
      );
      await press('‹ やめて戻る');
      expect(onBack).not.toHaveBeenCalled();
    });
  });
});

/** Selects event 3 (the first unsure note) with the keyboard. */
async function openNote3() {
  screen.getByRole('application').focus();
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
  await screen.findByTestId('candidate-panel');
}

describe('HumReview: 録音を保存（wav）', () => {
  it('is shown only when onSaveTake is given, and a click calls it', async () => {
    setup();
    expect(
      screen.queryByRole('button', { name: '録音を保存（wav）' }),
    ).toBeNull();
    cleanup();
    const onSaveTake = vi.fn();
    setup(humSampleResult(), { onSaveTake });
    await press('録音を保存（wav）');
    expect(onSaveTake).toHaveBeenCalledTimes(1);
  });
});
