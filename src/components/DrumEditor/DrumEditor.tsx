import {
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { DrumEvent, Shuffle } from '../../lib/drum';
import {
  applyDrumCommand,
  initialDrumEditorState,
  keyToDrumCommand,
  tupletForRemoval,
  type DrumCommand,
  type DrumEditorState,
} from '../../lib/drumInput';
import {
  announcement,
  shuffleMessage,
  stateChangeMessage,
  toggleOnPreviousMessage,
  tupletInsertedMessage,
  tupletRemovedMessage,
} from '../../lib/drumLabels';
import { parseDrums } from '../../lib/drumParse';
import {
  drumBarMismatchDisplay,
  drumParts,
  ensureDrumPart,
  readDrumSection,
  reflowDrumSection,
  writeDrumSection,
} from '../../lib/drumPart';
import type { TimeSig } from '../../lib/melody';
import { melodyTimeSignature } from '../../lib/melody';
import { chartOrder } from '../../lib/melodyEditor';
import {
  partSections,
  preambleOverrides,
  renamePart,
  type PreambleOverrides,
} from '../../lib/melodyPart';
import { sectionLabels } from '../../lib/sections';
import type { Song } from '../../lib/song';
import { Button } from '../Button/Button';
import { DrumPads } from '../DrumPads/DrumPads';
import { DrumStaff } from '../DrumStaff/DrumStaff';
import { DurationBar } from '../DurationBar/DurationBar';
import { ModeStatus } from '../ModeStatus/ModeStatus';
import { PartScore } from '../PartScore/PartScore';
import { SectionNotice } from '../SectionNotice/SectionNotice';
import { SectionPartBar } from '../SectionPartBar/SectionPartBar';
import { SegmentedControl } from '../SegmentedControl/SegmentedControl';
import { TupletPicker } from '../TupletPicker/TupletPicker';
import styles from './DrumEditor.module.css';

/** Name of the drum part created by the first edit when there is none. */
const NEW_PART_NAME = 'Drums';

/** Section value of the implicit "no labels at all" choice. */
const NO_SECTION = '';

export interface DrumEditorProps {
  song: Song;
  /** Called exactly once per user action that changes the song. */
  onChange: (song: Song) => void;
  /**
   * Shown as a button in the read-only notice instead of plain text, for a
   * caller that can switch to テキスト入力. Omit to just show the
   * instruction as text.
   */
  onRequestTextEdit?: () => void;
}

type SectionView =
  | { status: 'ok'; events: DrumEvent[]; shuffle: Shuffle }
  | { status: 'missing'; events: DrumEvent[]; shuffle: Shuffle }
  | {
      status: 'readonly';
      events: DrumEvent[];
      shuffle: Shuffle;
      reason: string;
    }
  /**
   * Bars no longer fit the time signature (M3): read-only until reflowed.
   * `events` are display-only (`drumBarMismatchDisplay`: the staff layout
   * would throw on a beat/tuplet crossing a new barline, m5-review.md R1).
   */
  | {
      status: 'barMismatch';
      events: DrumEvent[];
      shuffle: Shuffle;
      reason: string;
    };

const EMPTY: DrumEvent[] = [];

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

/**
 * Events + shuffle of one section of the part body (or unlabeled beats).
 * A section without its own `\tf` shows the inherited shuffle; a missing one
 * the shuffle it would inherit where it gets inserted (m5-review.md R2).
 */
function readView(
  partBody: string | undefined,
  label: string,
  ts: TimeSig,
  unsupportedPreamble: boolean,
  order: string[],
): SectionView {
  if (unsupportedPreamble) {
    return {
      status: 'readonly',
      events: EMPTY,
      shuffle: 'none',
      reason: 'パート冒頭の拍子（\\ts）をアプリでは読めません',
    };
  }
  if (label === NO_SECTION) {
    const unlabeled =
      partBody !== undefined ? partSections(partBody).unlabeled : undefined;
    const parsed = unlabeled ? parseDrums(unlabeled, ts) : null;
    return {
      status: 'readonly',
      events: parsed?.ok ? parsed.events : EMPTY,
      shuffle: parsed?.ok ? parsed.shuffle : 'none',
      reason: 'セクション（\\section）がありません',
    };
  }
  if (partBody === undefined) {
    return { status: 'missing', events: EMPTY, shuffle: 'none' };
  }
  const read = readDrumSection(partBody, label, ts, order);
  switch (read.status) {
    case 'ok':
      return read;
    case 'barMismatch':
      return { ...read, events: drumBarMismatchDisplay(read.events, ts) };
    case 'missing':
      return {
        status: 'missing',
        events: EMPTY,
        shuffle: read.shuffle ?? 'none',
      };
    case 'readonly':
      return {
        status: 'readonly',
        events: EMPTY,
        shuffle: 'none',
        reason: read.reason,
      };
  }
}

function clampState(s: DrumEditorState, length: number): DrumEditorState {
  const cursor = Math.min(Math.max(0, s.cursor), length);
  const selected =
    s.selected !== null && s.selected < length ? s.selected : null;
  return cursor === s.cursor && selected === s.selected
    ? s
    : { ...s, cursor, selected };
}

/** Index of the beat Shift+instrument / S / A act on (select or before). */
function previousBeat(state: DrumEditorState): number {
  return state.selected ?? state.cursor - 1;
}

const SHUFFLE_OPTIONS: { value: Shuffle; label: string }[] = [
  { value: '8', label: '8分' },
  { value: '16', label: '16分' },
  { value: 'none', label: 'なし' },
];

const preventFocusSteal = (e: ReactMouseEvent) => e.preventDefault();

/**
 * Drum tab (M5 T21, docs/m5-plan.md 設計判断 8): section / part selection,
 * input controls (duration, tuplet, ghost / accent, per-section shuffle),
 * the input staff with drum pads, and an alphaTab preview of the drum part.
 * Every edit turns into ONE `onChange(song)` with the edited section (events
 * and shuffle together) rewritten by `writeDrumSection`. Owns the tab's one
 * aria-live region (rendered by DrumStaff via `liveMessage`).
 */
export function DrumEditor({
  song,
  onChange,
  onRequestTextEdit,
}: DrumEditorProps) {
  // Part ------------------------------------------------------------------
  const parts = drumParts(song);
  const [partOrdinal, setPartOrdinal] = useState(0);
  const ordinal = Math.min(partOrdinal, Math.max(0, parts.length - 1));
  const part = parts[ordinal] as (typeof parts)[number] | undefined;
  const partIndex = part ? song.parts.indexOf(part) : -1;
  const partBody = part?.body;

  // The part's own \ts wins over the song info (M11).
  const overrides =
    partBody !== undefined ? preambleOverrides(partBody) : NO_OVERRIDES;
  const unsupportedPreamble = 'unsupported' in overrides;
  const tsOverride = 'unsupported' in overrides ? undefined : overrides.ts;
  const ts = stableTimeSig(tsOverride ?? melodyTimeSignature(song.meta.time));

  // Section ---------------------------------------------------------------
  const labels = sectionLabels(song).map((l) => l.label);
  const [labelChoice, setLabelChoice] = useState<string | null>(null);
  const label =
    labels.length === 0
      ? NO_SECTION
      : labelChoice !== null && labels.includes(labelChoice)
        ? labelChoice
        : labels[0];

  const view = readView(
    partBody,
    label,
    ts,
    unsupportedPreamble,
    chartOrder(song),
  );
  const { events, shuffle } = view;
  const readOnly = view.status === 'readonly' || view.status === 'barMismatch';

  // Editor state, kept per (part, section) ---------------------------------
  const stateKey = `${ordinal}\u0000${label}`;
  const [states, setStates] = useState<Record<string, DrumEditorState>>({});
  const state = clampState(
    states[stateKey] ?? initialDrumEditorState(events),
    events.length,
  );
  // Also store an unchanged state that was only derived so far: otherwise
  // it would be re-derived from the NEW events (cursor at the new end) after
  // an edit that keeps the cursor where it is (e.g. inserting a tuplet).
  const setState = (next: DrumEditorState) => {
    if (next !== state || states[stateKey] === undefined) {
      setStates((m) => ({ ...m, [stateKey]: next }));
    }
  };

  const [error, setError] = useState('');
  /** The editor's one live region (M8). */
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

  // Writing ---------------------------------------------------------------
  /**
   * Writes `next` + `nextShuffle` into the current section: exactly one
   * onChange. Returns false when nothing was written. Never creates an
   * empty section / part.
   */
  const commit = (next: DrumEvent[], nextShuffle: Shuffle): boolean => {
    if (readOnly || label === NO_SECTION) return false;
    if (view.status === 'missing' && next.length === 0) return false;
    let base = song;
    let idx = partIndex;
    if (idx < 0) {
      const ensured = ensureDrumPart(song, NEW_PART_NAME);
      base = ensured.song;
      idx = ensured.partIndex;
    }
    try {
      const body = writeDrumSection(
        base.parts[idx].body,
        label,
        next,
        nextShuffle,
        ts,
        chartOrder(song),
      );
      setError('');
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

  /** Live text for an applied command that changed the events. */
  const editMessage = (
    cmd: DrumCommand,
    next: DrumEvent[],
    nextState: DrumEditorState,
  ): string => {
    switch (cmd.type) {
      case 'insertTuplet':
        return tupletInsertedMessage(cmd.n);
      case 'removeTuplet':
        return tupletRemovedMessage();
      case 'toggleOnPrevious': {
        // A hit toggle never changes lengths, so indexes are stable.
        const i = previousBeat(state);
        if (events[i] && next[i]) {
          return toggleOnPreviousMessage(cmd.inst, events[i], next[i]);
        }
        break;
      }
    }
    return announcement(next, nextState.cursor, nextState.selected);
  };

  const run = (cmd: DrumCommand) => {
    if (readOnly) return;
    const r = applyDrumCommand(events, state, cmd, { ts });
    if (r.message !== undefined) {
      // Refused (events/state unchanged): show the reason and announce it.
      reject(r.message);
      return;
    }
    setError('');
    setState(r.state);
    if (r.events !== events) {
      if (commit(r.events, shuffle)) {
        say(editMessage(cmd, r.events, r.state));
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

  const changeShuffle = (next: Shuffle) => {
    if (readOnly || events.length === 0 || next === shuffle) return;
    if (commit(events, next)) say(shuffleMessage(next));
  };

  /** Tuplet group at the cursor/selection, for 「連符を削除」's canRemove. */
  const canRemoveTuplet = !readOnly && tupletForRemoval(events, state) !== null;

  // Returns keyboard focus to the staff (TupletPicker's onDone, shuffle).
  const staffContainerRef = useRef<HTMLDivElement>(null);
  const focusStaff = () => {
    staffContainerRef.current
      ?.querySelector<HTMLElement>('[role="application"]')
      ?.focus();
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    // DrumStaff forwards every key, Esc included (→ clearSelection).
    const cmd = keyToDrumCommand({
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

  // Re-barring after a time-signature change (M3) --------------------------
  const noticeId = useId();
  const shuffleHintId = useId();
  const reflow = () => {
    if (partBody === undefined || partIndex < 0) return;
    try {
      const body = reflowDrumSection(partBody, label, ts, chartOrder(song));
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

  const shuffleDisabled = readOnly || events.length === 0;

  return (
    <div className={styles.editor}>
      <h2 className={styles.srOnly}>ドラム</h2>

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

      {label === NO_SECTION && (
        <p className={styles.hint}>コード譜でセクションを作ってください</p>
      )}
      {tsOverride && (
        <p className={styles.hint}>
          このパートの冒頭で拍子が指定されています（拍子 {tsOverride.num}/
          {tsOverride.den} を使います）
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
        <div className={styles.articulation} role="group" aria-label="奏法">
          <Button
            aria-keyshortcuts="S"
            title="直前（選択中）の拍の楽器にゴーストを付ける／外す（S）"
            onMouseDown={preventFocusSteal}
            onClick={() => run({ type: 'toggleGhost' })}
          >
            ゴースト
            <span aria-hidden="true" className={styles.keyHint}>
              S
            </span>
          </Button>
          <Button
            aria-keyshortcuts="A"
            title="直前（選択中）の拍の楽器のアクセントを切り替える（なし→アクセント→強いアクセント）（A）"
            onMouseDown={preventFocusSteal}
            onClick={() => run({ type: 'cycleAccent' })}
          >
            アクセント
            <span aria-hidden="true" className={styles.keyHint}>
              A
            </span>
          </Button>
        </div>
        <fieldset
          className={styles.shuffle}
          disabled={shuffleDisabled}
          aria-describedby={
            !readOnly && events.length === 0 ? shuffleHintId : undefined
          }
        >
          <legend className={styles.fieldLabel}>シャッフル</legend>
          <SegmentedControl
            label="シャッフル"
            options={SHUFFLE_OPTIONS}
            value={shuffle}
            onChange={(v) => {
              changeShuffle(v);
              focusStaff();
            }}
          />
          {!readOnly && events.length === 0 && (
            <span id={shuffleHintId} className={styles.hint}>
              拍を入力すると選べます
            </span>
          )}
        </fieldset>
      </fieldset>

      <ModeStatus
        readOnly={readOnly}
        selected={state.selected}
        unit="拍"
        ordinal="番目"
        onClearSelection={() => run({ type: 'clearSelection' })}
      />

      <div className={styles.workArea}>
        <div className={styles.staffColumn}>
          <div ref={staffContainerRef}>
            <DrumStaff
              events={events}
              ts={ts}
              shuffle={shuffle}
              state={state}
              readOnly={readOnly}
              onCommand={run}
              onKeyDown={handleKeyDown}
              liveMessage={live}
              ariaLabel={
                label === NO_SECTION
                  ? 'ドラム（セクションなし）'
                  : `セクション ${label} のドラム`
              }
            />
          </div>
          {/* Not role="alert": the live region already says it (R6). */}
          {error && (
            <p className={styles.error} data-testid="editor-error">
              {error}
            </p>
          )}
        </div>
        <DrumPads
          disabled={readOnly}
          onInput={(inst) => run({ type: 'instInput', inst })}
          onToggleOnPrevious={(inst) => run({ type: 'toggleOnPrevious', inst })}
        />
      </div>

      <section className={styles.preview} aria-labelledby={`${noticeId}-pv`}>
        <h3 id={`${noticeId}-pv`} className={styles.heading}>
          仕上がりの確認
        </h3>
        {part ? (
          <PartScore song={song} partNames={[part.name]} debounceMs={400} />
        ) : (
          <p className={styles.hint}>まだドラムがありません</p>
        )}
      </section>
    </div>
  );
}
