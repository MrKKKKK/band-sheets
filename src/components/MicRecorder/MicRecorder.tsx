import { useEffect, useId, useMemo, useRef, type Ref } from 'react';
import { saveFile } from '../../audio/saveFile';
import { useHumPlayback, type HumPlayback } from '../../hooks/useHumPlayback';
import type { AudioPlayerDeps } from '../../hooks/useAudioPlayer';
import type { TonePlayer } from '../../hooks/tonePlayer.types';
import {
  useMicLevel,
  type MicRecorder as Recorder,
  type MicTake,
} from '../../hooks/useMicRecorder';
import { formatClock, formatFileSize } from '../../lib/import/format';
import type { TimeSig } from '../../lib/melody';
import { clickBeats, clickNotes } from '../../lib/mic/clickTrack';
import {
  CANCEL_COUNT_IN,
  COUNT_IN_NOTE,
  COUNT_IN_STATUS,
  DEFAULT_MIC_NOTE,
  ELAPSED_LABEL,
  FINISHING_STATUS,
  HEADPHONES_NOTE,
  LATENCY_HINT,
  latencyText,
  measureButtonText,
  MIC_ERROR_TEXTS,
  micLabel,
  readyNoticeText,
  RECORDING_NOTE,
  RECORDING_STATUS,
  recordNote,
  remainingText,
  RETAKE_BODY,
  RETAKE_NOTE,
  RETAKE_TITLE,
  SWITCH_TO_FILE,
  takeEndText,
  TAKE_STATUS,
} from '../../lib/mic/micTexts';
import type {
  Meter,
  RecorderState,
  TakeEnd,
} from '../../lib/mic/recorderState';
import { Button } from '../Button/Button';
import { ConfirmDialog } from '../ConfirmDialog/ConfirmDialog';
import { LatencyDialog } from '../LatencyDialog/LatencyDialog';
import { LevelMeter } from '../LevelMeter/LevelMeter';
import { TakeWaveform } from '../TakeWaveform/TakeWaveform';
import styles from './MicRecorder.module.css';

/** What the component reads and calls of `useMicRecorder`'s result (stories may pass a hand-made one). */
export type MicRecorderView = Pick<
  Recorder,
  | 'state'
  | 'take'
  | 'subscribeLevel'
  | 'getLevel'
  | 'open'
  | 'chooseMic'
  | 'measure'
  | 'closeMeasure'
  | 'record'
  | 'cancelCountIn'
  | 'stop'
  | 'retake'
  | 'cancelRetake'
  | 'confirmRetake'
>;

export type MicRecorderProps = {
  recorder: MicRecorderView;
  /** S2's time signature: the beats in the note under ● 録音 (M5 / M6 use the take's own meter). */
  ts: TimeSig;
  /** M2's 「ファイルを選ぶほうに切り替える」 shortcut. */
  onUseFile: () => void;
  /** The file name for 「録音を保存（wav）」 (`humTakeFileName`). */
  saveName: string;
  /** Writes the take to the PC. Default: `saveFile`. */
  save?: (blob: Blob, name: string) => void;
  /** Injected player parts for M7's listening (tests / stories). */
  playbackDeps?: { audio?: AudioPlayerDeps; createTone?: () => TonePlayer };
};

type Group = 'wait' | 'error' | 'ready' | 'count' | 'rec' | 'take';

/** Phases that belong to one screen of the canvas: focus moves only when the group changes. */
function groupOf(state: RecorderState): Group {
  switch (state.phase) {
    case 'closed':
    case 'opening':
      return 'wait';
    case 'micError':
      return 'error';
    case 'ready':
    case 'measuring':
    case 'measured':
    case 'measureFailed':
      return 'ready';
    case 'countIn':
      return 'count';
    case 'recording':
    case 'finishing':
      return 'rec';
    case 'take':
    case 'confirmRetake':
      return 'take';
  }
}

function meterText(m: Meter): string {
  return `♩= ${m.tempo} ・ ${m.ts.num}/${m.ts.den}`;
}

function MeterRow({ recorder }: { recorder: MicRecorderView }) {
  const level = useMicLevel(recorder);
  return <LevelMeter level={level} label="音の大きさ" />;
}

function BeatBoxes({
  count,
  beat,
  small = false,
}: {
  count: number;
  beat: number;
  small?: boolean;
}) {
  return (
    <div
      className={small ? styles.beatsSmall : styles.beats}
      aria-hidden="true"
      data-testid="beats"
    >
      {Array.from({ length: count }, (_, i) => (
        <b
          key={i}
          className={
            i + 1 < beat ? styles.done : i + 1 === beat ? styles.on : undefined
          }
          data-state={i + 1 < beat ? 'done' : i + 1 === beat ? 'on' : 'next'}
        >
          {i + 1}
        </b>
      ))}
    </div>
  );
}

/**
 * 「マイクで録る」 (docs/mic-recording-plan.md §2.7, canvas M1–M8): the mic panel inside S2's first card. Driven by
 * `useMicRecorder`'s result; it creates NO live region (S2's one says what the hook's `announce` is given) and its
 * error / notice boxes are not `role="alert"`. Focus: M3 → ● 録音, M5 → やめる, M6 → ■ 止める, M7 → the take's
 * heading, M2 → the error box (moved when the screen changes, not on mount).
 */
export function MicRecorder({
  recorder,
  ts,
  onUseFile,
  saveName,
  save = saveFile,
  playbackDeps,
}: MicRecorderProps) {
  const { state } = recorder;
  const group = groupOf(state);
  const recordRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const takeRef = useRef<HTMLHeadingElement>(null);
  const prevGroup = useRef(group);

  useEffect(() => {
    if (prevGroup.current === group) return;
    prevGroup.current = group;
    const target: Record<Group, { current: HTMLElement | null } | null> = {
      wait: null,
      error: errorRef,
      ready: recordRef,
      count: cancelRef,
      rec: stopRef,
      take: takeRef,
    };
    target[group]?.current?.focus();
  }, [group]);

  const selectId = useId();
  const noteId = useId();

  if (state.phase === 'closed' || state.phase === 'opening') {
    return (
      <div className={styles.mic} data-testid="mic-panel" data-phase="waiting">
        <div className={styles.row}>
          <label className={styles.label} htmlFor={selectId}>
            マイク
          </label>
          <select
            id={selectId}
            className={styles.select}
            disabled
            aria-describedby={noteId}
          >
            <option>マイクの許可を待っています…</option>
          </select>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>音の大きさ</span>
          <LevelMeter level={0} label="音の大きさ" />
        </div>
        <div className={styles.row}>
          <Button
            variant="primary"
            className={styles.recBtn}
            disabled
            aria-describedby={noteId}
          >
            ● 録音
          </Button>
          <span id={noteId} className={styles.note}>
            マイクが使えるようになると押せます。
          </span>
        </div>
      </div>
    );
  }

  if (state.phase === 'micError') {
    const text = MIC_ERROR_TEXTS[state.error];
    return (
      <div className={styles.mic} data-testid="mic-panel" data-phase="error">
        <div
          ref={errorRef}
          className={styles.err}
          tabIndex={-1}
          data-testid="mic-error"
        >
          <strong>{text.title}</strong>
          <br />
          {text.body}
        </div>
        <div className={styles.row}>
          {text.retry ? (
            <Button onClick={recorder.open}>{text.retry}</Button>
          ) : null}
          <Button variant="ghost" onClick={onUseFile}>
            {SWITCH_TO_FILE}
          </Button>
        </div>
      </div>
    );
  }

  if (state.phase === 'countIn') {
    return (
      <div className={styles.mic} data-testid="mic-panel" data-phase="countIn">
        <div className={styles.head}>
          <strong className={styles.status}>{COUNT_IN_STATUS}</strong>
          <span className={styles.meterText}>{meterText(state.meter)}</span>
        </div>
        <BeatBoxes count={state.meter.ts.num} beat={state.beat} />
        <p className={styles.noteCenter}>{COUNT_IN_NOTE}</p>
        <div className={styles.row}>
          <span className={styles.label}>音の大きさ</span>
          <MeterRow recorder={recorder} />
        </div>
        <div className={styles.center}>
          <Button ref={cancelRef} onClick={recorder.cancelCountIn}>
            {CANCEL_COUNT_IN}
          </Button>
        </div>
      </div>
    );
  }

  if (state.phase === 'recording' || state.phase === 'finishing') {
    return (
      <div
        className={styles.mic}
        data-testid="mic-panel"
        data-phase={state.phase}
      >
        {state.phase === 'recording' ? (
          <>
            <div className={styles.head}>
              <strong className={styles.status}>
                <span className={styles.dot} aria-hidden="true" />
                {RECORDING_STATUS}
              </strong>
              <span className={styles.meterText}>{meterText(state.meter)}</span>
            </div>
            <div className={styles.big}>
              <div className={styles.bigCell}>
                <p className={styles.note}>{ELAPSED_LABEL}</p>
                <p className={styles.bigNum} data-testid="elapsed">
                  {formatClock(state.elapsedSec)}
                </p>
              </div>
              <div className={styles.bigCell}>
                <p className={styles.note}>いま</p>
                <p className={styles.bigNum} data-testid="bar">
                  {state.bar}
                  <span className={styles.bigUnit}> 小節目</span>
                </p>
              </div>
              <BeatBoxes small count={state.meter.ts.num} beat={state.beat} />
            </div>
            {state.remainingSec !== null ? (
              <p className={styles.remaining} data-testid="remaining">
                {remainingText(state.remainingSec)}
              </p>
            ) : null}
            <div className={styles.row}>
              <span className={styles.label}>音の大きさ</span>
              <MeterRow recorder={recorder} />
            </div>
            <p className={styles.note}>{RECORDING_NOTE}</p>
            <div className={styles.center}>
              <Button
                ref={stopRef}
                variant="primary"
                className={`${styles.recBtn} ${styles.stopBtn}`}
                onClick={recorder.stop}
              >
                ■ 止める
              </Button>
            </div>
          </>
        ) : (
          <p className={styles.status}>{FINISHING_STATUS}</p>
        )}
      </div>
    );
  }

  if (state.phase === 'take' || state.phase === 'confirmRetake') {
    return (
      <div className={styles.mic} data-testid="mic-panel" data-phase="take">
        {recorder.take ? (
          <TakeCard
            take={recorder.take}
            end={state.end}
            recorder={recorder}
            saveName={saveName}
            save={save}
            playbackDeps={playbackDeps}
            headingRef={takeRef}
          />
        ) : null}
        <ConfirmDialog
          open={state.phase === 'confirmRetake'}
          title={RETAKE_TITLE}
          message={`${RETAKE_BODY}${RETAKE_NOTE}`}
          cancelLabel="やめる"
          confirmLabel="録り直す"
          onCancel={recorder.cancelRetake}
          onConfirm={recorder.confirmRetake}
        />
      </div>
    );
  }

  // ready (M3) and its dialog phases (M4)
  const devices = state.devices;
  const current =
    devices.find((d) => d.deviceId === state.deviceId) ??
    devices.find((d) => d.isDefault) ??
    devices[0];
  return (
    <div className={styles.mic} data-testid="mic-panel" data-phase="ready">
      {state.phase === 'ready' && state.notice ? (
        <div className={styles.notice} data-testid="mic-notice">
          {readyNoticeText(state.notice)}
        </div>
      ) : null}
      <div className={styles.row}>
        <label className={styles.label} htmlFor={selectId}>
          マイク
        </label>
        <select
          id={selectId}
          className={styles.select}
          value={current?.deviceId ?? ''}
          onChange={(e) => recorder.chooseMic(e.target.value)}
          aria-describedby={current?.isDefault ? noteId : undefined}
        >
          {devices.length === 0 ? <option value="">マイク</option> : null}
          {devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {micLabel(d, i)}
            </option>
          ))}
        </select>
        {current?.isDefault ? (
          <span id={noteId} className={styles.note}>
            {DEFAULT_MIC_NOTE}
          </span>
        ) : null}
      </div>
      <div className={styles.row}>
        <span className={styles.label}>音の大きさ</span>
        <MeterRow recorder={recorder} />
        <span className={`${styles.note} ${styles.meterHint}`}>
          声を出して確かめます
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.labelWide}>入力の遅れ（このマイク）</span>
        <span className={styles.value} data-testid="latency-value">
          {latencyText(state.remainderMs)}
        </span>
        <Button className={styles.small} onClick={recorder.measure}>
          {measureButtonText(state.remainderMs)}
        </Button>
      </div>
      {state.remainderMs === null ? (
        <div className={styles.hint}>
          <span>{LATENCY_HINT}</span>
        </div>
      ) : null}
      <div className={styles.row}>
        <Button
          ref={recordRef}
          variant="primary"
          className={`${styles.recBtn} ${styles.recWide}`}
          onClick={recorder.record}
          disabled={state.phase !== 'ready'}
        >
          ● 録音
        </Button>
        <span className={styles.note}>
          <strong className={styles.strong}>{HEADPHONES_NOTE}</strong>
          {recordNote(ts.num)}
        </span>
      </div>
      <LatencyDialog
        state={state}
        onClose={recorder.closeMeasure}
        onMeasure={recorder.measure}
      />
    </div>
  );
}

function TakeCard({
  take,
  end,
  recorder,
  saveName,
  save,
  playbackDeps,
  headingRef,
}: {
  take: MicTake;
  end: TakeEnd;
  recorder: MicRecorderView;
  saveName: string;
  save: (blob: Blob, name: string) => void;
  playbackDeps?: MicRecorderProps['playbackDeps'];
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const sounding = useMemo(
    () =>
      clickNotes(clickBeats(take.meter.tempo, take.meter.ts, take.durationSec)),
    [take],
  );
  const pb: HumPlayback = useHumPlayback(take.file, sounding, playbackDeps);
  const { player } = pb;
  const clickId = useId();
  const bars = Math.max(
    0,
    Math.round((take.durationSec - take.bar1Sec) / take.bar1Sec),
  );
  const endText = takeEndText(end);
  return (
    <>
      <div className={styles.head}>
        <strong className={styles.status}>{TAKE_STATUS}</strong>
        <span className={styles.meterText}>{meterText(take.meter)}</span>
      </div>
      {endText ? (
        <div className={styles.notice} data-testid="take-end-notice">
          {endText}
        </div>
      ) : null}
      <div className={styles.takeCard}>
        <div className={styles.takeHead}>
          <h3 ref={headingRef} tabIndex={-1} className={styles.takeTitle}>
            録音 1 つ
          </h3>
          <span className={styles.takeInfo} data-testid="take-info">
            長さ {formatClock(take.durationSec)}（約 {bars} 小節）・{' '}
            {formatFileSize(take.file.size)}（この端末の中だけ）
          </span>
        </div>
        <TakeWaveform
          peaks={take.peaks}
          durationSec={take.durationSec}
          bar1Sec={take.bar1Sec}
          playheadSec={
            player.playing || player.currentTime > 0 ? player.currentTime : null
          }
          label="録音の波形"
        />
        <div className={styles.row}>
          <Button
            variant="primary"
            onClick={() => (player.playing ? pb.pause() : pb.play())}
            disabled={player.failed}
          >
            {player.playing ? '■ 止める' : '▶ 聞く'}
          </Button>
          <label className={styles.check} htmlFor={clickId}>
            <input
              id={clickId}
              type="checkbox"
              defaultChecked
              onChange={(e) => {
                pb.setMode(e.target.checked ? 'both' : 'recording');
              }}
            />
            クリックも一緒に聞く
          </label>
          <span className={styles.note}>
            {player.failed
              ? 'この録音を再生できませんでした。'
              : 'ヘッドホンのままで聞くと、歌とクリックのずれが確かめられます。'}
          </span>
        </div>
      </div>
      <div className={styles.row}>
        <Button onClick={recorder.retake}>録り直す</Button>
        <Button onClick={() => save(take.file, saveName)}>
          録音を保存（wav）
        </Button>
        <span className={styles.note}>録り直すと、この録音は消えます。</span>
      </div>
    </>
  );
}
