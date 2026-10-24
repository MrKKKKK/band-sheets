/**
 * The chords Worker (one per run, terminated by the client afterwards). Third-party notices (librosa ISC, fft.js
 * MIT) are prepended to the built chunk by vite.config.ts (`analysisLicenseBanner`); scripts/check-bundle.mjs
 * checks they are there.
 */
import './worker/lockdown'; // first: remove the network before any analyzer module runs
import { runChords } from './worker/runChords';
import { serve } from './worker/serve';

serve(self as unknown as Parameters<typeof serve>[0], 'chords', runChords);
