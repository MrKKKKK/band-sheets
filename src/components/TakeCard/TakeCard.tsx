import { useId, useMemo, type Ref } from 'react';
import type { AudioPlayerDeps } from '../../hooks/useAudioPlayer';
import { useHumPlayback, type HumPlayback } from '../../hooks/useHumPlayback';
import type { TonePlayer } from '../../hooks/tonePlayer.types';
import { formatClock, formatFileSize } from '../../lib/import/format';
import {
  meterText,
  PAUSE_LABEL,
  PLAY_FAILED,
  PLAY_LABEL,
  RETAKE_BUTTON,
  RETAKE_HINT,
  SAVE_WAV_BUTTON,
  TAKE_HEADING,
  TAKE_PLAY_HINT,
  takeEndText,
  TAKE_STATUS,
  WITH_CLICK_LABEL,
} from '../../lib/mic/micTexts';
import type { TakeEnd } from '../../lib/mic/recorderState';
import type { MicTake } from '../../lib/mic/take';
import { takeBars, takeClickNotes } from '../../lib/mic/takeView';
import { Button } from '../Button/Button';
import { TakeWaveform } from '../TakeWaveform/TakeWaveform';
import styles from './TakeCard.module.css';

/** Injected player parts for listening to the take (tests / stories). */
export type TakePlaybackDeps = {
  audio?: AudioPlayerDeps;
  createTone?: () => TonePlayer;
};

/** M7's take: status, waveform, listening (with or without the clicks), 録り直す and 録音を保存. */
export function TakeCard({
  take,
  end,
  onRetake,
  saveName,
  save,
  playbackDeps,
  headingRef,
}: {
  take: MicTake;
  end: TakeEnd;
  onRetake: () => void;
  saveName: () => string;
  save: (blob: Blob, name: string) => void;
  playbackDeps?: TakePlaybackDeps;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const sounding = useMemo(() => takeClickNotes(take), [take]);
  const pb: HumPlayback = useHumPlayback(take.file, sounding, playbackDeps);
  const { player } = pb;
  const clickId = useId();
  const bars = takeBars(take);
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
            {TAKE_HEADING}
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
            {player.playing ? PAUSE_LABEL : PLAY_LABEL}
          </Button>
          <label className={styles.check} htmlFor={clickId}>
            <input
              id={clickId}
              type="checkbox"
              checked={pb.mode !== 'recording'}
              onChange={(e) => {
                pb.setMode(e.target.checked ? 'both' : 'recording');
              }}
            />
            {WITH_CLICK_LABEL}
          </label>
          <span className={styles.note}>
            {player.failed ? PLAY_FAILED : TAKE_PLAY_HINT}
          </span>
        </div>
      </div>
      <div className={styles.row}>
        <Button onClick={onRetake}>{RETAKE_BUTTON}</Button>
        <Button onClick={() => save(take.file, saveName())}>
          {SAVE_WAV_BUTTON}
        </Button>
        <span className={styles.note}>{RETAKE_HINT}</span>
      </div>
    </>
  );
}
