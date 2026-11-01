import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { SectionScore } from './SectionScore';

/** Case-variant chords (alphaTab keys chords case-insensitively). */
const CHORD_CASE_TEX = String.raw`\track "Vo"
\staff {score}
\ts 4 4
\ks c
\section "A"
:4 C5{ch "C#m7"} C5{ch "C#M7"} C5{ch "Cm7"} C5{ch "CM7"} |
:4 C5{ch "DbM7"} C5{ch "C#M7/G#"} C5{ch "CmM7"} C5{ch "C#m7-5"} |
`;

const meta = {
  title: 'Viewer/SectionScore/ChordCase',
  component: SectionScore,
  args: { tex: CHORD_CASE_TEX, trackCount: 1, zoom: 1.5, firstBar: 1 },
} satisfies Meta<typeof SectionScore>;
export default meta;
type Story = StoryObj<typeof meta>;

const chordTexts = async (root: HTMLElement) => {
  const score = within(root).getByTestId('section-score');
  await waitFor(() => expect(score.dataset.state).toBe('rendered'), {
    timeout: 15000,
  });
  await new Promise((r) => setTimeout(r, 300));
  return [...score.querySelectorAll('svg text')].map(
    (t) => t.textContent ?? '',
  );
};

const AS_WRITTEN = [
  'C#m7',
  'C#M7',
  'Cm7',
  'CM7',
  'DbM7',
  'C#M7/G#',
  'CmM7',
  'C#m7-5',
];

export const AsWritten: Story = {
  play: async ({ canvasElement }) => {
    const texts = await chordTexts(canvasElement);
    for (const c of AS_WRITTEN) expect(texts).toContain(c);
    expect(texts.join('')).not.toContain('​');
  },
};

export const TransposedUp: Story = {
  args: { transpose: 1 },
  play: async ({ canvasElement }) => {
    const texts = await chordTexts(canvasElement);
    for (const c of ['Dm7', 'DM7', 'DbmM7', 'DM7/A'])
      expect(texts).toContain(c);
    expect(texts.join('')).not.toContain('​');
  },
};

export const TransposedDown: Story = {
  args: { transpose: -1 },
  play: async ({ canvasElement }) => {
    const texts = await chordTexts(canvasElement);
    for (const c of ['Cm7', 'CM7', 'BmM7']) expect(texts).toContain(c);
    expect(texts.join('')).not.toContain('​');
  },
};
