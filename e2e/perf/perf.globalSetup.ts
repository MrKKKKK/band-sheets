import { writeMicFakeLongWav } from '../support/micFakeAudio';

export default async function globalSetup(): Promise<void> {
  await writeMicFakeLongWav();
}
