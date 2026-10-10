import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { viewerSongText } from '../../lib/fixtures/viewerFixtures';
import { parseSong } from '../../lib/parseSong';
import type { SheetLayout } from './sheetModel';
import { ViewerSheet } from './ViewerSheet';

// jsdom has no real alphaTab rendering: every score fails (R7 / R14).
describe('ViewerSheet with failing scores', () => {
  it('turns a failed score into a score-error unit and becomes ready', async () => {
    const song = parseSong(viewerSongText);
    const onLayout = vi.fn<(l: SheetLayout) => void>();
    render(
      <ViewerSheet
        song={song}
        zoom={1}
        layout="part"
        part="Bass"
        scoreHidden={[]}
        scoreChart={true}
        onLayout={onLayout}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    const last = onLayout.mock.calls.at(-1)![0];
    expect(last.ready).toBe(true);
    const failed = last.units.filter((u) => u.id.startsWith('score-error:'));
    expect(failed.length).toBeGreaterThan(0);
    expect(last.timedUnits.length).toBeGreaterThan(0);
  });
});
