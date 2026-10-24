import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import type { HumAnalysisResult } from '../../lib/analysis/hum/types';
import { formatClock } from '../../lib/import/chordReview';
import {
  humCandidates,
  humDraftEvents,
  proposeOctave,
  type HumChoice,
  type HumDraftOk,
  type HumDraftOptions,
  type HumNoteCandidates,
} from '../../lib/import/humDraft';
import {
  beatsLabel,
  firstNoteAt,
  labelledEvents,
  NOTE_NAME_MODES,
  noteName,
  notePlaceLabel,
  octaveLabel,
  positionLabel,
  semitoneLabel,
  soundingAt,
  totalTicks,
  TRANSPOSE_LIMIT,
  type NoteNameMode,
} from '../../lib/import/humImport';
import {
  HUM_DRAFT_FAILED_MESSAGE,
  HUM_TUPLET_SHIFT_MESSAGE,
  IMPORT_ERROR_MESSAGES,
  PLAYBACK_FAILED_MESSAGE,
} from '../../lib/import/importErrors';
import { playbackNotes } from '../../lib/import/playback';
import {
  barTicks,
  WHOLE_TICKS,
  type MelodyEvent,
  type TimeSig,
} from '../../lib/melody';
import { parsePitch, pitchToMidi } from '../../lib/pitch';
import type { TonePlayer } from '../../hooks/tonePlayer';
import type { AudioPlayerDeps } from '../../hooks/useAudioPlayer';
import {
  useHumPlayback,
  type HumPlayback,
  type ListenMode,
} from '../../hooks/useHumPlayback';
import { Button } from '../Button/Button';
import { Chip } from '../Button/Chip';
import { ConfirmDialog } from '../ConfirmDialog/ConfirmDialog';
import { ImportFrame } from '../ImportFrame/ImportFrame';
import { MelodyStaff } from '../MelodyStaff/MelodyStaff';
import { SegmentedControl } from '../SegmentedControl/SegmentedControl';
import styles from './HumReview.module.css';

export type HumReviewProps = {
  result: HumAnalysisResult;
  /** The recording (listening comparison; nothing is stored). */
  file: File;
  songTitle: string;
  /** Shown only when the song has more than one melody part. */
  partName?: string;
  label: string;
  /** Key for spelling the notes (the editor's key; S2's choice). */
  keySig?: string;
  /** Notes in the section now: > 0 asks before replacing them. */
  existingNotes: number;
  initialNoteNames: NoteNameMode;
  onNoteNamesChange: (mode: NoteNameMode) => void;
  /** 「このセクションに下書きを入れる」 (after the confirmation when needed). */
  onInsert: (events: MelodyEvent[], ts: TimeSig) => void;
  onBack: () => void;
  /** A new value = the browser's back button: same as 「やめて戻る」. */
  backRequest?: number;
  /** The browser's back was cancelled on the confirmation. */
  onStay?: () => void;
  /** Why the last 「下書きを入れる」 failed (shown above the button). */
  insertError?: string | null;
  /** The screen's one live region: its text (shown by the staff) and the setter. */
  live: string;
  say: (message: string) => void;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Tests / stories: no real <audio> / AudioContext. */
  playbackDeps?: { audio?: AudioPlayerDeps; createTone?: () => TonePlayer };
};

interface Fixes {
  octave: number;
  transpose: number;
  shiftTicks: number;
  chosen: Readonly<Record<number, HumChoice>>;
}

const LISTEN: { value: ListenMode; label: string }[] = [
  { value: 'recording', label: '録音' },
  { value: 'draft', label: '下書き' },
  { value: 'both', label: '両方' },
];
const OCTAVE_RANGE = 2;
const NO_EVENTS: MelodyEvent[] = [];
const FALLBACK_TS: TimeSig = { num: 4, den: 4 };

const midiOf = (pitch: string | undefined) => {
  const p = pitch ? parsePitch(pitch) : null;
  return p ? pitchToMidi(p) : null;
};

/**
 * S4 「鼻歌の下書きを確かめる」 (docs/audio-integration-plan.md §4, sketch D2): whole-draft fixes (octave,
 * transpose, start) in a card above the score, a sticky player bar (録音 / 下書き / 両方, moving cursor), the
 * draft on the app's own input staff (MelodyStaff, review mode) with note names and unsure notes marked, and per
 * note the pitch / length candidates (a click plays it and applies it). Every choice lives only here until
 * 「このセクションに下書きを入れる」.
 */
export function HumReview({
  result,
  file,
  songTitle,
  partName,
  label,
  keySig,
  existingNotes,
  initialNoteNames,
  onNoteNamesChange,
  onInsert,
  onBack,
  backRequest,
  onStay,
  insertError,
  live,
  say,
  headingRef,
  playbackDeps,
}: HumReviewProps) {
  const ids = { fix: useId(), score: useId(), side: useId(), panel: useId() };
  const [proposed] = useState(() => proposeOctave(result));
  const [fixes, setFixes] = useState<Fixes>({
    octave: proposed,
    transpose: 0,
    shiftTicks: 0,
    chosen: {},
  });
  const [names, setNames] = useState<NoteNameMode>(initialNoteNames);
  /** The note whose candidates are open (its id, stable across fixes). */
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);

  const optsOf = (f: Fixes): HumDraftOptions => ({ ...f, key: keySig });
  const opts = useMemo<HumDraftOptions>(
    () => ({ ...fixes, key: keySig }),
    [fixes, keySig],
  );
  const draft = useMemo(() => humDraftEvents(result, opts), [result, opts]);
  const ok: HumDraftOk | null = draft.ok ? draft : null;
  const events = ok?.events ?? NO_EVENTS;
  const ts = ok?.ts ?? FALLBACK_TS;
  const cands = useMemo<(HumNoteCandidates | null)[]>(
    () => (ok ? humCandidates(result, ok, opts) : []),
    [result, ok, opts],
  );
  const sounding = useMemo(
    () => (ok ? playbackNotes(ok.events, ok.tempo, ok.startSec) : []),
    [ok],
  );
  const pb = useHumPlayback(file, sounding, playbackDeps);
  const { player } = pb;

  // The cursor moves when the sounding note changes (not only at ~4 Hz).
  const { setBarResolver } = player;
  useEffect(() => {
    setBarResolver((t) => soundingAt(sounding, t));
    return () => setBarResolver(null);
  }, [setBarResolver, sounding]);
  const playhead =
    player.playing || player.currentTime > 0
      ? soundingAt(sounding, player.currentTime)
      : null;

  // A note's candidates open below the staff: bring them into view.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openId !== null)
      panelRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [openId]);

  const selected = openId === null ? -1 : (ok?.ids.indexOf(openId) ?? -1);
  const open = selected >= 0 ? cands[selected] : null;
  const shown = useMemo(
    () => labelledEvents(events, cands, names),
    [events, cands, names],
  );
  const marked = useMemo(
    () =>
      new Set(
        cands.flatMap((c, i) => (c?.low ? [i] : [])),
      ) as ReadonlySet<number>,
    [cands],
  );

  const noteCount = events.filter((e) => e.kind === 'note').length;
  const lowCount = marked.size;
  const bars = Math.round(totalTicks(events) / barTicks(ts));
  const first = firstNoteAt(events);
  const beat = WHOLE_TICKS / ts.den;
  const tickSec = ok ? 60 / (ok.tempo * (WHOLE_TICKS / 4)) : 0;

  const fixSummary = [
    fixes.octave !== proposed ? octaveLabel(fixes.octave - proposed) : '',
    fixes.transpose !== 0
      ? `${fixes.transpose > 0 ? '+' : '−'}${Math.abs(fixes.transpose)} 半音`
      : '',
    fixes.shiftTicks !== 0
      ? `${Math.abs(fixes.shiftTicks / beat)} 拍${fixes.shiftTicks > 0 ? '後' : '前'}`
      : '',
    Object.keys(fixes.chosen).length > 0
      ? `候補 ${Object.keys(fixes.chosen).length} 音`
      : '',
  ].filter(Boolean);

  /** Applies a fix if the draft still works out; returns the new draft (null = refused). */
  const update = (
    patch: Partial<Fixes>,
    message?: string,
  ): HumDraftOk | null => {
    const next = { ...fixes, ...patch };
    const d = humDraftEvents(result, optsOf(next));
    if (!d.ok) {
      say(
        d.reason === 'tupletCrossesBar'
          ? HUM_TUPLET_SHIFT_MESSAGE
          : IMPORT_ERROR_MESSAGES.internal,
      );
      return null;
    }
    setFixes(next);
    if (message) say(message);
    return d;
  };

  const nameOf = (pitch: string) =>
    noteName(pitch, names === 'none' ? 'letter' : names);

  const select = (index: number | null) => {
    const id = index === null ? null : (ok?.ids[index] ?? null);
    setOpenId(id);
    if (index === null || id === null) return;
    const e = events[index];
    say(
      `${notePlaceLabel(events, index, ts)}（${e.pitch ? nameOf(e.pitch) : ''}、${beatsLabel(e.ticks, ts)}）。下に候補があります`,
    );
  };

  const choose = (choice: HumChoice, message: string) => {
    if (!open) return;
    const id = open.id;
    // Picking the analyzer's own reading again is no choice at all.
    const merged: HumChoice = { ...fixes.chosen[id], ...choice };
    const orig = open.position[0];
    if (merged.midi === open.pitch[0].midi) delete merged.midi;
    if (
      merged.position &&
      merged.position.startTick === orig.startTick &&
      merged.position.ticks === orig.ticks
    )
      delete merged.position;
    const { [id]: _old, ...others } = fixes.chosen;
    const d = update(
      {
        chosen:
          merged.midi === undefined && merged.position === undefined
            ? others
            : { ...others, [id]: merged },
      },
      message,
    );
    if (!d) return;
    // Play the note as it is now (pitch and length after the choice).
    const i = d.ids.indexOf(id);
    const e = d.events[i];
    const midi = midiOf(e?.pitch);
    if (e && midi !== null)
      pb.playNote(midi, e.ticks * (60 / (d.tempo * (WHOLE_TICKS / 4))));
  };

  const onStaffKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const from = selected >= 0 ? selected : step > 0 ? -1 : events.length;
    for (let i = from + step; i >= 0 && i < events.length; i += step)
      if (events[i].kind === 'note') return select(i);
  };

  const insert = () => {
    if (!ok) return;
    pb.pause();
    if (existingNotes > 0) setConfirm(true);
    else onInsert(ok.events, ok.ts);
  };

  // 「やめて戻る」 (and the browser's back): ask first when something was fixed here.
  const [confirmBack, setConfirmBack] = useState<'button' | 'browser' | null>(
    null,
  );
  const changed = fixSummary.length > 0;
  const back = (from: 'button' | 'browser' = 'button') => {
    pb.pause();
    if (changed) setConfirmBack(from);
    else onBack();
  };
  const backRef = useRef(back);
  useEffect(() => {
    backRef.current = back;
  });
  const [firstBack] = useState(backRequest);
  useEffect(() => {
    if (backRequest !== firstBack) backRef.current('browser');
  }, [backRequest, firstBack]);

  const where = `${songTitle}${partName ? ` / ${partName}` : ''} / ${label}`;

  return (
    <ImportFrame
      backLabel="‹ やめて戻る"
      onBack={() => back()}
      note="鼻歌から下書き ・ 2 / 2（確かめる）"
    >
      <div className={styles.layout}>
        <main className={styles.main}>
          <div className={styles.titleRow}>
            <h1 ref={headingRef} tabIndex={-1} className={styles.h1}>
              鼻歌の下書きを確かめる
            </h1>
            <span className={styles.badge}>下書き</span>
          </div>
          <p className={styles.draftNote}>
            これは歌からの<strong>下書き</strong>
            です。正確な書き起こしではありません。録音と聞き比べて、違って聞こえる所だけ直してください。入れたあとは、いつもの編集画面でも直せます。
            <span className={styles.muted}>
              {' '}
              {file.name} ・ {formatClock(result.source.durationSec)}
            </span>
          </p>

          <PlayerBar
            pb={pb}
            durationSec={player.duration ?? result.source.durationSec}
            say={say}
          />

          <section className={styles.card} aria-labelledby={ids.fix}>
            <div className={styles.cardHead}>
              <h2 id={ids.fix} className={styles.h2}>
                全体の直し
              </h2>
              <span className={styles.note}>
                下書き全体の高さやタイミングが、録音と違って聞こえるときに使います。
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.label} id={`${ids.fix}-oct`}>
                全体の高さ
              </span>
              <span
                className={styles.inline}
                role="group"
                aria-labelledby={`${ids.fix}-oct`}
              >
                <Button
                  disabled={fixes.octave <= proposed - OCTAVE_RANGE}
                  onClick={() =>
                    update(
                      { octave: fixes.octave - 1 },
                      `全体の高さ: ${octaveLabel(fixes.octave - 1 - proposed)}`,
                    )
                  }
                >
                  1 オクターブ下げる
                </Button>
                <span className={styles.fixValue} data-testid="hum-octave">
                  {octaveLabel(fixes.octave - proposed)}
                </span>
                <Button
                  disabled={fixes.octave >= proposed + OCTAVE_RANGE}
                  onClick={() =>
                    update(
                      { octave: fixes.octave + 1 },
                      `全体の高さ: ${octaveLabel(fixes.octave + 1 - proposed)}`,
                    )
                  }
                >
                  1 オクターブ上げる
                </Button>
              </span>
              <span className={styles.note}>
                同じ音名のまま、1 段高く・低くします。
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.label} id={`${ids.fix}-tr`}>
                音の高さをずらす
              </span>
              <span
                className={styles.inline}
                role="group"
                aria-labelledby={`${ids.fix}-tr`}
              >
                <Button
                  aria-label="半音下げる"
                  disabled={fixes.transpose <= -TRANSPOSE_LIMIT}
                  onClick={() =>
                    update(
                      { transpose: fixes.transpose - 1 },
                      `${fixes.transpose - 1} 半音`,
                    )
                  }
                >
                  −
                </Button>
                <span className={styles.fixValue} data-testid="hum-transpose">
                  {fixes.transpose} 半音
                </span>
                <Button
                  aria-label="半音上げる"
                  disabled={fixes.transpose >= TRANSPOSE_LIMIT}
                  onClick={() =>
                    update(
                      { transpose: fixes.transpose + 1 },
                      `${fixes.transpose + 1} 半音`,
                    )
                  }
                >
                  ＋
                </Button>
              </span>
              <span className={styles.note}>
                歌った音が、全体に少し高い・低いときに（半音 =
                ピアノの隣の鍵盤）。
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.label} id={`${ids.fix}-sh`}>
                歌い始め
              </span>
              <span
                className={styles.inline}
                role="group"
                aria-labelledby={`${ids.fix}-sh`}
              >
                <Button
                  disabled={first === null || first < beat}
                  onClick={() =>
                    update(
                      { shiftTicks: fixes.shiftTicks - beat },
                      first !== null
                        ? `歌い始め: ${positionLabel(first - beat, ts)}`
                        : undefined,
                    )
                  }
                >
                  ‹ 1 拍前へ
                </Button>
                <span className={styles.fixValue} data-testid="hum-start">
                  {first !== null ? positionLabel(first, ts) : '—'}
                </span>
                <Button
                  disabled={first === null}
                  onClick={() =>
                    update(
                      { shiftTicks: fixes.shiftTicks + beat },
                      first !== null
                        ? `歌い始め: ${positionLabel(first + beat, ts)}`
                        : undefined,
                    )
                  }
                >
                  1 拍後へ ›
                </Button>
              </span>
              <span className={styles.note}>音が全体に早い・遅いときに。</span>
            </div>
          </section>

          <section className={styles.card} aria-labelledby={ids.score}>
            <div className={styles.cardHead}>
              <h2 id={ids.score} className={styles.h2}>
                下書きの譜面
              </h2>
              <span className={styles.muted} data-testid="hum-summary">
                {label} ・ {bars} 小節 ・ 音 {noteCount} 個 ・ 自信がない音{' '}
                {lowCount} 個
              </span>
            </div>
            <p className={styles.muted}>
              音を押すと、高さと長さのほかの候補が出ます。色のついた「?」の音は、自信がない音です。音の下の文字は高さです（表示は下で切り替えられます）。
            </p>
            <div className={styles.row}>
              <span className={styles.smallLabel} id={`${ids.score}-names`}>
                音名の表示
              </span>
              <SegmentedControl
                label="音名の表示"
                options={[...NOTE_NAME_MODES]}
                value={names}
                onChange={(m) => {
                  setNames(m);
                  onNoteNamesChange(m);
                }}
              />
              <span className={styles.note}>
                この端末に覚えます。音の下の文字と、候補の両方に効きます。
              </span>
            </div>

            {!ok ? (
              <p className={styles.error} data-testid="draft-error">
                {HUM_DRAFT_FAILED_MESSAGE}
              </p>
            ) : null}

            <MelodyStaff
              events={shown}
              ts={ts}
              keySignature={keySig}
              selected={selected >= 0 ? selected : null}
              onSelect={select}
              onKeyDown={onStaffKey}
              liveMessage={live}
              ariaLabel={`${label} の下書きの譜面`}
              selectOnly
              playhead={playhead}
              markedNotes={marked}
            />

            {open && selected >= 0 ? (
              <CandidatePanel
                panelRef={panelRef}
                titleId={ids.panel}
                title={notePlaceLabel(events, selected, ts)}
                cand={open}
                names={names}
                ts={ts}
                onClose={() => setOpenId(null)}
                onPitch={(midi, pitch) =>
                  choose(
                    { midi },
                    `高さを ${noteName(pitch, names === 'none' ? 'letter' : names)} にしました`,
                  )
                }
                onPosition={(startTick, ticks) =>
                  choose(
                    { position: { startTick, ticks } },
                    `長さを ${beatsLabel(ticks, ts)} にしました`,
                  )
                }
                onListenRecording={() => {
                  const n = sounding.find((s) => s.index === selected);
                  if (n)
                    pb.playRecording(
                      Math.max(0, n.start - 0.15),
                      n.start + n.duration + 0.15,
                    );
                }}
                onListenDraft={() => {
                  const midi = midiOf(events[selected]?.pitch);
                  if (midi !== null)
                    pb.playNote(midi, events[selected].ticks * tickSec);
                }}
              />
            ) : null}

            {ok && ok.dropped > 0 ? (
              <p className={styles.dropped} data-testid="dropped-notice">
                {ok.dropped} 個の音は、1
                小節目より前か、ほかの音と重なったので入れません。
              </p>
            ) : null}

            <div className={styles.legend}>
              <span>黒い音: 自信がある</span>
              <span>
                <span className={styles.warn}>橙の音と「?」</span>:
                自信がない（先に聞いてみてください）
              </span>
              <span>青い縦線: いま再生している場所</span>
            </div>
          </section>
        </main>

        <aside className={styles.side} aria-labelledby={ids.side}>
          <div className={styles.sideCard}>
            <h2 id={ids.side} className={styles.h2small}>
              入れる内容
            </h2>
            <dl className={styles.summary}>
              <div>
                <dt>入れ先</dt>
                <dd>{where}</dd>
              </div>
              <div>
                <dt>小節 / 音</dt>
                <dd>
                  {bars} 小節 ・ {noteCount} 個
                </dd>
              </div>
              <div>
                <dt>自信がない音</dt>
                <dd className={lowCount > 0 ? styles.warn : undefined}>
                  {lowCount} 個
                </dd>
              </div>
              <div>
                <dt>全体の直し</dt>
                <dd>
                  {fixSummary.length > 0 ? fixSummary.join('・') : 'なし'}
                </dd>
              </div>
            </dl>
            {insertError ? (
              <p className={styles.error} data-testid="insert-error">
                {insertError}
              </p>
            ) : null}
            {existingNotes > 0 ? (
              <p className={styles.replaceNote} data-testid="replace-note">
                {label}
                には、すでに音符が入っています。入れるときに、置き換えるか確認します。
              </p>
            ) : null}
            <Button
              variant="primary"
              className={`${styles.wide} ${styles.insert}`}
              disabled={noteCount === 0}
              onClick={insert}
            >
              このセクションに下書きを入れる
            </Button>
            <p className={styles.note}>
              入れたあとは、ふつうの音符です。曲のテキストに「下書き」の印は付きません。この画面でだけ、下書きと示します。
            </p>
            <Button className={styles.wide} onClick={() => back()}>
              やめて戻る
            </Button>
            <p className={styles.note}>
              候補とここでの直しは、この画面を閉じると消えます。
            </p>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmBack !== null}
        title="ここでの直しを捨てて戻りますか？"
        message="選んだ候補と全体の直しは消えます。もう一度使うには、録音を解析し直します。"
        confirmLabel="捨てて戻る"
        danger
        onConfirm={() => {
          setConfirmBack(null);
          onBack();
        }}
        onCancel={() => {
          if (confirmBack === 'browser') onStay?.();
          setConfirmBack(null);
        }}
      />
      <ConfirmDialog
        open={confirm}
        title={`${label}の音符を置き換えますか`}
        message={`${label}には、すでに音符が入っています。下書きを入れると、いまの音符は消えて、この下書きに置き換わります。「キャンセル」を押すと、この画面に戻って続きを直せます。`}
        confirmLabel="置き換えて入れる"
        danger
        onConfirm={() => {
          setConfirm(false);
          if (ok) onInsert(ok.events, ok.ts);
        }}
        onCancel={() => setConfirm(false)}
      />
    </ImportFrame>
  );
}

function PlayerBar({
  pb,
  durationSec,
  say,
}: {
  pb: HumPlayback;
  durationSec: number;
  say: (m: string) => void;
}) {
  const { player } = pb;
  return (
    <div className={styles.player} data-testid="player-bar">
      <Button
        variant="primary"
        className={styles.playButton}
        disabled={player.failed}
        onClick={() => {
          if (player.playing) {
            pb.pause();
            say('止めました');
          } else pb.play();
        }}
      >
        {player.playing ? '❚❚ 止める' : '▶ 再生'}
      </Button>
      <SegmentedControl
        label="聞き比べ"
        options={LISTEN}
        value={pb.mode}
        onChange={(m) => {
          pb.setMode(m);
          say(`${LISTEN.find((o) => o.value === m)!.label}を鳴らします`);
        }}
      />
      <input
        type="range"
        className={styles.seek}
        aria-label="再生位置"
        min={0}
        max={Math.max(0, durationSec)}
        step={0.1}
        value={Math.min(player.currentTime, durationSec)}
        aria-valuetext={`${formatClock(player.currentTime)} / ${formatClock(durationSec)}`}
        disabled={player.failed}
        onChange={(e) => pb.seek(Number(e.target.value))}
      />
      <span className={styles.time}>
        {formatClock(player.currentTime)} / {formatClock(durationSec)}
      </span>
      {player.failed ? (
        <span className={styles.note}>{PLAYBACK_FAILED_MESSAGE}</span>
      ) : null}
    </div>
  );
}

function CandidatePanel({
  panelRef,
  titleId,
  title,
  cand,
  names,
  ts,
  onClose,
  onPitch,
  onPosition,
  onListenRecording,
  onListenDraft,
}: {
  panelRef: Ref<HTMLDivElement>;
  titleId: string;
  title: string;
  cand: HumNoteCandidates;
  names: NoteNameMode;
  ts: TimeSig;
  onClose: () => void;
  onPitch: (midi: number, pitch: string) => void;
  onPosition: (startTick: number, ticks: number) => void;
  onListenRecording: () => void;
  onListenDraft: () => void;
}) {
  const original = cand.pitch[0];
  const pitchText = (o: (typeof cand.pitch)[number]) =>
    names === 'none'
      ? semitoneLabel(o.midi - original.midi)
      : noteName(o.pitch, names);
  const current = cand.pitch.find((o) => o.selected) ?? original;
  const origPos = cand.position[0];
  const posText = (o: (typeof cand.position)[number]) =>
    `${beatsLabel(o.ticks, ts)}${
      o.startTick < origPos.startTick
        ? '（早めに入る）'
        : o.startTick > origPos.startTick
          ? '（遅れて入る）'
          : ''
    }`;
  const pct = (c?: number) =>
    c === undefined ? null : c < 0.01 ? (
      <small className={styles.small}>1% 未満</small>
    ) : (
      <small className={styles.small}>{Math.round(c * 100)}%</small>
    );
  return (
    <div
      ref={panelRef}
      className={styles.panel}
      role="group"
      aria-labelledby={titleId}
      data-testid="candidate-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.panelHead}>
        <p id={titleId} className={styles.panelTitle}>
          {title}
        </p>
        <Button variant="ghost" onClick={onClose}>
          閉じる
        </Button>
      </div>
      <div className={styles.row}>
        <span className={styles.label} id={`${titleId}-p`}>
          高さ
        </span>
        <span
          className={styles.inline}
          role="group"
          aria-labelledby={`${titleId}-p`}
        >
          {cand.pitch.map((o) => (
            <Chip
              className={styles.chip}
              key={o.midi}
              selected={o.selected}
              onClick={() => onPitch(o.midi, o.pitch)}
            >
              ▶ {pitchText(o)} {pct(o.confidence)}
            </Chip>
          ))}
        </span>
        <span className={styles.note}>
          いまの下書きは「{pitchText(current)}
          」。押すと鳴って、その音に変わります。
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.label} id={`${titleId}-l`}>
          長さ
        </span>
        <span
          className={styles.inline}
          role="group"
          aria-labelledby={`${titleId}-l`}
        >
          {cand.position.map((o) => (
            <Chip
              className={styles.chip}
              key={`${o.startTick}:${o.ticks}`}
              selected={o.selected}
              onClick={() => onPosition(o.startTick, o.ticks)}
            >
              ▶ {posText(o)} {pct(o.confidence)}
            </Chip>
          ))}
        </span>
        <span className={styles.note}>1 拍 = クリック 1 回ぶんです。</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>聞く</span>
        <Button onClick={onListenRecording}>▶ 録音のここ</Button>
        <Button onClick={onListenDraft}>▶ 下書きのここ</Button>
        <span className={styles.note}>
          2 つを聞き比べて、近いほうを選んでください。
        </span>
      </div>
      <p className={styles.note}>
        選ぶと、鳴ってその音に変わります。最初の候補に戻すこともできます。選ばないと、いまの音のまま入ります。％は解析の確からしさで、正解の確率ではありません。
      </p>
    </div>
  );
}
