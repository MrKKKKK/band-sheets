import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { Duration, MelodyEvent, TimeSig } from '../../lib/melody';
import {
  CHORD_FONT_SPACES,
  hitTestChord,
  hitTestNote,
  layoutMelody,
  nearestCursor,
  previewPiece,
  STEP_RANGE,
  stepAt,
  systemAt,
  yToPitch,
  type Layout,
  type LayoutGlyph,
  type PreviewPiece,
} from '../../lib/staffLayout';
import { injectBravuraFontFace } from '../PartScore/bravuraFont';
import { announcement, pitchTooltip } from './labels';
import styles from './MelodyStaff.module.css';

injectBravuraFontFace();

export interface MelodyStaffProps {
  events: MelodyEvent[];
  ts: TimeSig;
  /** Song key; clicked pitches follow its key signature (key G → F#). */
  keySignature?: string;
  /** Insertion point 0..events.length (before event i). */
  cursor: number;
  /** Selected event index, or null. */
  selected: number | null;
  /** Note value of the hover preview (the value the next note will get). */
  previewDuration: { d: Duration; dotted: boolean };
  /** Lyrics of events from this index on are drawn in --warning. */
  mismatchFrom?: number | null;
  readOnly?: boolean;
  /**
   * Click on empty staff space with nothing selected: insert `pitch` at
   * insertion point `index`. While something is selected, that click only
   * calls `onSelect(null)` (M7); the next one places.
   */
  onPlace: (index: number, pitch: string) => void;
  /** Click a note/rest (again → null), Escape → null. */
  onSelect: (index: number | null) => void;
  /**
   * Drag of the selected note up/down (M9): called once on pointer release
   * with the new pitch (key-aware, `yToPitch`), only if it changed. Escape
   * during the drag cancels it. Omit to disable dragging.
   */
  onPitchDrag?: (index: number, pitch: string) => void;
  /**
   * Text for the live region. When given, it replaces the built-in
   * cursor/selection announcement, so a parent (MelodyEditor) can own the
   * one live region of the editor (M8).
   */
  liveMessage?: string;
  /** Every keydown on the focused staff (Escape included). */
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** Fixed width in px; default: the container's width (min 320). */
  width?: number;
  ariaLabel: string;
  /**
   * Chord editing (issue #6): a click on a chord name, or on the dotted
   * ＋ box drawn above a selected chordless note, calls this with the
   * event index. Omit to draw chords read-only (and no ＋ box).
   */
  onChordClick?: (index: number) => void;
  /**
   * Content (the chord popover) shown in a box just below event
   * `overlay.index`'s notehead, outside the keyboard-handling wrapper so
   * typing in it never reaches `onKeyDown`.
   */
  overlay?: { index: number; content: ReactNode } | null;
  /**
   * Review staff (S4, the humming draft): a click only selects a note (or clears the selection); nothing is
   * placed, no hover preview, and the cursor line is drawn only at `playhead`. Keys still go to `onKeyDown`.
   */
  selectOnly?: boolean;
  /** `selectOnly`: the cursor line (before event i, e.g. the note sounding now); null/absent = none. */
  playhead?: number | null;
  /** Events drawn in --warning (S4: low-confidence notes), lyric row included. */
  markedNotes?: ReadonlySet<number>;
}

/** Must match the popover width in ChordPopover.module.css. */
const OVERLAY_WIDTH = 320;

const MIN_WIDTH = 320;
/** px of vertical movement before a press on the selected note is a drag. */
const DRAG_THRESHOLD = 3;

interface Drag {
  index: number;
  pointerId: number;
  /** Pointer y at the press, and the notehead's y / system then. */
  startY: number;
  noteY: number;
  system: number;
  /** Pitch before the drag, and the one shown now. */
  from: string;
  pitch: string;
  moved: boolean;
}

interface Hover {
  x: number;
  y: number;
}

/** Hover target: a note (select on click) or a place preview, or nothing. */
type Target =
  | { kind: 'chord'; index: number }
  | { kind: 'note'; index: number }
  | { kind: 'place'; cursor: number; pitch: string }
  | null;

/** The dotted ＋ box above a selected chordless note (x/y = top left). */
function chordSlotBox(layout: Layout, selected: number | null) {
  if (selected === null) return null;
  const p = layout.pieces.find(
    (p) => p.eventIndex === selected && p.pieceIndex === 0,
  );
  if (!p || p.chordLabel) return null;
  const s = layout.staffSpace;
  const h = CHORD_FONT_SPACES * s + 0.4 * s;
  const y = layout.systems[p.system].chordY;
  return { x: p.glyph.x - 0.3 * s, y: y - h + 0.35 * s, w: 2.6 * s, h };
}

function targetAt(
  layout: Layout,
  x: number,
  y: number,
  key: string | undefined,
  chords: { selected: number | null } | null,
): Target {
  if (chords) {
    const c = hitTestChord(layout, x, y);
    if (c !== null) return { kind: 'chord', index: c };
    const box = chordSlotBox(layout, chords.selected);
    if (
      box &&
      x >= box.x &&
      x <= box.x + box.w &&
      y >= box.y &&
      y <= box.y + box.h
    ) {
      return { kind: 'chord', index: chords.selected! };
    }
  }
  const hit = hitTestNote(layout, x, y);
  if (hit !== null) return { kind: 'note', index: hit };
  const sys = systemAt(layout, y);
  const step = stepAt(layout, sys, y);
  // Outside D3…G6 (e.g. the lyric row): not a place to put a note.
  if (step < STEP_RANGE.min - 1 || step > STEP_RANGE.max + 1) return null;
  return {
    kind: 'place',
    cursor: nearestCursor(layout, x, y),
    pitch: yToPitch(layout, sys, y, key),
  };
}

function Glyph({
  g,
  className,
  anchor,
}: {
  g: LayoutGlyph;
  className?: string;
  anchor?: 'middle';
}) {
  return (
    <text x={g.x} y={g.y} className={className} textAnchor={anchor}>
      {g.text}
    </text>
  );
}

/** Notehead / stem / flag / dot / accidental / ledger lines (no hit box). */
function NoteShape({
  p,
  layout,
}: {
  p: Pick<
    PreviewPiece,
    'glyph' | 'stem' | 'flag' | 'dot' | 'accidental' | 'ledgerLines'
  >;
  layout: Layout;
}) {
  const t = layout.thickness;
  return (
    <>
      {p.ledgerLines.map((l, i) => (
        <line
          key={i}
          x1={l.x1}
          x2={l.x2}
          y1={l.y}
          y2={l.y}
          strokeWidth={t.ledger}
          className={styles.ledger}
        />
      ))}
      {p.stem && (
        <line
          x1={p.stem.x}
          x2={p.stem.x}
          y1={p.stem.y1}
          y2={p.stem.y2}
          strokeWidth={t.stem}
          className={styles.stem}
        />
      )}
      <Glyph g={p.glyph} />
      {p.flag && <Glyph g={p.flag} />}
      {p.dot && <Glyph g={p.dot} />}
      {p.accidental && <Glyph g={p.accidental} />}
    </>
  );
}

/**
 * Hand-drawn input staff for the melody editor (M4 T11, docs/m4-plan.md
 * decisions 3 and 5). Thin view over `layoutMelody`: draws, hit-tests and
 * reports clicks / keys; all editing state lives in the parent.
 */
export function MelodyStaff({
  events,
  ts,
  keySignature,
  cursor,
  selected,
  previewDuration,
  mismatchFrom = null,
  readOnly = false,
  onPlace,
  onSelect,
  onPitchDrag,
  liveMessage,
  onKeyDown,
  width,
  ariaLabel,
  onChordClick,
  overlay = null,
  selectOnly = false,
  playhead = null,
  markedNotes,
}: MelodyStaffProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Swallows the click that follows a drag (or a cancelled one). */
  const suppressClick = useRef(false);
  const hintId = useId();

  useLayoutEffect(() => {
    if (width !== undefined) return;
    const el = rootRef.current;
    if (!el) return;
    setMeasured(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => {
      setMeasured(Math.floor(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const w = Math.max(MIN_WIDTH, width ?? measured ?? MIN_WIDTH);
  // While dragging, draw the selected note at its preview pitch.
  const dragPitch = drag?.moved ? drag.pitch : null;
  const dragIndex = drag?.index ?? null;
  const shown = useMemo(
    () =>
      dragPitch === null || dragIndex === null
        ? events
        : events.map((e, i) =>
            i === dragIndex ? { ...e, pitch: dragPitch } : e,
          ),
    [events, dragIndex, dragPitch],
  );
  const layout = useMemo(
    () => layoutMelody(shown, ts, { width: w, key: keySignature }),
    [shown, ts, w, keySignature],
  );

  const chordTargets = onChordClick && !readOnly ? { selected } : null;

  // aria-live: announce the note at the cursor / selection after changes
  // (not on mount).
  const message = announcement(events, cursor, selected);
  const [live, setLive] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setLive(message);
  }, [message]);

  const toSvg = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (readOnly) return;
    wrapperRef.current?.focus();
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const { x, y } = toSvg(e);
    const t = targetAt(layout, x, y, keySignature, chordTargets);
    if (!t) return;
    if (t.kind === 'chord') onChordClick?.(t.index);
    else if (t.kind === 'note') onSelect(t.index === selected ? null : t.index);
    else if (selectOnly || selected !== null) {
      if (selected !== null) onSelect(null);
    } else onPlace(t.cursor, t.pitch);
  };

  const release = (target: Element, pointerId: number) => {
    try {
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // Synthetic pointer ids (tests) have no capture to release.
    }
  };

  const handlePointerDown = (e: PointerEvent<SVGSVGElement>) => {
    suppressClick.current = false;
    if (readOnly || !onPitchDrag || selected === null || e.button !== 0) {
      return;
    }
    const { x, y } = toSvg(e);
    const piece = layout.pieces.find(
      (p) =>
        p.eventIndex === selected &&
        x >= p.box.x1 &&
        x <= p.box.x2 &&
        y >= p.box.y1 &&
        y <= p.box.y2,
    );
    const ev = events[selected];
    if (!piece || ev?.kind !== 'note' || !ev.pitch) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer ids (tests) cannot be captured; moves still arrive.
    }
    wrapperRef.current?.focus();
    setHover(null);
    setDrag({
      index: selected,
      pointerId: e.pointerId,
      startY: y,
      noteY: piece.y,
      system: piece.system,
      from: ev.pitch,
      pitch: ev.pitch,
      moved: false,
    });
  };

  const handlePointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (readOnly) return;
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      const dy = toSvg(e).y - drag.startY;
      const moved = drag.moved || Math.abs(dy) > DRAG_THRESHOLD;
      // Back on the note's own staff step: keep its original spelling
      // (e.g. F#4 in key C), not the key signature's.
      const atStart = yToPitch(layout, drag.system, drag.noteY, keySignature);
      const at = yToPitch(layout, drag.system, drag.noteY + dy, keySignature);
      const pitch = moved && at !== atStart ? at : drag.from;
      if (moved !== drag.moved || pitch !== drag.pitch) {
        setDrag({ ...drag, moved, pitch });
      }
      return;
    }
    setHover(toSvg(e));
  };

  const handlePointerUp = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    release(e.currentTarget, e.pointerId);
    setDrag(null);
    if (!drag.moved) return; // a plain press: the click toggles selection
    suppressClick.current = true;
    if (drag.pitch !== drag.from) onPitchDrag?.(drag.index, drag.pitch);
  };

  const cancelDrag = () => {
    if (!drag) return;
    const svg = svgRef.current;
    if (svg) release(svg, drag.pointerId);
    setDrag(null);
    suppressClick.current = true;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (drag) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelDrag();
      }
      return;
    }
    if (e.key === 'Escape' && selected !== null) onSelect(null);
    onKeyDown(e);
  };

  // No place preview while something is selected: a click there only
  // clears the selection (M7).
  const target =
    hover && !drag
      ? targetAt(layout, hover.x, hover.y, keySignature, chordTargets)
      : null;
  const preview =
    target?.kind === 'place' && selected === null && !selectOnly
      ? previewPiece(
          layout,
          target.cursor,
          target.pitch,
          previewDuration.d,
          previewDuration.dotted,
        )
      : null;

  const s = layout.staffSpace;
  const t = layout.thickness;
  const cursorAt = selectOnly ? playhead : cursor;
  const cur =
    layout.cursors[
      Math.max(0, Math.min(cursorAt ?? 0, layout.cursors.length - 1))
    ];
  const curSys = layout.systems[cur.system];
  const selectedPieces =
    selected === null
      ? []
      : layout.pieces.filter((p) => p.eventIndex === selected);

  const rootClass = [styles.root, readOnly && styles.readOnly]
    .filter(Boolean)
    .join(' ');

  const slot = chordTargets ? chordSlotBox(layout, selected) : null;
  const overlayPiece = overlay
    ? layout.pieces.find(
        (p) => p.eventIndex === overlay.index && p.pieceIndex === 0,
      )
    : undefined;
  const overlayStyle = overlayPiece
    ? ({
        left: overlayPiece.glyph.x,
        top: overlayPiece.box.y2 + 0.4 * s,
        // Keeps the popover inside the staff's width (ChordPopover reads it).
        '--chord-popover-left': `${
          Math.min(
            Math.max(0, overlayPiece.glyph.x),
            Math.max(0, layout.width - OVERLAY_WIDTH),
          ) - overlayPiece.glyph.x
        }px`,
      } as CSSProperties)
    : undefined;

  return (
    <div ref={rootRef} className={rootClass}>
      <div
        ref={wrapperRef}
        className={styles.wrapper}
        {...(readOnly
          ? { role: 'img', 'aria-label': `${ariaLabel}（読み取り専用）` }
          : {
              role: 'application',
              tabIndex: 0,
              'aria-label': ariaLabel,
              'aria-roledescription': selectOnly
                ? '下書きの譜面'
                : 'メロディ入力',
              'aria-describedby': hintId,
              onKeyDown: handleKeyDown,
            })}
      >
        <svg
          ref={svgRef}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className={
            drag?.moved ? `${styles.svg} ${styles.dragging}` : styles.svg
          }
          style={{ fontSize: layout.fontSize }}
          aria-hidden="true"
          data-testid="melody-staff-svg"
          data-target={target?.kind ?? 'none'}
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={cancelDrag}
          onPointerLeave={() => setHover(null)}
        >
          {/* selection highlight, behind everything */}
          {selectedPieces.map((p) => (
            <rect
              key={`sel-${p.pieceIndex}`}
              data-testid="selection"
              x={p.box.x1}
              y={p.box.y1}
              width={p.box.x2 - p.box.x1}
              height={p.box.y2 - p.box.y1}
              rx={s * 0.3}
              className={styles.selection}
            />
          ))}

          {layout.systems.map((sys) => (
            <g key={`sys-${sys.index}`} data-testid={`system-${sys.index}`}>
              {sys.lineYs.map((y, i) => (
                <line
                  key={i}
                  x1={sys.lineX1}
                  x2={sys.lineX2}
                  y1={y}
                  y2={y}
                  strokeWidth={t.staffLine}
                  className={styles.staffLine}
                />
              ))}
              {sys.barlines.map((x, i) => (
                <line
                  key={`bar-${i}`}
                  x1={x}
                  x2={x}
                  y1={sys.lineYs[0]}
                  y2={sys.lineYs[4]}
                  strokeWidth={t.barline}
                  className={styles.barline}
                />
              ))}
              <g className={styles.music} data-testid={`clef-${sys.index}`}>
                <Glyph g={sys.clef} />
                {sys.timeSig && (
                  <>
                    <Glyph g={sys.timeSig.num} anchor="middle" />
                    <Glyph g={sys.timeSig.den} anchor="middle" />
                  </>
                )}
              </g>
            </g>
          ))}

          {layout.ties.map((tie, i) => (
            <path
              key={`tie-${i}`}
              d={tie.d}
              strokeWidth={t.tie}
              className={styles.tie}
            />
          ))}

          {[...new Set(layout.slurs.map((sl) => sl.start))].map((start) => (
            <g key={`slur-${start}`} data-testid={`slur-${start}`}>
              {layout.slurs
                .filter((sl) => sl.start === start)
                .map((sl) => (
                  <path
                    key={sl.system}
                    d={sl.d}
                    strokeWidth={t.tie}
                    className={styles.slur}
                  />
                ))}
            </g>
          ))}

          {layout.tuplets.map((tp) => (
            <g key={`tuplet-${tp.start}`} data-testid={`tuplet-${tp.start}`}>
              {tp.line.map((seg, i) => (
                <line
                  key={i}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  strokeWidth={t.tuplet}
                  className={styles.tuplet}
                />
              ))}
              <text
                x={tp.number.x}
                y={tp.number.y}
                textAnchor="middle"
                className={styles.music}
              >
                {tp.number.text}
              </text>
            </g>
          ))}

          {layout.pieces.map((p) => {
            const isSel = p.eventIndex === selected;
            return (
              <g
                key={`${p.eventIndex}-${p.pieceIndex}`}
                data-testid={`${p.kind}-${p.eventIndex}-${p.pieceIndex}`}
                className={[
                  styles.music,
                  markedNotes?.has(p.eventIndex) && styles.marked,
                  isSel && styles.selectedNote,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <NoteShape p={p} layout={layout} />
              </g>
            );
          })}

          {layout.pieces.map(
            (p) =>
              p.lyric && (
                <text
                  key={`lyric-${p.eventIndex}`}
                  data-testid={`lyric-${p.eventIndex}`}
                  x={p.lyric.x}
                  y={p.lyric.y}
                  textAnchor="middle"
                  fontSize={s * 1.6}
                  className={
                    (mismatchFrom !== null && p.eventIndex >= mismatchFrom) ||
                    markedNotes?.has(p.eventIndex)
                      ? `${styles.lyric} ${styles.lyricWarn}`
                      : styles.lyric
                  }
                >
                  {p.lyric.text}
                </text>
              ),
          )}

          {layout.pieces.map((p) => {
            const c = p.chordLabel;
            if (!c) return null;
            const isSel = chordTargets !== null && p.eventIndex === selected;
            const fs = s * CHORD_FONT_SPACES;
            return (
              <g
                key={`chord-${p.eventIndex}`}
                className={isSel ? styles.chordSelected : undefined}
              >
                {isSel && (
                  <rect
                    x={c.x - 0.3 * s}
                    y={c.y - fs * 0.95}
                    width={c.width + 0.6 * s}
                    height={fs * 1.25}
                    rx={s * 0.3}
                    className={styles.chordSelectedBg}
                  />
                )}
                <text
                  data-testid={`chord-${p.eventIndex}`}
                  data-row={c.row}
                  x={c.x}
                  y={c.y}
                  fontSize={fs}
                  className={styles.chord}
                >
                  {c.text}
                </text>
              </g>
            );
          })}

          {slot && (
            <g data-testid="chord-slot" className={styles.chordSlot}>
              <rect
                x={slot.x}
                y={slot.y}
                width={slot.w}
                height={slot.h}
                rx={s * 0.3}
              />
              <text
                x={slot.x + slot.w / 2}
                y={slot.y + slot.h * 0.78}
                textAnchor="middle"
                fontSize={s * 1.5}
              >
                ＋
              </text>
            </g>
          )}

          {!readOnly && cursorAt !== null && (
            <line
              data-testid="cursor"
              x1={cur.x}
              x2={cur.x}
              y1={curSys.lineYs[0] - s}
              y2={curSys.lineYs[4] + s}
              className={styles.cursor}
            />
          )}

          {drag?.moved && selectedPieces[0] && (
            <text
              data-testid="drag-tooltip"
              x={selectedPieces[0].x + 1.6 * s}
              y={selectedPieces[0].y + 0.45 * s}
              fontSize={s * 1.3}
              className={styles.tooltip}
            >
              {pitchTooltip(drag.pitch)}
            </text>
          )}

          {preview && (
            <g data-testid="preview-note" data-pitch={preview.pitch}>
              <g className={`${styles.music} ${styles.preview}`}>
                <NoteShape p={preview} layout={layout} />
              </g>
              <text
                data-testid="preview-tooltip"
                // Right of the notehead (past a flag / dot), on its line:
                // above the staff it would collide with chord labels.
                x={preview.x + (previewDuration.dotted ? 2.2 : 1.6) * s}
                y={preview.y + 0.45 * s}
                fontSize={s * 1.3}
                className={styles.tooltip}
              >
                {pitchTooltip(preview.pitch)}
              </text>
            </g>
          )}
        </svg>
      </div>
      {overlayStyle && (
        <div className={styles.overlay} style={overlayStyle}>
          {overlay!.content}
        </div>
      )}
      {!readOnly && selectOnly && (
        <p id={hintId} className={styles.srOnly}>
          音符をクリックすると、その音の候補が出ます。← → で前後の音を選び、Esc
          で選ぶのをやめます。
        </p>
      )}
      {!readOnly && !selectOnly && (
        <p id={hintId} className={styles.srOnly}>
          五線をクリックで音を置く、音符をクリックで選択（選択中に空き部分をクリックすると選択解除、選んだ音符は上下ドラッグで高さを変更）。A〜Kキーで音を入力、W
          E T Y U で黒鍵、Shiftで1オクターブ上。数字キー 1 2 4 8 6
          で音価、ピリオドで付点、Rで休符、Backspaceで削除。Enterでカーソル直前の音符を選択、Escで選択解除。↑↓で選んだ音を半音上下、Shift＋↑↓で1オクターブ、Ctrl＋↑↓で基準オクターブ。歌詞:
          Nでのばす、Mでつめる、Vで分ける、Cで歌詞なし。
          {onChordClick &&
            'コード: Shift＋Cで選んだ音符のコードを置く・変える、Shift＋Backspaceで消す。'}
        </p>
      )}
      <div
        aria-live="polite"
        className={styles.srOnly}
        data-testid="staff-live"
      >
        {liveMessage ?? live}
      </div>
    </div>
  );
}
