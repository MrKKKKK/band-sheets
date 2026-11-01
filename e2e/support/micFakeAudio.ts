/**
 * The files Chromium's fake microphone plays (`--use-file-for-fake-audio-capture=<wav>`, looped). The browser reads
 * the path when it LAUNCHES, so the files are written by the Playwright `globalSetup` (before any browser), and the
 * configs only name the path. Content = the synthetic hum fixture (src/lib/analysis/fixtures/hum.wav, the sample
 * tune) looped: sung-like notes, so the analysis finds a melody. The fake device's timing is not real, so these
 * files test the flow, never the latency.
 */
import { join } from 'node:path';
import { GEN_DIR, loopTo, readFixtureWav, writeWav16 } from './analysisAudio';

export const MIC_FAKE_WAV = join(GEN_DIR, 'mic-fake-40s.wav');
export const MIC_FAKE_LONG_WAV = join(GEN_DIR, 'mic-fake-11min.wav');

/** The fake mic loops the file; 40 s covers the longest e2e take (a few seconds). */
export async function writeMicFakeWav(): Promise<string> {
  const { y, sr } = readFixtureWav('hum.wav');
  return writeWav16('mic-fake-40s.wav', loopTo(y, sr, 40), sr);
}

/** 11 minutes (more than the 10-minute limit, so the loop never matters); only for `npm run perf:mic`. */
export async function writeMicFakeLongWav(): Promise<string> {
  const { y, sr } = readFixtureWav('hum.wav');
  return writeWav16('mic-fake-11min.wav', loopTo(y, sr, 11 * 60), sr);
}
