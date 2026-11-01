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
import { formatDurationJa } from '../lib/import/format';
import {
  importProgressView,
  type ImportStep,
} from '../lib/import/importProgress';
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
  /** The progress steps table. */
  steps: readonly ImportStep[];
  /** Announced when the analysis ends in the review. */
  doneMessage: string;
  /** A result that cannot become a draft: the notice to show instead of the review. */
  rejectResult?: (result: AnalysisResultMap[R['kind']]) => ImportNotice | null;
  /** The notice for a failed `startFile` run (a recording the screen made). Default: noticeFor. */
  takeNotice?: (code: AnalysisErrorCode) => ImportNotice;
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
  /** Analyse the file picked so far (its length known); does nothing without one, or while its length is read. */
  start: (request: R) => Promise<void>;
  /**
   * Analyse `file` whose length is already known (a recording the screen made): no length probe and no
   * 「選びました」 announcement. On failure / cancel the pick phase shows the file picked BEFORE (or none), so the
   * picked file and the recording both survive. Reads no render-time state, so it works right after a state change
   * in the same handler. Does nothing while an analysis runs. A pick whose length is still being read is
   * discarded (the file comes back with `duration: null`), so callers should wait for the probe.
   */
  startFile: (file: File, durationSec: number, request: R) => Promise<void>;
  cancel: () => void;
}

export function useAnalysisRun<R extends AnalysisRequest>({
  client: injected,
  probe,
  steps,
  doneMessage,
  rejectResult,
  takeNotice = noticeFor,
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
  type Picked = { file: File | null; duration: number | null };
  /** The file picked with `pick` (what failure / cancel returns to); kept in a ref so no handler reads a stale render. */
  const pickedRef = useRef<Picked>({ file: null, duration: null });
  /** Where the running analysis returns to on failure / cancel. */
  const backRef = useRef<Picked>({ file: null, duration: null });
  const analyzingRef = useRef(false);

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
    analyzingRef.current = false;
    pickedRef.current = { file, duration };
    setPhase({ kind: 'pick', file, duration, notice });
    say(notice.message);
  };

  const pick = async (file: File) => {
    if (phase.kind === 'analyzing') return;
    const run = ++runRef.current;
    pickedRef.current = { file, duration: null };
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
      showNotice(null, null, noticeFor('too-long'));
      return;
    }
    pickedRef.current = { file, duration };
    setPhase({ kind: 'pick', file, duration, notice: null });
    say(
      `${file.name} を選びました${duration !== null ? `。長さ ${formatDurationJa(duration)}` : ''}`,
    );
  };

  /** Runs the analysis of `file`; failure / cancel return to `back`. */
  const analyze = async (
    file: File,
    duration: number | null,
    back: Picked,
    request: R,
    failNotice: (code: AnalysisErrorCode) => ImportNotice = noticeFor,
  ) => {
    const run = ++runRef.current;
    analyzingRef.current = true;
    backRef.current = back;
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
        showNotice(back.file, back.duration, rejected);
        return;
      }
      analyzingRef.current = false;
      focusNext.current = 'review';
      setPhase({ kind: 'review', file, result });
      say(doneMessage);
    } catch (e) {
      if (run !== runRef.current) return;
      const code = isAnalysisError(e) ? e.code : 'internal';
      if (code === 'too-long' && back.file === file)
        showNotice(null, null, failNotice(code));
      else showNotice(back.file, back.duration, failNotice(code));
    }
  };

  const start = async (request: R) => {
    if (phase.kind !== 'pick' || !phase.file || phase.probing) return;
    const { file, duration } = phase;
    await analyze(file, duration, { file, duration }, request);
  };

  const startFile = async (file: File, durationSec: number, request: R) => {
    if (analyzingRef.current) return;
    await analyze(
      file,
      durationSec,
      { ...pickedRef.current },
      request,
      takeNotice,
    );
  };

  const cancel = () => {
    if (phase.kind !== 'analyzing') return;
    runRef.current++;
    clientRef.current?.cancel();
    showNotice(
      backRef.current.file,
      backRef.current.duration,
      noticeFor('cancelled'),
    );
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
    startFile,
    cancel,
  };
}
