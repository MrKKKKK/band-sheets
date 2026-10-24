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
import { wavBytes } from '../../analysis/testing/wavBytes';
import { humSampleResult } from '../../lib/import/fixtures/humResults';
import type { NoteNameMode } from '../../lib/import/humImport';
import { HumReview, type HumReviewProps } from './HumReview';

/** S4 with a hand-made result; the recording is 12 s of silence, the draft tone is a spy (no sound). */
const silentWav = () =>
  new File(
    [wavBytes({ sr: 8000, dataBytes: 8000 * 2 * 12 })],
    'hum-take2.wav',
    { type: 'audio/wav' },
  );

const tone = {
  start: fn(),
  stop: fn(),
  playOne: fn(),
  close: fn(),
};

/** The screen owns the live region text; keep it here like HumImportScreen does. */
function WithLive(props: Omit<HumReviewProps, 'live' | 'say'>) {
  const [live, setLive] = useState('');
  return <HumReview {...props} live={live} say={setLive} />;
}

const meta = {
  title: 'Import/HumReview',
  component: WithLive,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    result: humSampleResult(),
    file: silentWav(),
    songTitle: '聖者の行進',
    label: 'A',
    keySig: 'C',
    existingNotes: 0,
    initialNoteNames: 'doremi' as NoteNameMode,
    onNoteNamesChange: fn(),
    onInsert: fn(),
    onBack: fn(),
    playbackDeps: { createTone: () => tone },
  },
} satisfies Meta<typeof WithLive>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('hum-summary')).toHaveTextContent(
      'A ・ 4 小節 ・ 音 8 個 ・ 自信がない音 2 個',
    );
    expect(c.getByTestId('lyric-1')).toHaveTextContent('ミ');
    expect(c.getByTestId('lyric-3')).toHaveTextContent('ラ?');
    expect(c.getByTestId('hum-start')).toHaveTextContent('1 小節目の 2 拍目');
    expect(c.getByRole('button', { name: '両方' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(c.queryByTestId('replace-note')).toBeNull();
  },
};

/** 16th-note start shift: one press = a 16th, two = a half beat; the bound disables the back buttons. */
export const StartShift16th: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: '16 分後へ ›' }));
    expect(c.getByTestId('hum-shift')).toHaveTextContent('16 分 1 つ後');
    expect(c.getByTestId('hum-start')).toHaveTextContent(
      '1 小節目の 2 拍目のすこし後',
    );
    await userEvent.click(c.getByRole('button', { name: '16 分後へ ›' }));
    expect(c.getByTestId('hum-shift')).toHaveTextContent('16 分 2 つ後');
    expect(c.getByTestId('hum-fixes')).toHaveTextContent('16 分 2 つ後');
    await userEvent.click(c.getByRole('button', { name: '‹ 1 拍前へ' }));
    expect(c.getByTestId('hum-shift')).toHaveTextContent('16 分 2 つ前');
    expect(c.getByTestId('hum-start')).toHaveTextContent(
      '1 小節目の 1 拍目のすこし後',
    );
    await userEvent.click(c.getByRole('button', { name: '‹ 16 分前へ' }));
    await userEvent.click(c.getByRole('button', { name: '‹ 16 分前へ' }));
    expect(c.getByTestId('hum-shift')).toHaveTextContent('1 拍前');
    expect(c.getByTestId('hum-start')).toHaveTextContent('1 小節目の 1 拍目');
    expect(c.getByRole('button', { name: '‹ 16 分前へ' })).toBeDisabled();
    expect(c.getByRole('button', { name: '‹ 1 拍前へ' })).toBeDisabled();
  },
};

/** Selects event 3 (the first unsure note) with the keyboard: → moves from note to note. */
async function openNote3(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  c.getByRole('application').focus();
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
  return c.findByTestId('candidate-panel');
}

/** A click on a notehead opens its candidates too. */
export const ClickANote: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // the notehead glyph sits on its baseline (x, y in staff coordinates)
    const head = c.getByTestId('note-1-0').querySelector('text')!;
    const svg = c.getByTestId('melody-staff-svg');
    // in view first: the click focuses the staff, which would scroll it under the pointer
    svg.scrollIntoView({ block: 'center' });
    const box = svg.getBoundingClientRect();
    const pt = {
      clientX: box.left + Number(head.getAttribute('x')) + 4,
      clientY: box.top + Number(head.getAttribute('y')),
    };
    fireEvent.click(svg, pt);
    expect(await c.findByTestId('candidate-panel')).toHaveTextContent(
      '1 小節目の 1 つ目の音',
    );
  },
};

export const CandidateOpenDoremi: Story = {
  play: async ({ canvasElement, args }) => {
    const panel = within(await openNote3(canvasElement));
    expect(panel.getByText('1 小節目の 3 つ目の音')).toBeVisible();
    const chips = panel
      .getAllByRole('button', { name: /^▶ / })
      .filter((b) => b.hasAttribute('aria-pressed'));
    expect(chips.map((b) => b.textContent)).toEqual([
      '▶ ラ ',
      '▶ ソ♯ 31%',
      '▶ ラ♯ 12%',
      '▶ 1 拍 ',
      '▶ 半拍 28%',
    ]);
    // a click plays the candidate and applies it at once
    await userEvent.click(panel.getByRole('button', { name: /ソ♯/ }));
    expect(tone.playOne).toHaveBeenCalled();
    const c = within(canvasElement);
    await waitFor(() =>
      expect(c.getByTestId('lyric-3')).toHaveTextContent('ソ♯'),
    );
    expect(panel.getByRole('button', { name: /ソ♯/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // the original stays to go back to
    await userEvent.click(panel.getByRole('button', { name: '▶ ラ' }));
    await waitFor(() =>
      expect(c.getByTestId('lyric-3')).toHaveTextContent('ラ'),
    );
    expect(args.onInsert).not.toHaveBeenCalled();
  },
};

export const CandidateOpenLetters: Story = {
  args: { initialNoteNames: 'letter' },
  play: async ({ canvasElement }) => {
    const panel = within(await openNote3(canvasElement));
    expect(panel.getByRole('button', { name: /G♯ 31%/ })).toBeVisible();
    expect(within(canvasElement).getByTestId('lyric-1')).toHaveTextContent('E');
  },
};

export const CandidateOpenNoNames: Story = {
  args: { initialNoteNames: 'none' },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.queryByTestId('lyric-1')).toBeNull();
    expect(c.getByTestId('lyric-3')).toHaveTextContent('?');
    const panel = within(await openNote3(canvasElement));
    expect(panel.getByRole('button', { name: /半音下 31%/ })).toBeVisible();
    expect(panel.getByRole('button', { name: /元の高さ/ })).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'ドレミ' }));
    expect(args.onNoteNamesChange).toHaveBeenCalledWith('doremi');
  },
};

export const OverwriteConfirm: Story = {
  args: { existingNotes: 14 },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('replace-note')).toBeVisible();
    await userEvent.click(
      c.getByRole('button', { name: 'このセクションに下書きを入れる' }),
    );
    const body = within(document.body);
    const dialog = await body.findByRole('dialog', {
      name: 'Aの音符を置き換えますか',
    });
    const d = within(dialog);
    expect(d.getByRole('button', { name: 'キャンセル' })).toHaveFocus();
    await userEvent.click(d.getByRole('button', { name: '置き換えて入れる' }));
    expect(args.onInsert).toHaveBeenCalledTimes(1);
  },
};

export const PlayerBarVisibleAfterScroll: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const bar = c.getByTestId('player-bar');
    const legend = c.getByText('青い縦線: いま再生している場所');
    // scroll until the bottom of the score card is near the top of the window
    window.scrollTo(
      0,
      legend.getBoundingClientRect().top + window.scrollY - 200,
    );
    await waitFor(() => {
      const r = bar.getBoundingClientRect();
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeLessThan(10);
    });
    window.scrollTo(0, 0);
  },
};

/** A failed insert is shown next to the button, not only read out. */
export const InsertError: Story = {
  args: { insertError: 'セクション「A」は読み取り専用です: 例' },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByTestId('insert-error')).toBeVisible();
  },
};
