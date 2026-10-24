import type { AnalysisErrorCode } from '../../analysis/types';

/**
 * Japanese texts for the import screens, one per `AnalysisErrorCode`
 * (docs/audio-integration-plan.md §6.2): what happened + what the user can do.
 * No details of the file or the error are shown (they could hold song content).
 */
export const IMPORT_ERROR_MESSAGES: Record<AnalysisErrorCode, string> = {
  'decode-failed':
    'この形式は読めませんでした。WAV・MP3・M4A のファイルを選んでください。',
  'too-long':
    '長すぎます。10 分までの録音を選んでください。長い場合は、使いたい部分だけを切り出してください。',
  empty: '音が入っていません。別のファイルを選んでください。',
  'too-short': '短すぎます。1 秒以上の録音を選んでください。',
  'non-finite':
    'このファイルは壊れているようです。別のファイルを選んでください。',
  silent: '音が聞こえませんでした。音量を確かめて、別の録音を選んでください。',
  'no-beats':
    '拍を見つけられませんでした。リズムがはっきりした録音を選んでください。',
  'invalid-info':
    '入力した内容では解析できません。テンポ・拍子・歌い始めの位置を確かめてください。',
  'out-of-memory':
    'メモリが足りませんでした。ほかのタブを閉じてから、もう一度試してください。',
  'worker-crashed':
    '解析が途中で止まりました。ほかのタブを閉じてから、もう一度試してください。',
  unsupported:
    'このブラウザでは音声の解析を使えません。PC の Chrome や Edge など、新しいブラウザで開いてください。',
  cancelled: '中止しました。',
  internal:
    '解析できませんでした。もう一度試してください。直らないときは、別のファイルを試してください。',
};

/** Shown on the review screen when the browser cannot play the picked file (analysis itself worked). */
export const PLAYBACK_FAILED_MESSAGE =
  'このファイルは、このブラウザでは再生できません。';

export interface ImportNotice {
  /** `notice` = the user asked for it (cancel): show it plainly, not as an error. */
  severity: 'error' | 'notice';
  message: string;
  /** Offer 「もう一度試す」 (crash / memory / internal errors, and after a cancel). */
  retry?: boolean;
}

/** Errors after which the same file may work on a second try. */
const RETRYABLE = new Set<AnalysisErrorCode>([
  'worker-crashed',
  'out-of-memory',
  'internal',
]);

export function importErrorInfo(code: AnalysisErrorCode): ImportNotice {
  return {
    severity: code === 'cancelled' ? 'notice' : 'error',
    message: IMPORT_ERROR_MESSAGES[code],
  };
}

/** The notice box for an error code, with the retry offer. */
export function noticeFor(code: AnalysisErrorCode): ImportNotice {
  return {
    ...importErrorInfo(code),
    retry: code === 'cancelled' || RETRYABLE.has(code),
  };
}
