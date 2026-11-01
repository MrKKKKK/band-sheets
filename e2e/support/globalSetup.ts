import { writeMicFakeWav } from './micFakeAudio';

/** Runs once before any browser launches (the mic project's fake capture file must exist by then). */
export default async function globalSetup(): Promise<void> {
  await writeMicFakeWav();
}
