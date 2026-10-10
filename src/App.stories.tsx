import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import App from './App';
import { sampleSongText } from './lib/fixtures/sampleSong';
import { EDITOR_MODE_KEY, createMemoryStorage } from './lib/storage';

/**
 * Each story mount gets its own in-memory storage (seeded with the editor mode),
 * so stories never share drafts through the browser's real localStorage.
 */
function Demo({
  initialText,
  editorMode,
}: {
  initialText?: string;
  editorMode?: 'easy' | 'text';
}) {
  const [storage] = useState(() =>
    createMemoryStorage(editorMode ? { [EDITOR_MODE_KEY]: editorMode } : {}),
  );
  return (
    <App
      storage={storage}
      songId="story"
      initialText={initialText}
      baseVersion={null}
    />
  );
}

const meta = {
  title: 'App',
  component: Demo,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A chart with one section and no melody/drum parts yet (for DrumsTab). */
const DRUM_DRAFT = `{title: テスト}
{key: C}
{time: 4/4}

{start_of_verse: A}
[C]きらきら
{end_of_verse}
`;

/** No draft: a new 「無題の曲」 at editor A step 1. */
export const NewSong: Story = {
  args: {},
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 1, name: '無題の曲' }),
    ).toBeVisible();
    await expect(canvas.getByLabelText('歌詞を貼り付け')).toBeVisible();
  },
};

/** Restored draft, editor A step 2. */
export const RestoredDraft: Story = {
  args: {
    initialText: sampleSongText,
  },
};

/** Restored draft, editor B (remembered mode); switching keeps the text. */
export const TextMode: Story = {
  args: {
    initialText: sampleSongText,
    editorMode: 'text',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const textarea = () => canvas.getByLabelText('ChordPro テキスト');
    await expect(textarea()).toHaveValue(sampleSongText);
    await userEvent.click(canvas.getByRole('button', { name: 'かんたん入力' }));
    await userEvent.click(canvas.getByRole('button', { name: 'テキスト入力' }));
    await expect(textarea()).toHaveValue(sampleSongText);
  },
};

/** Melody tab (M4 T17): the real MelodyEditor, full width in the tab panel. */
export const MelodyTab: Story = {
  args: {
    initialText: sampleSongText,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: 'メロディ' }));
    await expect(canvas.getByRole('application')).toBeVisible();
  },
};

/**
 * Drums tab (M5 T22): the real DrumEditor, full width in the tab panel. Types
 * a few keys on the staff (H = ハイハット, Shift+J = adds バスドラム to the
 * same beat) and checks the resulting ChordPro text in テキスト入力.
 */
export const DrumsTab: Story = {
  args: {
    initialText: DRUM_DRAFT,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: 'ドラム' }));
    const staff = canvas.getByRole('application', {
      name: 'セクション A のドラム',
    });
    await expect(staff).toBeVisible();
    staff.focus();
    // H = ハイハット, Shift+J = バスドラムを直前の拍に追加.
    await userEvent.keyboard('[KeyH]{Shift>}[KeyJ]{/Shift}');

    await userEvent.click(canvas.getByRole('tab', { name: 'コード譜' }));
    await userEvent.click(canvas.getByRole('button', { name: 'テキスト入力' }));
    const text = (
      canvas.getByLabelText('ChordPro テキスト') as HTMLTextAreaElement
    ).value;
    await expect(text).toContain('{start_of_part: Drums}');
    await expect(text).toContain('(HH BD)');
  },
};

/**
 * Viewer screen (M6 T16): 「閲覧モード」 shows the Viewer (the caller owns the URL; Demo leaves `viewing` uncontrolled),
 * 「編集に戻る」 returns to the editor with the EasyEditor state intact.
 */
export const ViewerScreen: Story = {
  args: {
    initialText: sampleSongText,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '閲覧モード' }));
    const back = await canvas.findByRole('button', { name: /編集に戻る/ });
    await expect(back).toBeVisible();
    await userEvent.click(back);
    await expect(
      await canvas.findByRole('button', { name: '閲覧モード' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: /編集に戻る/ }),
    ).toBeNull();
  },
};
