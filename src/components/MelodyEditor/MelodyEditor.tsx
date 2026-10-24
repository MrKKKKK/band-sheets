import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { MelodyEvent, TimeSig } from '../../lib/melody';
import { melodyTimeSignature } from '../../lib/melody';
import { parseMelody } from '../../lib/melodyParse';
import {
  applyCommand,
  initialEditorState,
  keyToCommand,
  MAX_BASE_OCTAVE,
  MIN_BASE_OCTAVE,
  tupletAtCursor,
  type Command,
  type EditorState,
} from '../../lib/melodyInput';
import {
  extend,
  lyricMismatch,
  merge,
  noLyric,
  split,
} from '../../lib/melodyLyrics';
import {
  convertPartLevelLyrics,
  ensureMelodyPart,
  hasPartLevelLyrics,
  melodyParts,
  partSections,
  preambleOverrides,
  readSection,
  reflowSection,
  renamePart,
  withoutCrossingTuplets,
  writeSection,
  type PreambleOverrides,
} from '../../lib/melodyPart';
import {
  chartChords,
  clearChords,
  copyChordsFromChart,
  copyResultLines,
  removeChord,
  setChord,
  type CopyMode,
  type CopySummary,
} from '../../lib/melodyChords';
import { chartOrder } from '../../lib/melodyEditor';
import { diatonicChords } from '../../lib/keys';
import { paletteGroups } from '../../lib/palette';
import { parsePitch, pitchToMidi } from '../../lib/pitch';
import { sectionLabels } from '../../lib/sections';
import type { Song } from '../../lib/song';
import { chartSyllables } from '../../lib/syllables';
import { Button } from '../Button/Button';
import { ChordPopover } from '../ChordPopover/ChordPopover';
import { DurationBar } from '../DurationBar/DurationBar';
import { LyricsPanel, type LyricsAction } from '../LyricsPanel/LyricsPanel';
import { MelodyChordsPanel } from '../MelodyChordsPanel/MelodyChordsPanel';
import { ModeStatus } from '../ModeStatus/ModeStatus';
import { announcement, stateChangeMessage } from '../MelodyStaff/labels';
import { MelodyStaff } from '../MelodyStaff/MelodyStaff';
import { PartScore } from '../PartScore/PartScore';
import { PianoKeyboard } from '../PianoKeyboard/PianoKeyboard';
import { SectionNotice } from '../SectionNotice/SectionNotice';
import { SectionPartBar } from '../SectionPartBar/SectionPartBar';
import { TupletPicker } from '../TupletPicker/TupletPicker';
import styles from './MelodyEditor.module.css';

/** Name of the melody part created by the first edit when there is none. */
const NEW_PART_NAME = 'Vocal';

/** Section value of the implicit "no labels at all" choice. */
const NO_SECTION = '';

export interface MelodyEditorProps {
  song: Song;
  /** Called exactly once per user action that changes the song. */
  onChange: (song: Song) => void;
  /**
   * Shown as a button in the read-only notice instead of plain text, for a
   * caller that can switch to テキスト入力 (e.g. App: コード譜 tab +
   * テキスト入力 mode). Omit to just show the instruction as text.
   */
  onRequestTextEdit?: () => void;
  /**
   * 「鼻歌から下書き」 (plan §4 S2, PC only): shown when given; called with where the draft goes. The caller
   * shows the humming import screens instead of the editor.
   */
  onHumImport?: (req: HumImportRequest) => void;
  /** Show this section (after a draft was put into it); a new `seq` = a new request. */
  showSection?: { label: string; seq: number } | null;
  /** A new value (not the first) = focus the 「鼻歌から下書き」 button (back from the humming screens). */
  focusHumEntry?: number;
}

/** Where a humming draft goes: the editor's part, section, and its effective time signature / key. */
export interface HumImportRequest {
  label: string;
  /** Index in `song.parts`; -1 = no melody part yet. */
  partIndex: number;
  /** Set only when the song has more than one melody part. */
  partName?: string;
  ts: TimeSig;
  keySig?: string;
}

type LyricOp = typeof extend;

/** Lyric shortcuts (shown as hints in LyricsPanel), by `e.code`. */
const LYRIC_KEYS: Record<string, { op: LyricOp; action: LyricsAction }> = {
  KeyN: { op: extend, action: 'extend' },
  KeyM: { op: merge, action: 'merge' },
  KeyV: { op: split, action: 'split' },
  KeyC: { op: noLyric, action: 'noLyric' },
};

/** Live-region text after a lyrics operation (M8). */
const LYRIC_MESSAGES: Record<LyricsAction, string> = {
  import: '歌詞を取り込みました',
  extend: 'のばしました',
  merge: 'つめました',
  split: '分けました',
  noLyric: '歌詞をなくしました',
};

type SectionView =
  | { status: 'ok'; events: MelodyEvent[] }
  | { status: 'missing'; events: MelodyEvent[] }
  | { status: 'readonly'; events: MelodyEvent[]; reason: string }
  /**
   * Bars no longer fit the time signature (M3): read-only until reflowed.
   * `events` are display-only (`withoutCrossingTuplets`: the staff layout
   * would throw on a tuplet crossing a new barline, m5-review.md R1).
   */
  | { status: 'barMismatch'; events: MelodyEvent[]; reason: string };

const EMPTY: MelodyEvent[] = [];

const TIME_SIGS = new Map<string, TimeSig>();
/** One shared object per time signature, so memoized layouts stay valid. */
function stableTimeSig(t: TimeSig): TimeSig {
  const k = `${t.num}/${t.den}`;
  const hit = TIME_SIGS.get(k);
  if (hit) return hit;
  const own = { num: t.num, den: t.den };
  TIME_SIGS.set(k, own);
  return own;
}
const NO_OVERRIDES: PreambleOverrides = {};

/** Events of one section of the part body (or the unlabeled notes). */
function readView(
  partBody: string | undefined,
  label: string,
  ts: TimeSig,
  unsupportedPreamble: boolean,
): SectionView {
  if (unsupportedPreamble) {
    return {
      status: 'readonly',
      events: EMPTY,
      reason: 'パート冒頭の拍子・キー（\\ts / \\ks）をアプリでは読めません',
    };
  }
  if (label === NO_SECTION) {
    const unlabeled =
      partBody !== undefined ? partSections(partBody).unlabeled : undefined;
    const parsed = unlabeled ? parseMelody(unlabeled, ts) : null;
    return {
      status: 'readonly',
      events: parsed?.ok ? parsed.events : EMPTY,
      reason: 'セクション（\\section）がありません',
    };
  }
  if (partBody === undefined) return { status: 'missing', events: EMPTY };
  const read = readSection(partBody, label, ts);
  if (read.status === 'ok') return read;
  if (read.status === 'missing') return { status: 'missing', events: EMPTY };
  if (read.status === 'barMismatch') {
    return { ...read, events: withoutCrossingTuplets(read.events, ts) };
  }
  return { status: 'readonly', events: EMPTY, reason: read.reason };
}

function clampState(s: EditorState, length: number): EditorState {
  const cursor = Math.min(Math.max(0, s.cursor), length);
  const selected =
    s.selected !== null && s.selected < length ? s.selected : null;
  return cursor === s.cursor && selected === s.selected
    ? s
    : { ...s, cursor, selected };
}

/**
 * Melody tab (M4 T16, docs/m4-plan.md decisions 4 and 5): section / part
 * selection, the input staff with duration bar, piano and lyrics panel, and
 * an alphaTab preview of the melody part. Every edit turns into ONE
 * `onChange(song)` with the edited section rewritten by `writeSection`.
 */
export function MelodyEditor({
  song,
  onChange,
  onRequestTextEdit,
  onHumImport,
  showSection,
  focusHumEntry,
}: MelodyEditorProps) {
  // Part ------------------------------------------------------------------
  const parts = melodyParts(song);
  const [partOrdinal, setPartOrdinal] = useState(0);
  const ordinal = Math.min(partOrdinal, Math.max(0, parts.length - 1));
  const part = parts[ordinal] as (typeof parts)[number] | undefined;
  const partIndex = part ? song.parts.indexOf(part) : -1;
  const partBody = part?.body;

  // The part's own \ts / \ks win over the song info (M11).
  const overrides =
    partBody !== undefined ? preambleOverrides(partBody) : NO_OVERRIDES;
  const unsupportedPreamble = 'unsupported' in overrides;
  const tsOverride = 'unsupported' in overrides ? undefined : overrides.ts;
  const keyOverride = 'unsupported' in overrides ? undefined : overrides.key;
  const ts = stableTimeSig(tsOverride ?? melodyTimeSignature(song.meta.time));
  const keySig = keyOverride ?? song.meta.key;

  // Section ---------------------------------------------------------------
  const labels = sectionLabels(song).map((l) => l.label);
  const [labelChoice, setLabelChoice] = useState<string | null>(null);
  const label =
    labels.length === 0
      ? NO_SECTION
      : labelChoice !== null && labels.includes(labelChoice)
        ? labelChoice
        : labels[0];

  const view = readView(partBody, label, ts, unsupportedPreamble);
  const events = view.events;
  const readOnly = view.status === 'readonly' || view.status === 'barMismatch';

  // Editor state, kept per (part, section) ---------------------------------
  const stateKey = `${ordinal}\u0000${label}`;
  const [states, setStates] = useState<Record<string, EditorState>>({});
  const state = clampState(
    states[stateKey] ?? initialEditorState(events),
    events.length,
  );
  // Also store an unchanged state that was only derived so far: otherwise
  // it would be re-derived from the NEW events (cursor at the new end) after
  // an edit that keeps the cursor where it is (same shape as DrumEditor's
  // fix — see its `setState` comment).
  const setState = (next: EditorState) => {
    if (next !== state || states[stateKey] === undefined) {
      setStates((m) => ({ ...m, [stateKey]: next }));
    }
  };

  // Lyrics ----------------------------------------------------------------
  const chart = label === NO_SECTION ? [] : chartSyllables(song, label);
  const partLevelLyrics = part ? hasPartLevelLyrics(part.body) : false;
  const hasLyrics = events.some((e) => e.kind === 'note' && e.lyric);
  const mismatchFrom =
    chart.length > 0 && hasLyrics
      ? lyricMismatch(events, chart).firstMismatchNote
      : null;

  // Chords (issue #6) ------------------------------------------------------
  const chartChordInfo =
    label === NO_SECTION
      ? { syllables: [], chords: [] }
      : chartChords(song, label);
  /** Event whose chord popover is open (always the selected event). */
  const [chordEdit, setChordEdit] = useState<number | null>(null);
  /** Last copy result, per (part, section). */
  const [copyResult, setCopyResult] = useState<
    (CopySummary & { key: string }) | null
  >(null);

  const [error, setError] = useState('');
  /** The editor's one live region (M8): state changes and note descriptions. */
  const [live, setLive] = useState('');
  /**
   * Puts `msg` in the live region; the same text twice in a row gets a
   * trailing no-break space toggled so it is announced again.
   */
  const say = (msg: string) =>
    setLive((prev) => (prev === msg ? `${msg}\u00a0` : msg));
  /**
   * A refused action: visible error text (NOT a live region / alert of its
   * own) and one announcement through the live region (m5-review.md R6).
   */
  const reject = (msg: string) => {
    setError(msg);
    say(msg);
  };

  // A humming draft was put into a section: show it and announce it (the staff gets focus below).
  const [seenShow, setSeenShow] = useState(showSection?.seq);
  if (showSection && showSection.seq !== seenShow) {
    setSeenShow(showSection.seq);
    setLabelChoice(showSection.label);
    say(`セクション ${showSection.label} に鼻歌の下書きを入れました`);
  }

  // Writing ---------------------------------------------------------------
  /**
   * Writes `next` into the current section: exactly one onChange. Returns
   * false when nothing was written. Never creates an empty section / part
   * (M12).
   */
  const commit = (next: MelodyEvent[]): boolean => {
    if (readOnly || label === NO_SECTION) return false;
    if (view.status === 'missing' && next.length === 0) return false;
    let base = song;
    let idx = partIndex;
    if (idx < 0) {
      const ensured = ensureMelodyPart(song, NEW_PART_NAME);
      base = ensured.song;
      idx = ensured.partIndex;
    }
    try {
      const body = writeSection(
        base.parts[idx].body,
        label,
        next,
        ts,
        chartOrder(song),
      );
      setError('');
      setCopyResult(null);
      onChange({
        ...base,
        parts: base.parts.map((p, i) => (i === idx ? { ...p, body } : p)),
      });
      return true;
    } catch (e) {
      reject(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const run = (cmd: Command) => {
    if (readOnly) return;
    setChordEdit(null);
    // Refill from the chart only once the section has lyrics: otherwise
    // every typed note would silently take a chart syllable.
    const r = applyCommand(events, state, cmd, {
      key: keySig,
      chart: hasLyrics ? chart : undefined,
      ts,
    });
    if (r.message !== undefined) {
      // Refused (events/state unchanged): show the reason and announce it.
      reject(r.message);
      return;
    }
    setError('');
    setState(r.state);
    if (r.events !== events) {
      if (commit(r.events)) {
        say(announcement(r.events, r.state.cursor, r.state.selected));
      }
      return;
    }
    if (r.state === state) return;
    const moved =
      r.state.selected !== state.selected || r.state.cursor !== state.cursor;
    say(
      (!moved && stateChangeMessage(state, r.state)) ||
        announcement(events, r.state.cursor, r.state.selected),
    );
  };

  /** Tuplet group at the cursor/selection, for 「連符を削除」's canRemove. */
  const canRemoveTuplet = !readOnly && tupletAtCursor(events, state) !== null;

  // Returns keyboard focus to the staff (TupletPicker's onDone): the popover
  // unmounts right after, so Popover's own cleanup would otherwise send
  // focus back to the 連符 button instead.
  const staffContainerRef = useRef<HTMLDivElement>(null);
  const focusStaff = () => {
    staffContainerRef.current
      ?.querySelector<HTMLElement>('[role="application"]')
      ?.focus();
  };
  const humEntryRef = useRef<HTMLButtonElement>(null);
  const [firstEntryFocus] = useState(focusHumEntry);
  useEffect(() => {
    if (focusHumEntry !== firstEntryFocus) humEntryRef.current?.focus();
  }, [focusHumEntry, firstEntryFocus]);
  const showSeq = showSection?.seq;
  useEffect(() => {
    if (showSeq === undefined) return;
    staffContainerRef.current
      ?.querySelector<HTMLElement>('[role="application"]')
      ?.focus();
  }, [showSeq]);

  const commitLyrics = (next: MelodyEvent[], action: LyricsAction) => {
    if (action === 'import' && !next.some((e) => e.kind === 'note')) return;
    if (commit(next)) say(LYRIC_MESSAGES[action]);
  };

  const lyricTarget = (): number | null => {
    if (state.selected !== null) {
      return events[state.selected]?.kind === 'note' ? state.selected : null;
    }
    const before = state.cursor - 1;
    return events[before]?.kind === 'note' ? before : null;
  };

  /** Selected event, else the one just before the cursor (input mode). */
  const chordTarget = (): number | null => {
    if (state.selected !== null) return state.selected;
    const before = state.cursor - 1;
    return events[before] ? before : null;
  };

  /** The popover's anchor: focus goes back to the staff when it closes. */
  const staffAnchorRef = useRef<HTMLElement | null>(null);

  /** Selects `index` (if needed) and opens the chord popover on it. */
  const openChordEditor = (index: number) => {
    if (readOnly || !events[index]) return;
    staffAnchorRef.current =
      staffContainerRef.current?.querySelector<HTMLElement>(
        '[role="application"]',
      ) ?? null;
    if (state.selected !== index) run({ type: 'select', index });
    setChordEdit(index);
  };

  const commitChords = (next: MelodyEvent[], msg: string) => {
    if (next === events) return;
    if (commit(next)) say(msg);
  };

  const applyChord = (index: number, chord: string) => {
    setChordEdit(null);
    commitChords(
      setChord(events, index, chord),
      `${index + 1}音目のコードを ${chord.trim()} にしました`,
    );
  };

  const deleteChord = (index: number) => {
    setChordEdit(null);
    if (events[index]?.chord === undefined) {
      say(`${index + 1}音目にはコードがありません`);
      return;
    }
    commitChords(
      removeChord(events, index),
      `${index + 1}音目のコードを消しました`,
    );
  };

  const copyChords = (mode: CopyMode) => {
    const r = copyChordsFromChart(events, chartChordInfo, mode);
    if (r.events !== events && !commit(r.events)) return;
    const summary = { copied: r.copied, skipped: r.skipped, kept: r.kept };
    setCopyResult({ ...summary, key: stateKey });
    say(copyResultLines(summary).join('。'));
  };

  const clearAllChords = () => {
    setChordEdit(null);
    commitChords(
      clearChords(events),
      'このセクションのコードをすべて消しました',
    );
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (readOnly || e.key === 'Escape') return;
    // Shift+C / Shift+Backspace: chord of the selected event (or the one
    // before the cursor). keyToCommand maps neither (KeyC is no note key;
    // Shift+Backspace is unbound), and the lyric keys need no modifiers.
    const shiftOnly = e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (
      shiftOnly &&
      !e.nativeEvent.isComposing &&
      (e.code === 'KeyC' || e.code === 'Backspace')
    ) {
      e.preventDefault();
      const target = chordTarget();
      if (target === null) {
        reject('コードを付ける音符を選んでください');
        return;
      }
      if (e.code === 'KeyC') openChordEditor(target);
      else deleteChord(target);
      return;
    }
    const noModifiers = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    const lyricKey = LYRIC_KEYS[e.code];
    if (
      lyricKey &&
      noModifiers &&
      !partLevelLyrics &&
      !e.nativeEvent.isComposing
    ) {
      const target = lyricTarget();
      if (target !== null) {
        e.preventDefault();
        const next = lyricKey.op(events, target, chart);
        if (next !== events) commitLyrics(next, lyricKey.action);
        return;
      }
    }
    const cmd = keyToCommand({
      code: e.code,
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      isComposing: e.nativeEvent.isComposing,
    });
    if (!cmd) return;
    e.preventDefault();
    run(cmd);
  };

  const handlePianoKey = (pitch: string) => {
    if (state.selected !== null) {
      const p = parsePitch(pitch);
      if (!p) return;
      const semitone = pitchToMidi(p) - (state.baseOctave + 1) * 12;
      run({ type: 'noteInput', semitone, octaveUp: false });
    } else {
      run({ type: 'placeAt', index: state.cursor, pitch });
    }
  };

  const convertLyrics = () => {
    if (!part) return;
    const out = convertPartLevelLyrics(part.body, ts);
    if (typeof out !== 'string') {
      reject(out.error);
      return;
    }
    setError('');
    onChange({
      ...song,
      parts: song.parts.map((p, i) =>
        i === partIndex ? { ...p, body: out } : p,
      ),
    });
    say('音符ごとの歌詞に変換しました');
  };

  // Re-barring after a time-signature change (M3) --------------------------
  const noticeId = useId();
  const reflow = () => {
    if (partBody === undefined || partIndex < 0) return;
    try {
      const body = reflowSection(partBody, label, ts, chartOrder(song));
      setError('');
      onChange({
        ...song,
        parts: song.parts.map((p, i) => (i === partIndex ? { ...p, body } : p)),
      });
      say('小節を引き直しました');
    } catch (e) {
      reject(e instanceof Error ? e.message : String(e));
    }
  };

  // Part name -------------------------------------------------------------
  const partName = part?.name;
  const renamePartTo = (name: string): string | undefined => {
    if (partIndex < 0) return undefined;
    const out = renamePart(song, partIndex, name);
    if ('error' in out) return out.error;
    if (out.parts[partIndex].name !== partName) onChange(out);
    return undefined;
  };

  const sectionOptions =
    labels.length === 0
      ? [{ value: NO_SECTION, label: '（セクションなし）' }]
      : labels.map((l) => ({ value: l, label: l }));

  const selectedPitch =
    state.selected !== null ? events[state.selected]?.pitch : undefined;

  // Chord popover over the staff (same ChordPopover as the chart editor).
  const editingChord =
    !readOnly && chordEdit !== null && chordEdit === state.selected
      ? chordEdit
      : null;
  const diatonic = diatonicChords(keySig ?? '');
  const groups = paletteGroups(song);
  const sectionChords = events.flatMap((e) => (e.chord ? [e.chord] : []));
  const palette = [
    ...new Set([...groups.user, ...groups.used, ...sectionChords]),
  ].filter((c) => !diatonic.includes(c));
  const editingEvent = editingChord !== null ? events[editingChord] : undefined;
  const chordOverlay =
    editingChord !== null && editingEvent
      ? {
          index: editingChord,
          content: (
            <ChordPopover
              key={editingChord}
              open
              anchorRef={staffAnchorRef}
              initialChord={editingEvent.chord}
              palette={palette}
              diatonic={diatonic}
              keyLabel={keySig}
              onCommit={(chord) => applyChord(editingChord, chord)}
              onDelete={
                editingEvent.chord !== undefined
                  ? () => deleteChord(editingChord)
                  : undefined
              }
              onClose={() => setChordEdit(null)}
            />
          ),
        }
      : null;

  return (
    <div className={styles.editor}>
      <h2 className={styles.srOnly}>メロディ</h2>

      <SectionPartBar
        sectionOptions={sectionOptions}
        sectionLabel={label}
        onSectionLabelChange={setLabelChoice}
        partNames={parts.map((p) => p.name)}
        partOrdinal={ordinal}
        onPartOrdinalChange={setPartOrdinal}
        partName={partName}
        noPartHint={`パート「${NEW_PART_NAME}」は最初の入力で作られます`}
        onRenamePart={renamePartTo}
      />

      {onHumImport && (
        <div className={styles.humRow}>
          <Button
            ref={humEntryRef}
            disabled={label === NO_SECTION || unsupportedPreamble}
            onClick={() =>
              onHumImport({
                label,
                partIndex,
                ...(parts.length > 1 && partName ? { partName } : {}),
                ts,
                keySig,
              })
            }
          >
            <MicIcon /> 鼻歌から下書き
          </Button>
        </div>
      )}

      {label === NO_SECTION && (
        <p className={styles.hint}>コード譜でセクションを作ってください</p>
      )}
      {(tsOverride || keyOverride) && (
        <p className={styles.hint}>
          このパートの冒頭で拍子/キーが指定されています（
          {[
            tsOverride && `拍子 ${tsOverride.num}/${tsOverride.den}`,
            keyOverride && `キー ${keyOverride}`,
          ]
            .filter(Boolean)
            .join('、')}
          を使います）
        </p>
      )}
      {view.status === 'barMismatch' && (
        <SectionNotice
          id={noticeId}
          status="barMismatch"
          reason={view.reason}
          timeSigLabel={`${ts.num}/${ts.den}`}
          onReflow={reflow}
        />
      )}
      {view.status === 'readonly' && (
        <SectionNotice
          id={noticeId}
          status="readonly"
          reason={view.reason}
          onRequestTextEdit={onRequestTextEdit}
        />
      )}

      <fieldset
        className={styles.controls}
        disabled={readOnly}
        aria-describedby={readOnly ? noticeId : undefined}
      >
        <legend className={styles.srOnly}>入力</legend>
        <DurationBar
          duration={state.duration}
          dotted={state.dotted}
          onDurationChange={(d) => run({ type: 'setDuration', d })}
          onDottedChange={() => run({ type: 'toggleDot' })}
          onRest={() => run({ type: 'rest' })}
        />
        <TupletPicker
          disabled={readOnly}
          canRemove={canRemoveTuplet}
          onInsert={(n) => run({ type: 'insertTuplet', n })}
          onRemove={() => run({ type: 'removeTuplet' })}
          onDone={focusStaff}
        />
      </fieldset>

      <ModeStatus
        readOnly={readOnly}
        selected={state.selected}
        unit="音"
        onClearSelection={() => run({ type: 'clearSelection' })}
      />

      <div ref={staffContainerRef}>
        <MelodyStaff
          events={events}
          ts={ts}
          keySignature={keySig}
          cursor={state.cursor}
          selected={state.selected}
          previewDuration={{ d: state.duration, dotted: state.dotted }}
          mismatchFrom={mismatchFrom}
          readOnly={readOnly}
          onPlace={(index, pitch) => run({ type: 'placeAt', index, pitch })}
          onPitchDrag={(index, pitch) =>
            run({ type: 'setPitch', index, pitch })
          }
          liveMessage={live}
          onSelect={(index) =>
            run(
              index === null
                ? { type: 'clearSelection' }
                : { type: 'select', index },
            )
          }
          onKeyDown={handleKeyDown}
          onChordClick={openChordEditor}
          overlay={chordOverlay}
          ariaLabel={
            label === NO_SECTION
              ? 'メロディ（セクションなし）'
              : `セクション ${label} のメロディ`
          }
        />
      </div>
      {/* Not role="alert": the live region already says it (R6). */}
      {error && (
        <p className={styles.error} data-testid="editor-error">
          {error}
        </p>
      )}

      <div className={styles.lower}>
        <fieldset className={styles.pianoBlock} disabled={readOnly}>
          <legend className={styles.srOnly}>鍵盤</legend>
          <div className={styles.octaveRow}>
            <span className={styles.fieldLabel}>
              基準オクターブ {state.baseOctave}
            </span>
            <Button
              variant="ghost"
              aria-label="基準オクターブを下げる"
              disabled={state.baseOctave <= MIN_BASE_OCTAVE}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run({ type: 'baseOctaveDown' })}
            >
              −
            </Button>
            <Button
              variant="ghost"
              aria-label="基準オクターブを上げる"
              disabled={state.baseOctave >= MAX_BASE_OCTAVE}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run({ type: 'baseOctaveUp' })}
            >
              ＋
            </Button>
          </div>
          <div className={styles.pianoScroll}>
            <PianoKeyboard
              baseOctave={state.baseOctave}
              keySignature={keySig}
              onKey={handlePianoKey}
              highlight={selectedPitch ? [selectedPitch] : undefined}
            />
          </div>
        </fieldset>

        {!readOnly && (
          <div className={styles.lyrics}>
            <LyricsPanel
              events={events}
              chartSyllables={chart}
              selectedNote={state.selected}
              sectionLabel={label}
              onChange={commitLyrics}
              partLevelLyrics={partLevelLyrics}
              onConvertPartLyrics={convertLyrics}
            />
          </div>
        )}

        {!readOnly && label !== NO_SECTION && (
          <div className={styles.chords}>
            <MelodyChordsPanel
              events={events}
              chart={chartChordInfo}
              sectionLabel={label}
              selected={state.selected}
              result={copyResult?.key === stateKey ? copyResult : null}
              onCopy={copyChords}
              onEdit={() => {
                if (state.selected !== null) openChordEditor(state.selected);
              }}
              onDelete={() => {
                if (state.selected !== null) deleteChord(state.selected);
              }}
              onClearAll={clearAllChords}
            />
          </div>
        )}
      </div>

      <section className={styles.preview} aria-labelledby={`${noticeId}-pv`}>
        <h3 id={`${noticeId}-pv`} className={styles.heading}>
          仕上がりの確認
        </h3>
        {part ? (
          <PartScore song={song} partNames={[part.name]} debounceMs={400} />
        ) : (
          <p className={styles.hint}>まだメロディがありません</p>
        )}
      </section>
    </div>
  );
}

function MicIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
