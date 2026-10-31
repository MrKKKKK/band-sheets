import { useEffect, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import {
  createFakeMicSession,
  type FakeMicSession,
} from '../../audio/fakeMicSession';
import { useMicRecorder } from '../../hooks/useMicRecorder';
import { createMemoryStorage } from '../../lib/storage';
import {
  RETAKE_BODY,
  RETAKE_NOTE,
  MIC_ERROR_TEXTS,
} from '../../lib/mic/micTexts';
import { fakeAudio } from '../../hooks/testing/fakeAudio';
import { MicRecorder, type MicRecorderProps } from './MicRecorder';
import { makeTake, stateOf, viewOf } from './micStoryFixtures';

/** Stands in for S2's first card, so headings keep their order and the panel sits where it will. */
function Card({ children }: { children: ReactNode }) {
  return (
    <section
      style={{
        boxSizing: 'border-box',
        width: 880,
        maxWidth: '100%',
        margin: 24,
        padding: '20px 24px',
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <h2 style={{ margin: 0, fontSize: '1.125rem' }}>1. 歌の音を受け取る</h2>
      {children}
    </section>
  );
}

const meta = {
  title: 'Mic/MicRecorder',
  component: MicRecorder,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <Card>
        <Story />
      </Card>
    ),
  ],
  args: {
    recorder: viewOf(stateOf({ phase: 'closed' })),
    ts: { num: 4, den: 4 },
    onUseFile: fn(),
    saveName: () => '鼻歌_聖者の行進_Aメロ_20261031-1200.wav',
    save: fn(),
  },
} satisfies Meta<typeof MicRecorder>;

export default meta;
type Story = StoryObj<typeof meta>;

let session: FakeMicSession | null = null;

const body = (el: HTMLElement) => within(el.ownerDocument.body);

// --- M1 ---

export const M1PermissionWait: Story = {
  args: { recorder: viewOf(stateOf({ phase: 'opening', notice: null })) },
  play: ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole('button', { name: '● 録音' })).toBeDisabled();
    expect(c.getByText('マイクが使えるようになると押せます。')).toBeVisible();
    expect(c.getByLabelText('マイク')).toBeDisabled();
  },
};

// --- M2 ---

export const M2Denied: Story = {
  args: { recorder: viewOf(stateOf({ phase: 'micError', error: 'denied' })) },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText(MIC_ERROR_TEXTS.denied.title)).toBeVisible();
    expect(c.queryByRole('alert')).toBeNull();
    await userEvent.click(c.getByRole('button', { name: 'もう一度試す' }));
    expect(args.recorder.open).toHaveBeenCalled();
    await userEvent.click(
      c.getByRole('button', { name: 'ファイルを選ぶほうに切り替える' }),
    );
    expect(args.onUseFile).toHaveBeenCalled();
  },
};

export const M2NotFound: Story = {
  args: { recorder: viewOf(stateOf({ phase: 'micError', error: 'notFound' })) },
  play: ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText('マイクが見つかりません。')).toBeVisible();
    expect(c.getByRole('button', { name: 'もう一度探す' })).toBeVisible();
  },
};

export const M2Busy: Story = {
  args: { recorder: viewOf(stateOf({ phase: 'micError', error: 'busy' })) },
  play: ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText('マイクが使用できません。')).toBeVisible();
    expect(c.getByRole('button', { name: 'もう一度試す' })).toBeVisible();
  },
};

export const M2Unsupported: Story = {
  args: {
    recorder: viewOf(stateOf({ phase: 'micError', error: 'unsupported' })),
  },
  play: ({ canvasElement }) => {
    const c = within(canvasElement);
    // retrying cannot help: only the shortcut is offered
    expect(c.queryByRole('button', { name: /もう一度/ })).toBeNull();
    expect(
      c.getByRole('button', { name: 'ファイルを選ぶほうに切り替える' }),
    ).toBeVisible();
  },
};

// --- M3 ---

export const M3Ready: Story = {
  args: {
    recorder: viewOf(stateOf({ phase: 'ready', notice: null }), {
      level: 0.3,
    }),
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByRole('meter', { name: '音の大きさ' })).toHaveAttribute(
      'aria-valuenow',
      '55',
    );
    expect(c.getByTestId('latency-value')).toHaveTextContent(
      'まだ測っていません',
    );
    expect(c.getByText(/一度測っておくと/)).toBeVisible();
    expect(c.getByText(/ヘッドホンをつけてください/)).toBeVisible();
    expect(c.getByText(/1 小節（4 拍）のカウント/)).toBeVisible();
    await userEvent.selectOptions(c.getByLabelText('マイク'), 'built-in');
    expect(args.recorder.chooseMic).toHaveBeenCalledWith('built-in');
    await userEvent.click(c.getByRole('button', { name: '遅れを測る' }));
    expect(args.recorder.measure).toHaveBeenCalled();
    await userEvent.click(c.getByRole('button', { name: '● 録音' }));
    expect(args.recorder.record).toHaveBeenCalled();
  },
};

export const M3Measured: Story = {
  args: {
    recorder: viewOf(
      stateOf({ phase: 'ready', notice: null }, { remainderMs: 48 }),
    ),
  },
  play: ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('latency-value')).toHaveTextContent('48 ms');
    expect(c.getByRole('button', { name: '測り直す' })).toBeVisible();
    expect(c.queryByText(/一度測っておくと/)).toBeNull();
  },
};

export const M3DeviceGoneNotice: Story = {
  args: {
    recorder: viewOf(
      stateOf({ phase: 'ready', notice: { kind: 'deviceGone' } }),
    ),
  },
  play: ({ canvasElement }) => {
    expect(within(canvasElement).getByTestId('mic-notice')).toHaveTextContent(
      '選んでいたマイクが見つからなくなった',
    );
  },
};

export const M3AfterCountInInterruption: Story = {
  args: {
    recorder: viewOf(
      stateOf({
        phase: 'ready',
        notice: { kind: 'micStopped', cause: 'ended', during: 'countIn' },
      }),
    ),
  },
  play: ({ canvasElement }) => {
    expect(within(canvasElement).getByTestId('mic-notice')).toHaveTextContent(
      'カウントをやめました',
    );
  },
};

export const M3TooShortNotice: Story = {
  args: {
    recorder: viewOf(stateOf({ phase: 'ready', notice: { kind: 'tooShort' } })),
  },
  play: ({ canvasElement }) => {
    expect(within(canvasElement).getByTestId('mic-notice')).toHaveTextContent(
      '短すぎます',
    );
  },
};

// --- M5 / M6 ---

const METER = { tempo: 96, ts: { num: 4, den: 4 } };

const countIn = (num: number, den: number, tempo: number, beat: number) =>
  viewOf(
    stateOf({
      phase: 'countIn',
      meter: { tempo, ts: { num, den } },
      beat,
    }),
    { level: 0.02 },
  );

export const M5CountIn68: Story = {
  args: { recorder: countIn(6, 8, 120, 4), ts: { num: 6, den: 8 } },
  play: ({ canvasElement }) => {
    const boxes = within(canvasElement).getByTestId('beats');
    expect(boxes.querySelectorAll('b')).toHaveLength(6);
    expect(boxes.scrollWidth).toBeLessThanOrEqual(boxes.clientWidth);
  },
};

export const M5CountIn128: Story = {
  args: { recorder: countIn(12, 8, 120, 7), ts: { num: 12, den: 8 } },
  play: ({ canvasElement }) => {
    const boxes = within(canvasElement).getByTestId('beats');
    expect(boxes.querySelectorAll('b')).toHaveLength(12);
    expect(boxes.scrollWidth).toBeLessThanOrEqual(boxes.clientWidth);
    expect(canvasElement.scrollWidth).toBeLessThanOrEqual(
      canvasElement.clientWidth,
    );
  },
};

export const M5CountIn: Story = {
  args: {
    recorder: viewOf(stateOf({ phase: 'countIn', meter: METER, beat: 3 }), {
      level: 0.02,
    }),
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('カウント中です。まだ歌わないでください')).toBeVisible();
    const boxes = c.getByTestId('beats').querySelectorAll('b');
    expect(Array.from(boxes).map((b) => b.dataset.state)).toEqual([
      'done',
      'done',
      'on',
      'next',
    ]);
    await userEvent.click(
      c.getByRole('button', { name: 'やめる（録音は残りません）' }),
    );
    expect(args.recorder.cancelCountIn).toHaveBeenCalled();
  },
};

export const M6Recording: Story = {
  args: {
    recorder: viewOf(
      stateOf({
        phase: 'recording',
        meter: METER,
        elapsedSec: 9,
        bar: 4,
        beat: 2,
        remainingSec: null,
      }),
      { level: 0.5 },
    ),
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('録音しています')).toBeVisible();
    expect(c.getByTestId('elapsed')).toHaveTextContent('0:09');
    expect(c.getByTestId('bar')).toHaveTextContent('4 小節目');
    expect(c.queryByTestId('remaining')).toBeNull();
    expect(c.getByText('経過（最長 10 分）')).toBeVisible();
    // no live region of its own
    expect(
      canvasElement.querySelector('[aria-live], [role="status"]'),
    ).toBeNull();
    await userEvent.click(c.getByRole('button', { name: '■ 止める' }));
    expect(args.recorder.stop).toHaveBeenCalled();
  },
};

export const M6RemainingTime: Story = {
  args: {
    recorder: viewOf(
      stateOf({
        phase: 'recording',
        meter: METER,
        elapsedSec: 535,
        bar: 215,
        beat: 1,
        remainingSec: 58,
      }),
      { level: 0.5 },
    ),
  },
  play: ({ canvasElement }) => {
    expect(within(canvasElement).getByTestId('remaining')).toHaveTextContent(
      '残り 0:58',
    );
  },
};

export const M6Finishing: Story = {
  args: {
    recorder: viewOf(stateOf({ phase: 'finishing', end: 'user', stopSec: 12 })),
  },
  play: ({ canvasElement }) => {
    expect(
      within(canvasElement).getByText('録音をまとめています…'),
    ).toBeVisible();
  },
};

// --- M7 / M8 ---

const take = makeTake();
const takeState = (end: 'user' | 'limit' | 'ended' | 'stalled' = 'user') =>
  stateOf({ phase: 'take', take, end }, { remainderMs: 48 });

/** A fake <audio> so ▶ works without a sound device. */
const depsWith = (start: () => number): MicRecorderProps['playbackDeps'] => ({
  audio: {
    createElement: () => {
      const audio = fakeAudio({ duration: 24 });
      setTimeout(() => audio.loadMetadata(), 0);
      return audio as unknown as HTMLAudioElement;
    },
    createUrl: () => 'blob:fake',
    revokeUrl: () => {},
  },
  createTone: () => ({
    start,
    stop: () => {},
    now: () => 0,
    playOne: () => {},
    close: () => {},
  }),
});
const fakeDeps = depsWith(() => 0);

export const M7Take: Story = {
  args: {
    recorder: viewOf(takeState(), { take }),
    playbackDeps: fakeDeps,
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByText('録れました')).toBeVisible();
    expect(c.getByRole('heading', { name: '録音 1 つ' })).toBeVisible();
    expect(c.getByTestId('take-info')).toHaveTextContent(
      '長さ 0:24（約 9 小節）',
    );
    expect(c.getByRole('img', { name: '録音の波形' })).toBeVisible();
    expect(c.queryByTestId('take-end-notice')).toBeNull();
    expect(
      c.getByRole('checkbox', { name: 'クリックも一緒に聞く' }),
    ).toBeChecked();
    await userEvent.click(c.getByRole('button', { name: '録音を保存（wav）' }));
    expect(args.save).toHaveBeenCalledWith(
      take.file,
      '鼻歌_聖者の行進_Aメロ_20261031-1200.wav',
    );
    await userEvent.click(c.getByRole('button', { name: '録り直す' }));
    expect(args.recorder.retake).toHaveBeenCalled();
  },
};

export const M7Limit: Story = {
  args: {
    recorder: viewOf(takeState('limit'), { take }),
    playbackDeps: fakeDeps,
  },
  play: ({ canvasElement }) => {
    expect(
      within(canvasElement).getByTestId('take-end-notice'),
    ).toHaveTextContent('10 分になったので止めました。');
  },
};

export const M7InterruptedMicEnded: Story = {
  args: {
    recorder: viewOf(takeState('ended'), { take }),
    playbackDeps: fakeDeps,
  },
  play: ({ canvasElement }) => {
    const n = within(canvasElement).getByTestId('take-end-notice');
    expect(n).toHaveTextContent('マイクが外れたか');
    expect(n).toHaveTextContent('そこまでの録音を残しました。');
  },
};

export const M7InterruptedStalled: Story = {
  args: {
    recorder: viewOf(takeState('stalled'), { take }),
    playbackDeps: fakeDeps,
  },
  play: ({ canvasElement }) => {
    expect(
      within(canvasElement).getByTestId('take-end-notice'),
    ).toHaveTextContent('音の処理が止まりました。');
  },
};

export const M7Playing: Story = {
  args: { recorder: viewOf(takeState(), { take }), playbackDeps: fakeDeps },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      c.getByRole('checkbox', { name: 'クリックも一緒に聞く' }),
    );
    expect(
      c.getByRole('checkbox', { name: 'クリックも一緒に聞く' }),
    ).not.toBeChecked();
    await userEvent.click(c.getByRole('button', { name: '▶ 聞く' }));
    await waitFor(() =>
      expect(c.getByRole('button', { name: '⏸ 止める' })).toBeVisible(),
    );
  },
};

const clickStart = fn(() => 0);

export const M7PlayWithClick: Story = {
  args: {
    recorder: viewOf(takeState(), { take }),
    playbackDeps: depsWith(clickStart),
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    clickStart.mockClear();
    await userEvent.click(c.getByRole('button', { name: '▶ 聞く' }));
    await waitFor(() => expect(clickStart).toHaveBeenCalled());
  },
};

const noClickStart = fn(() => 0);

export const M7PlayWithoutClick: Story = {
  args: {
    recorder: viewOf(takeState(), { take }),
    playbackDeps: depsWith(noClickStart),
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    noClickStart.mockClear();
    await userEvent.click(
      c.getByRole('checkbox', { name: 'クリックも一緒に聞く' }),
    );
    await userEvent.click(c.getByRole('button', { name: '▶ 聞く' }));
    await waitFor(() =>
      expect(c.getByRole('button', { name: '⏸ 止める' })).toBeVisible(),
    );
    // let the player's `playing` event pass: the click tone must still not start
    await new Promise((r) => setTimeout(r, 200));
    expect(noClickStart).not.toHaveBeenCalled();
  },
};

export const M8ConfirmRetake: Story = {
  args: {
    recorder: viewOf(
      stateOf(
        { phase: 'confirmRetake', take, end: 'user' },
        { remainderMs: 48 },
      ),
      { take },
    ),
    playbackDeps: fakeDeps,
  },
  play: async ({ canvasElement, args }) => {
    const d = body(canvasElement);
    const dialog = await d.findByRole('dialog', { name: '録り直しますか？' });
    expect(within(dialog).getByText(new RegExp(RETAKE_BODY))).toBeVisible();
    expect(within(dialog).getByText(new RegExp(RETAKE_NOTE))).toBeVisible();
    // Enter must not destroy: focus starts on やめる
    expect(
      within(dialog).getByRole('button', { name: 'やめる' }),
    ).toHaveFocus();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'やめる' }),
    );
    expect(args.recorder.cancelRetake).toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole('button', { name: '録り直す' }),
    );
    expect(args.recorder.confirmRetake).toHaveBeenCalled();
  },
};

// --- M4 (the dialog) ---

export const M4Measuring: Story = {
  args: {
    recorder: viewOf(stateOf({ phase: 'measuring', heard: 3 })),
  },
  play: async ({ canvasElement, args }) => {
    const d = body(canvasElement);
    const dialog = await d.findByRole('dialog', {
      name: '入力の遅れを測ります',
    });
    expect(within(dialog).getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '3',
    );
    expect(within(dialog).getByText('測っています…（3 / 4）')).toBeVisible();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: '中止' }));
    expect(args.recorder.closeMeasure).toHaveBeenCalled();
  },
};

export const M4Measured: Story = {
  args: {
    recorder: viewOf(
      stateOf(
        { phase: 'measured', spreadMs: 3, found: 4 },
        { remainderMs: 48 },
      ),
    ),
  },
  play: async ({ canvasElement, args }) => {
    const d = body(canvasElement);
    const dialog = await d.findByRole('dialog', { name: '測れました' });
    expect(within(dialog).getByTestId('measure-result')).toHaveTextContent(
      '入力の遅れ 48 ms を覚えました。',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'もう一度測る' }),
    );
    expect(args.recorder.measure).toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole('button', { name: '閉じる' }),
    );
    expect(args.recorder.closeMeasure).toHaveBeenCalled();
  },
};

export const M4MeasureFailed: Story = {
  args: { recorder: viewOf(stateOf({ phase: 'measureFailed' })) },
  play: async ({ canvasElement, args }) => {
    const d = body(canvasElement);
    const dialog = await d.findByRole('dialog', { name: '測れませんでした' });
    expect(
      within(dialog).getByText('クリックを拾えませんでした。'),
    ).toBeVisible();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'もう一度測る' }),
    );
    expect(args.recorder.measure).toHaveBeenCalled();
  },
};

// --- the whole flow with the real hook and the fake session (♩=240, 4/4: a bar is 1 s) ---

function Live({
  sessionOptions,
  onSession,
}: {
  sessionOptions?: Parameters<typeof createFakeMicSession>[0];
  onSession?: (s: FakeMicSession) => void;
}) {
  const [session] = useState(() => {
    const s = createFakeMicSession({ tickMs: 50, ...sessionOptions });
    onSession?.(s);
    return s;
  });
  const [storage] = useState(() => createMemoryStorage());
  const [fileTab, setFileTab] = useState(false);
  const recorder = useMicRecorder({
    session,
    storage,
    tempo: 240,
    ts: { num: 4, den: 4 },
  });
  const { open } = recorder;
  useEffect(() => {
    open();
  }, [open]);
  return fileTab ? (
    <p>ファイルを選ぶ</p>
  ) : (
    <MicRecorder
      recorder={recorder}
      ts={{ num: 4, den: 4 }}
      onUseFile={() => setFileTab(true)}
      saveName={() => '録音.wav'}
      save={fn()}
      playbackDeps={fakeDeps}
    />
  );
}

export const FlowRecordAndRetake: Story = {
  render: () => <Live />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const d = body(canvasElement);
    const rec = await c.findByRole('button', { name: '● 録音' });
    await waitFor(() => expect(rec).toBeEnabled());
    await userEvent.click(rec);
    const cancel = await c.findByRole('button', { name: /やめる/ });
    await waitFor(() => expect(cancel).toHaveFocus());
    const stop = await c.findByRole(
      'button',
      { name: '■ 止める' },
      { timeout: 4000 },
    );
    await waitFor(() => expect(stop).toHaveFocus());
    await new Promise((r) => setTimeout(r, 1500));
    await userEvent.click(stop);
    const heading = await c.findByRole(
      'heading',
      { name: '録音 1 つ' },
      { timeout: 8000 },
    );
    await waitFor(() => expect(heading).toHaveFocus());
    const again = c.getByRole('button', { name: '録り直す' });
    await userEvent.click(again);
    const dialog = await d.findByRole('dialog', { name: '録り直しますか？' });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'やめる' }),
    );
    await waitFor(() => expect(again).toHaveFocus());
    await userEvent.click(again);
    await userEvent.click(
      within(await d.findByRole('dialog')).getByRole('button', {
        name: '録り直す',
      }),
    );
    const rec2 = await c.findByRole(
      'button',
      { name: '● 録音' },
      { timeout: 5000 },
    );
    await waitFor(() => expect(rec2).toHaveFocus());
  },
};

export const FlowMeasureSucceeds: Story = {
  render: () => <Live />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const d = body(canvasElement);
    const measure = await c.findByRole('button', { name: '遅れを測る' });
    await userEvent.click(measure);
    const dialog = await d.findByRole('dialog', {
      name: '入力の遅れを測ります',
    });
    expect(dialog).toBeVisible();
    const done = await d.findByRole(
      'dialog',
      { name: '測れました' },
      { timeout: 8000 },
    );
    const close = within(done).getByRole('button', { name: '閉じる' });
    await waitFor(() => expect(close).toHaveFocus());
    await userEvent.click(close);
    await waitFor(() => expect(d.queryByRole('dialog')).toBeNull());
    // focus goes back to the button that opened the dialog, now 「測り直す」
    const again = await c.findByRole('button', { name: '測り直す' });
    await waitFor(() => expect(again).toHaveFocus());
    expect(c.getByTestId('latency-value')).not.toHaveTextContent('まだ');
  },
};

export const FlowMeasureFails: Story = {
  render: () => <Live sessionOptions={{ clickRoundTripMs: null }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const d = body(canvasElement);
    await userEvent.click(await c.findByRole('button', { name: '遅れを測る' }));
    const failed = await d.findByRole(
      'dialog',
      { name: '測れませんでした' },
      { timeout: 8000 },
    );
    await userEvent.click(
      within(failed).getByRole('button', { name: '閉じる' }),
    );
    await waitFor(() => expect(d.queryByRole('dialog')).toBeNull());
    // recording is still possible
    expect(await c.findByRole('button', { name: '● 録音' })).toBeEnabled();
  },
};

export const FlowPermissionDenied: Story = {
  render: () => <Live sessionOptions={{ openError: 'denied' }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const err = await c.findByTestId('mic-error');
    await waitFor(() => expect(err).toHaveFocus());
    await userEvent.click(
      c.getByRole('button', { name: 'ファイルを選ぶほうに切り替える' }),
    );
    expect(await c.findByText('ファイルを選ぶ')).toBeVisible();
  },
};

export const FlowRemainingAndLimit: Story = {
  // the fake clock is moved by hand: no waiting for 10 real minutes (8 kHz keeps the take small)
  render: () => {
    return (
      <Live
        sessionOptions={{ tickMs: undefined, sampleRate: 8000 }}
        onSession={(s) => {
          session = s;
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const rec = await c.findByRole('button', { name: '● 録音' });
    await waitFor(() => expect(rec).toBeEnabled());
    await userEvent.click(rec);
    await c.findByRole('button', { name: /やめる/ });
    // through the count-in (a bar is 1 s at ♩=240) into the recording
    session!.advance(1.5);
    const stop = await c.findByRole('button', { name: '■ 止める' });
    expect(c.queryByTestId('remaining')).toBeNull();
    // 9 minutes of the file: the remaining time appears
    session!.advance(541 - 1.5);
    const remaining = await c.findByTestId('remaining');
    expect(remaining).toHaveTextContent(/残り [01]:\d\d/);
    expect(stop).toBeVisible();
    // 10 minutes: it stops by itself and the take says so
    session!.advance(61);
    const note = await c.findByTestId('take-end-notice', undefined, {
      timeout: 10000,
    });
    expect(note).toHaveTextContent('10 分になったので止めました。');
    expect(c.getByTestId('take-info')).toHaveTextContent(/長さ (9:59|10:00)/);
  },
};
