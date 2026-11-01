/**
 * 「録音から新しい曲」 (docs/audio-integration-plan.md §4 S1 → S3, v1a): pick an audio file, analyse it in a
 * Worker (progress, 「中止」, Japanese errors), review the chord draft, then hand the song text to `onCreate`
 * (Root makes a new device-only song and opens the editor).
 *
 * Loaded ONLY with React.lazy from Root: this module (and the analysis client it imports) is its own chunk, so the
 * first load (list, editor, tablet viewer) carries no analysis code (scripts/check-bundle.mjs). The client is
 * imported statically (by useAnalysisRun, which only the import screens use) on purpose: a second dynamic import() would put rolldown's namespace helper in the
 * app's entry chunk, which the CSP e2e harness page (sharing the client chunk) would then have to load. Nothing is stored:
 * the file, the result and the review choices live in this component's state only (plan §5).
 */
import { probeDuration } from '../analysis/probeDuration';
import type { AnalysisClient, ChordsRequest } from '../analysis/types';
import { ChordReview } from '../components/ChordReview/ChordReview';
import { ImportFrame } from '../components/ImportFrame/ImportFrame';
import { ImportPicker } from '../components/ImportPicker/ImportPicker';
import { ImportProgress } from '../components/ImportProgress/ImportProgress';
import { useAnalysisRun } from '../hooks/useAnalysisRun';
import { useAudioPlayer } from '../hooks/useAudioPlayer';
import { usePageDropGuard } from '../hooks/usePageDropGuard';
import { CHORDS_CONFIG_HASH } from '../lib/analysis/origin';
import { draftSongText, type ReviewState } from '../lib/import/chordReview';
import { CHORD_STEPS } from '../lib/import/importProgress';
import { formatDraftDate } from '../lib/import/draftMarks';
import styles from './ImportScreen.module.css';

export type ImportScreenProps = {
  /** Default: the real client (src/analysis/analysisClient.ts), made on the first run. */
  client?: AnalysisClient;
  onBackToList: () => void;
  /** The new song's text (draft marks included). */
  onCreate: (text: string) => void;
  now?: () => Date;
  /** Default: probeDuration (WAV header / <audio> metadata). */
  probe?: (file: Blob) => Promise<number | null>;
};

export function ImportScreen({
  client: injected,
  onBackToList,
  onCreate,
  now = () => new Date(),
  probe = probeDuration,
}: ImportScreenProps) {
  const {
    phase,
    live,
    say,
    h1Ref,
    progressRef,
    noticeRef,
    reviewRef,
    pick,
    start,
    cancel,
  } = useAnalysisRun<ChordsRequest>({
    client: injected,
    probe,
    steps: CHORD_STEPS,
    doneMessage: '解析が終わりました。コード譜の下書きを確かめてください',
  });

  usePageDropGuard();

  const player = useAudioPlayer(phase.kind === 'review' ? phase.file : null);

  const create = (state: ReviewState) => {
    if (phase.kind !== 'review') return;
    player.pause();
    onCreate(
      draftSongText(phase.result, state, {
        date: formatDraftDate(now()),
        configHash: CHORDS_CONFIG_HASH,
      }),
    );
  };

  const liveRegion = (
    <p className={styles.srOnly} role="status" data-testid="import-live">
      {live}
    </p>
  );

  if (phase.kind === 'review') {
    return (
      <>
        <ChordReview
          result={phase.result}
          fileName={phase.file.name}
          player={player}
          onCreate={create}
          onBack={onBackToList}
          say={say}
          headingRef={reviewRef}
        />
        {liveRegion}
      </>
    );
  }

  return (
    <ImportFrame
      backLabel="‹ 曲の一覧"
      onBack={onBackToList}
      note="PC のブラウザで解析します"
    >
      <main className={styles.main}>
        <div className={styles.column}>
          <div className={styles.intro}>
            <h1 ref={h1Ref} tabIndex={-1} className={styles.h1}>
              録音から新しい曲
            </h1>
            <p className={styles.lead}>
              音声ファイルから、テンポ・キー・セクション・コードの
              <strong>下書き</strong>
              を作ります。次の画面で内容を確かめてから、新しい曲にします。
            </p>
          </div>
          {phase.kind === 'analyzing' ? (
            <ImportProgress
              fileName={phase.file.name}
              duration={phase.duration}
              progress={phase.progress}
              onCancel={cancel}
              headingRef={progressRef}
              steps={CHORD_STEPS}
            />
          ) : (
            <ImportPicker
              file={
                phase.file
                  ? {
                      name: phase.file.name,
                      size: phase.file.size,
                      duration: phase.duration,
                      probing: phase.probing,
                    }
                  : null
              }
              notice={phase.notice}
              noticeRef={noticeRef}
              onPick={(f) => void pick(f)}
              onStart={() => {
                if (phase.file)
                  void start({
                    kind: 'chords',
                    source: { file: phase.file },
                  });
              }}
            />
          )}
        </div>
      </main>
      {liveRegion}
    </ImportFrame>
  );
}
