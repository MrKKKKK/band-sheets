/**
 * 「鼻歌から下書き」 (docs/audio-integration-plan.md §4 S2 → S4, v1b): pick a humming recording and say where it
 * goes (S2), analyse it in a Worker (progress, 「中止」, Japanese errors), check it against the recording (S4),
 * then hand the song with the section rewritten to `onInsert` — ONE song, so the editor does one setText.
 *
 * Shown by App in place of the editor (which stays mounted, hidden: its draft / autosave keep working) and
 * loaded ONLY with React.lazy from there: this module and the analysis client it imports statically are their
 * own chunk (scripts/check-bundle.mjs; see ImportScreen for why the client is a static import here). Nothing is
 * stored: the file, the result and the choices live in this component's state only (plan §5); only the note-name
 * display mode is remembered per device.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAnalysisClient } from '../analysis/analysisClient';
import { probeDuration } from '../analysis/probeDuration';
import {
  isAnalysisError,
  MAX_DURATION_SEC,
  type AnalysisClient,
  type AnalysisErrorCode,
  type AnalysisProgress,
} from '../analysis/types';
import {
  HumReview,
  type HumReviewProps,
} from '../components/HumReview/HumReview';
import { HumSetup, type HumSetupValue } from '../components/HumSetup/HumSetup';
import { ImportFrame } from '../components/ImportFrame/ImportFrame';
import { ImportProgress } from '../components/ImportProgress/ImportProgress';
import { usePageDropGuard } from '../hooks/usePageDropGuard';
import type { HumAnalysisResult } from '../lib/analysis/hum/types';
import { DEFAULT_TEMPO } from '../lib/autoScroll';
import {
  formatDurationJa,
  importProgressView,
} from '../lib/import/chordReview';
import {
  HUM_STEPS,
  humRunInfo,
  humTargets,
  insertHumDraft,
} from '../lib/import/humImport';
import {
  humNoVoiceNotice,
  noticeFor,
  type ImportNotice,
} from '../lib/import/importErrors';
import type { MelodyEvent, TimeSig } from '../lib/melody';
import { UNTITLED } from '../lib/serializeSong';
import type { Song } from '../lib/song';
import {
  loadNoteNameMode,
  saveNoteNameMode,
  type KeyValueStorage,
} from '../lib/storage';
import styles from './ImportScreen.module.css';

export type HumImportScreenProps = {
  song: Song;
  /** The melody part to write into (index in `song.parts`), -1 = none yet (a 「Vocal」 part is added). */
  partIndex: number;
  /** Shown only when the song has more than one melody part. */
  partName?: string;
  /** The section the editor was showing (S2's initial target). */
  initialLabel: string;
  /** The part's effective time signature and key (MelodyEditor's). */
  ts: TimeSig;
  keySig?: string;
  storage: KeyValueStorage | null;
  /** The song with the draft written into `label`. */
  onInsert: (song: Song, label: string) => void;
  onBack: () => void;
  /** Default: the real client, made on the first run. */
  client?: AnalysisClient;
  /** Default: probeDuration. */
  probe?: (file: Blob) => Promise<number | null>;
  playbackDeps?: HumReviewProps['playbackDeps'];
};

type Phase =
  | {
      kind: 'setup';
      file: File | null;
      duration: number | null;
      probing?: boolean;
      notice: ImportNotice | null;
    }
  | {
      kind: 'analyzing';
      file: File;
      duration: number | null;
      progress: AnalysisProgress | null;
    }
  | { kind: 'review'; file: File; result: HumAnalysisResult };

const stepText = (p: AnalysisProgress | null) => {
  const v = importProgressView(p, HUM_STEPS);
  return `${v.current} / ${v.steps.length} 段階: ${v.steps[v.current - 1].label}`;
};

export function HumImportScreen({
  song,
  partIndex,
  partName,
  initialLabel,
  ts,
  keySig,
  storage,
  onInsert,
  onBack,
  client: injected,
  probe = probeDuration,
  playbackDeps,
}: HumImportScreenProps) {
  const targets = useMemo(
    () => humTargets(song, partIndex, ts),
    [song, partIndex, ts],
  );
  const [value, setValue] = useState<HumSetupValue>(() => ({
    label:
      targets.find((t) => t.label === initialLabel && t.writable)?.label ??
      targets.find((t) => t.writable)?.label ??
      initialLabel,
    tempo: song.meta.tempo ?? DEFAULT_TEMPO,
    key: keySig ?? '',
    bar: 1,
    beat: 1,
  }));
  const [phase, setPhase] = useState<Phase>({
    kind: 'setup',
    file: null,
    duration: null,
    notice: null,
  });
  const [live, setLive] = useState('');
  const clientRef = useRef<AnalysisClient | null>(injected ?? null);
  const runRef = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const h1Ref = useRef<HTMLHeadingElement>(null);
  const progressRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<'h1' | 'progress' | 'notice' | 'review' | null>(
    'h1',
  );
  const songTitle = song.meta.title.trim() || UNTITLED;

  const say = useCallback((msg: string) => {
    setLive((prev) => (prev === msg ? `${msg} ` : msg));
  }, []);

  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    const el = {
      h1: h1Ref,
      progress: progressRef,
      notice: noticeRef,
      review: reviewRef,
    }[target].current;
    if (!el) return;
    focusNext.current = null;
    el.focus();
  }, [phase]);

  usePageDropGuard();

  // Leaving the screen stops a running analysis (plan §6.2).
  useEffect(
    () => () => {
      runRef.current++;
      clientRef.current?.cancel();
    },
    [],
  );

  const showNotice = (
    file: File | null,
    duration: number | null,
    notice: ImportNotice,
  ) => {
    focusNext.current = 'notice';
    setPhase({ kind: 'setup', file, duration, notice });
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
    setPhase({
      kind: 'setup',
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
    setPhase({ kind: 'setup', file, duration, notice: null });
    say(
      `${file.name} を選びました${duration !== null ? `。長さ ${formatDurationJa(duration)}` : ''}`,
    );
  };

  const start = async () => {
    if (phase.kind !== 'setup' || !phase.file || phase.probing) return;
    const { file, duration } = phase;
    const run = ++runRef.current;
    focusNext.current = 'progress';
    setPhase({ kind: 'analyzing', file, duration, progress: null });
    say(`解析を始めました。${stepText(null)}`);
    const client = clientRef.current ?? createAnalysisClient();
    clientRef.current = client;
    let step = 1;
    try {
      const result = await client.run(
        {
          kind: 'hum',
          source: { file },
          info: humRunInfo({ ...value, key: value.key || undefined, ts }),
          firstNoteAuto: true,
        },
        (p) => {
          if (run !== runRef.current) return;
          setPhase((ph) =>
            ph.kind === 'analyzing' ? { ...ph, progress: p } : ph,
          );
          const v = importProgressView(p, HUM_STEPS);
          if (v.current !== step && v.fraction < 1) {
            step = v.current;
            say(stepText(p));
          }
        },
      );
      if (run !== runRef.current) return;
      if (!result.melody.quantized.events.some((e) => e.kind === 'note')) {
        showNotice(file, duration, humNoVoiceNotice());
        return;
      }
      focusNext.current = 'review';
      setPhase({ kind: 'review', file, result });
      say('解析が終わりました。鼻歌の下書きを確かめてください');
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

  const insert = (events: MelodyEvent[], draftTs: TimeSig) => {
    try {
      onInsert(
        insertHumDraft(song, partIndex, value.label, events, draftTs),
        value.label,
      );
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  };

  if (phase.kind === 'review') {
    return (
      <HumReview
        result={phase.result}
        file={phase.file}
        fileName={phase.file.name}
        songTitle={songTitle}
        partName={partName}
        label={value.label}
        keySig={value.key || undefined}
        existingNotes={targets.find((t) => t.label === value.label)?.notes ?? 0}
        initialNoteNames={loadNoteNameMode(storage)}
        onNoteNamesChange={(m) => saveNoteNameMode(storage, m)}
        onInsert={insert}
        onBack={onBack}
        live={live}
        say={say}
        headingRef={reviewRef}
        playbackDeps={playbackDeps}
      />
    );
  }

  const file = phase.file;
  return (
    <ImportFrame
      backLabel="‹ やめて戻る"
      onBack={onBack}
      note="鼻歌から下書き ・ 1 / 2（受け取る）"
    >
      <HumSetup
        songTitle={songTitle}
        partName={partName}
        targets={targets}
        ts={ts}
        value={value}
        onChange={setValue}
        file={
          file
            ? {
                name: file.name,
                size: file.size,
                duration: phase.duration,
                probing: phase.kind === 'setup' ? phase.probing : false,
              }
            : null
        }
        onPick={(f) => void pick(f)}
        fileInputRef={fileInput}
        notice={phase.kind === 'setup' ? phase.notice : null}
        noticeRef={noticeRef}
        progress={
          phase.kind === 'analyzing' ? (
            <ImportProgress
              fileName={phase.file.name}
              duration={phase.duration}
              progress={phase.progress}
              onCancel={cancel}
              headingRef={progressRef}
              steps={HUM_STEPS}
              footnote="数秒かかります。「中止」を押すと、すぐ止めてこの画面に戻ります。"
            />
          ) : null
        }
        onStart={() => void start()}
        onBack={onBack}
        headingRef={h1Ref}
      />
      <p className={styles.srOnly} role="status" data-testid="import-live">
        {live}
      </p>
    </ImportFrame>
  );
}
