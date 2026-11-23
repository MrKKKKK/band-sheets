/**
 * LT2 of the live chord-check tool: the one analysis Worker (docs/live-chord-tool-plan.md section 4). Blocks from the
 * AudioWorklet arrive on a MessagePort, are put into a 22,050 Hz ring (capture.ts: assembleBlocks, toMono, resampled once
 * on arrival, ring.ts), the tuning and gain are measured once on the first 3 s above the gate (and again on 測り直す),
 * then the loop computes back-to-back: the next window starts as soon as the previous result is out, always on the newest
 * audio, always lagging 0.8 s. Nothing is stored or sent anywhere but back to the page.
 */
/// <reference lib="webworker" />
import { Capture, CalibrationCollector, latestWindow, windowLagSec, type ChannelBlock } from '../live/capture';
import { analyzeWindow, calibrate, type WindowCtx } from '../live/core';
import type { FromWorker, ToWorker } from '../live/protocol';
import { variantById, type VariantId } from '../live/variants';

const post = (m: FromWorker): void => self.postMessage(m);

let capture: Capture | null = null;
let pending: ChannelBlock[] = [];
let runId = 0;
let config: { variantId: VariantId; windowSec: number; key: string | undefined } = { variantId: 'base', windowSec: 1, key: undefined };
let fixed: { tuning: number; gainDb: number } | null = null;
const collector = new CalibrationCollector();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'start') {
    const id = ++runId;
    capture = new Capture(m.deviceRate);
    pending = [];
    fixed = null;
    collector.reset();
    m.port.onmessage = (ev: MessageEvent<ChannelBlock>) => {
      if (id === runId) pending.push(ev.data);
    };
    post({ type: 'calibration', calibration: { state: 'waiting' } });
    void loop(id);
  } else if (m.type === 'config') config = { variantId: m.variantId, windowSec: m.windowSec, key: m.key };
  else if (m.type === 'recalibrate') {
    fixed = null;
    collector.reset();
    post({ type: 'calibration', calibration: { state: 'waiting' } });
  } else if (m.type === 'stop') {
    runId++;
    capture = null;
    pending = [];
  }
};

async function loop(id: number): Promise<void> {
  const times: number[] = []; // performance.now() of recent results
  let lastEnd = -1;
  let lastCollecting = -1;
  while (id === runId && capture) {
    await sleep(0); // let queued blocks and config messages in
    if (id !== runId || !capture) return;
    const ring = capture.ring;
    try {
      if (pending.length) capture.ingest(pending.splice(0));
      if (!fixed) {
        const y = collector.feed(ring);
        if (y) {
          const t = performance.now();
          fixed = calibrate(y);
          capture.gapFrames = 0; // the display counts what is lost after the numbers were fixed
          post({ type: 'calibration', calibration: { state: 'fixed', ...fixed, ms: performance.now() - t } });
        } else {
          const sec = collector.progress(ring);
          if (sec > 0 && Math.floor(sec * 4) !== lastCollecting) post({ type: 'calibration', calibration: { state: 'collecting', sec } });
          lastCollecting = Math.floor(sec * 4);
          await sleep(20);
        }
        continue;
      }
      const w = latestWindow(ring, config.windowSec);
      if (!w || w.to === lastEnd) {
        await sleep(10); // nothing new: wait, never compute the same audio twice
        continue;
      }
      lastEnd = w.to;
      const { variantId, windowSec, key } = config;
      const ctx: WindowCtx = { ...fixed, colStart: w.colStart, colEnd: w.colEnd, key };
      const samples = ring.slice(w.from, w.to);
      const pendingSec = capture.pendingSec;
      const t0 = performance.now();
      const result = analyzeWindow(variantById(variantId), samples, ctx);
      const t1 = performance.now();
      if (id !== runId) return;
      times.push(t1);
      while (times.length > 1 && t1 - times[0] > 3000) times.shift();
      const perSec = times.length > 1 ? ((times.length - 1) * 1000) / (t1 - times[0]) : 0;
      post({
        type: 'result',
        variantId,
        windowSec,
        result,
        lagSec: windowLagSec(t1 - t0, pendingSec),
        perSec,
        ms: t1 - t0,
        gapMs: (capture.gapFrames / capture.deviceRate) * 1000,
      });
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      await sleep(500);
    }
  }
}
