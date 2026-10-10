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
import { sortHits, type DrumEvent, type DrumHit } from '../../lib/drum';
import {
  applyDrumCommand,
  initialDrumEditorState,
  keyToDrumCommand,
  type DrumCommand,
} from '../../lib/drumInput';
import type { DrumInstrument } from '../../lib/drumKit';
import {
  instrumentY,
  layoutDrums,
  type DrumLayout,
} from '../../lib/drumLayout';
import type { TimeSig } from '../../lib/melody';
import { DrumStaff, type DrumStaffProps } from './DrumStaff';

const WIDTH = 720;
const TS: TimeSig = { num: 4, den: 4 };

type Spec = DrumInstrument | `${DrumInstrument}:${'g' | 'ac' | 'hac'}`;
const hit = (spec: Spec): DrumHit => {
  const [inst, eff] = spec.split(':') as [DrumInstrument, string | undefined];
  if (eff === 'g') return { inst, ghost: true };
  if (eff === 'ac') return { inst, accent: 'normal' };
  if (eff === 'hac') return { inst, accent: 'heavy' };
  return { inst };
};
const b = (ticks: number, ...hits: Spec[]): DrumEvent => ({
  hits: sortHits(hits.map(hit)),
  ticks,
});
const r = (ticks: number): DrumEvent => ({ hits: [], ticks });
const group = (n: number, items: DrumEvent[]): DrumEvent[] =>
  items.map((e, slot) => ({ ...e, tuplet: { n, slot } }));

/**
 * Three bars (two systems at 720px): an 8-beat with crash / accent / open
 * hi-hat; ghost notes, an 8th triplet and a 16th 5-tuplet; rests, a dotted
 * 8th, toms and a crash chord with an accent.
 */
const RICH: DrumEvent[] = [
  // bar 1: 0..7
  b(8, 'CR', 'BD'),
  b(8, 'HH'),
  b(8, 'HH', 'SD:ac'),
  b(8, 'HH'),
  b(8, 'HH', 'BD'),
  b(8, 'HH'),
  b(8, 'HH', 'SD'),
  b(8, 'HO'),
  // bar 2: 8..19
  b(8, 'HH', 'BD'),
  b(8, 'SD:g'),
  ...group(3, [b(8, 'HH'), r(8), b(8, 'SD:hac')]), // 10..12
  b(8, 'HH', 'SD'),
  r(8), // 14
  ...group(5, [b(4, 'HH'), b(4, 'SD:g'), b(4, 'HH'), b(4, 'SD'), b(4, 'BD')]), // 15..19
  // bar 3: 20..25
  r(16),
  b(12, 'RD', 'BD'),
  b(4, 'SD'),
  b(8, 'T1'),
  b(8, 'T2'),
  b(16, 'CR:ac', 'FT', 'BD'),
];

const meta = {
  title: 'Drums/DrumStaff',
  parameters: { a11y: { test: 'error' } },
  component: DrumStaff,
  args: {
    events: RICH,
    ts: TS,
    shuffle: '8',
    state: {
      cursor: RICH.length,
      selected: null,
      duration: '8',
      dotted: false,
    },
    width: WIDTH,
    ariaLabel: 'セクション A のドラム',
    onCommand: fn(),
    onKeyDown: fn(),
  },
} satisfies Meta<typeof DrumStaff>;

export default meta;
type Story = StoryObj<typeof meta>;

const layoutOf = (args: DrumStaffProps): DrumLayout =>
  layoutDrums(args.events, args.ts, {
    width: args.width ?? WIDTH,
    shuffle: args.shuffle,
  });

const svgOf = (el: HTMLElement) =>
  within(el).getByTestId('drum-staff-svg') as unknown as SVGSVGElement;

/** Client coordinates of an SVG-space point. */
function at(svg: SVGSVGElement, x: number, y: number) {
  const rect = svg.getBoundingClientRect();
  return { clientX: rect.left + x, clientY: rect.top + y };
}

const lastCommand = (onCommand: unknown): DrumCommand =>
  (onCommand as ReturnType<typeof fn>).mock.lastCall![0] as DrumCommand;

/** Everything layoutDrums outputs, for the T18 screenshot. */
export const Rich: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const l = layoutOf(args);
    expect(l.systems.length).toBeGreaterThanOrEqual(2);
    expect(canvas.getByTestId('system-1')).toBeInTheDocument();
    expect(
      canvasElement.querySelectorAll('[data-testid^="beat-"]'),
    ).toHaveLength(RICH.length);
    expect(canvas.getByTestId('head-0-CR')).toBeInTheDocument();
    expect(canvas.getByTestId('head-7-HO')).toBeInTheDocument();
    expect(canvas.getByTestId('ghost-9-SD')).toBeInTheDocument();
    expect(canvas.getByTestId('beat-14')).toHaveAttribute('data-kind', 'rest');
    expect(canvas.getByTestId('tuplet-10')).toHaveAttribute('data-n', '3');
    expect(canvas.getByTestId('tuplet-15')).toHaveAttribute('data-n', '5');
    expect(canvas.getByTestId('shuffle-mark')).toHaveTextContent('Shuffle');
    expect(canvas.getByTestId('accent-2-0')).toBeInTheDocument();
    expect(canvas.getByTestId('cursor')).toBeInTheDocument();
    expect(canvas.queryByTestId('selection')).toBeNull();
    expect(
      canvas.getByRole('application', { name: args.ariaLabel }),
    ).toHaveAttribute('aria-roledescription', 'ドラム入力');
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
    await fireEvent.click(
      svg,
      at(svg, end.x, instrumentY(l, end.system, 'SD')),
    );
    expect(args.onCommand).toHaveBeenCalledOnce();
    expect(args.onCommand).toHaveBeenCalledWith({
      type: 'placeAt',
      index: RICH.length,
      inst: 'SD',
    });
    expect(within(canvasElement).getByRole('application')).toHaveFocus();
  },
};

/**
 * R4 (docs/m5-review.md): while a beat is selected, clicking empty staff
 * space only clears the selection — it must not insert a beat there, since
 * ModeStatus tells the user that click deselects.
 */
export const ClickEmptyWhileSelected: Story = {
  args: {
    state: { cursor: 3, selected: 9, duration: '8', dotted: false },
  },
  play: async ({ canvasElement, args }) => {
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const end = l.cursors[l.cursors.length - 1];
    await fireEvent.click(
      svg,
      at(svg, end.x, instrumentY(l, end.system, 'SD')),
    );
    expect(args.onCommand).toHaveBeenCalledOnce();
    expect(args.onCommand).toHaveBeenCalledWith({ type: 'clearSelection' });
  },
};

/**
 * R10 (docs/m5-review.md): while a beat is selected, hovering empty staff
 * space (an 'insert' target) must not show the insert preview — a click
 * there only clears the selection (R4), so the preview would promise
 * something that doesn't happen. A 'column' target (click adds an
 * instrument to that beat) still shows its preview while selected.
 */
export const NoPreviewWhileSelected: Story = {
  args: {
    state: { cursor: 3, selected: 9, duration: '8', dotted: false },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const end = l.cursors[l.cursors.length - 1];
    await fireEvent.pointerMove(
      svg,
      at(svg, end.x, instrumentY(l, end.system, 'CR')),
    );
    expect(svg).toHaveAttribute('data-target', 'insert');
    expect(canvas.queryByTestId('preview-drum')).toBeNull();
    // A column target (another height within an existing beat) still
    // previews while selected: clicking it adds an instrument.
    const beat = l.beats[1];
    await fireEvent.pointerMove(
      svg,
      at(svg, beat.x, instrumentY(l, beat.system, 'SD')),
    );
    expect(svg).toHaveAttribute('data-target', 'column');
    expect(canvas.getByTestId('preview-drum')).toHaveAttribute(
      'data-kind',
      'column',
    );
  },
};

export const ClickColumnAdds: Story = {
  play: async ({ canvasElement, args }) => {
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const beat = l.beats[1]; // HH alone
    await fireEvent.click(
      svg,
      at(svg, beat.x, instrumentY(l, beat.system, 'BD')),
    );
    expect(lastCommand(args.onCommand)).toEqual({
      type: 'addAt',
      index: 1,
      inst: 'BD',
    });
    // A rest's column adds too (decision 2026-10-04).
    const rest = l.beats[14];
    await fireEvent.click(
      svg,
      at(svg, rest.x, instrumentY(l, rest.system, 'SD')),
    );
    expect(lastCommand(args.onCommand)).toEqual({
      type: 'addAt',
      index: 14,
      inst: 'SD',
    });
    // Shift does not change what a click does.
    await fireEvent.click(svg, {
      ...at(svg, beat.x, instrumentY(l, beat.system, 'SD')),
      shiftKey: true,
    });
    expect(lastCommand(args.onCommand)).toEqual({
      type: 'addAt',
      index: 1,
      inst: 'SD',
    });
  },
};

export const ClickHeadSelects: Story = {
  play: async ({ canvasElement, args }) => {
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const ho = l.beats[7].heads[0];
    await fireEvent.click(svg, at(svg, ho.x, ho.y));
    expect(lastCommand(args.onCommand)).toEqual({
      type: 'select',
      index: 7,
      inst: 'HO',
    });
    const cr = l.beats[0].heads.find((h) => h.inst === 'CR')!;
    await fireEvent.click(svg, at(svg, cr.x, cr.y));
    expect(lastCommand(args.onCommand)).toEqual({
      type: 'select',
      index: 0,
      inst: 'CR',
    });
  },
};

export const Selected: Story = {
  args: {
    state: { cursor: 3, selected: 9, duration: '8', dotted: false },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('selection')).toBeInTheDocument();
    expect(canvas.getByTestId('beat-9').getAttribute('class')).toMatch(
      /selectedBeat/,
    );
    // Select mode: no insertion cursor.
    expect(canvas.queryByTestId('cursor')).toBeNull();
  },
};

export const HoverPreview: Story = {
  args: {
    state: { cursor: 0, selected: null, duration: '16', dotted: true },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const end = l.cursors[l.cursors.length - 1];
    expect(canvas.queryByTestId('preview-drum')).toBeNull();
    await fireEvent.pointerMove(
      svg,
      at(svg, end.x, instrumentY(l, end.system, 'CR')),
    );
    const preview = await canvas.findByTestId('preview-drum');
    expect(preview).toHaveAttribute('data-inst', 'CR');
    expect(preview).toHaveAttribute('data-kind', 'insert');
    // New beat: stem + ledger line; dotted → a dot.
    expect(preview.querySelectorAll('line').length).toBeGreaterThanOrEqual(2);
    expect(svg).toHaveAttribute('data-target', 'insert');
    // In a column at another height: just a notehead.
    const beat = l.beats[1];
    await fireEvent.pointerMove(
      svg,
      at(svg, beat.x, instrumentY(l, beat.system, 'SD')),
    );
    expect(canvas.getByTestId('preview-drum')).toHaveAttribute(
      'data-kind',
      'column',
    );
    expect(canvas.getByTestId('preview-drum').querySelector('line')).toBeNull();
    // Over a notehead: no preview (a click selects).
    const hh = beat.heads[0];
    await fireEvent.pointerMove(svg, at(svg, hh.x, hh.y));
    expect(canvas.queryByTestId('preview-drum')).toBeNull();
    expect(svg).toHaveAttribute('data-target', 'head');
    // React derives onPointerLeave from pointerout.
    await fireEvent.pointerOut(svg, { relatedTarget: document.body });
    expect(canvas.queryByTestId('preview-drum')).toBeNull();
  },
};

export const KeyDownForwarded: Story = {
  play: async ({ canvasElement, args }) => {
    const staff = within(canvasElement).getByRole('application');
    staff.focus();
    await userEvent.keyboard('[Semicolon]');
    await userEvent.keyboard('{Escape}');
    expect(args.onKeyDown).toHaveBeenCalledTimes(2);
    const e = (args.onKeyDown as ReturnType<typeof fn>).mock.calls[0][0];
    expect(e.code).toBe('Semicolon');
    expect(args.onCommand).not.toHaveBeenCalled();
  },
};

export const LiveMessage: Story = {
  args: { liveMessage: '3 番目: 8分 ハイハット＋スネア' },
  play: async ({ canvasElement }) => {
    const live = within(canvasElement).getByTestId('staff-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('3 番目: 8分 ハイハット＋スネア');
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByRole('application')).toBeNull();
    expect(
      canvas.getByRole('img', { name: /読み取り専用/ }),
    ).toBeInTheDocument();
    const svg = svgOf(canvasElement);
    const l = layoutOf(args);
    const end = l.cursors[l.cursors.length - 1];
    const y = instrumentY(l, end.system, 'SD');
    await fireEvent.click(svg, at(svg, end.x, y));
    const hh = l.beats[1].heads[0];
    await fireEvent.click(svg, at(svg, hh.x, hh.y));
    await fireEvent.pointerMove(svg, at(svg, end.x, y));
    expect(args.onCommand).not.toHaveBeenCalled();
    expect(canvas.queryByTestId('preview-drum')).toBeNull();
    expect(canvas.queryByTestId('cursor')).toBeNull();
  },
};

/** No beats yet: clef, time signature, the 16th Shuffle mark and a cursor. */
export const Empty: Story = {
  args: {
    events: [],
    shuffle: '16',
    state: { cursor: 0, selected: null, duration: '8', dotted: false },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('clef-0')).toBeInTheDocument();
    expect(canvas.getByTestId('shuffle-mark')).toHaveAttribute(
      'data-shuffle',
      '16',
    );
    expect(canvas.getByTestId('cursor')).toBeInTheDocument();
  },
};

/** Stateful demo: clicks and keys go through applyDrumCommand. */
export const Interactive: Story = {
  args: { events: [], shuffle: 'none' },
  render: function Render(args) {
    const [events, setEvents] = useState<DrumEvent[]>(RICH.slice(0, 4));
    const [state, setState] = useState(() =>
      initialDrumEditorState(RICH.slice(0, 4)),
    );
    const [message, setMessage] = useState('');
    const run = (cmd: DrumCommand) => {
      const res = applyDrumCommand(events, state, cmd, { ts: args.ts });
      setEvents(res.events);
      setState(res.state);
      setMessage(res.message ?? '');
    };
    return (
      <DrumStaff
        {...args}
        events={events}
        state={state}
        liveMessage={message}
        onCommand={run}
        onKeyDown={(e) => {
          const cmd = keyToDrumCommand(e);
          if (!cmd) return;
          e.preventDefault();
          run(cmd);
        }}
      />
    );
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const svg = svgOf(canvasElement);
    const l = layoutDrums(RICH.slice(0, 4), args.ts, { width: WIDTH });
    const end = l.cursors[4];
    await fireEvent.click(svg, at(svg, end.x, instrumentY(l, 0, 'SD')));
    expect(
      canvasElement.querySelectorAll('[data-testid^="beat-"]'),
    ).toHaveLength(5);
    expect(canvas.getByTestId('head-4-SD')).toBeInTheDocument();
    // Keys: F (snare) appends another beat.
    await userEvent.keyboard('[KeyF]');
    expect(canvas.getByTestId('head-5-SD')).toBeInTheDocument();
    // R4: select a beat, then click empty space — selection clears, no
    // beat is inserted (end-to-end through applyDrumCommand).
    const l2 = layoutDrums(RICH.slice(0, 4).concat(RICH.slice(4, 6)), args.ts, {
      width: WIDTH,
    });
    const headToSelect = l2.beats[0].heads[0];
    await fireEvent.click(svg, at(svg, headToSelect.x, headToSelect.y));
    expect(canvas.getByTestId('selection')).toBeInTheDocument();
    const farEnd = l2.cursors[l2.cursors.length - 1];
    await fireEvent.click(
      svg,
      at(svg, farEnd.x, instrumentY(l2, farEnd.system, 'CR')),
    );
    expect(canvas.queryByTestId('selection')).toBeNull();
    expect(
      canvasElement.querySelectorAll('[data-testid^="beat-"]'),
    ).toHaveLength(6);
  },
};

/** Whole / half / dotted values, seconds (shifted heads), rest kinds. */
export const Glyphs: Story = {
  args: {
    shuffle: 'none',
    events: [
      b(64, 'CR', 'BD'),
      b(32, 'HH', 'RD'),
      r(32),
      b(24, 'T1', 'T2', 'SD'),
      b(12, 'HH'),
      b(6, 'SD', 'FT'),
      b(2, 'HO'),
      r(12),
      r(8),
      r(64),
    ],
    state: { cursor: 10, selected: 3, duration: '8', dotted: false },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('head-3-T1')).toBeInTheDocument();
    expect(canvas.getByTestId('head-3-T2')).toBeInTheDocument();
    expect(canvas.getByTestId('beat-9')).toHaveAttribute('data-kind', 'rest');
    expect(canvas.getByTestId('selection')).toBeInTheDocument();
  },
};
