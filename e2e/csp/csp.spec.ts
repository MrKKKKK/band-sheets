/**
 * The PRODUCTION build under its Content-Security-Policy (src/lib/csp.ts, playwright.csp.config.ts): the whole
 * Drive flow with the fake GIS/Drive (served at the real Google URLs the policy allows), the editor's and the
 * viewer's alphaTab scores (melody + drums), and the analysis Worker (harness page) — with ZERO CSP violations.
 * A positive control proves the collector would see one.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import type {
  Harness,
  HarnessOutcome,
} from '../../src/analysis/testing/harness';
import { parseCsp, CSP_DIRECTIVES } from '../../src/lib/csp';
import { FIXTURES } from '../support/analysisAudio';
import { installFakeDrive } from '../support/fakeDrive';

interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

/** Collects `securitypolicyviolation` events (every document) and CSP console errors. */
async function watchCsp(page: Page) {
  const console: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()))
      console.push(m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: unknown[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        source: `${e.sourceFile}:${e.lineNumber}`,
      });
    });
  });
  return {
    console,
    events: () =>
      page.evaluate(
        () => (window as unknown as { __csp: Violation[] }).__csp ?? [],
      ),
  };
}

type Watch = Awaited<ReturnType<typeof watchCsp>>;

async function expectNoViolations(page: Page, w: Watch) {
  expect(await w.events()).toEqual([]);
  expect(w.console).toEqual([]);
}

/** The page carries exactly the policy of src/lib/csp.ts. */
async function expectPolicy(page: Page) {
  const content = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(parseCsp(content ?? '')).toEqual(CSP_DIRECTIVES);
}

// Chart A B + Vocal (melody) / Drums.
const SONG = `{title: CSPの確認}
{key: G}
{tempo: 120}
{time: 4/4}

{start_of_verse: A}
[G]あさの[Em]ひかり[C]まどを[D]あけて
{end_of_verse}

{start_of_chorus: B}
[C]うたを[D]うたおう[G]いま[Em]ここで
{end_of_chorus}

{start_of_part: Vocal}
\\section "A"
:4 B4 B4 A4 G4 | E4.2 E4.4 G4 |
\\section "B"
:4 E5 E5 D5 B4 | G4.1 |
{end_of_part}

{start_of_part: Drums}
\\instrument percussion
\\section "A"
:8 (HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |
(HH BD) HH (HH SD) HH :16 SD SD SD SD SD SD (SD BD) (SD BD) |
\\section "B"
\\tf triplet8th
:8 (RD BD) RD (RD SD) RD (RD BD) RD (RD SD) RD |
(RD BD) RD (RD SD) RD (CR BD) r r r r r |
{end_of_part}
`;

const saveStatus = (page: Page) => page.getByTestId('save-status');
const textarea = (page: Page) => page.getByLabel('ChordPro テキスト');

test('sign in, list, new song, save, reopen, edit, save, editor scores, viewer: no CSP violation', async ({
  page,
}) => {
  const w = await watchCsp(page);
  const drive = await installFakeDrive(page);
  await page.goto('./');
  await expectPolicy(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // GIS (the stub at https://accounts.google.com/gsi/client) + Drive list.
  await page.getByRole('button', { name: 'Google でログイン' }).click();
  await expect(page.getByTestId('song-list-empty')).toBeVisible();
  expect(await drive.gisCalls(page)).toBe(1);

  // New song → save (create + upload).
  await page.getByRole('button', { name: '新しい曲', exact: true }).click();
  await expect(page).toHaveURL(/#\/edit\//);
  await page.getByRole('button', { name: 'テキスト入力' }).click();
  await textarea(page).fill(SONG);
  await page.keyboard.press('Control+s');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  expect(drive.songs()).toHaveLength(1);

  // Back to the list after a reload (list from Drive), open it (alt=media download).
  await page.getByRole('button', { name: '‹ 曲の一覧' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'CSPの確認を開く' }).click();
  await expect(textarea(page)).toHaveValue(/CSPの確認/);
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');

  // Edit → save (getMeta + update upload).
  await textarea(page).fill(SONG.replace('いま[Em]ここで', 'いま[Em]ここから'));
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  expect(drive.songs()[0].text).toContain('ここから');

  // Editor previews: alphaTab (PartScore) for melody and drums.
  for (const tab of ['メロディ', 'ドラム']) {
    await page.getByRole('tab', { name: tab }).click();
    const panel = page.getByRole('tabpanel', { name: tab });
    await expect(
      panel.locator('[data-state="rendered"]').first(),
    ).toBeVisible();
    // PartScore keeps alphaTab's lazy loading: the SVG goes in once it is on screen
    await panel.locator('.at-surface').first().scrollIntoViewIfNeeded();
    await expect(
      panel.locator('[data-state="rendered"] .at-surface svg').first(),
    ).toBeAttached();
  }

  // Viewer: one alphaTab per section, melody + drums tracks.
  await page.getByRole('button', { name: '閲覧モード' }).click();
  await expect(page.getByTestId('viewer')).toHaveAttribute(
    'data-ready',
    'true',
  );
  const scores = page.getByTestId('section-score');
  await expect(scores).toHaveCount(2);
  for (const s of await scores.all()) {
    await expect(s).toHaveAttribute('data-state', 'rendered');
    await expect(s.locator('svg').first()).toBeAttached();
  }

  // Self-hosted fonts actually loaded (font-src): Bravura (alphaTab + @font-face) and Noto Sans JP.
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => f.family.replace(/["']/g, ''));
  });
  expect(fonts).toContain('Bravura');
  expect(fonts.some((f) => f.startsWith('Noto Sans JP'))).toBe(true);

  await expectNoViolations(page, w);
});

test('analysis Worker (harness page of the build): chords run, no CSP violation', async ({
  page,
}) => {
  const w = await watchCsp(page);
  const workers: string[] = [];
  page.on('worker', (wk) => workers.push(wk.url()));
  await page.goto('e2e/harness/analysis.html');
  await expectPolicy(page);
  await page.waitForFunction(() => '__analysis' in window);
  await page.setInputFiles('#file', join(FIXTURES, 'chords.wav'));
  const out: HarnessOutcome = await page.evaluate(() =>
    (window as unknown as { __analysis: Harness }).__analysis.run('chords'),
  );
  expect(out).toMatchObject({ ok: true });
  // a same-origin chunk of the build (worker-src 'self'), not blob:/data:
  expect(workers).toHaveLength(1);
  expect(workers[0]).toMatch(
    /^http:\/\/localhost:5175\/band-sheets\/assets\/chords\.worker-[\w-]+\.js$/,
  );
  await expectNoViolations(page, w);
});

test('録音から新しい曲 (lazy screen + analysis + <audio> on a blob: URL + new song): no CSP violation', async ({
  page,
}) => {
  const w = await watchCsp(page);
  await installFakeDrive(page);
  await page.goto('./');
  await expectPolicy(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page
    .getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' })
    .click();
  await page.getByRole('button', { name: '‹ 曲の一覧' }).click();
  await page.getByRole('button', { name: '保存せずに戻る' }).click();
  await page.getByRole('button', { name: '録音から新しい曲' }).click();
  await page
    .getByTestId('audio-file-input')
    .setInputFiles(join(FIXTURES, 'chords.wav'));
  await expect(page.getByTestId('picked-file')).toContainText('長さ 0:07');
  await page.getByRole('button', { name: '解析を始める' }).click();
  await expect(
    page.getByRole('heading', { name: 'コード譜の下書きを確かめる' }),
  ).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '録音を再生' }).click();
  await expect(page.locator('[data-current]')).toHaveCount(1);
  await page.getByRole('button', { name: '録音を止める' }).click();
  await page.getByRole('button', { name: 'この内容で曲を作る' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'chords（下書き）' }),
  ).toBeVisible();
  await expectNoViolations(page, w);
});

test('鼻歌から下書き (lazy screen from the editor + hum Worker + <audio> on a blob: URL + Web Audio tone): no CSP violation', async ({
  page,
}) => {
  const w = await watchCsp(page);
  await installFakeDrive(page);
  await page.goto('./');
  await expectPolicy(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page
    .getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' })
    .click();
  await page.getByRole('tab', { name: 'メロディ' }).click();
  await page.getByRole('button', { name: '鼻歌から下書き' }).click();
  await page.getByRole('combobox', { name: '歌い始めの拍' }).selectOption('2');
  await page
    .getByTestId('audio-file-input')
    .setInputFiles(join(FIXTURES, 'hum.wav'));
  await expect(page.getByTestId('picked-file')).toContainText('hum.wav');
  await page.getByRole('button', { name: '解析する' }).click();
  await expect(
    page.getByRole('heading', { name: '鼻歌の下書きを確かめる' }),
  ).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '▶ 再生' }).click();
  await expect(page.getByRole('button', { name: '❚❚ 止める' })).toBeVisible();
  await page.getByRole('button', { name: '❚❚ 止める' }).click();
  await page
    .getByRole('button', { name: 'このセクションに下書きを入れる' })
    .click();
  await page.getByRole('button', { name: '置き換えて入れる' }).click();
  await expect(
    page.getByRole('application', { name: 'セクション A のメロディ' }),
  ).toBeFocused();
  await expectNoViolations(page, w);
});

test('positive control: an injected inline script is blocked and reported', async ({
  page,
}) => {
  const w = await watchCsp(page);
  await installFakeDrive(page);
  await page.goto('./');
  await expect(
    page.getByRole('button', { name: 'Google でログイン' }),
  ).toBeVisible();
  expect(await w.events()).toEqual([]);
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.head.append(s);
  });
  await expect.poll(async () => (await w.events()).length).toBe(1);
  expect((await w.events())[0].directive).toBe('script-src-elem');
  expect(
    await page.evaluate(() => (window as { __injected?: boolean }).__injected),
  ).toBeUndefined();
});
