/**
 * Checks of the REAL mic plumbing (src/audio/micSession.ts) in a browser, not app UI:
 * - `WorkletInDev` (run by `npm run test:storybook`): the capture AudioWorklet loads as a module from Vite's dev
 *   server (`?worker&url` → `?worker_file&type=module`) and its chunks arrive, on an OfflineAudioContext (no mic, no
 *   user gesture needed). The production build is checked by `npm run e2e:csp`.
 * - `RealMic` (manual, excluded from the test run): open a real microphone on your PC and see which device id the
 *   track reports (must be the real device, not `default`), the reported latency and a 3-second capture.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import {
  connectCapture,
  createMicSession,
  type MicDevice,
  type OpenMic,
} from './micSession';

const RATE = 48000;

function WorkletInDev() {
  const [status, setStatus] = useState('読み込み中…');
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ctx = new OfflineAudioContext(1, RATE, RATE);
        const osc = new OscillatorNode(ctx, { frequency: 440 });
        const graph = await connectCapture(ctx, osc);
        osc.start();
        const cap = graph.startCapture(0, RATE / 2);
        await ctx.startRendering();
        const end = await cap.done;
        if (!alive) return;
        const peak = Math.max(
          ...cap.buffer.sliceFloat(0, RATE / 2).map(Math.abs),
        );
        setStatus(
          `読み込めました: ${cap.buffer.endFrame - cap.buffer.firstFrame} フレーム（${end.reason}、最大 ${peak.toFixed(2)}）`,
        );
      } catch (e) {
        if (alive) setStatus(`失敗: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return <p data-testid="worklet-status">{status}</p>;
}

const session = createMicSession();

function RealMic() {
  const [mic, setMic] = useState<OpenMic | null>(null);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const log = (l: string) => setLines((ls) => [...ls, l]);

  async function open(deviceId: string | null) {
    await mic?.close();
    try {
      const m = await session.open(deviceId, {
        onInterrupted: (r) => log(`割り込み: ${r}`),
      });
      setMic(m);
      setDevices(await session.listDevices());
      log(
        `開いた: deviceId=${m.deviceId} label=${m.label} sampleRate=${m.sampleRate}`,
      );
    } catch (e) {
      log(`開けなかった: ${String(e)}`);
    }
  }

  async function record() {
    if (!mic) return;
    await mic.resume();
    const r = mic.sampleRate;
    const t0 = mic.now() + 0.3;
    mic.scheduleClicks(
      Array.from({ length: 6 }, (_, i) => ({
        time: t0 + i * 0.5,
        strong: i % 4 === 0,
      })),
    );
    const cap = mic.startCapture(t0 * r, (t0 + 600) * r);
    await new Promise((res) => setTimeout(res, 1500));
    const lat = mic.latencyNow();
    await new Promise((res) => setTimeout(res, 1500));
    cap.stop(mic.now() * r);
    const end = await cap.done;
    log(
      `録れた: ${((cap.buffer.endFrame - cap.buffer.firstFrame) / r).toFixed(2)} 秒、途切れ ${cap.buffer.gapFrames} フレーム（${end.reason}）、baseLatency ${(lat.baseLatencySec * 1000).toFixed(1)} ms、outputLatency ${(lat.outputLatencySec * 1000).toFixed(1)} ms`,
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => void open(null)}>
          既定のマイクを開く
        </button>
        <button type="button" disabled={!mic} onClick={() => void record()}>
          3 秒録る（クリックあり）
        </button>
        <button
          type="button"
          disabled={!mic}
          onClick={() => {
            void mic?.close();
            setMic(null);
            log('閉じた');
          }}
        >
          閉じる
        </button>
      </div>
      <ul aria-label="マイクの一覧">
        {devices.map((d) => (
          <li key={d.deviceId}>
            <button type="button" onClick={() => void open(d.deviceId)}>
              {d.label || '（名前なし）'}
              {d.isDefault ? '（既定）' : ''} を開く
            </button>{' '}
            <code>{d.deviceId}</code>
          </li>
        ))}
      </ul>
      <pre>{lines.join('\n')}</pre>
    </div>
  );
}

const meta = {
  title: 'Audio/MicCheck',
  parameters: { a11y: { test: 'error' } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkletInDevServer: Story = {
  render: () => <WorkletInDev />,
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByTestId('worklet-status');
    await waitFor(
      () =>
        expect(status).toHaveTextContent(
          /^読み込めました: 24000 フレーム（limit、最大 1\.00）$/,
        ),
      { timeout: 10_000 },
    );
  },
};

export const RealMicManual: Story = {
  tags: ['!test'],
  render: () => <RealMic />,
};
