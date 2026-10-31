/**
 * Japanese texts of 「マイクで録る」 (docs/mic-recording-plan.md §2.6–§2.8, canvas M2–M8): errors, notices,
 * statuses and what the screen's ONE live region says when the recorder's state changes (`announcementFor`).
 * Nothing per beat or per second is announced.
 */
import type { MicDevice, MicErrorKind } from './micTypes';
import { formatClock, formatDurationJa } from '../import/format';
import type {
  ReadyNotice,
  RecorderState,
  StopCause,
  TakeEnd,
} from './recorderState';

export interface MicErrorText {
  title: string;
  body: string;
  /** the retry button; null = retrying cannot help */
  retry: string | null;
}

const USE_FILE = '録音アプリで録ったファイルを使うこともできます。';

/** M2. */
export const MIC_ERROR_TEXTS: Record<MicErrorKind, MicErrorText> = {
  denied: {
    title: 'マイクが許可されていません。',
    body: 'アドレスバーの左にある鍵（設定）のマークから、マイクを「許可」にして、もう一度試してください。',
    retry: 'もう一度試す',
  },
  notFound: {
    title: 'マイクが見つかりません。',
    body: `マイクをつないでから「もう一度探す」を押してください。${USE_FILE}`,
    retry: 'もう一度探す',
  },
  busy: {
    title: 'マイクが使用できません。',
    body: `ほかのアプリがマイクを使っているかもしれません。そのアプリを閉じてから「もう一度試す」を押してください。${USE_FILE}`,
    retry: 'もう一度試す',
  },
  unsupported: {
    title: 'このブラウザではマイクで録れません。',
    body: `PC の Chrome や Edge など、新しいブラウザで開いてください。${USE_FILE}`,
    retry: null,
  },
  unknown: {
    title: 'マイクを開けませんでした。',
    body: 'もう一度試してください。直らないときは、録音アプリで録ったファイルを使ってください。',
    retry: 'もう一度試す',
  },
};

export const SWITCH_TO_FILE = 'ファイルを選ぶほうに切り替える';

/** Why a mic stopped by itself (M7's notice, M3's notice after a count-in). */
const STOP_CAUSE_TEXTS: Record<StopCause, string> = {
  ended: 'マイクが外れたか、マイクの許可が取り消されました。',
  contextClosed: '音の処理が止まりました。',
  contextInterrupted:
    'ほかのアプリが音を使い始めたなどで、音の処理が止まりました。',
  stalled: '音の処理が止まりました。',
  workletError: '録音の処理でエラーが起きました。',
};

const LIMIT_TEXT = '10 分になったので止めました。';

/** M7: how the recording ended; null for ■ (nothing to explain). */
export function takeEndText(end: TakeEnd): string | null {
  if (end === 'user') return null;
  if (end === 'limit') return LIMIT_TEXT;
  return `${STOP_CAUSE_TEXTS[end]}そこまでの録音を残しました。`;
}

/** M3's notice. */
export function readyNoticeText(n: ReadyNotice): string {
  switch (n.kind) {
    case 'deviceGone':
      return '選んでいたマイクが見つからなくなったので、ブラウザが選んでいるマイクに戻しました。';
    case 'tooShort':
      return '短すぎます。1 小節目に入ってから止めてください。';
    case 'micStopped':
      return n.during === 'countIn'
        ? `${STOP_CAUSE_TEXTS[n.cause]}カウントをやめました。もう一度「● 録音」を押してください。`
        : `${STOP_CAUSE_TEXTS[n.cause]}マイクを開き直しました。`;
  }
}

/** The select's text for a device; labels are empty until the permission was given. */
export function micLabel(d: MicDevice, index: number): string {
  return d.label || `マイク ${index + 1}`;
}

export const DEFAULT_MIC_NOTE = 'ブラウザが選んでいるマイクです。';

/** M3: the latency row's value. */
export function latencyText(remainderMs: number | null): string {
  return remainderMs === null
    ? 'まだ測っていません'
    : `${Math.round(remainderMs)} ms`;
}

export function measureButtonText(remainderMs: number | null): string {
  return remainderMs === null ? '遅れを測る' : '測り直す';
}

export const LATENCY_HINT =
  '一度測っておくと、下書きの拍のずれが小さくなります。測らなくても録れます（約 50 ms ずれることがあり、次の画面の「16分ずらし」で直せます）。';

export const HEADPHONES_NOTE =
  'ヘッドホンをつけてください。クリックの音がマイクに入るのを防ぎます。';

/** M3: under ● 録音. */
export function recordNote(beats: number): string {
  return `録音を押すと、1 小節（${beats} 拍）のカウントのあとから録れます。`;
}

// --- M4 ---

export const MEASURE_TITLE = '入力の遅れを測ります';
export const MEASURE_INSTRUCTION =
  'ヘッドホンのスピーカー側を、マイクにぴったりつけてください。クリックが数回鳴ります。';

export function measureProgressText(heard: number, total: number): string {
  return `測っています…（${heard} / ${total}）`;
}

export const MEASURED_TITLE = '測れました';

export function measuredText(remainderMs: number): string {
  return `入力の遅れ ${Math.round(remainderMs)} ms を覚えました。`;
}

export function measuredNote(spreadMs: number): string {
  return `このマイクで録るときは、この分を自動で補正します。マイクやヘッドホンを変えたときは、測り直してください。ばらつき：${Math.round(spreadMs)} ms。`;
}

export const MEASURE_FAILED_TITLE = '測れませんでした';
export const MEASURE_FAILED_TEXT = 'クリックを拾えませんでした。';
export const MEASURE_FAILED_TIPS = [
  'ヘッドホンの音量を上げる',
  'スピーカー側をマイクに、もっと近づける',
  '別のマイクを選ぶ',
];

// --- M5 / M6 / M7 / M8 ---

export const COUNT_IN_STATUS = 'カウント中です。まだ歌わないでください';
export const COUNT_IN_NOTE =
  'このあと、次の拍（1 小節目の 1 拍目）から録ります。';
export const CANCEL_COUNT_IN = 'やめる（録音は残りません）';
export const RECORDING_STATUS = '録音しています';
export const RECORDING_NOTE =
  'クリックは鳴り続けます。歌い終わったら「止める」を押してください。10 分で自動的に止まります。';
export const ELAPSED_LABEL = '経過（最長 10 分）';

export function barText(bar: number): string {
  return `${bar} 小節目`;
}

export function remainingText(sec: number): string {
  return `残り ${formatClock(sec)}`;
}

export const TAKE_STATUS = '録れました';
export const RETAKE_TITLE = '録り直しますか？';
export const RETAKE_BODY = '今の録音は消えます。録り直しますか？';
export const RETAKE_NOTE =
  '残したいときは、先に「録音を保存（wav）」を押してください。';

// --- the live region ---

/**
 * What to announce when the state goes from `prev` to `next`; null = nothing. Only state changes: the mic
 * opened, an error, the count-in / recording started, 「残り 1 分」 once, the take (how it ended + its length),
 * a notice back in M3, the measurement's result.
 */
export function announcementFor(
  prev: RecorderState,
  next: RecorderState,
): string | null {
  if (prev.phase === next.phase) {
    if (
      next.phase === 'recording' &&
      prev.phase === 'recording' &&
      prev.remainingSec === null &&
      next.remainingSec !== null
    )
      return '残り 1 分です。';
    return null;
  }
  switch (next.phase) {
    case 'micError':
      return MIC_ERROR_TEXTS[next.error].title;
    case 'ready':
      if (next.notice) return readyNoticeText(next.notice);
      return prev.phase === 'opening'
        ? 'マイクを使えるようになりました。'
        : null;
    case 'measured':
      return next.remainderMs === null ? null : measuredText(next.remainderMs);
    case 'measureFailed':
      return MEASURE_FAILED_TEXT;
    case 'countIn':
      return 'カウントを始めました。まだ歌わないでください。';
    case 'recording':
      return '録音を始めました。';
    case 'take': {
      if (prev.phase !== 'finishing') return null;
      const why = takeEndText(next.end) ?? '録音を止めました。';
      return `${why}${formatDurationJa(next.take.durationSec)}の録音です。`;
    }
    default:
      return null;
  }
}
