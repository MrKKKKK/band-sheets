import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { MelodyEvent } from '../../lib/melody';
import type { ChartChords } from '../../lib/melodyChords';
import { MelodyChordsPanel } from './MelodyChordsPanel';

const n = (lyric?: string, chord?: string): MelodyEvent => ({
  kind: 'note',
  pitch: 'C4',
  ticks: 16,
  ...(lyric !== undefined && { lyric }),
  ...(chord !== undefined && { chord }),
});

const CHART: ChartChords = {
  syllables: ['き', 'ら', 'き', 'ら'],
  chords: [
    { chord: 'C', syllable: 0 },
    { chord: 'G7', syllable: 2 },
  ],
};
const PLAIN = [n('き'), n('ら'), n('き'), n('ら')];
const WITH_CHORDS = [n('き', 'C'), n('ら'), n('き', 'G7'), n('ら', 'C')];

const meta = {
  title: 'Melody/MelodyChordsPanel',
  component: MelodyChordsPanel,
  parameters: { a11y: { test: 'error' }, layout: 'padded' },
  args: {
    events: PLAIN,
    chart: CHART,
    sectionLabel: 'A',
    selected: null,
    onCopy: fn(),
    onEdit: fn(),
    onDelete: fn(),
    onClearAll: fn(),
  },
} satisfies Meta<typeof MelodyChordsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No chords yet: copying needs no confirmation. */
export const NoChordsYet: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText('まだコードがありません')).toBeInTheDocument();
    expect(canvas.getByText('コードが付いた音符 0 / 4')).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'コード譜からコードを写す' }),
    );
    expect(args.onCopy).toHaveBeenCalledWith('overwrite');
    expect(canvas.getByText(/音符を選ぶと/)).toBeInTheDocument();
  },
};

/** Chords exist: the button asks 上書き / 空いている音符だけ / キャンセル. */
export const ConfirmWhenChordsExist: Story = {
  args: { events: WITH_CHORDS },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const items = canvas.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['C ×2', 'G7 ×1']);
    expect(canvas.getByText('コードが付いた音符 3 / 4')).toBeInTheDocument();
    const copy = canvas.getByRole('button', {
      name: 'コード譜からコードを写す',
    });
    await userEvent.click(copy);
    const dialog = canvas.getByRole('dialog', { name: 'コードを写す方法' });
    expect(dialog).toHaveTextContent('すでにコードが 3 個付いています');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'キャンセル' }),
    );
    expect(args.onCopy).not.toHaveBeenCalled();
    await userEvent.click(copy);
    await userEvent.click(
      canvas.getByRole('button', { name: '空いている音符だけに写す' }),
    );
    expect(args.onCopy).toHaveBeenCalledWith('fillEmpty');
    await userEvent.click(copy);
    await userEvent.click(
      canvas.getByRole('button', { name: 'すべて上書きする' }),
    );
    expect(args.onCopy).toHaveBeenLastCalledWith('overwrite');
  },
};

/** After a copy: the result, incl. chords that found no note. */
export const CopyResult: Story = {
  args: {
    events: WITH_CHORDS,
    result: { copied: 3, skipped: 1, kept: 0 },
  },
  play: async ({ canvasElement }) => {
    const result = within(canvasElement).getByTestId('chord-copy-result');
    expect(result).toHaveTextContent('コードを 3 個、音符に写しました');
    expect(result).toHaveTextContent(
      'コード譜の 1 個は、合う音符が無く写せませんでした',
    );
  },
};

/** A selected note with a chord: 変更 (Shift+C) and 消す (Shift+⌫). */
export const SelectedWithChord: Story = {
  args: { events: WITH_CHORDS, selected: 2 },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(/選んだ音符（3 音目）のコード/),
    ).toBeInTheDocument();
    const change = canvas.getByRole('button', { name: /変更/ });
    expect(change).toHaveAttribute('aria-keyshortcuts', 'Shift+C');
    await userEvent.click(change);
    expect(args.onEdit).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: /^消す/ }));
    expect(args.onDelete).toHaveBeenCalledOnce();
  },
};

/** A selected chordless note: 置く only. */
export const SelectedWithoutChord: Story = {
  args: { events: WITH_CHORDS, selected: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('button', { name: /置く/ })).toBeInTheDocument();
    expect(canvas.queryByRole('button', { name: /^消す/ })).toBeNull();
  },
};

/** すべて消す asks first. */
export const ClearAll: Story = {
  args: { events: WITH_CHORDS },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', {
        name: 'このセクションのコードをすべて消す',
      }),
    );
    expect(args.onClearAll).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: 'すべて消す' }));
    expect(args.onClearAll).toHaveBeenCalledOnce();
  },
};

/** Copy is disabled with a reason: no lyrics on the notes yet. */
export const NeedsLyrics: Story = {
  args: { events: [n(), n()] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByRole('button', { name: 'コード譜からコードを写す' }),
    ).toBeDisabled();
    expect(
      canvas.getByText(/先に歌詞を音符に付けてください/),
    ).toBeInTheDocument();
  },
};

/** The chart section has no chords. */
export const ChartWithoutChords: Story = {
  args: { chart: { syllables: ['き', 'ら'], chords: [] } },
  play: async ({ canvasElement }) => {
    expect(
      within(canvasElement).getByText(
        'コード譜のセクション A にコードがありません',
      ),
    ).toBeInTheDocument();
  },
};
