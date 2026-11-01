import {
  MicRecorder,
  type MicRecorderProps,
} from '../components/MicRecorder/MicRecorder';
import type { HumSource } from '../components/HumSetup/HumSetup';
import { formatClock } from '../lib/import/format';
import { latencyText } from '../lib/mic/micTexts';
import type { RecorderState } from '../lib/mic/recorderState';

/** Count-in, recording and making the file: S2 cannot be left or switched to the file meanwhile. */
export function isRecording(state: RecorderState): boolean {
  return (
    state.phase === 'countIn' ||
    state.phase === 'recording' ||
    state.phase === 'finishing'
  );
}

/**
 * S2's source when the singing is recorded with the mic (docs/mic-recording-plan.md §2.7, canvas M1–M8): the
 * recorder panel, 「下書きを作る」 once there is a take. No 「録り方」 card (M3 says it next to ● 録音).
 */
export function micHumSource({
  recorder,
  ts,
  onUseFile,
  saveName,
  save,
  playbackDeps,
  waitForFile,
}: MicRecorderProps & {
  /** A picked file is still being probed: starting now would discard it (useAnalysisRun.startFile). */
  waitForFile: boolean;
}): HumSource {
  const { state, take } = recorder;
  const recording = isRecording(state);
  return {
    field: (
      <MicRecorder
        recorder={recorder}
        ts={ts}
        onUseFile={onUseFile}
        saveName={saveName}
        save={save}
        playbackDeps={playbackDeps}
      />
    ),
    ready: !!take && !waitForFile,
    summaryLabel: '音',
    meter: take?.meter,
    summary: take
      ? `マイクの録音 ${formatClock(take.durationSec)}`
      : recording
        ? '録音しています'
        : 'まだ録っていません',
    // the take was recorded with this mic's remembered remainder (measuring needs an open mic, M7 has none)
    summaryExtra: take
      ? { label: '入力の遅れ', value: latencyText(state.remainderMs) }
      : undefined,
    startLabel: '下書きを作る',
    hint: take ? '数秒かかります。' : '先に録音してください。',
    retake: { label: '録り直す', onClick: recorder.retake },
    startNote:
      'マイクで録るときは、カウントの次の拍が 1 小節目の 1 拍目です。曲が途中から始まるときだけ、ここを変えます。',
    locked: recording,
  };
}
