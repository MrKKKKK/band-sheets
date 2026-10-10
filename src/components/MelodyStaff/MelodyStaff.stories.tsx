import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import {
  expect,
  fireEvent,
  fn,
  userEvent,
  waitFor,
  within,
} from 'storybook/test';
import { kirakiraA } from '../../lib/fixtures/melodyFixtures';
import type { MelodyEvent } from '../../lib/melody';
import {
  layoutMelody,
  nearestCursor,
  pitchToY,
  yToPitch,
  type Layout,
} from '../../lib/staffLayout';
import { MelodyStaff, type MelodyStaffProps } from './MelodyStaff';

const WIDTH = 720;

const meta = {
  title: 'Melody/MelodyStaff',
  parameters: { a11y: { test: 'error' } },
  component: MelodyStaff,
  args: {
    events: kirakiraA.events,
    ts: kirakiraA.ts,
    keySignature: 'C',
    cursor: 3,
    selected: null,
    previewDuration: { d: '4', dotted: false },
    width: WIDTH,
    ariaLabel: 'セクション A のメロディ',
    onPlace: fn(),
    onSelect: fn(),
    onKeyDown: fn(),
  },
} satisfies Meta<typeof MelodyStaff>;

export default meta;
type Story = StoryObj<typeof meta>;

const layoutOf = (args: MelodyStaffProps): Layout =>
  layoutMelody(args.events, args.ts, {
    width: args.width ?? WIDTH,
    key: args.keySignature,
  });

const svgOf = (el: HTMLElement) =>
  within(el).getByTestId('melody-staff-svg') as unknown as SVGSVGElement;

/** Client coordinates of an SVG-space point. */
function at(svg: SVGSVGElement, x: number, y: number) {
  const r = svg.getBoundingClientRect();
  return { clientX: r.left + x, clientY: r.top + y };
}

const n = (pitch: string, ticks: number, lyric?: string): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks,
  ...(lyric && { lyric }),
});
const r = (ticks: number): MelodyEvent => ({ kind: 'rest', ticks });
/** One slot of a quarter-note 3-tuplet (M5 T20). */
const tn3 = (pitch: string, slot: number): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks: 16,
  tuplet: { n: 3, slot },
});

export const KiraKira: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const notes = canvasElement.querySelectorAll('[data-testid^="note-"]');
    expect(notes).toHaveLength(kirakiraA.events.length);
    expect(canvas.getByTestId('note-0-0')).toBeInTheDocument();
    expect(canvas.getByTestId('lyric-0')).toHaveTextContent('き');
    expect(canvas.getByTestId('chord-4')).toHaveTextContent('F');
    expect(canvas.getByTestId('cursor')).toBeInTheDocument();
    expect(
      canvas.getByRole('application', { name: args.ariaLabel }),
    ).toHaveAttribute('aria-roledescription', 'メロディ入力');
    // Bravura is loaded (glyphs are not tofu).
    await waitFor(() =>
      expect(document.fonts.check('40px Bravura')).toBe(true),
    );
  },
};

export const ClickEmptyPlaces: Story = {
  play: async ({ canvasElement, args }) => {
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const end = l.cursors[l.cursors.length - 1];
    const y = pitchToY(l, end.system, 'A4');
    await fireEvent.click(svg, at(svg, end.x, y));
    expect(args.onPlace).toHaveBeenCalledOnce();
    expect(args.onPlace).toHaveBeenCalledWith(
      nearestCursor(l, end.x, y),
      yToPitch(l, end.system, y, 'C'),
    );
    expect(args.onPlace).toHaveBeenCalledWith(kirakiraA.events.length, 'A4');
    expect(args.onSelect).not.toHaveBeenCalled();
    // Clicking focuses the staff.
    expect(within(canvasElement).getByRole('application')).toHaveFocus();
    // The lyric row is not a place to put notes.
    await fireEvent.click(svg, at(svg, end.x, l.systems[end.system].lyricY));
    expect(args.onPlace).toHaveBeenCalledOnce();
  },
};

export const ClickNoteSelects: Story = {
  play: async ({ canvasElement, args }) => {
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const p = l.pieces.find((q) => q.eventIndex === 2)!;
    await fireEvent.click(svg, at(svg, p.x, p.y));
    expect(args.onSelect).toHaveBeenLastCalledWith(2);
    expect(args.onPlace).not.toHaveBeenCalled();
  },
};

export const SelectedClickAgainOrEscape: Story = {
  args: { selected: 2 },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('selection')).toBeInTheDocument();
    const svg = svgOf(canvasElement);
    const p = layoutOf(args).pieces.find((q) => q.eventIndex === 2)!;
    await fireEvent.click(svg, at(svg, p.x, p.y));
    expect(args.onSelect).toHaveBeenLastCalledWith(null);
    await userEvent.keyboard('{Escape}');
    expect(args.onSelect).toHaveBeenCalledTimes(2);
    expect(args.onSelect).toHaveBeenLastCalledWith(null);
    expect(args.onKeyDown).toHaveBeenCalledOnce();
  },
};

/** M7: with a selection, a click on empty space only clears it. */
export const SelectedClickEmptyClears: Story = {
  args: { selected: 2 },
  play: async ({ canvasElement, args }) => {
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const end = l.cursors[l.cursors.length - 1];
    const y = pitchToY(l, end.system, 'A4');
    // No place preview while something is selected.
    await fireEvent.pointerMove(svg, at(svg, end.x, y));
    expect(within(canvasElement).queryByTestId('preview-note')).toBeNull();
    await fireEvent.click(svg, at(svg, end.x, y));
    expect(args.onSelect).toHaveBeenCalledOnce();
    expect(args.onSelect).toHaveBeenLastCalledWith(null);
    expect(args.onPlace).not.toHaveBeenCalled();
  },
};

/** M9: drag the selected note up two staff steps → one onPitchDrag. */
export const DragSelectedNote: Story = {
  args: { selected: 2, onPitchDrag: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    // kirakiraA event 2 is G4.
    const p = l.pieces.find((q) => q.eventIndex === 2)!;
    const s = l.staffSpace;
    await fireEvent.pointerDown(svg, { ...at(svg, p.x, p.y), pointerId: 7 });
    await fireEvent.pointerMove(svg, {
      ...at(svg, p.x, p.y - s / 2),
      pointerId: 7,
    });
    await fireEvent.pointerMove(svg, {
      ...at(svg, p.x, p.y - s),
      pointerId: 7,
    });
    expect(canvas.getByTestId('drag-tooltip')).toHaveTextContent('シ（B4）');
    expect(args.onPitchDrag).not.toHaveBeenCalled();
    await fireEvent.pointerUp(svg, { ...at(svg, p.x, p.y - s), pointerId: 7 });
    expect(args.onPitchDrag).toHaveBeenCalledOnce();
    expect(args.onPitchDrag).toHaveBeenCalledWith(2, 'B4');
    expect(canvas.queryByTestId('drag-tooltip')).toBeNull();
    // The click that follows the drag does not toggle the selection.
    await fireEvent.click(svg, at(svg, p.x, p.y - s));
    expect(args.onSelect).not.toHaveBeenCalled();
    // A press without movement is still a click (deselect).
    await fireEvent.pointerDown(svg, { ...at(svg, p.x, p.y), pointerId: 8 });
    await fireEvent.pointerUp(svg, { ...at(svg, p.x, p.y), pointerId: 8 });
    await fireEvent.click(svg, at(svg, p.x, p.y));
    expect(args.onSelect).toHaveBeenLastCalledWith(null);
    expect(args.onPitchDrag).toHaveBeenCalledOnce();
  },
};

/** M9: Escape during a drag cancels it (no change, selection kept). */
export const DragEscapeCancels: Story = {
  args: { selected: 2, onPitchDrag: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const p = l.pieces.find((q) => q.eventIndex === 2)!;
    await fireEvent.pointerDown(svg, { ...at(svg, p.x, p.y), pointerId: 3 });
    await fireEvent.pointerMove(svg, {
      ...at(svg, p.x, p.y + 2 * l.staffSpace),
      pointerId: 3,
    });
    expect(canvas.getByTestId('drag-tooltip')).toHaveTextContent('ド（C4）');
    expect(canvas.getByRole('application')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(canvas.queryByTestId('drag-tooltip')).toBeNull();
    await fireEvent.pointerUp(svg, { ...at(svg, p.x, p.y), pointerId: 3 });
    await fireEvent.click(svg, at(svg, p.x, p.y));
    expect(args.onPitchDrag).not.toHaveBeenCalled();
    expect(args.onSelect).not.toHaveBeenCalled();
    expect(args.onKeyDown).not.toHaveBeenCalled();
  },
};

export const KeyDownForwarded: Story = {
  play: async ({ canvasElement, args }) => {
    const staff = within(canvasElement).getByRole('application');
    staff.focus();
    await userEvent.keyboard('a');
    await userEvent.keyboard('{ArrowUp}');
    expect(args.onKeyDown).toHaveBeenCalledTimes(2);
    const e = (args.onKeyDown as ReturnType<typeof fn>).mock.calls[0][0];
    expect(e.code).toBe('KeyA');
    expect(args.onSelect).not.toHaveBeenCalled();
  },
};

export const HoverPreview: Story = {
  args: { previewDuration: { d: '8', dotted: true } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const end = l.cursors[l.cursors.length - 1];
    expect(canvas.queryByTestId('preview-note')).toBeNull();
    await fireEvent.pointerMove(
      svg,
      at(svg, end.x, pitchToY(l, end.system, 'E5')),
    );
    const preview = await canvas.findByTestId('preview-note');
    expect(preview).toHaveAttribute('data-pitch', 'E5');
    expect(canvas.getByTestId('preview-tooltip')).toHaveTextContent('ミ（E5）');
    // Over a note: no preview (a click would select).
    const p = l.pieces[0];
    await fireEvent.pointerMove(svg, at(svg, p.x, p.y));
    expect(canvas.queryByTestId('preview-note')).toBeNull();
    await fireEvent.pointerMove(
      svg,
      at(svg, end.x, pitchToY(l, end.system, 'C4')),
    );
    expect(canvas.getByTestId('preview-note')).toHaveAttribute(
      'data-pitch',
      'C4',
    );
    // React derives onPointerLeave from pointerout.
    await fireEvent.pointerOut(svg, { relatedTarget: document.body });
    expect(canvas.queryByTestId('preview-note')).toBeNull();
  },
};

export const LyricMismatch: Story = {
  args: { mismatchFrom: 9 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const before = canvas.getByTestId('lyric-8');
    const after = canvas.getByTestId('lyric-9');
    expect(after.getAttribute('class')).toMatch(/lyricWarn/);
    expect(canvas.getByTestId('lyric-13').getAttribute('class')).toMatch(
      /lyricWarn/,
    );
    expect(before.getAttribute('class')).not.toMatch(/lyricWarn/);
  },
};

/** Melismas get automatic slurs (none across the rest, split across systems). */
export const MelismaSlurs: Story = {
  args: {
    width: 360,
    cursor: 0,
    events: [
      n('C4', 16, 'る'),
      n('D4', 16),
      n('E4', 16),
      n('C5', 16, 'ら'),
      n('B4', 16),
      n('A5', 16),
      n('G5', 32),
      n('E4', 16, 'あ'),
      r(16),
      n('F4', 16),
      n('G4', 16, 'い'),
      n('A4', 16),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('slur-0').querySelectorAll('path')).toHaveLength(
      1,
    );
    expect(canvas.getByTestId('slur-3')).toBeInTheDocument();
    expect(canvas.getByTestId('slur-10')).toBeInTheDocument();
    expect(canvas.queryByTestId('slur-7')).toBeNull();
    expect(
      canvasElement.querySelectorAll('[data-testid^="slur-"]'),
    ).toHaveLength(3);
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true, selected: null },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByRole('application')).toBeNull();
    expect(
      canvas.getByRole('img', { name: /読み取り専用/ }),
    ).toBeInTheDocument();
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const end = l.cursors[l.cursors.length - 1];
    await fireEvent.click(svg, at(svg, end.x, pitchToY(l, end.system, 'A4')));
    const p = l.pieces[0];
    await fireEvent.click(svg, at(svg, p.x, p.y));
    await fireEvent.pointerMove(
      svg,
      at(svg, end.x, pitchToY(l, end.system, 'A4')),
    );
    expect(args.onPlace).not.toHaveBeenCalled();
    expect(args.onSelect).not.toHaveBeenCalled();
    expect(canvas.queryByTestId('preview-note')).toBeNull();
    expect(canvas.queryByTestId('cursor')).toBeNull();
  },
};

export const Empty: Story = {
  args: { events: [], cursor: 0 },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('clef-0')).toBeInTheDocument();
    expect(canvas.getByTestId('cursor')).toBeInTheDocument();
    expect(
      canvasElement.querySelectorAll('[data-testid^="note-"]'),
    ).toHaveLength(0);
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    await fireEvent.click(
      svg,
      at(svg, l.cursors[0].x + 40, pitchToY(l, 0, 'G4')),
    );
    expect(args.onPlace).toHaveBeenCalledWith(0, 'G4');
  },
};

export const KeyGSharpensF: Story = {
  args: { keySignature: 'G' },
  play: async ({ canvasElement, args }) => {
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const end = l.cursors[l.cursors.length - 1];
    // The top line is F5.
    await fireEvent.click(svg, at(svg, end.x, l.systems[end.system].lineYs[0]));
    expect(args.onPlace).toHaveBeenCalledWith(kirakiraA.events.length, 'F#5');
  },
};

/** Flags, dots, accidentals, rests, ledger lines, a tie over the barline. */
export const MixedValues: Story = {
  args: {
    events: [
      n('C#5', 24, 'ら'),
      n('Bb4', 8, 'り'),
      n('E4', 4, 'る'),
      n('F4', 4),
      n('G4', 8, 'れ'),
      r(16),
      { ...n('A5', 40, 'あ'), chord: 'Dm7' },
      n('D4', 8, 'い'),
      r(8),
      { ...n('C4', 32, 'う'), chord: 'G7' },
      n('B3', 16, 'え'),
      n('C6', 16, 'お'),
    ],
    cursor: 7,
    selected: 3,
    mismatchFrom: 10,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('note-6-1')).toBeInTheDocument(); // tied piece
    expect(canvas.getByTestId('rest-5-0')).toBeInTheDocument();
    expect(canvasElement.querySelectorAll('path')).not.toHaveLength(0);
  },
};

/**
 * M5 T20: two 3-tuplet brackets in one bar. Group 1 (events 0-2) has 2 of 3
 * notes stem-down (高い音) → side 'below', but its one low outlier (D3)
 * drags that flat bracket line down with it (T16's flagged case: a
 * below-side bracket may hang well beneath the staff). Group 2 (events
 * 3-5) has 2 of 3 notes stem-up (低い音) → default side 'above', but its
 * one very high outlier (G6, the top of the supported range) drags that
 * bracket up toward the top of the system — `staffLayout.ts` grows each
 * system's own top padding to fit it, so it stays inside the band instead
 * of being clipped by the SVG's viewBox (fixed after this story first
 * caught it clipped entirely).
 */
export const TupletBrackets: Story = {
  args: {
    width: 420,
    cursor: 6,
    events: [
      tn3('B5', 0),
      tn3('D3', 1),
      tn3('C6', 2),
      tn3('D3', 0),
      tn3('G6', 1),
      tn3('E3', 2),
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('tuplet-0')).toBeInTheDocument();
    expect(canvas.getByTestId('tuplet-3')).toBeInTheDocument();
    const l = layoutOf(args);
    expect(l.tuplets[0].side).toBe('below');
    expect(l.tuplets[1].side).toBe('above');
    // The low outlier (D3) drags the 'below' bracket beneath the staff...
    expect(l.tuplets[0].line[0].y1).toBeGreaterThan(l.systems[0].lineYs[4]);
    // …and the high outlier (G6) drags the 'above' bracket up, but it stays
    // inside the system's (grown) top padding, above the staff itself.
    expect(l.tuplets[1].line[0].y1).toBeGreaterThan(l.systems[0].top);
    expect(l.tuplets[1].line[1].y1).toBeLessThan(l.systems[0].lineYs[0]);
  },
};

/** Stateful demo: click to place, click a note to select. */
export const Interactive: Story = {
  args: { events: [], cursor: 0 },
  render: function Render(args) {
    const [events, setEvents] = useState<MelodyEvent[]>(
      kirakiraA.events.slice(0, 4),
    );
    const [cursor, setCursor] = useState(4);
    const [selected, setSelected] = useState<number | null>(null);
    return (
      <MelodyStaff
        {...args}
        events={events}
        cursor={cursor}
        selected={selected}
        onPlace={(i, pitch) => {
          setEvents([...events.slice(0, i), n(pitch, 16), ...events.slice(i)]);
          setCursor(i + 1);
          setSelected(null);
        }}
        onSelect={setSelected}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const svg = svgOf(canvasElement);
    const l = layoutMelody(kirakiraA.events.slice(0, 4), kirakiraA.ts, {
      width: WIDTH,
    });
    const end = l.cursors[4];
    await fireEvent.click(svg, at(svg, end.x, pitchToY(l, 0, 'D5')));
    expect(
      canvasElement.querySelectorAll('[data-testid^="note-"]'),
    ).toHaveLength(5);
    await waitFor(() =>
      expect(canvas.getByTestId('staff-live')).toHaveTextContent(
        '5音目: レ5、4分音符',
      ),
    );
  },
};
