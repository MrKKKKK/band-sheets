import { expect, test, type Page } from '@playwright/test';
import { freshStart } from './support/app';

// Melody-tab playback (sketch https://claude.ai/artifact/WjYDhuLPY7TRVZHH1BTcta). Only the UI state and the
// live text are checked, never the sound.

async function openSampleMelody(page: Page) {
  await freshStart(page);
  await page
    .getByRole('button', { name: 'サンプル曲で試す（聖者の行進）' })
    .click();
  await page.getByRole('tab', { name: 'メロディ' }).click();
  const panel = page.getByRole('tabpanel', { name: 'メロディ' });
  const staff = panel.getByRole('application');
  await expect(staff).toBeVisible();
  // Focus without clicking: a click on the staff would place a note.
  await staff.focus();
  return {
    panel,
    staff,
    player: panel.getByRole('group', { name: '再生' }),
    live: panel.getByTestId('staff-live'),
  };
}

test('Space plays and stops; Esc stops without clearing the selection', async ({
  page,
}) => {
  const { panel, staff, player, live } = await openSampleMelody(page);
  await staff.press('Space');
  await expect(player).toHaveAttribute('data-state', 'playing');
  await expect(live).toHaveText(/小節目から再生します/);
  await expect(panel.getByTestId('playhead')).toBeVisible();
  await staff.press('Space');
  await expect(player).toHaveAttribute('data-state', 'stopped');
  await expect(live).toHaveText('止めました');
  await expect(panel.getByTestId('playhead')).toHaveCount(0);

  await staff.press('Enter'); // selects the note before the cursor
  await expect(panel.getByTestId('selection').first()).toBeVisible();
  await staff.press('Space');
  await expect(player).toHaveAttribute('data-state', 'playing');
  await staff.press('Escape');
  await expect(player).toHaveAttribute('data-state', 'stopped');
  await expect(panel.getByTestId('selection').first()).toBeVisible();
});

test('editing during playback stops it first; leaving the tab stops it', async ({
  page,
}) => {
  const { panel, staff, player, live } = await openSampleMelody(page);
  await staff.press('Enter');
  await staff.press('Space');
  await expect(player).toHaveAttribute('data-state', 'playing');
  await staff.press('ArrowUp'); // raise the selected note a semitone
  await expect(player).toHaveAttribute('data-state', 'stopped');
  await expect(live).not.toHaveText(/再生|止めました/);

  await panel.getByRole('button', { name: '再生', exact: true }).click();
  await expect(player).toHaveAttribute('data-state', 'playing');
  await page.getByRole('tab', { name: 'ドラム' }).click();
  await page.getByRole('tab', { name: 'メロディ' }).click();
  await expect(player).toHaveAttribute('data-state', 'stopped');
});
