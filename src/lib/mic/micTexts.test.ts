import { describe, expect, it } from 'vitest';
import {
  announcementFor,
  latencyText,
  measureButtonText,
  micLabel,
  MIC_ERROR_TEXTS,
  readyNoticeText,
  remainingText,
  takeEndText,
} from './micTexts';
import {
  initialRecorderState,
  recorderReducer,
  type RecorderEvent,
  type RecorderState,
} from './recorderState';

const meter = { tempo: 120, ts: { num: 4, den: 4 } };
const take = { durationSec: 24.4, bar1Sec: 2, meter };

/** The announcement of each step of `events`. */
function announcements(...events: RecorderEvent[]): (string | null)[] {
  const out: (string | null)[] = [];
  let s: RecorderState = initialRecorderState;
  for (const e of events) {
    const next = recorderReducer(s, e);
    out.push(announcementFor(s, next));
    s = next;
  }
  return out;
}

const OPEN: RecorderEvent[] = [
  { type: 'open' },
  { type: 'opened', deviceId: 'a', remainderMs: null },
];
const RECORD: RecorderEvent[] = [
  ...OPEN,
  { type: 'record', meter },
  { type: 'tick', sinceCountInSec: 0.5 },
  { type: 'tick', sinceCountInSec: 2 },
  { type: 'tick', sinceCountInSec: 3 },
];

describe('announcementFor', () => {
  it('a whole take: opened, count-in, recording, stopped with the length — nothing per beat', () => {
    expect(
      announcements(
        ...RECORD,
        { type: 'stop', atSec: 30 },
        {
          type: 'finished',
          take,
        },
      ),
    ).toEqual([
      null,
      'マイクを使えるようになりました。',
      'カウントを始めました。まだ歌わないでください。',
      null,
      '録音を始めました。',
      null,
      null,
      '録音を止めました。24 秒の録音です。',
    ]);
  });

  it('「残り 1 分」 once, then the limit', () => {
    expect(
      announcements(
        ...RECORD,
        { type: 'tick', sinceCountInSec: 540 },
        { type: 'tick', sinceCountInSec: 560 },
        { type: 'tick', sinceCountInSec: 600 },
        { type: 'finished', take: { ...take, durationSec: 599.9 } },
      ).slice(-4),
    ).toEqual([
      '残り 1 分です。',
      null,
      null,
      '10 分になったので止めました。10 分 0 秒の録音です。',
    ]);
  });

  it('an interruption says why and that the take was kept', () => {
    expect(
      announcements(
        ...RECORD,
        { type: 'interrupted', cause: 'ended', atSec: 5 },
        { type: 'finished', take },
      ).at(-1),
    ).toBe(
      'マイクが外れたか、マイクの許可が取り消されました。そこまでの録音を残しました。24 秒の録音です。',
    );
  });

  it('errors, notices and the measurement', () => {
    expect(
      announcements({ type: 'open' }, { type: 'openFailed', error: 'denied' }),
    ).toEqual([null, 'マイクが許可されていません。']);
    expect(
      announcements(...RECORD.slice(0, 3), { type: 'stop', atSec: 1 }).at(-1),
    ).toBe('短すぎます。1 小節目に入ってから止めてください。');
    expect(
      announcements(
        ...OPEN,
        { type: 'measure' },
        { type: 'measureDone', remainderMs: 47.6, spreadMs: 1, found: 4 },
        { type: 'closeMeasure' },
        { type: 'measure' },
        { type: 'measureFailed' },
      ).slice(2),
    ).toEqual([
      null,
      '入力の遅れ 48 ms を覚えました。',
      null,
      null,
      'クリックを拾えませんでした。',
    ]);
  });

  it('a reopen with a notice announces the notice, not 「使えるように」', () => {
    expect(
      announcements(
        ...OPEN,
        {
          type: 'devices',
          devices: [{ deviceId: 'b', label: 'B', isDefault: true }],
        },
        { type: 'opened', deviceId: 'b', remainderMs: null },
      ).at(-1),
    ).toBe(
      '選んでいたマイクが見つからなくなったので、ブラウザが選んでいるマイクに戻しました。',
    );
  });

  it('closing / the retake dialog say nothing', () => {
    expect(
      announcements(
        ...RECORD,
        { type: 'stop', atSec: 30 },
        { type: 'finished', take },
        { type: 'retake' },
        { type: 'cancelRetake' },
      ).slice(-2),
    ).toEqual([null, null]);
    expect(announcements(...OPEN, { type: 'close' }).at(-1)).toBeNull();
  });
});

describe('texts', () => {
  it('every error has a title and a body; unsupported offers no retry', () => {
    for (const t of Object.values(MIC_ERROR_TEXTS)) {
      expect(t.title).not.toBe('');
      expect(t.body).not.toBe('');
    }
    expect(MIC_ERROR_TEXTS.unsupported.retry).toBeNull();
    expect(MIC_ERROR_TEXTS.busy).toMatchObject({
      title: 'マイクが使用できません。',
      retry: 'もう一度試す',
    });
    expect(MIC_ERROR_TEXTS.busy.body).toContain('ほかのアプリ');
    expect(MIC_ERROR_TEXTS.unknown.body).toBe(
      'もう一度試してください。直らないときは、録音アプリで録ったファイルを使ってください。',
    );
  });

  it('take ends', () => {
    expect(takeEndText('user')).toBeNull();
    expect(takeEndText('limit')).toBe('10 分になったので止めました。');
    expect(takeEndText('stalled')).toBe(
      '音の処理が止まりました。そこまでの録音を残しました。',
    );
  });

  it('M3 notices', () => {
    expect(
      readyNoticeText({
        kind: 'micStopped',
        cause: 'contextClosed',
        during: 'countIn',
      }),
    ).toBe(
      '音の処理が止まりました。カウントをやめました。もう一度「● 録音」を押してください。',
    );
    expect(
      readyNoticeText({ kind: 'micStopped', cause: 'ended', during: 'idle' }),
    ).toContain('開き直しました');
  });

  it('latency, labels, remaining time', () => {
    expect(latencyText(null)).toBe('まだ測っていません');
    expect(latencyText(-4.6)).toBe('-5 ms');
    expect(measureButtonText(null)).toBe('遅れを測る');
    expect(measureButtonText(48)).toBe('測り直す');
    expect(micLabel({ deviceId: 'x', label: '', isDefault: true }, 1)).toBe(
      'マイク 2',
    );
    expect(micLabel({ deviceId: 'x', label: 'USB', isDefault: true }, 1)).toBe(
      'USB',
    );
    expect(remainingText(59)).toBe('残り 0:59');
  });
});
