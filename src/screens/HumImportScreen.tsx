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
import { useEffect, useMemo, useRef, useState } from 'react';
import { probeDuration } from '../analysis/probeDuration';
import type { AnalysisClient, HumRequest } from '../analysis/types';
import { AudioFileField } from '../components/AudioFileField/AudioFileField';
import {
  HumReview,
  type HumReviewProps,
} from '../components/HumReview/HumReview';
import {
  HumSetup,
  type HumSetupValue,
  type HumSource,
} from '../components/HumSetup/HumSetup';
import { ImportFrame } from '../components/ImportFrame/ImportFrame';
import { ImportProgress } from '../components/ImportProgress/ImportProgress';
import { useAnalysisRun } from '../hooks/useAnalysisRun';
import { usePageDropGuard } from '../hooks/usePageDropGuard';
import { DEFAULT_TEMPO } from '../lib/autoScroll';
import {
  HUM_STEPS,
  humRunInfo,
  humTargets,
  insertHumDraft,
} from '../lib/import/humImport';
import { humNoVoiceNotice } from '../lib/import/importErrors';
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
  /** A new value = the browser's back button: same as 「やめて戻る」 (S4 may ask first). */
  backRequest?: number;
  /** The browser's back was cancelled on S4's confirmation. */
  onStay?: () => void;
  /** Default: the real client, made on the first run. */
  client?: AnalysisClient;
  /** Default: probeDuration. */
  probe?: (file: Blob) => Promise<number | null>;
  playbackDeps?: HumReviewProps['playbackDeps'];
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
  backRequest,
  onStay,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [insertError, setInsertError] = useState<string | null>(null);
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
  } = useAnalysisRun<HumRequest>({
    client: injected,
    probe,
    steps: HUM_STEPS,
    doneMessage: '解析が終わりました。鼻歌の下書きを確かめてください',
    rejectResult: (result) =>
      result.melody.quantized.events.some((e) => e.kind === 'note')
        ? null
        : humNoVoiceNotice(),
  });
  const songTitle = song.meta.title.trim() || UNTITLED;

  usePageDropGuard();

  // The browser's back before S4 leaves at once (S4 handles it itself: it may ask first).
  const inReview = phase.kind === 'review';
  const [firstBack] = useState(backRequest);
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });
  useEffect(() => {
    if (backRequest !== firstBack && !inReview) onBackRef.current();
    // only on a new back request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backRequest]);

  const startRun = () => {
    if (phase.kind !== 'pick' || !phase.file) return;
    void start({
      kind: 'hum',
      source: { file: phase.file },
      info: humRunInfo({ ...value, key: value.key || undefined, ts }),
      firstNoteAuto: true,
    });
  };

  const insert = (events: MelodyEvent[], draftTs: TimeSig) => {
    try {
      onInsert(
        insertHumDraft(song, partIndex, value.label, events, draftTs),
        value.label,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInsertError(msg);
      say(msg);
    }
  };

  if (phase.kind === 'review') {
    return (
      <HumReview
        result={phase.result}
        file={phase.file}
        songTitle={songTitle}
        partName={partName}
        label={value.label}
        keySig={value.key || undefined}
        existingNotes={targets.find((t) => t.label === value.label)?.notes ?? 0}
        initialNoteNames={loadNoteNameMode(storage)}
        onNoteNamesChange={(m) => saveNoteNameMode(storage, m)}
        onInsert={insert}
        onBack={onBack}
        backRequest={backRequest}
        onStay={onStay}
        insertError={insertError}
        live={live}
        say={say}
        headingRef={reviewRef}
        playbackDeps={playbackDeps}
      />
    );
  }

  const file = phase.file;
  const pickedFile = file
    ? {
        name: file.name,
        size: file.size,
        duration: phase.duration,
        probing: phase.kind === 'pick' ? phase.probing : false,
      }
    : null;
  // Today S2's source is always a picked file.
  const source: HumSource = {
    heading: '1. 録音ファイル',
    field: (
      <AudioFileField
        file={pickedFile}
        onPick={(f) => void pick(f)}
        inputRef={fileInputRef}
        hint="wav・mp3・m4a など、ブラウザで開ける形式。10 分まで。"
      />
    ),
    chosen: !!pickedFile,
    ready: !!pickedFile && !pickedFile.probing,
    summary: pickedFile ? pickedFile.name : 'まだ選んでいません',
    startHint: '先に録音ファイルを選んでください。',
    retake: {
      label: '別のファイルを選ぶ',
      onClick: () => fileInputRef.current?.click(),
    },
    how: (
      <>
        <li>
          <strong>ヘッドホンをつけます。</strong>
          クリック（メトロノーム）の音が、マイクに入らないようにするためです。
        </li>
        <li>
          録音アプリで録音を始め、曲のテンポ（♩= {value.tempo}）で
          <strong>クリックを鳴らします</strong>。
        </li>
        <li>
          <strong>1 小節（{ts.num} 拍）数えてから</strong>
          歌い始めます。最初の数えの 1 小節は、小節の数に入れません。
        </li>
        <li>
          「ラ」や「ん〜」で、1
          つの音をはっきり歌います。録れたファイルを上で選んでください。
        </li>
      </>
    ),
  };
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
        source={source}
        notice={phase.kind === 'pick' ? phase.notice : null}
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
        onStart={startRun}
        onBack={onBack}
        headingRef={h1Ref}
      />
      <p className={styles.srOnly} role="status" data-testid="import-live">
        {live}
      </p>
    </ImportFrame>
  );
}
