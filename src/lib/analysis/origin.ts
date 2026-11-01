/**
 * Where the code under `src/lib/analysis/` came from (docs/audio-integration-plan.md section 2.1).
 *
 * The analyzers are ported from the long-lived research branch `research/audio-analysis`
 * (`spikes/analysis/ts/`), which is never merged into main. Analysis logic is NOT changed here: fix and
 * measure it on the research branch first, then re-port (a `chore/<issue>-analysis-sync-<commit>` PR) and update
 * these constants. `origin.test.ts` checks that the config hashes below equal the hashes of the ported code, so a
 * changed default config without a re-port (or the other way round) fails the tests.
 */

/** Commit of `research/audio-analysis` the code was ported from (spike 4 merge, PR #15 there). */
export const ORIGIN_COMMIT = '2e6ffe1b5c85dc7e5d61e43c9801f2ab4b3098ba';

/** `configHash()` of the chords / key / beats / sections analyzer (`chords/config.ts`, "dsp-v1"). */
export const CHORDS_CONFIG_HASH = 'adec583eb3c6';

/** `humConfigHash()` of the humming analyzer (`hum/config.ts`, "hum-v3"). */
export const HUM_CONFIG_HASH = 'f7a35fb44ae5';
