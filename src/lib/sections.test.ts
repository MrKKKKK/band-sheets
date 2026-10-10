import { describe, expect, it } from 'vitest';
import { sampleSong } from './fixtures/sampleSong';
import { sectionLabels } from './sections';
import type { Song } from './song';

describe('sectionLabels', () => {
  it('matches chart sections and part markers by label', () => {
    expect(sectionLabels(sampleSong)).toEqual([
      { label: 'A', inChart: true, parts: ['Vocal', 'Drums'] },
      { label: 'B', inChart: true, parts: ['Vocal'] },
    ]);
  });

  it('orders chart labels first, then labels only found in parts, unique', () => {
    const song: Song = {
      meta: { title: '' },
      chart: [
        { kind: 'verse', label: 'A', lines: [] },
        { kind: '', label: '', lines: [] },
        { kind: 'chorus', label: '', lines: [] },
        { kind: 'chorus', label: 'サビ', lines: [] },
        { kind: 'verse', label: 'A', lines: [] },
      ],
      parts: [
        {
          name: 'Gt',
          body: '\\section "Intro"\nC4 |\n\\section "A" "Verse"\n\\section Outro',
        },
        {
          name: 'Ba',
          body: '\\section "サビ"\n\\section "Intro"\n\\section "Intro"',
        },
      ],
    };
    expect(sectionLabels(song)).toEqual([
      { label: 'A', inChart: true, parts: ['Gt'] },
      { label: 'サビ', inChart: true, parts: ['Ba'] },
      { label: 'Intro', inChart: false, parts: ['Gt', 'Ba'] },
      { label: 'Outro', inChart: false, parts: ['Gt'] },
    ]);
  });

  it('matches by exact name only', () => {
    const song: Song = {
      meta: { title: '' },
      chart: [{ kind: 'verse', label: 'A', lines: [] }],
      parts: [{ name: 'P', body: '\\section "a"' }],
    };
    expect(sectionLabels(song)).toEqual([
      { label: 'A', inChart: true, parts: [] },
      { label: 'a', inChart: false, parts: ['P'] },
    ]);
  });

  it('ignores markers in alphaTex line comments', () => {
    const song: Song = {
      meta: { title: '' },
      chart: [],
      parts: [{ name: 'P', body: '// \\section "X"\n\\section "Y"' }],
    };
    expect(sectionLabels(song).map((s) => s.label)).toEqual(['Y']);
  });
});
