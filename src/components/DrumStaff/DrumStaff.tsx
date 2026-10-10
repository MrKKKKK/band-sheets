import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type { DrumEvent, Shuffle } from '../../lib/drum';
import type { DrumCommand, DrumEditorState } from '../../lib/drumInput';
import {
  hitTestDrums,
  layoutDrums,
  previewDrum,
  type DrumBeatLayout,
  type DrumLayout,
  type DrumTarget,
  type ShuffleMark,
} from '../../lib/drumLayout';
import type { LayoutGlyph, Segment } from '../../lib/staffLayout';
import type { TimeSig } from '../../lib/melody';
import type { LineSegment } from '../../lib/tupletLayout';
import { injectBravuraFontFace } from '../PartScore/bravuraFont';
import styles from './DrumStaff.module.css';

injectBravuraFontFace();

export interface DrumStaffProps {
  /** Normalized events of one section (`normalizeDrums`). */
  events: DrumEvent[];
  /** The section's effective time signature. */
  ts: TimeSig;
  /** The section's shuffle; a "Shuffle" marking is drawn unless 'none'. */
  shuffle?: Shuffle;
  /**
   * Editor state: `cursor` (input mode), `selected` (select mode) and the
   * value of the next input (`duration` / `dotted`, for the hover preview).
   */
  state: Pick<DrumEditorState, 'cursor' | 'selected' | 'duration' | 'dotted'>;
  readOnly?: boolean;
  /**
   * Mouse input, already mapped to editor commands (`hitTestDrums`):
   * notehead → `select { index, inst }`, another height in a beat's column
   * (rests included) → `addAt { index, inst }`, anywhere else →
   * `placeAt { index: insertion point, inst }`. Shift is ignored (a click
   * never removes a hit; use the pads / keys on the selected beat).
   */
  onCommand: (cmd: DrumCommand) => void;
  /** Every keydown on the focused staff (map it with `keyToDrumCommand`). */
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** Text of the live region; the parent (DrumEditor) owns its content. */
  liveMessage?: string;
  /** Fixed width in px; default: the container's width (min 320). */
  width?: number;
  ariaLabel: string;
}

const MIN_WIDTH = 320;

/** The command a click on `t` sends. */
function targetCommand(t: DrumTarget): DrumCommand {
  switch (t.kind) {
    case 'head':
      return { type: 'select', index: t.event, inst: t.inst };
    case 'column':
      return { type: 'addAt', index: t.event, inst: t.inst };
    case 'insert':
      return { type: 'placeAt', index: t.cursor, inst: t.inst };
  }
}

function Glyph({ g, anchor }: { g: LayoutGlyph; anchor?: 'middle' }) {
  return (
    <text x={g.x} y={g.y} textAnchor={anchor}>
      {g.text}
    </text>
  );
}

function Lines({
  segs,
  width,
  className,
}: {
  segs: LineSegment[];
  width: number;
  className: string;
}) {
  return segs.map((seg, i) => (
    <line
      key={i}
      x1={seg.x1}
      y1={seg.y1}
      x2={seg.x2}
      y2={seg.y2}
      strokeWidth={width}
      className={className}
    />
  ));
}

function Ledgers({ ls, width }: { ls: Segment[]; width: number }) {
  return ls.map((l, i) => (
    <line
      key={i}
      x1={l.x1}
      x2={l.x2}
      y1={l.y}
      y2={l.y}
      strokeWidth={width}
      className={styles.ledger}
    />
  ));
}

function Beat({ b, layout }: { b: DrumBeatLayout; layout: DrumLayout }) {
  const t = layout.thickness;
  return (
    <>
      <Ledgers ls={b.ledgerLines} width={t.ledger} />
      {b.stem && (
        <line
          x1={b.stem.x}
          x2={b.stem.x}
          y1={b.stem.y1}
          y2={b.stem.y2}
          strokeWidth={t.stem}
          className={styles.stem}
        />
      )}
      {b.heads.map((h) => (
        <g key={h.inst} data-testid={`head-${b.eventIndex}-${h.inst}`}>
          <Glyph g={h.glyph} />
          {h.ghost && (
            <g data-testid={`ghost-${b.eventIndex}-${h.inst}`}>
              <path
                d={h.ghost.left}
                strokeWidth={t.ghost}
                className={styles.ghost}
              />
              <path
                d={h.ghost.right}
                strokeWidth={t.ghost}
                className={styles.ghost}
              />
            </g>
          )}
        </g>
      ))}
      {b.rest && <Glyph g={b.rest} />}
      {b.flag && <Glyph g={b.flag} />}
      {b.dots.map((d, i) => (
        <Glyph key={`dot-${i}`} g={d} />
      ))}
      {b.accents.map((a, i) => (
        <g key={`acc-${i}`} data-testid={`accent-${b.eventIndex}-${i}`}>
          <Glyph g={a} />
        </g>
      ))}
    </>
  );
}

function ShuffleFigure({ m, layout }: { m: ShuffleMark; layout: DrumLayout }) {
  const t = layout.thickness;
  return (
    <g data-testid="shuffle-mark" data-shuffle={m.shuffle}>
      <text
        x={m.label.x}
        y={m.label.y}
        fontSize={m.labelFontSize}
        className={styles.label}
      >
        {m.label.text}
      </text>
      <text
        x={m.equals.x}
        y={m.equals.y}
        fontSize={m.labelFontSize}
        textAnchor="middle"
        className={styles.label}
      >
        {m.equals.text}
      </text>
      {m.stems.map((st, i) => (
        <line
          key={`st-${i}`}
          x1={st.x}
          x2={st.x}
          y1={st.y1}
          y2={st.y2}
          strokeWidth={t.stem}
          className={styles.stem}
        />
      ))}
      {m.beams.map((bm, i) => (
        <line
          key={`bm-${i}`}
          x1={bm.x1}
          x2={bm.x2}
          y1={bm.y}
          y2={bm.y}
          strokeWidth={t.shuffleBeam}
          className={styles.beam}
        />
      ))}
      <Lines segs={m.tuplet.line} width={t.tuplet} className={styles.tuplet} />
      <g className={styles.music} style={{ fontSize: m.fontSize }}>
        {m.heads.map((h, i) => (
          <Glyph key={`h-${i}`} g={h} />
        ))}
        {m.flags.map((f, i) => (
          <Glyph key={`f-${i}`} g={f} />
        ))}
        <text x={m.tuplet.number.x} y={m.tuplet.number.y} textAnchor="middle">
          {m.tuplet.number.text}
        </text>
      </g>
    </g>
  );
}

/**
 * Hand-drawn drum input staff (M5 T18). Thin view over `layoutDrums`:
 * draws, hit-tests (`hitTestDrums`) and reports clicks as `DrumCommand`s
 * and keys via `onKeyDown`; all editing state lives in the parent.
 */
export function DrumStaff({
  events,
  ts,
  shuffle = 'none',
  state,
  readOnly = false,
  onCommand,
  onKeyDown,
  liveMessage,
  width,
  ariaLabel,
}: DrumStaffProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
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
  const layout = useMemo(
    () => layoutDrums(events, ts, { width: w, shuffle }),
    [events, ts, w, shuffle],
  );

  const toSvg = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (readOnly) return;
    wrapperRef.current?.focus();
    const { x, y } = toSvg(e);
    const t = hitTestDrums(layout, x, y);
    // While a beat is selected, a click on empty staff space only clears
    // the selection (like MelodyStaff) instead of inserting a new beat
    // there — ModeStatus tells the user that click deselects (R4).
    if (t.kind === 'insert' && state.selected !== null) {
      onCommand({ type: 'clearSelection' });
      return;
    }
    onCommand(targetCommand(t));
  };

  const handlePointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (readOnly) return;
    setHover(toSvg(e));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    onKeyDown(e);
  };

  const target = hover ? hitTestDrums(layout, hover.x, hover.y) : null;
  // No place preview while something is selected (mirrors MelodyStaff, M7):
  // a click on an 'insert' target there only clears the selection (R4), so
  // showing a preview there would promise an insert that won't happen.
  // A 'column' target still adds an instrument on click, so its preview stays.
  const preview =
    target && !(target.kind === 'insert' && state.selected !== null)
      ? previewDrum(layout, target, { d: state.duration, dotted: state.dotted })
      : null;

  const s = layout.staffSpace;
  const t = layout.thickness;
  const { selected } = state;
  const selBeat =
    selected !== null && selected >= 0 && selected < layout.beats.length
      ? layout.beats[selected]
      : null;
  const cur = layout.cursors[
    Math.max(0, Math.min(state.cursor, layout.cursors.length - 1))
  ] ?? { system: 0, x: 0 };
  const curSys = layout.systems[cur.system];

  const rootClass = [styles.root, readOnly && styles.readOnly]
    .filter(Boolean)
    .join(' ');

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
              'aria-roledescription': 'ドラム入力',
              'aria-describedby': hintId,
              onKeyDown: handleKeyDown,
            })}
      >
        <svg
          ref={svgRef}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className={styles.svg}
          style={{ fontSize: layout.fontSize }}
          aria-hidden="true"
          data-testid="drum-staff-svg"
          data-target={target?.kind ?? 'none'}
          onClick={handleClick}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* selection highlight, behind everything */}
          {selBeat && (
            <rect
              data-testid="selection"
              x={selBeat.box.x1}
              y={Math.min(selBeat.box.y1, selBeat.top - 0.3 * s)}
              width={selBeat.box.x2 - selBeat.box.x1}
              height={
                selBeat.box.y2 - Math.min(selBeat.box.y1, selBeat.top - 0.3 * s)
              }
              rx={s * 0.3}
              className={styles.selection}
            />
          )}

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

          {layout.shuffle && (
            <ShuffleFigure m={layout.shuffle} layout={layout} />
          )}

          {layout.tuplets.map((tp) => (
            <g
              key={`tuplet-${tp.start}`}
              data-testid={`tuplet-${tp.start}`}
              data-n={tp.n}
            >
              <Lines
                segs={tp.line}
                width={t.tuplet}
                className={styles.tuplet}
              />
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

          {layout.beats.map((b) => (
            <g
              key={b.eventIndex}
              data-testid={`beat-${b.eventIndex}`}
              data-kind={b.kind}
              className={[
                styles.music,
                b.eventIndex === selected && styles.selectedBeat,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <Beat b={b} layout={layout} />
            </g>
          ))}

          {!readOnly && selected === null && curSys && (
            <line
              data-testid="cursor"
              x1={cur.x}
              x2={cur.x}
              y1={curSys.lineYs[0] - s}
              y2={curSys.lineYs[4] + s}
              className={styles.cursor}
            />
          )}

          {preview && (
            <g
              data-testid="preview-drum"
              data-inst={preview.inst}
              data-kind={target?.kind}
              className={`${styles.music} ${styles.preview}`}
            >
              <Ledgers ls={preview.ledgerLines} width={t.ledger} />
              {preview.stem && (
                <line
                  x1={preview.stem.x}
                  x2={preview.stem.x}
                  y1={preview.stem.y1}
                  y2={preview.stem.y2}
                  strokeWidth={t.stem}
                  className={styles.stem}
                />
              )}
              <Glyph g={preview.glyph} />
              {preview.flag && <Glyph g={preview.flag} />}
              {preview.dots.map((d, i) => (
                <Glyph key={i} g={d} />
              ))}
            </g>
          )}
        </svg>
      </div>
      {!readOnly && (
        <p id={hintId} className={styles.srOnly}>
          五線の何もない所をクリックでその高さの楽器を挿入、拍の列の別の高さをクリックでその拍に楽器を足す、符頭をクリックで拍を選択。キーで楽器を入力（Shift＋キーで直前の拍に足す・外す）、数字キー
          1 2 4 8 6
          で音価、ピリオドで付点、Rで休符、Sでゴースト、Aでアクセント、Backspaceで削除、Enterで直前の拍を選択、Escで選択解除。
        </p>
      )}
      <div
        aria-live="polite"
        className={styles.srOnly}
        data-testid="staff-live"
      >
        {liveMessage ?? ''}
      </div>
    </div>
  );
}
