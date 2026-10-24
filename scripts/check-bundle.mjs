#!/usr/bin/env node
/**
 * Build output check for the audio analysis code (docs/audio-integration-plan.md sections 2.2 and 6.1).
 * Run after `vite build` (CI: `npm run check-bundle`).
 *
 * 1. The first load (dist/index.html's module script + modulepreloads) holds NO analysis code: neither analyzer
 *    markers nor the analysis client (it must be loaded lazily, and the tablet viewer never loads it).
 * 2. Every analysis Worker chunk keeps the third-party notices: each ```text block of
 *    src/lib/analysis/THIRD_PARTY.md (librosa ISC, fft.js MIT) verbatim (vite.config.ts analysisLicenseBanner).
 * 3. Size budget: the Worker chunks together <= 60 KB gzip (tables included).
 *
 * The Worker chunks are checked in a separate build of src/analysis/analysisClient.ts (into
 * node_modules/.tmp/analysis-probe, same vite.config.ts), so 2 and 3 are checked even while the app does not
 * import the client yet; Worker chunks found in dist/ (once the app imports it) are checked too.
 * The probe is also the positive control: every marker used in 1 must appear in it, so a marker that no longer
 * matches anything fails here instead of passing silently.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROBE = path.join(ROOT, 'node_modules/.tmp/analysis-probe');
const THIRD_PARTY = path.join(ROOT, 'src/lib/analysis/THIRD_PARTY.md');
const BUDGET_GZIP = 60_000;

/** Strings that survive minification and only occur in analysis code. */
const WORKER_MARKERS = [
  'FFT size must be a power of two', // fft.js
  'librosa development team', // the license banner
  'dsp-v1', // chords analyzer config name
];
const HUM_MARKERS = ['hum-v3']; // hum analyzer config name
const CLIENT_MARKERS = ['band-sheets-analysis-']; // Worker names (src/analysis/kinds.ts)

const failures = [];
const fail = (msg) => failures.push(msg);
const kb = (n) => `${(n / 1000).toFixed(1)} KB`;

function licenseTexts() {
  const md = readFileSync(THIRD_PARTY, 'utf8');
  const texts = [...md.matchAll(/```text\n([\s\S]*?)```/g)].map((m) =>
    m[1].trimEnd(),
  );
  if (texts.length < 2)
    fail(`THIRD_PARTY.md: expected >= 2 license texts, found ${texts.length}`);
  return texts;
}

function workerChunks(dir) {
  const assets = path.join(dir, 'assets');
  if (!existsSync(assets)) return [];
  return readdirSync(assets)
    .filter((f) => /\.worker-[\w-]+\.js$/.test(f))
    .map((f) => path.join(assets, f));
}

/** Checks notices and size of one build's Worker chunks; returns rows for the report. */
function checkWorkers(label, files, texts) {
  const rows = [];
  let total = 0;
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    const gz = gzipSync(code, { level: 9 }).length;
    total += gz;
    rows.push({
      build: label,
      file: path.basename(f),
      raw: code.length,
      gzip: gz,
    });
    texts.forEach((t, i) => {
      if (!code.includes(t))
        fail(
          `${label} ${path.basename(f)}: license text #${i + 1} of THIRD_PARTY.md missing`,
        );
    });
    if (!code.startsWith('/*!'))
      fail(`${label} ${path.basename(f)}: does not start with a /*! notice */`);
  }
  if (total > BUDGET_GZIP)
    fail(
      `${label}: Worker chunks ${kb(total)} gzip > budget ${kb(BUDGET_GZIP)}`,
    );
  rows.push({ build: label, file: '(Workers total)', raw: NaN, gzip: total });
  return rows;
}

/** The JS files of the first load: dist/index.html's module scripts and modulepreloads. */
function initialChunks() {
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const refs = [
    ...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
  ].map((m) => m[1]);
  // refs carry the base path (`/`, `./` or `/<repo>/`): keep the part from `assets/`
  return [...new Set(refs)].map((r) =>
    path.join(DIST, r.includes('assets/') ? r.slice(r.indexOf('assets/')) : r),
  );
}

async function probeBuild() {
  await build({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    publicDir: false,
    build: {
      outDir: PROBE,
      emptyOutDir: true,
      rollupOptions: {
        input: path.join(ROOT, 'src/analysis/analysisClient.ts'),
        preserveEntrySignatures: 'exports-only',
      },
    },
  });
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(
    'check-bundle: dist/index.html not found; run `npm run build` first',
  );
  process.exit(1);
}
const texts = licenseTexts();
const rows = [];

// --- probe build: Worker notices + size, and positive control for the markers
await probeBuild();
const probeWorkers = workerChunks(PROBE);
if (probeWorkers.length < 2)
  fail(
    `probe: expected the chords and hum Worker chunks, found ${probeWorkers.length}`,
  );
rows.push(...checkWorkers('probe', probeWorkers, texts));
const probeAll = readdirSync(path.join(PROBE, 'assets'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(path.join(PROBE, 'assets', f), 'utf8'))
  .join('\n');
const workersCode = probeWorkers.map((f) => readFileSync(f, 'utf8')).join('\n');
for (const m of [...WORKER_MARKERS, ...HUM_MARKERS])
  if (!workersCode.includes(m))
    fail(`marker "${m}" not found in the probe Workers (stale marker)`);
for (const m of CLIENT_MARKERS)
  if (!probeAll.includes(m))
    fail(`marker "${m}" not found in the probe client (stale marker)`);

// --- the app's first load
const initial = initialChunks();
if (initial.length === 0) fail('dist/index.html: no module script found');
for (const f of initial) {
  if (!existsSync(f)) {
    fail(`initial chunk ${path.relative(DIST, f)} not found`);
    continue;
  }
  const code = readFileSync(f, 'utf8');
  rows.push({
    build: 'dist (first load)',
    file: path.basename(f),
    raw: code.length,
    gzip: gzipSync(code, { level: 9 }).length,
  });
  for (const m of [...WORKER_MARKERS, ...HUM_MARKERS, ...CLIENT_MARKERS])
    if (code.includes(m))
      fail(
        `first-load chunk ${path.basename(f)} contains analysis marker "${m}"`,
      );
}

// --- Worker chunks of the app itself (once the import screen uses the client)
const distWorkers = workerChunks(DIST);
if (distWorkers.length > 0)
  rows.push(...checkWorkers('dist', distWorkers, texts));

console.log('check-bundle: sizes (bytes)');
for (const r of rows)
  console.log(
    `  ${r.build.padEnd(18)} ${r.file.padEnd(36)} ${Number.isNaN(r.raw) ? ''.padStart(8) : String(r.raw).padStart(8)}  gzip ${String(r.gzip).padStart(7)}`,
  );
console.log(`  Worker budget: ${kb(BUDGET_GZIP)} gzip (chords + hum)`);
if (distWorkers.length === 0)
  console.log(
    '  dist/ has no analysis Worker chunk yet (the app does not import src/analysis/)',
  );
if (failures.length > 0) {
  console.error(`check-bundle: ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('check-bundle: OK');
