/**
 * The state machine the two import screens share (ImportScreen: chords, HumImportScreen: humming): pick a file
 * (its length is probed), start an analysis, show progress, cancel, fail with a Japanese notice, and land on the
 * review. Also owns what goes with it: the screen's ONE live region text, where focus goes after each phase
 * change, and stopping a running analysis when the screen unmounts (plan §6.2). The screens keep only what
 * differs: the request, the steps table, and what to do with a result.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createAnalysisClient } from '../analysis/analysisClient';
import {
  isAnalysisError,
  MAX_DURATION_SEC,
  type AnalysisClient,
  type AnalysisErrorCode,
  type AnalysisProgress,
  type AnalysisRequest,
  type AnalysisResultMap,
} from '../analysis/types';
import {
  formatDurationJa,
  importProgressView,
} from '../lib/import/chordReview';
import { noticeFor, type ImportNotice } from '../lib/import/importErrors';

export type RunPhase<Result> =
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
  | { kind: 'review'; file: File; result: Result };

export interface AnalysisRunOptions<R extends AnalysisRequest> {
  /** Default: the real client (src/analysis/analysisClient.ts), made on the first run. */
  client?: AnalysisClient;
  /** File length reader (probeDuration or a test double). */
  probe: (file: Blob) => Promise<number | null>;
  /** The progress steps table; default: the chords one. */
  steps?: Parameters<typeof importProgressView>[1];
  /** Announced when the analysis ends in the review. */
  doneMessage: string;
  /** A result that cannot become a draft: the notice to show instead of the review. */
  rejectResult?: (result: AnalysisResultMap[R['kind']]) => ImportNotice | null;
}

type FocusTarget = 'h1' | 'progress' | 'notice' | 'review';

export interface AnalysisRun<R extends AnalysisRequest> {
  phase: RunPhase<AnalysisResultMap[R['kind']]>;
  /** The live region's text. */
  live: string;
  /** Announce `msg` (an unchanged message is made different so it is read again). */
  say: (msg: string) => void;
  /** Attach to the heading / notice that should take focus in each phase. */
  h1Ref: RefObject<HTMLHeadingElement | null>;
  progressRef: RefObject<HTMLHeadingElement | null>;
  noticeRef: RefObject<HTMLDivElement | null>;
  reviewRef: RefObject<HTMLHeadingElement | null>;
  pick: (file: File) => Promise<void>;
  start: (file: File, duration: number | null, request: R) => Promise<void>;
  cancel: () => void;
}

export function useAnalysisRun<R extends AnalysisRequest>({
  client: injected,
  probe,
  steps,
  doneMessage,
  rejectResult,
}: AnalysisRunOptions<R>): AnalysisRun<R> {
  type Phase = RunPhase<AnalysisResultMap[R['kind']]>;
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
  const focusNext = useRef<FocusTarget | null>('h1');

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

  const stepText = (p: AnalysisProgress | null) => {
    const v = importProgressView(p, steps);
    return `${v.current} / ${v.steps.length} 段階: ${v.steps[v.current - 1].label}`;
  };

  const showNotice = (
    file: File | null,
    duration: number | null,
    notice: ImportNotice,
  ) => {
    focusNext.current = 'notice';
    setPhase({ kind: 'pick', file, duration, notice });
    say(notice.message);
  };

  const fail = (
    file: File,
    duration: number | null,
    code: AnalysisErrorCode,
  ) =>
    code === 'too-long'
      ? showNotice(null, null, noticeFor(code))
      : showNotice(file, duration, noticeFor(code));

  const pick = async (file: File) => {
    if (phase.kind === 'analyzing') return;
    const run = ++runRef.current;
    // Show the new file at once; starting waits for its length.
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
      fail(file, null, 'too-long');
      return;
    }
    setPhase({ kind: 'pick', file, duration, notice: null });
    say(
      `${file.name} を選びました${duration !== null ? `。長さ ${formatDurationJa(duration)}` : ''}`,
    );
  };

  const start = async (file: File, duration: number | null, request: R) => {
    const run = ++runRef.current;
    focusNext.current = 'progress';
    setPhase({ kind: 'analyzing', file, duration, progress: null });
    say(`解析を始めました。${stepText(null)}`);
    const client = clientRef.current ?? createAnalysisClient();
    clientRef.current = client;
    let step = 1;
    try {
      const result = await client.run(request, (p) => {
        if (run !== runRef.current) return;
        setPhase((ph) =>
          ph.kind === 'analyzing' ? { ...ph, progress: p } : ph,
        );
        const v = importProgressView(p, steps);
        if (v.current !== step && v.fraction < 1) {
          step = v.current;
          say(stepText(p));
        }
      });
      if (run !== runRef.current) return;
      const rejected = rejectResult?.(result);
      if (rejected) {
        showNotice(file, duration, rejected);
        return;
      }
      focusNext.current = 'review';
      setPhase({ kind: 'review', file, result });
      say(doneMessage);
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

  return {
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
  };
}
