import { useId, useState, type ReactNode, type Ref } from 'react';
import type { HumTarget } from '../../lib/import/humImport';
import type { ImportNotice } from '../../lib/import/importErrors';
import type { TimeSig } from '../../lib/melody';
import { Button } from '../Button/Button';
import styles from './HumSetup.module.css';

/** What S2 asks for, besides the source. */
export interface HumSetupValue {
  label: string;
  /** Quarter notes per minute, like the song's `{tempo}`. */
  tempo: number;
  /** '' = no key. */
  key: string;
  bar: number;
  beat: number;
}

/**
 * Where the singing comes from: everything in S2 that depends on it. HumSetup only lays these out, so the
 * screen decides what the first card holds (today: a picked file).
 */
export interface HumSource {
  /** The first card's heading (numbered, e.g. 「1. 録音ファイル」). */
  heading: string;
  /** The first card's body. */
  field: ReactNode;
  /** Something is chosen (decides the hint under 「解析する」). */
  chosen: boolean;
  /** 「解析する」 may start: chosen and fully read (not still probing). */
  ready: boolean;
  /** The summary card's 「ファイル」 row. */
  summary: string;
  /** Under 「解析する」 while nothing is chosen yet. */
  startHint: string;
  /** The error's action to choose again (e.g. 「別のファイルを選ぶ」). */
  retake: { label: string; onClick: () => void };
  /** The `<li>`s of the 「録り方」 card. */
  how: ReactNode;
}

export type HumSetupProps = {
  songTitle: string;
  /** Shown only when the song has more than one melody part. */
  partName?: string;
  targets: HumTarget[];
  /** The section's time signature (fixed: the draft is written in it). */
  ts: TimeSig;
  value: HumSetupValue;
  onChange: (value: HumSetupValue) => void;
  source: HumSource;
  /** Error / 「中止しました」 above the form (texts from importErrors.ts). */
  notice: ImportNotice | null;
  noticeRef?: Ref<HTMLDivElement>;
  /** The progress card while analysing (the form is then disabled). */
  progress?: ReactNode;
  onStart: () => void;
  onBack: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
};

const TEMPO_RANGE = { min: 40, max: 240 } as const;

/** Keys offered in S2 (the song's own key is added when it is not among them). */
const KEYS = [
  'C',
  'G',
  'D',
  'A',
  'E',
  'B',
  'F#',
  'Db',
  'Ab',
  'Eb',
  'Bb',
  'F',
  'Am',
  'Em',
  'Bm',
  'F#m',
  'C#m',
  'G#m',
  'Dm',
  'Gm',
  'Cm',
  'Fm',
  'Bbm',
  'Ebm',
];
const BARS = 16;

const displayKey = (k: string) => k.replace('#', '♯').replace(/b(?=m?$)/, '♭');

function targetLabel(t: HumTarget): string {
  if (!t.writable) return `${t.label}（この画面では入れられません）`;
  return t.notes > 0
    ? `${t.label}（${t.bars} 小節）`
    : `${t.label}（まだ音符なし）`;
}

/**
 * S2 「鼻歌から下書きを作る」 (docs/audio-integration-plan.md §4, sketch D2): the recording, where it goes, the
 * song info it is analysed with, where the singing starts, and how to record (always shown). A summary card on
 * the right with 「解析する」. Presentational: the screen owns the state and the one live region.
 */
export function HumSetup({
  songTitle,
  partName,
  targets,
  ts,
  value,
  onChange,
  source,
  notice,
  noticeRef,
  progress,
  onStart,
  onBack,
  headingRef,
}: HumSetupProps) {
  const id = useId();
  const busy = progress !== undefined && progress !== null;
  const set = (patch: Partial<HumSetupValue>) =>
    onChange({ ...value, ...patch });
  const keys =
    value.key && !KEYS.includes(value.key) ? [value.key, ...KEYS] : KEYS;
  const target = targets.find((t) => t.label === value.label);
  const canStart = !busy && source.ready && !!target?.writable;
  /** The tempo field while typing; checked and clamped on blur / Enter (null = not editing). */
  const [tempoText, setTempoText] = useState<string | null>(null);
  const commitTempo = () => {
    if (tempoText === null) return;
    const n = Number(tempoText);
    setTempoText(null);
    if (tempoText.trim() !== '' && Number.isFinite(n) && n > 0)
      set({ tempo: tempo(n) });
  };
  const tempo = (n: number) =>
    Math.min(TEMPO_RANGE.max, Math.max(TEMPO_RANGE.min, Math.round(n)));
  const where = `${songTitle}${partName ? ` / ${partName}` : ''} / ${value.label}`;
  const start = `${value.bar} 小節目の ${value.beat} 拍目`;

  return (
    <div className={styles.layout}>
      <main className={styles.main}>
        <div className={styles.titleRow}>
          <h1 ref={headingRef} tabIndex={-1} className={styles.h1}>
            鼻歌から下書きを作る
          </h1>
          <span className={styles.badge}>下書き</span>
        </div>
        <p className={styles.draftNote}>
          歌った声から、メロディの<strong>高さと長さのおおよその下書き</strong>
          を作ります。正確な書き起こしではありません。次の画面で、録音と聞き比べながら直せます。
          <span className={styles.muted}>
            {' '}
            音は、この端末の外には出ません。
          </span>
        </p>

        {progress}

        {notice ? (
          <div
            ref={noticeRef}
            tabIndex={-1}
            className={notice.severity === 'error' ? styles.error : styles.info}
            data-testid="import-notice"
            data-severity={notice.severity}
          >
            <p className={styles.noticeText}>{notice.message}</p>
            {notice.severity === 'error' ? (
              <div className={styles.actions}>
                <Button onClick={source.retake.onClick}>
                  {source.retake.label}
                </Button>
                {notice.retry ? (
                  <Button
                    variant="primary"
                    onClick={onStart}
                    disabled={!canStart}
                  >
                    もう一度試す
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <fieldset className={styles.fields} disabled={busy}>
          <legend className={styles.srOnly}>解析の内容</legend>
          <section className={styles.card} aria-labelledby={`${id}-file`}>
            <h2 id={`${id}-file`} className={styles.h2}>
              {source.heading}
            </h2>
            {source.field}
          </section>

          <section className={styles.card} aria-labelledby={`${id}-to`}>
            <h2 id={`${id}-to`} className={styles.h2}>
              2. 入れる場所
            </h2>
            <div className={styles.row}>
              <span className={styles.label}>曲</span>
              <strong>{songTitle}</strong>
              {partName ? (
                <span className={styles.muted}>パート {partName}</span>
              ) : null}
            </div>
            <div className={styles.row}>
              <label htmlFor={`${id}-sec`} className={styles.label}>
                セクション
              </label>
              <select
                id={`${id}-sec`}
                className={styles.select}
                value={value.label}
                onChange={(e) => set({ label: e.target.value })}
              >
                {targets.map((t) => (
                  <option key={t.label} value={t.label} disabled={!t.writable}>
                    {targetLabel(t)}
                  </option>
                ))}
              </select>
              <span className={styles.note}>
                いま音符が入っているセクションなら、入れる前に確認します。
              </span>
            </div>
          </section>

          <section className={styles.card} aria-labelledby={`${id}-info`}>
            <h2 id={`${id}-info`} className={styles.h2}>
              3. 曲の情報（曲から入れてあります）
            </h2>
            <div className={styles.row}>
              <span className={styles.label} id={`${id}-tempo`}>
                テンポ
              </span>
              <span
                className={styles.inline}
                role="group"
                aria-labelledby={`${id}-tempo`}
              >
                <Button
                  aria-label="テンポを 1 下げる"
                  disabled={value.tempo <= TEMPO_RANGE.min}
                  onClick={() => set({ tempo: tempo(value.tempo - 1) })}
                >
                  −
                </Button>
                <input
                  className={styles.number}
                  type="number"
                  aria-label="テンポ（1 分間の 4 分音符の数）"
                  min={TEMPO_RANGE.min}
                  max={TEMPO_RANGE.max}
                  value={tempoText ?? String(value.tempo)}
                  onChange={(e) => setTempoText(e.target.value)}
                  onBlur={commitTempo}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitTempo();
                  }}
                  data-testid="hum-tempo"
                />
                <Button
                  aria-label="テンポを 1 上げる"
                  disabled={value.tempo >= TEMPO_RANGE.max}
                  onClick={() => set({ tempo: tempo(value.tempo + 1) })}
                >
                  ＋
                </Button>
              </span>
              <span className={styles.note}>
                録るときのクリックも、このテンポで鳴らします。
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>拍子</span>
              <span className={styles.value} data-testid="hum-meter">
                {ts.num}/{ts.den}
              </span>
              <span className={styles.note}>
                セクションの拍子です（曲の情報で変えられます）。
              </span>
            </div>
            <div className={styles.row}>
              <label htmlFor={`${id}-key`} className={styles.label}>
                キー
              </label>
              <select
                id={`${id}-key`}
                className={styles.selectSmall}
                value={value.key}
                onChange={(e) => set({ key: e.target.value })}
              >
                <option value="">指定しない</option>
                {keys.map((k) => (
                  <option key={k} value={k}>
                    {displayKey(k)}
                  </option>
                ))}
              </select>
              <span className={styles.note}>
                キーは、音の候補を並べる順番と ♯・♭
                の書き方にだけ使います。歌った音を曲のキーに寄せたりはしません。
              </span>
            </div>
          </section>

          <section className={styles.card} aria-labelledby={`${id}-start`}>
            <h2 id={`${id}-start`} className={styles.h2}>
              4. 歌い始めの場所
            </h2>
            <div className={styles.row}>
              <select
                className={styles.selectSmall}
                aria-label="歌い始めの小節"
                value={value.bar}
                onChange={(e) => set({ bar: Number(e.target.value) })}
              >
                {Array.from({ length: BARS }, (_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
              <span>小節目の</span>
              <select
                className={styles.selectSmall}
                aria-label="歌い始めの拍"
                value={value.beat}
                onChange={(e) => set({ beat: Number(e.target.value) })}
              >
                {Array.from({ length: ts.num }, (_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
              <span>拍目から歌い始める</span>
            </div>
            <p className={styles.note}>
              ふつうは 1 小節目の 1
              拍目のままで大丈夫です。曲が途中から始まるとき（たとえば 4
              拍目から歌い始める）は、そこに合わせてください。録音の中で歌い始めた時間は、自動で見つけます。
            </p>
          </section>
        </fieldset>

        <section className={styles.card} aria-labelledby={`${id}-how`}>
          <h2 id={`${id}-how`} className={styles.h2}>
            録り方
          </h2>
          <ol className={styles.steps}>{source.how}</ol>
        </section>
      </main>

      <aside className={styles.side} aria-labelledby={`${id}-sum`}>
        <div className={styles.sideCard}>
          <h2 id={`${id}-sum`} className={styles.h2small}>
            解析の内容
          </h2>
          <dl className={styles.summary}>
            <div>
              <dt>入れ先</dt>
              <dd>{where}</dd>
            </div>
            <div>
              <dt>テンポ / 拍子</dt>
              <dd>
                ♩= {value.tempo} ・ {ts.num}/{ts.den}
              </dd>
            </div>
            <div>
              <dt>キー</dt>
              <dd>{value.key ? displayKey(value.key) : '指定しない'}</dd>
            </div>
            <div>
              <dt>歌い始め</dt>
              <dd>{start}</dd>
            </div>
            <div>
              <dt>ファイル</dt>
              <dd>{source.summary}</dd>
            </div>
          </dl>
          <Button
            variant="primary"
            className={styles.wide}
            disabled={!canStart}
            onClick={onStart}
          >
            {busy ? '解析しています…' : '解析する'}
          </Button>
          <p className={styles.note}>
            {busy
              ? '解析中は、設定を変えられません。'
              : source.chosen
                ? '数秒かかります。'
                : source.startHint}
          </p>
          <Button className={styles.wide} onClick={onBack}>
            やめて戻る
          </Button>
        </div>
      </aside>
    </div>
  );
}
