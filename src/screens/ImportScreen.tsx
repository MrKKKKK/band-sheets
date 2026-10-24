/**
 * 「録音から新しい曲」 (docs/audio-integration-plan.md §4 S1 → S3, v1a): pick an audio file, analyse it in a
 * Worker (progress, 「中止」, Japanese errors), review the chord draft, then hand the song text to `onCreate`
 * (Root makes a new device-only song and opens the editor).
 *
 * Loaded ONLY with React.lazy from Root: this module (and the analysis client it imports) is its own chunk, so the
 * first load (list, editor, tablet viewer) carries no analysis code (scripts/check-bundle.mjs). The client is
 * imported statically HERE on purpose: a second dynamic import() would put rolldown's namespace helper in the
 * app's entry chunk, which the CSP e2e harness page (sharing the client chunk) would then have to load. Nothing is stored:
 * the file, the result and the review choices live in this component's state only (plan §5).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createAnalysisClient } from '../analysis/analysisClient';
import { probeDuration } from '../analysis/probeDuration';
import {
  isAnalysisError,
  MAX_DURATION_SEC,
  type AnalysisClient,
  type AnalysisErrorCode,
  type AnalysisProgress,
} from '../analysis/types';
import { Button } from '../components/Button/Button';
import { ChordReview } from '../components/ChordReview/ChordReview';
import {
  ImportPicker,
  type ImportNotice,
} from '../components/ImportPicker/ImportPicker';
import { ImportProgress } from '../components/ImportProgress/ImportProgress';
import { useAudioPlayer } from '../hooks/useAudioPlayer';
import type { TsAnalysisResult } from '../lib/analysis/chords/result';
import { CHORDS_CONFIG_HASH } from '../lib/analysis/origin';
import {
  draftSongText,
  formatDurationJa,
  importProgressView,
  type ReviewState,
} from '../lib/import/chordReview';
import { formatDraftDate } from '../lib/import/draftMarks';
import { importErrorInfo } from '../lib/import/importErrors';
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

type Phase =
  | {
      kind: 'pick';
      file: File | null;
      duration: number | null;
      /** The chosen file's length is still being read. */
      probing?: boolean;
      notice: ImportNotice | null;
    }
  | {
      kind: 'analyzing';
      file: File;
      duration: number | null;
      progress: AnalysisProgress | null;
    }
  | { kind: 'review'; file: File; result: TsAnalysisResult };

/** Errors after which the same file may work on a second try. */
const RETRYABLE = new Set<AnalysisErrorCode>([
  'worker-crashed',
  'out-of-memory',
  'internal',
]);

function noticeFor(code: AnalysisErrorCode): ImportNotice {
  const info = importErrorInfo(code);
  return {
    severity: info.severity,
    message: info.message,
    retry: code === 'cancelled' || RETRYABLE.has(code),
  };
}

export function ImportScreen({
  client: injected,
  onBackToList,
  onCreate,
  now = () => new Date(),
  probe = probeDuration,
}: ImportScreenProps) {
  const [phase, setPhase] = useState<Phase>({
    kind: 'pick',
    file: null,
    duration: null,
    notice: null,
  });
  const [live, setLive] = useState('');
  const clientRef = useRef<AnalysisClient | null>(injected ?? null);
  /** Bumped by every start / cancel / unmount: late results of an older run are dropped. */
  const runRef = useRef(0);
  const h1Ref = useRef<HTMLHeadingElement>(null);
  const progressRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<'h1' | 'progress' | 'notice' | 'review' | null>(
    'h1',
  );

  const say = useCallback((msg: string) => {
    // An unchanged live region is not read again: toggle a trailing NBSP.
    setLive((prev) => (prev === msg ? `${msg} ` : msg));
  }, []);

  // Move focus to what the new phase is about.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    const el = {
      h1: h1Ref,
      progress: progressRef,
      notice: noticeRef,
      review: reviewRef,
    }[target].current;
    // Not rendered yet (an earlier update of the same run committed first): try on the next commit.
    if (!el) return;
    focusNext.current = null;
    el.focus();
  }, [phase]);

  // Leaving the screen stops a running analysis (plan §6.2).
  useEffect(
    () => () => {
      runRef.current++;
      clientRef.current?.cancel();
    },
    [],
  );

  const pick = async (file: File) => {
    const run = ++runRef.current;
    // Show the new file at once; 「解析を始める」 waits for its length.
    setPhase({
      kind: 'pick',
      file,
      duration: null,
      probing: true,
      notice: null,
    });
    const duration = await probe(file).catch(() => null);
    if (run !== runRef.current) return;
    if (duration !== null && duration > MAX_DURATION_SEC) {
      const notice = noticeFor('too-long');
      focusNext.current = 'notice';
      setPhase({ kind: 'pick', file: null, duration: null, notice });
      say(notice.message);
      return;
    }
    setPhase({ kind: 'pick', file, duration, notice: null });
    say(
      `${file.name} を選びました${duration !== null ? `。長さ ${formatDurationJa(duration)}` : ''}`,
    );
  };

  const fail = (
    file: File,
    duration: number | null,
    code: AnalysisErrorCode,
  ) => {
    const notice = noticeFor(code);
    focusNext.current = 'notice';
    setPhase({
      kind: 'pick',
      file: code === 'too-long' ? null : file,
      duration: code === 'too-long' ? null : duration,
      notice,
    });
    say(notice.message);
  };

  const start = async (file: File, duration: number | null) => {
    const run = ++runRef.current;
    focusNext.current = 'progress';
    setPhase({ kind: 'analyzing', file, duration, progress: null });
    say('解析を始めました。1 / 6 段階: 音声を読み込む');
    const client = clientRef.current ?? createAnalysisClient();
    clientRef.current = client;
    let step = 1;
    try {
      const result = await client.run(
        { kind: 'chords', source: { file } },
        (p) => {
          if (run !== runRef.current) return;
          setPhase((ph) =>
            ph.kind === 'analyzing' ? { ...ph, progress: p } : ph,
          );
          const v = importProgressView(p);
          if (v.current !== step && v.fraction < 1) {
            step = v.current;
            say(`${step} / ${v.steps.length} 段階: ${v.steps[step - 1].label}`);
          }
        },
      );
      if (run !== runRef.current) return;
      focusNext.current = 'review';
      setPhase({ kind: 'review', file, result });
      say('解析が終わりました。コード譜の下書きを確かめてください');
    } catch (e) {
      if (run !== runRef.current) return;
      fail(file, duration, isAnalysisError(e) ? e.code : 'internal');
    }
  };

  const cancel = () => {
    if (phase.kind !== 'analyzing') return;
    runRef.current++;
    clientRef.current?.cancel();
    fail(phase.file, phase.duration, 'cancelled');
  };

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

  const back = () => {
    if (phase.kind === 'analyzing') {
      runRef.current++;
      clientRef.current?.cancel();
    }
    onBackToList();
  };

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Button variant="ghost" className={styles.back} onClick={back}>
          ‹ 曲の一覧
        </Button>
        <p className={styles.brand}>band-sheets</p>
        <span className={styles.spacer} />
        <span className={styles.muted}>PC のブラウザで解析します</span>
      </header>
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
                if (phase.file && !phase.probing)
                  void start(phase.file, phase.duration);
              }}
              onRetry={() => {
                if (phase.file && !phase.probing)
                  void start(phase.file, phase.duration);
              }}
            />
          )}
        </div>
      </main>
      {liveRegion}
    </div>
  );
}
