import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { MelodyEvent } from '../../lib/melody';
import { kirakiraA } from '../../lib/fixtures/melodyFixtures';
import { autoAssign, extend, merge, split } from '../../lib/melodyLyrics';
import { LyricsPanel, type LyricsPanelProps } from './LyricsPanel';

/** きらきら星 A's notes (melodyFixtures.ts), stripped of their lyrics. */
function stripLyrics(events: readonly MelodyEvent[]): MelodyEvent[] {
  return events.map((e) => {
    const { lyric: _drop, ...rest } = e;
    return rest;
  });
}

const kirakiraEvents: MelodyEvent[] = kirakiraA.events;
const kirakiraBare: MelodyEvent[] = stripLyrics(kirakiraEvents);
// Every note of the fixture carries exactly one syllable, in order.
const kirakiraSyllables: string[] = kirakiraEvents.map((e) => e.lyric!);

type DemoProps = {
  initialEvents: MelodyEvent[];
  chartSyllables: string[];
  sectionLabel: string;
  partLevelLyrics?: boolean;
  onChange: LyricsPanelProps['onChange'];
  onConvertPartLyrics?: () => void;
  /** Selects this note on mount, for stories that need a selection ready. */
  initialSelected?: number | null;
};

/** Stateful harness: owns `events` + a note-selection stand-in for the staff. */
function Demo({
  initialEvents,
  chartSyllables,
  sectionLabel,
  partLevelLyrics,
  onChange,
  onConvertPartLyrics,
  initialSelected = null,
}: DemoProps) {
  const [events, setEvents] = useState(initialEvents);
  const [selectedNote, setSelectedNote] = useState<number | null>(
    initialSelected,
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/*
       * Stand-in for the melody staff (T11's MelodyStaff isn't owned by
       * this task): one button per event, selecting it like a staff click.
       */}
      <div role="group" aria-label="音符を選ぶ（テスト用）">
        {events.map((e, i) => (
          <button
            key={i}
            type="button"
            data-testid={`note-${i}`}
            aria-pressed={selectedNote === i}
            onClick={() => setSelectedNote(i)}
          >
            {i}:{e.kind === 'note' ? e.pitch : 'rest'}
            {e.lyric !== undefined ? `(${e.lyric})` : ''}
          </button>
        ))}
      </div>
      <LyricsPanel
        events={events}
        chartSyllables={chartSyllables}
        selectedNote={selectedNote}
        sectionLabel={sectionLabel}
        onChange={(next, action) => {
          onChange(next, action);
          setEvents(next);
        }}
        partLevelLyrics={partLevelLyrics}
        onConvertPartLyrics={onConvertPartLyrics}
      />
    </div>
  );
}

const meta = {
  title: 'Melody/LyricsPanel',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: {
    sectionLabel: 'A',
    onChange: fn(),
    onConvertPartLyrics: fn(),
  },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ImportIntoEmptyLyrics: Story = {
  args: {
    initialEvents: kirakiraBare,
    chartSyllables: kirakiraSyllables,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const importButton = canvas.getByRole('button', {
      name: 'コード譜から歌詞を取り込む',
    });
    await expect(importButton).toBeEnabled();
    // Chart syllable preview is visible: one chip per chart syllable.
    await expect(canvas.getAllByRole('listitem')).toHaveLength(
      kirakiraSyllables.length,
    );

    await userEvent.click(importButton);
    // No existing lyric: applies immediately, no confirm dialog.
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(args.onChange).toHaveBeenCalledOnce();
    expect(args.onChange).toHaveBeenCalledWith(
      autoAssign(kirakiraBare, kirakiraSyllables),
      'import',
    );
    await expect(
      canvas.getByText('音符 14・音節 14', { exact: false }),
    ).toBeInTheDocument();
  },
};

export const ImportWithExistingLyricsAsksToConfirm: Story = {
  args: {
    initialEvents: kirakiraEvents,
    chartSyllables: kirakiraSyllables,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const importButton = canvas.getByRole('button', {
      name: 'コード譜から歌詞を取り込む',
    });
    await userEvent.click(importButton);
    const dialog = await canvas.findByRole('dialog', {
      name: '歌詞の置き換えの確認',
    });
    await expect(
      within(dialog).getByText('今の歌詞を置き換えます。よろしいですか？'),
    ).toBeInTheDocument();

    // Cancel: no onChange, dialog closes.
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'キャンセル' }),
    );
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    expect(args.onChange).not.toHaveBeenCalled();

    // Confirm: applies once.
    await userEvent.click(importButton);
    const dialog2 = await canvas.findByRole('dialog');
    await userEvent.click(
      within(dialog2).getByRole('button', { name: '置き換える' }),
    );
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    await expect(args.onChange).toHaveBeenCalledOnce();
    expect(args.onChange).toHaveBeenCalledWith(
      autoAssign(kirakiraEvents, kirakiraSyllables),
      'import',
    );
  },
};

export const ExtendShiftsStream: Story = {
  args: {
    initialEvents: kirakiraEvents,
    chartSyllables: kirakiraSyllables,
    initialSelected: 0,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Note 0 ('き') is pre-selected by the harness.
    const extendButton = canvas.getByRole('button', { name: /^のばす:/ });
    await expect(extendButton).toBeEnabled();
    await userEvent.click(extendButton);

    await expect(args.onChange).toHaveBeenCalledOnce();
    const expected = extend(kirakiraEvents, 0, kirakiraSyllables);
    expect(args.onChange).toHaveBeenCalledWith(expected, 'extend');
    // Note 0 keeps 'き'; note 1 becomes the melisma slot (no lyric), and
    // every later note's syllable shifts back by one against the staff
    // stand-in, which re-renders from the applied `expected` events.
    expect(expected[0].lyric).toBe('き');
    expect(expected[1].lyric).toBeUndefined();
    const text = (i: number) =>
      `${i}:${expected[i].pitch}${
        expected[i].lyric !== undefined ? `(${expected[i].lyric})` : ''
      }`;
    await expect(canvas.getByTestId('note-1')).toHaveTextContent(text(1));
    await expect(canvas.getByTestId('note-2')).toHaveTextContent(text(2));
  },
};

export const MergeThenSplitRoundTrip: Story = {
  args: {
    initialEvents: kirakiraEvents,
    chartSyllables: kirakiraSyllables,
    initialSelected: 0,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const mergeButton = canvas.getByRole('button', { name: /^つめる:/ });
    await userEvent.click(mergeButton);
    await expect(args.onChange).toHaveBeenCalledOnce();
    const merged = merge(kirakiraEvents, 0, kirakiraSyllables);
    expect(args.onChange).toHaveBeenLastCalledWith(merged, 'merge');
    expect(merged[0].lyric).toBe('きら');

    const splitButton = canvas.getByRole('button', { name: /^分ける:/ });
    await userEvent.click(splitButton);
    await expect(args.onChange).toHaveBeenCalledTimes(2);
    const roundTripped = split(merged, 0, kirakiraSyllables);
    expect(args.onChange).toHaveBeenLastCalledWith(roundTripped, 'split');
    // Splitting the merge back out restores the original stream.
    expect(roundTripped).toEqual(kirakiraEvents);
  },
};

export const DisabledWithNoSelection: Story = {
  args: {
    initialEvents: kirakiraEvents,
    chartSyllables: kirakiraSyllables,
    initialSelected: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of [/^のばす:/, /^つめる:/, /^分ける:/, /^歌詞なし:/]) {
      await expect(canvas.getByRole('button', { name })).toBeDisabled();
    }
    await expect(canvas.getByText('音符を選んでください')).toBeInTheDocument();
  },
};

export const DisabledWithRestSelected: Story = {
  args: {
    initialEvents: [
      { kind: 'note', pitch: 'C4', ticks: 16, lyric: 'き' },
      { kind: 'rest', ticks: 16 },
      { kind: 'note', pitch: 'D4', ticks: 16 },
    ] satisfies MelodyEvent[],
    chartSyllables: ['き', 'ら'],
    initialSelected: 1,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of [/^のばす:/, /^つめる:/, /^分ける:/, /^歌詞なし:/]) {
      await expect(canvas.getByRole('button', { name })).toBeDisabled();
    }
    await expect(
      canvas.getByText('休符には歌詞を付けられません'),
    ).toBeInTheDocument();
  },
};

export const DisabledWithNoChartSection: Story = {
  args: {
    initialEvents: kirakiraBare,
    chartSyllables: [],
    sectionLabel: 'B',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: 'コード譜から歌詞を取り込む' }),
    ).toBeDisabled();
    await expect(
      canvas.getByText('コード譜にセクション B がありません'),
    ).toBeInTheDocument();
  },
};

/** M12: no notes yet → nothing to import onto. */
export const DisabledWithNoNotes: Story = {
  args: {
    initialEvents: [],
    chartSyllables: kirakiraSyllables,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: 'コード譜から歌詞を取り込む' }),
    ).toBeDisabled();
    await expect(
      canvas.getByText('先に音符を入力してください'),
    ).toBeInTheDocument();
    expect(args.onChange).not.toHaveBeenCalled();
  },
};

/** M6: the four ops advertise their keys. */
export const KeyShortcuts: Story = {
  args: {
    initialEvents: kirakiraEvents,
    chartSyllables: kirakiraSyllables,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const [name, k] of [
      [/^のばす:/, 'N'],
      [/^つめる:/, 'M'],
      [/^分ける:/, 'V'],
      [/^歌詞なし:/, 'C'],
    ] as const) {
      await expect(canvas.getByRole('button', { name })).toHaveAttribute(
        'aria-keyshortcuts',
        k,
      );
    }
  },
};

export const WarningWhenSyllablesAreShort: Story = {
  args: {
    // Last note's lyric removed: 13 placed, 14 expected.
    initialEvents: kirakiraEvents.map((e, i) =>
      i === kirakiraEvents.length - 1 ? stripLyrics([e])[0] : e,
    ),
    chartSyllables: kirakiraSyllables,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('音符 14・音節 13', { exact: false }),
    ).toBeInTheDocument();
    await expect(canvas.getByText('音節が1個足りません')).toBeInTheDocument();
  },
};

export const WarningWhenSyllablesAreExtra: Story = {
  args: {
    initialEvents: kirakiraEvents,
    // Chart has fewer syllables than are already placed on the notes.
    chartSyllables: kirakiraSyllables.slice(0, 12),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('音符 14・音節 14', { exact: false }),
    ).toBeInTheDocument();
    await expect(canvas.getByText('音節が2個多すぎます')).toBeInTheDocument();
  },
};

export const PartLevelLyricsNotice: Story = {
  args: {
    initialEvents: kirakiraEvents,
    chartSyllables: kirakiraSyllables,
    partLevelLyrics: true,
    initialSelected: 0,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        'このパートは歌詞をまとめて書く形式です。アプリで編集するには音符ごとの歌詞に変換してください',
      ),
    ).toBeInTheDocument();

    await expect(
      canvas.getByRole('button', { name: 'コード譜から歌詞を取り込む' }),
    ).toBeDisabled();
    for (const name of [/^のばす:/, /^つめる:/, /^分ける:/, /^歌詞なし:/]) {
      await expect(canvas.getByRole('button', { name })).toBeDisabled();
    }

    const convert = canvas.getByRole('button', {
      name: '音符ごとの歌詞に変換',
    });
    await userEvent.click(convert);
    await expect(args.onConvertPartLyrics).toHaveBeenCalledOnce();
  },
};
