import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { DashHelp } from '../DashHelp/DashHelp';
import type { AudioPlayer } from '../../hooks/useAudioPlayer';
import type { TsAnalysisResult } from '../../lib/analysis/chords/result';
import {
  chordCandidates,
  draftMeter,
  plainText,
  titleFromFileName,
  type TempoFactor,
} from '../../lib/import/chordDraft';
import {
  barAtTime,
  clampTempo,
  formatClock,
  initialReviewState,
  keyCandidates,
  lowConfidenceCount,
  reviewChanged,
  reviewDraft,
  reviewSections,
  shiftLimit,
  tempoCandidates,
  type KeyCandidate,
  type ReviewSection,
  type ReviewState,
} from '../../lib/import/chordReview';
import { DRAFT_TITLE_SUFFIX } from '../../lib/import/draftMarks';
import { PLAYBACK_FAILED_MESSAGE } from '../../lib/import/importErrors';
import { NO_CHORD } from '../../lib/dashChart';
import { UNTITLED } from '../../lib/serializeSong';
import { displayKey, respellChord } from '../../lib/transpose';
import { Button } from '../Button/Button';
import { Chip } from '../Button/Chip';
import { ConfirmDialog } from '../ConfirmDialog/ConfirmDialog';
import styles from './ChordReview.module.css';

export type ChordReviewProps = {
  result: TsAnalysisResult;
  fileName: string;
  player: AudioPlayer;
  /** 「この内容で曲を作る」 with the reviewed state (the screen writes the song). */
  onCreate: (state: ReviewState) => void;
  /** 「やめて戻る」, after the confirmation when something was changed. */
  onBack: () => void;
  /** The screen's one live region. */
  say?: (message: string) => void;
  /** The page heading (focused when the screen opens). */
  headingRef?: Ref<HTMLHeadingElement>;
};

const TEMPO_LABEL: Record<TempoFactor, string> = {
  0.5: '半分',
  1: '解析のまま',
  2: '倍',
};

const KEY_NOTE: Record<KeyCandidate['note'], string> = {
  best: '最有力',
  relative: '平行調',
  section: '途中の調',
};

interface OpenChord {
  id: number;
  bar: number;
  tok: number;
}

function shiftLabel(n: number): string {
  if (n === 0) return 'ずれなし';
  return n > 0 ? `${n} 拍後へ` : `${-n} 拍前へ`;
}

/**
 * S3 「コード譜の下書きを確かめる」 (docs/audio-integration-plan.md §4, §3.4):
 * whole-song fixes (title, tempo ×2/÷2, key, downbeat), the dash chart with
 * candidates per chord, playback with the current bar highlighted, and one
 * 「この内容で曲を作る」. Every choice lives only here until then.
 */
export function ChordReview({
  result,
  fileName,
  player,
  onCreate,
  onBack,
  say,
  headingRef,
}: ChordReviewProps) {
  const [initial] = useState(() =>
    initialReviewState(result, titleFromFileName(fileName)),
  );
  const [s, setS] = useState<ReviewState>(initial);
  const [open, setOpen] = useState<OpenChord | null>(null);
  const [confirmBack, setConfirmBack] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const titleInputId = useId();
  const ids = {
    whole: useId(),
    chart: useId(),
    side: useId(),
    panel: useId(),
  };

  const meter = useMemo(() => draftMeter(result), [result]);
  const draft = useMemo(() => reviewDraft(result, s), [result, s]);
  const sections = useMemo(() => reviewSections(draft, meter), [draft, meter]);
  const candidates = useMemo(() => chordCandidates(result), [result]);
  const tempos = useMemo(() => tempoCandidates(result), [result]);
  const keys = useMemo(() => keyCandidates(result), [result]);
  const limit = shiftLimit(result);
  const lowCount = lowConfidenceCount(sections);
  const barCount = draft.bars.length;
  const changed = reviewChanged(initial, s);

  const showPosition = player.playing || player.currentTime > 0;
  const currentBar = showPosition
    ? barAtTime(draft.bars, player.currentTime)
    : null;

  // The player re-renders this screen only when the bar changes (and at ~4 Hz).
  const { setBarResolver } = player;
  useEffect(() => {
    setBarResolver((t) => barAtTime(draft.bars, t));
    return () => setBarResolver(null);
  }, [setBarResolver, draft.bars]);

  // Keep the playing bar in view.
  useEffect(() => {
    if (!player.playing || currentBar === null) return;
    const el = chartRef.current?.querySelector<HTMLElement>(
      `[data-bar="${currentBar}"]`,
    );
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [currentBar, player.playing]);

  // Opening a chord's candidates moves focus to its current choice.
  useEffect(() => {
    if (!open) return;
    const panel = chartRef.current?.querySelector<HTMLElement>(
      '[data-testid="candidate-panel"]',
    );
    (
      panel?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
      panel?.querySelector<HTMLElement>('button[aria-pressed]')
    )?.focus();
  }, [open]);

  const update = (patch: Partial<ReviewState>, message?: string) => {
    setS((cur) => ({ ...cur, ...patch }));
    // Bars are redrawn: the open panel's bar / token index would point elsewhere.
    if ('tempoFactor' in patch || 'downbeatShift' in patch || 'key' in patch)
      setOpen(null);
    if (message) say?.(message);
  };

  const spell = (name: string) =>
    s.key === undefined ? name : respellChord(name, s.key);

  const focusChord = (o: OpenChord) => {
    queueMicrotask(() => {
      const root = chartRef.current;
      const el =
        root?.querySelector<HTMLElement>(`[data-chord="${o.bar}:${o.tok}"]`) ??
        root?.querySelector<HTMLElement>(`[data-bar="${o.bar}"] button`);
      el?.focus();
    });
  };

  const closePanel = () => {
    if (open) focusChord(open);
    setOpen(null);
  };

  const choose = (o: OpenChord, name: string) => {
    update(
      { chosen: { ...s.chosen, [o.id]: name } },
      `${o.bar + 1} 小節目のコードを ${spell(name)} にしました`,
    );
    focusChord(o);
    setOpen(null);
  };

  const back = () => {
    if (changed) setConfirmBack(true);
    else onBack();
  };

  const title = s.title.trim() === '' ? UNTITLED : s.title.trim();
  const structure = sections
    .map((sec) => `${sec.label}(${sec.barCount})`)
    .join(' ');

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Button variant="ghost" className={styles.back} onClick={back}>
          ‹ やめて戻る
        </Button>
        <p className={styles.brand}>band-sheets</p>
        <span className={styles.spacer} />
        <span className={styles.muted}>
          録音から新しい曲 ・ 2 / 2（確かめる）
        </span>
      </header>

      <div className={styles.layout}>
        <main className={styles.main}>
          <div className={styles.titleRow}>
            <h1 ref={headingRef} tabIndex={-1} className={styles.h1}>
              コード譜の下書きを確かめる
            </h1>
            <span className={styles.badge}>下書き</span>
          </div>
          <p className={styles.draftNote}>
            これは自動解析の<strong>下書き</strong>
            です。正確な書き起こしではありません。曲を作ったあとに、いつもの編集画面で直せます。
            <span className={styles.muted}>
              {' '}
              {fileName} ・ {formatClock(result.source.durationSec)}
            </span>
          </p>

          <section className={styles.card} aria-labelledby={ids.whole}>
            <h2 id={ids.whole} className={styles.h2}>
              曲の全体
            </h2>

            <div className={styles.row}>
              <label htmlFor={titleInputId} className={styles.label}>
                曲名
              </label>
              <span className={styles.titleField}>
                <input
                  id={titleInputId}
                  className={styles.input}
                  value={s.title}
                  onChange={(e) => update({ title: e.target.value })}
                />
                <span className={styles.muted}>{DRAFT_TITLE_SUFFIX}</span>
              </span>
              <span className={styles.note}>
                「（下書き）」は題名の後ろに付く印です。あとで消してもかまいません。
              </span>
            </div>

            <div className={styles.row}>
              <span className={styles.label} id={`${ids.whole}-tempo`}>
                テンポ
              </span>
              <span
                className={styles.inline}
                role="group"
                aria-labelledby={`${ids.whole}-tempo`}
              >
                <Button
                  aria-label="テンポを 1 下げる"
                  onClick={() =>
                    update(
                      { tempo: clampTempo(s.tempo - 1) },
                      `テンポ ${clampTempo(s.tempo - 1)}`,
                    )
                  }
                >
                  −
                </Button>
                <span className={styles.value} data-testid="review-tempo">
                  ♩= {s.tempo}
                </span>
                <Button
                  aria-label="テンポを 1 上げる"
                  onClick={() =>
                    update(
                      { tempo: clampTempo(s.tempo + 1) },
                      `テンポ ${clampTempo(s.tempo + 1)}`,
                    )
                  }
                >
                  ＋
                </Button>
              </span>
              <span
                className={styles.inline}
                role="group"
                aria-label="テンポの候補"
              >
                {tempos.map((c) => (
                  <Chip
                    key={c.factor}
                    selected={s.tempoFactor === c.factor}
                    className={styles.chip}
                    onClick={() =>
                      update(
                        { tempoFactor: c.factor, tempo: c.tempo },
                        `テンポ ${c.tempo}（${TEMPO_LABEL[c.factor]}）。小節を引き直しました`,
                      )
                    }
                  >
                    {TEMPO_LABEL[c.factor]} {c.tempo}
                  </Chip>
                ))}
              </span>
              <span className={styles.note}>
                倍・半分を選ぶと小節を引き直します。選んだコードはそのままです。
              </span>
            </div>

            <div className={styles.row}>
              <span className={styles.label}>拍子</span>
              <span className={styles.value} data-testid="review-meter">
                {meter.num}/{meter.den}
              </span>
              <span className={styles.note}>解析が判断した拍子です。</span>
            </div>

            <div className={styles.row}>
              <span className={styles.label} id={`${ids.whole}-key`}>
                キー
              </span>
              {keys.length > 0 ? (
                <>
                  <span
                    className={styles.inline}
                    role="group"
                    aria-labelledby={`${ids.whole}-key`}
                  >
                    {keys.map((k) => (
                      <Chip
                        key={k.key}
                        selected={s.key === k.key}
                        className={styles.chip}
                        onClick={() =>
                          update(
                            { key: k.key },
                            `キー ${displayKey(k.key)}。コード名をこのキーの書き方にしました`,
                          )
                        }
                      >
                        {displayKey(k.key)}{' '}
                        <small className={styles.small}>
                          {KEY_NOTE[k.note]}
                        </small>
                      </Chip>
                    ))}
                  </span>
                  <span className={styles.note}>
                    キーは曲の情報と、コード名の書き方（♯と♭）に使います。
                  </span>
                </>
              ) : (
                <span className={styles.note}>
                  キーは分かりませんでした。曲を作ったあとに、曲の情報で入れられます。
                </span>
              )}
            </div>

            <div className={styles.row}>
              <span className={styles.label} id={`${ids.whole}-shift`}>
                小節の頭
              </span>
              <span
                className={styles.inline}
                role="group"
                aria-labelledby={`${ids.whole}-shift`}
              >
                <Button
                  disabled={s.downbeatShift <= -limit}
                  onClick={() =>
                    update(
                      { downbeatShift: s.downbeatShift - 1 },
                      `小節の頭: ${shiftLabel(s.downbeatShift - 1)}`,
                    )
                  }
                >
                  ‹ 1 拍前へ
                </Button>
                <span className={styles.shift} data-testid="review-shift">
                  {shiftLabel(s.downbeatShift)}
                </span>
                <Button
                  disabled={s.downbeatShift >= limit}
                  onClick={() =>
                    update(
                      { downbeatShift: s.downbeatShift + 1 },
                      `小節の頭: ${shiftLabel(s.downbeatShift + 1)}`,
                    )
                  }
                >
                  1 拍後へ ›
                </Button>
              </span>
              <span className={styles.note}>
                1 小節目が、耳で聞いた頭とずれているときに使います。
              </span>
            </div>

            {draft.droppedSec >= 0.05 ? (
              <p className={styles.dropped} data-testid="dropped-notice">
                録音の最初の約 {draft.droppedSec.toFixed(1)} 秒は、1
                小節目より前なので取り込みません。
              </p>
            ) : null}
          </section>

          <section className={styles.card} aria-labelledby={ids.chart}>
            <div className={styles.chartHead}>
              <h2 id={ids.chart} className={styles.h2}>
                コード譜
              </h2>
              <span className={styles.muted} data-testid="chart-summary">
                {barCount} 小節 ・ {sections.length} セクション ・
                確かめたいコード {lowCount} 件
              </span>
              <DashHelp align="start" />
            </div>
            <p className={styles.muted}>
              コードを押すと、ほかの候補が出ます。選ばなければ、解析の第 1
              候補が <span className={styles.mono}>?</span>{' '}
              つきのまま曲に入ります。
            </p>

            <PlayerBar
              player={player}
              durationSec={player.duration ?? result.source.durationSec}
              say={say}
            />

            <div ref={chartRef} className={styles.chart}>
              {sections.map((sec) => (
                <SectionBlock
                  key={sec.index}
                  sec={sec}
                  name={s.sectionNames[sec.index] ?? sec.label}
                  onRename={(name) =>
                    update({
                      sectionNames: { ...s.sectionNames, [sec.index]: name },
                    })
                  }
                  onRevert={() => {
                    const { [sec.index]: _gone, ...rest } = s.sectionNames;
                    update({ sectionNames: rest });
                  }}
                  currentBar={currentBar}
                  open={open}
                  onOpen={(o) => setOpen(o)}
                  onPlayLine={(bar, sec0) => {
                    player.play(sec0);
                    say?.(`${bar + 1} 小節目から再生します`);
                  }}
                  renderPanel={(o) => {
                    const c = candidates[o.id];
                    if (!c) return null;
                    const current = s.chosen[o.id] ?? plainText(c.text);
                    const picked = s.chosen[o.id] !== undefined;
                    return (
                      <div
                        className={styles.panel}
                        role="group"
                        aria-labelledby={ids.panel}
                        data-testid="candidate-panel"
                        onKeyDown={(e: KeyboardEvent) => {
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            closePanel();
                          }
                        }}
                      >
                        <div className={styles.panelHead}>
                          <p id={ids.panel} className={styles.panelTitle}>
                            {o.bar + 1} 小節目のコードの候補
                          </p>
                          <Button variant="ghost" onClick={closePanel}>
                            閉じる
                          </Button>
                        </div>
                        <div className={styles.inline}>
                          {c.candidates.map((x) => (
                            <Chip
                              key={x.name}
                              selected={current === x.name}
                              onClick={() => choose(o, x.name)}
                            >
                              {spell(x.name)}{' '}
                              <small className={styles.small}>
                                {Math.round(x.confidence * 100)}%
                              </small>
                            </Chip>
                          ))}
                          <Chip
                            selected={current === NO_CHORD}
                            onClick={() => choose(o, NO_CHORD)}
                          >
                            {NO_CHORD}{' '}
                            <small className={styles.small}>コードなし</small>
                          </Chip>
                        </div>
                        <p className={styles.note}>
                          {c.lowConfidence && !picked
                            ? `いまは第 1 候補の ${spell(plainText(c.text))} で、? つきです。どれかを押して選ぶと ? が外れます。`
                            : ''}
                          ％は解析の確からしさで、正解の確率ではありません。
                        </p>
                      </div>
                    );
                  }}
                />
              ))}
            </div>

            <div className={styles.legend}>
              <span>
                <span className={styles.mono}>|</span> 小節の区切り（1 行 4
                小節）
              </span>
              <span>
                <span className={styles.mono}>-</span> 八分音符 1 つぶん
              </span>
              <span>
                <span className={styles.mono}>=</span> 十六分音符 1 つぶん
              </span>
              <span>
                <span className={`${styles.mono} ${styles.lowSample}`}>
                  [Am?]
                </span>{' '}
                自信がないコード
              </span>
              <span>
                <span className={styles.mono}>N.C.</span> コードなし
              </span>
            </div>
          </section>
        </main>

        <aside className={styles.side} aria-labelledby={ids.side}>
          <div className={styles.sideCard}>
            <h2 id={ids.side} className={styles.h2small}>
              作る曲
            </h2>
            <dl className={styles.summary}>
              <div>
                <dt>曲名</dt>
                <dd>
                  {title}
                  {DRAFT_TITLE_SUFFIX}
                </dd>
              </div>
              <div>
                <dt>キー / テンポ</dt>
                <dd>
                  {s.key !== undefined ? `${displayKey(s.key)} ・ ` : ''}♩={' '}
                  {s.tempo} ・ {meter.num}/{meter.den}
                </dd>
              </div>
              <div>
                <dt>構成</dt>
                <dd>{structure}</dd>
              </div>
              <div>
                <dt>? つきのコード</dt>
                <dd className={lowCount > 0 ? styles.warn : undefined}>
                  {lowCount} 件
                </dd>
              </div>
            </dl>
            <Button
              variant="primary"
              className={styles.wide}
              onClick={() => onCreate(s)}
            >
              この内容で曲を作る
            </Button>
            <p className={styles.note}>
              この端末に新しい曲として作り、編集画面を開きます。Drive
              には、保存を押したときに保存されます。
            </p>
            <Button className={styles.wide} onClick={back}>
              やめて戻る
            </Button>
            <p className={styles.note}>
              候補とここでの直しは、この画面を閉じると消えます。
            </p>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmBack}
        title="ここでの直しを捨てて戻りますか？"
        message="選んだ候補・曲名・テンポなどの直しは消えます。もう一度使うには、録音を解析し直します。"
        confirmLabel="捨てて戻る"
        danger
        onConfirm={() => {
          setConfirmBack(false);
          onBack();
        }}
        onCancel={() => setConfirmBack(false)}
      />
    </div>
  );
}

function SectionBlock({
  sec,
  name,
  onRename,
  onRevert,
  currentBar,
  open,
  onOpen,
  onPlayLine,
  renderPanel,
}: {
  sec: ReviewSection;
  name: string;
  onRename: (name: string) => void;
  /** Drop the typed name (back to the analyzer's). */
  onRevert: () => void;
  currentBar: number | null;
  open: OpenChord | null;
  onOpen: (o: OpenChord) => void;
  onPlayLine: (bar: number, sec: number) => void;
  renderPanel: (o: OpenChord) => ReactNode;
}) {
  return (
    <div className={styles.section} data-testid={`review-section-${sec.index}`}>
      <div className={styles.sectionHead}>
        <input
          className={styles.sectionName}
          aria-label={`セクション ${sec.index + 1} の名前`}
          value={name}
          onChange={(e) => onRename(e.target.value)}
          onBlur={() => {
            if (name.replace(/[{}\r\n]/g, '').trim() === '') onRevert();
          }}
        />
        <span className={styles.muted}>
          {sec.barCount} 小節 ・ 録音の {formatClock(sec.startSec)} から
        </span>
      </div>
      {sec.lines.map((line) => {
        const first = line[0];
        const last = line[line.length - 1];
        const openHere =
          open !== null && line.some((b) => b.index === open.bar);
        return (
          <div key={first.index}>
            <div className={styles.line}>
              <span className={styles.gutter}>
                {first.index + 1}〜{last.index + 1} 小節
              </span>
              <span
                className={styles.dash}
                data-testid={`review-line-${first.index}`}
              >
                |
                {line.map((bar) => (
                  <span key={bar.index}>
                    <span
                      className={
                        bar.index === currentBar
                          ? `${styles.barText} ${styles.current}`
                          : styles.barText
                      }
                      data-bar={bar.index}
                      data-current={bar.index === currentBar || undefined}
                    >
                      {bar.leading}
                      {bar.tokens.map((t, tok) => {
                        const key = { id: t.id ?? -1, bar: bar.index, tok };
                        if (t.id === null)
                          return (
                            <span key={tok}>
                              <span className={styles.nc}>[{t.chord}]</span>
                              {t.dashes}
                            </span>
                          );
                        const isOpen =
                          open !== null &&
                          open.bar === bar.index &&
                          open.tok === tok;
                        const cls = [
                          styles.chord,
                          t.lowConfidence ? styles.low : '',
                          isOpen ? styles.selected : '',
                        ]
                          .filter(Boolean)
                          .join(' ');
                        return (
                          <span key={tok}>
                            <button
                              type="button"
                              className={cls}
                              data-chord={`${bar.index}:${tok}`}
                              aria-expanded={isOpen}
                              aria-label={`${bar.index + 1} 小節目 ${t.chord}${t.lowConfidence ? '（自信がないコード）' : ''}の候補`}
                              onClick={() => onOpen(key)}
                            >
                              [{t.chord}]
                            </button>
                            {t.dashes}
                          </span>
                        );
                      })}
                    </span>
                    |
                  </span>
                ))}
              </span>
              <Button
                variant="ghost"
                className={styles.playLine}
                aria-label={`${first.index + 1} 小節目から再生`}
                onClick={() => onPlayLine(first.index, first.startSec)}
              >
                ▶
              </Button>
            </div>
            {openHere && open ? renderPanel(open) : null}
          </div>
        );
      })}
    </div>
  );
}

function PlayerBar({
  player,
  durationSec,
  say,
}: {
  player: AudioPlayer;
  durationSec: number;
  say?: (m: string) => void;
}) {
  return (
    <div className={styles.player} data-testid="player-bar">
      <Button
        className={styles.playButton}
        disabled={player.failed}
        aria-label={player.playing ? '録音を止める' : '録音を再生'}
        onClick={() => {
          if (player.playing) {
            player.pause();
            say?.('止めました');
          } else player.play();
        }}
      >
        {player.playing ? '❚❚ 止める' : '▶ 録音'}
      </Button>
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
        onChange={(e) => player.seek(Number(e.target.value))}
      />
      <span className={styles.time}>
        {formatClock(player.currentTime)} / {formatClock(durationSec)}
      </span>
      <span className={styles.note}>
        {player.failed ? PLAYBACK_FAILED_MESSAGE : '行の ▶ で、その行から再生'}
      </span>
    </div>
  );
}
