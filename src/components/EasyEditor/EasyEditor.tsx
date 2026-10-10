import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import {
  graphemes,
  lineLyrics,
  setChordAt,
  updateChord,
  updateLyricLine,
} from '../../lib/chartEdit';
import { applyLyrics, lyricsText } from '../../lib/lyrics';
import { paletteGroups } from '../../lib/palette';
import { isRawLine, type LyricLine, type Song } from '../../lib/song';
import { Button } from '../Button/Button';
import { ChordLyricLine } from '../ChordLyricLine/ChordLyricLine';
import { ChordPopover } from '../ChordPopover/ChordPopover';
import styles from './EasyEditor.module.css';

export type EasyEditorProps = {
  song: Song;
  /** Called exactly once per user action. */
  onChange: (song: Song) => void;
  /**
   * Step-1 draft, lifted to the parent so it survives EasyEditor unmounting
   * when the user switches to editor B and back (m3-review.md R3).
   */
  step: Step;
  onStepChange: (step: Step) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  /**
   * True when the step-1 draft has diverged from the song's lyrics AND
   * editor B changed those lyrics since the draft was created (m3-review.md
   * N1). Shown as a non-blocking notice with two choices, instead of
   * silently keeping or silently overwriting the draft.
   */
  lyricsChangedNotice: boolean;
  /** 「最新の歌詞で作り直す」: discards the draft, starts over from the song. */
  onResetDraft: () => void;
  /** 「この下書きを使う」: keeps the draft, acknowledging the change. */
  onKeepDraft: () => void;
};

export type Step = 'lyrics' | 'chords';

/** Popover target: a character (new chord) or an existing chord segment. */
type Target = {
  section: number;
  line: number;
  /** Highlighted character (for a chord: its segment's first character). */
  charIndex: number;
  /** Set when editing an existing chord. */
  segIndex?: number;
  chord?: string;
};

const BRACKETS = /[[\]{}]/;
const BRACKET_MESSAGE = '歌詞に [ ] { } は使えません';
const HASH_MESSAGE = '行頭に # は使えません（コメントになります）';
const EMPTY_MESSAGE = '歌詞を入力してください';

interface LineIssue {
  /** 1-based line number in the draft, for the error message. */
  line: number;
  message: string;
}

/**
 * Validates only lines that are new or changed relative to `original`
 * (m3-review.md R9): a draft line that exactly matches some original lyric
 * line (as a multiset — order-independent) is always allowed, even if it
 * contains `[ ] { }` from editor B. Everything else is checked for `[ ] { }`
 * (R2's original rule) and for a leading `#` (R2: it would be re-parsed as a
 * comment and vanish from the lyrics).
 */
function lineIssues(draft: string, original: string): LineIssue[] {
  const remaining = new Map<string, number>();
  for (const t of original.split(/\r?\n/)) {
    if (t.trim() === '') continue;
    remaining.set(t, (remaining.get(t) ?? 0) + 1);
  }
  const issues: LineIssue[] = [];
  draft.split(/\r?\n/).forEach((t, i) => {
    if (t.trim() === '') return;
    const left = remaining.get(t) ?? 0;
    if (left > 0) {
      remaining.set(t, left - 1);
      return;
    }
    if (BRACKETS.test(t))
      issues.push({ line: i + 1, message: BRACKET_MESSAGE });
    else if (t.trimStart().startsWith('#')) {
      issues.push({ line: i + 1, message: HASH_MESSAGE });
    }
  });
  return issues;
}

function formatIssues(issues: LineIssue[]): string {
  return issues
    .map((issue) => `${issue.line}行目: ${issue.message}`)
    .join('\n');
}
/** Must match the popover width in ChordPopover.module.css. */
const POPOVER_WIDTH = 320;

/**
 * Editor A 「かんたん入力」: step 1 pastes lyrics (applied with one
 * 「反映」), step 2 places chords by clicking characters.
 */
export function EasyEditor({
  song,
  onChange,
  step,
  onStepChange,
  draft,
  onDraftChange,
  lyricsChangedNotice,
  onResetDraft,
  onKeepDraft,
}: EasyEditorProps) {
  const [draftError, setDraftError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [popoverLeft, setPopoverLeft] = useState(0);
  const anchorRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** data-testid of the element to focus after the popover closes. */
  const returnFocus = useRef<string | null>(null);
  const textareaId = useId();
  const hintId = useId();
  const errorId = useId();

  const hasLyrics = lyricsText(song) !== '';

  // After a commit the clicked button may have been re-created (segments
  // split / merge); move focus to its successor so keyboard users stay put.
  useEffect(() => {
    if (target !== null || returnFocus.current === null) return;
    const testId = returnFocus.current;
    returnFocus.current = null;
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
        ?.focus();
    });
  }, [target]);

  const editLyrics = () => {
    onDraftChange(lyricsText(song));
    setDraftError(null);
    setTarget(null);
    onStepChange('lyrics');
  };

  const apply = () => {
    if (draft.trim() === '') {
      setDraftError(EMPTY_MESSAGE);
      return;
    }
    const issues = lineIssues(draft, lyricsText(song));
    if (issues.length > 0) {
      setDraftError(formatIssues(issues));
      return;
    }
    onChange(applyLyrics(song, draft));
    onStepChange('chords');
  };

  const open = (next: Target, anchor: HTMLButtonElement) => {
    anchorRef.current = anchor;
    const wrap = anchor.closest<HTMLElement>(`.${styles.lineWrap}`);
    if (wrap) {
      const left =
        anchor.getBoundingClientRect().left - wrap.getBoundingClientRect().left;
      const max = Math.max(0, wrap.clientWidth - POPOVER_WIDTH);
      setPopoverLeft(Math.round(Math.min(Math.max(0, left), max)));
    }
    setTarget(next);
  };

  const close = (focusTestId?: string) => {
    returnFocus.current = focusTestId ?? null;
    setTarget(null);
  };

  const editLine = (t: Target, fn: (line: LyricLine) => LyricLine) => {
    onChange(updateLyricLine(song, t.section, t.line, fn));
  };

  const charTestId = (t: Target) =>
    `char-${t.section}-${t.line}-${t.charIndex}`;

  const commit = (chord: string) => {
    if (!target) return;
    const t = target;
    if (t.segIndex === undefined) {
      editLine(t, (line) => setChordAt(line, t.charIndex, chord));
    } else if (chord !== t.chord) {
      editLine(t, (line) => updateChord(line, t.segIndex!, chord));
    }
    close(charTestId(t));
  };

  const remove = () => {
    if (!target || target.segIndex === undefined) return;
    const t = target;
    editLine(t, (line) => updateChord(line, t.segIndex!, null));
    close(charTestId(t));
  };

  const groups = paletteGroups(song);
  const palette = groups.all.filter((c) => !groups.diatonic.includes(c));

  return (
    <div ref={rootRef} className={styles.editor}>
      <ol className={styles.steps} aria-label="手順">
        <li
          className={styles.step}
          aria-current={step === 'lyrics' ? 'step' : undefined}
        >
          <span className={styles.stepNumber} aria-hidden="true">
            1
          </span>
          歌詞
        </li>
        <li
          className={styles.step}
          aria-current={step === 'chords' ? 'step' : undefined}
        >
          <span className={styles.stepNumber} aria-hidden="true">
            2
          </span>
          コード
        </li>
      </ol>

      {step === 'lyrics' ? (
        <div className={styles.lyricsStep}>
          <label htmlFor={textareaId} className={styles.textareaLabel}>
            歌詞を貼り付け
          </label>
          <p id={hintId} className={styles.hint}>
            空行でセクション（A メロ、サビ など）を区切ります。
          </p>
          {lyricsChangedNotice && (
            <div className={styles.notice} role="status">
              <p className={styles.noticeText}>
                テキスト入力で歌詞が変更されました
              </p>
              <div className={styles.noticeActions}>
                <Button variant="secondary" onClick={onResetDraft}>
                  最新の歌詞で作り直す
                </Button>
                <Button variant="primary" onClick={onKeepDraft}>
                  この下書きを使う
                </Button>
              </div>
            </div>
          )}
          <textarea
            id={textareaId}
            className={styles.textarea}
            value={draft}
            onChange={(e) => {
              onDraftChange(e.target.value);
              setDraftError(null);
            }}
            placeholder={
              'きらきらひかる\nおそらのほしよ\n\nみんなのうたが\nとどくといいな'
            }
            rows={14}
            spellCheck={false}
            aria-invalid={draftError !== null}
            aria-describedby={
              draftError !== null ? `${hintId} ${errorId}` : hintId
            }
          />
          {draftError !== null && (
            <p id={errorId} className={styles.error} role="alert">
              {draftError}
            </p>
          )}
          <div className={styles.actions}>
            {hasLyrics && (
              <Button variant="ghost" onClick={() => onStepChange('chords')}>
                キャンセル
              </Button>
            )}
            <Button variant="primary" onClick={apply}>
              反映
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.chordsStep}>
          <div className={styles.toolbar}>
            <p className={styles.hint}>
              文字を押すと、その文字の上にコードを置けます。置いたコードを押すと変更・削除できます。
            </p>
            <Button variant="secondary" onClick={editLyrics}>
              歌詞を編集
            </Button>
          </div>
          <div className={styles.chart}>
            {song.chart.map((section, si) => {
              const hasHeading = section.kind !== '';
              return (
                <section
                  key={si}
                  className={styles.section}
                  aria-label={
                    hasHeading ? section.label || section.kind : undefined
                  }
                >
                  {hasHeading && (
                    <h3 className={styles.heading}>
                      {section.label && <span>{section.label}</span>}
                      <span className={styles.kind}>{section.kind}</span>
                    </h3>
                  )}
                  {section.lines.map((line, li) => {
                    const key = `${si}-${li}`;
                    if (isRawLine(line)) {
                      return (
                        <div key={key} className={styles.raw}>
                          {line.raw}
                        </div>
                      );
                    }
                    if (line.segments.length === 0) {
                      return (
                        <div
                          key={key}
                          className={styles.blank}
                          aria-hidden="true"
                        />
                      );
                    }
                    if (lineLyrics(line).trim() === '') {
                      return (
                        <div key={key} className={styles.readOnly}>
                          <ChordLyricLine line={line} lineKey={key} />
                        </div>
                      );
                    }
                    const active =
                      target?.section === si && target.line === li
                        ? target
                        : null;
                    return (
                      <div
                        key={key}
                        className={styles.lineWrap}
                        style={
                          active
                            ? ({
                                '--chord-popover-left': `${popoverLeft}px`,
                              } as CSSProperties)
                            : undefined
                        }
                      >
                        <ChordLyricLine
                          line={line}
                          lineKey={key}
                          activeCharIndex={active?.charIndex}
                          onCharClick={(charIndex, anchor) =>
                            open({ section: si, line: li, charIndex }, anchor)
                          }
                          onChordClick={(segIndex, anchor) =>
                            open(
                              {
                                section: si,
                                line: li,
                                charIndex: segmentStart(line, segIndex),
                                segIndex,
                                chord: line.segments[segIndex].chord,
                              },
                              anchor,
                            )
                          }
                        />
                        {active && (
                          <ChordPopover
                            key={`${active.charIndex}-${active.segIndex}`}
                            open
                            anchorRef={anchorRef}
                            initialChord={active.chord}
                            palette={palette}
                            diatonic={groups.diatonic}
                            keyLabel={song.meta.key}
                            onCommit={commit}
                            onDelete={
                              active.segIndex !== undefined ? remove : undefined
                            }
                            onClose={() => close()}
                          />
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Grapheme-cluster index (m3-review.md N4: not `Array.from`'s code points,
 * so a preceding segment with NFD dakuten or an emoji ZWJ sequence still
 * resolves to the right character) of the first character of segment
 * `segIndex`.
 */
function segmentStart(line: LyricLine, segIndex: number): number {
  return line.segments
    .slice(0, segIndex)
    .reduce((n, s) => n + graphemes(s.lyrics).length, 0);
}
