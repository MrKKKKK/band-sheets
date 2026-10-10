import { describe, expect, it } from 'vitest';
import { chartOrder } from './melodyEditor';
import { parseSong } from './parseSong';

const song = parseSong(`{title: t}

{start_of_verse: A}
[C]きらきら[F]ひか[C]る
# comment

[F]おそら[C]の[G]ほし[C]よ
[C]
{end_of_verse}

{start_of_chorus: B}
みんなの
{end_of_chorus}
`);

describe('chartOrder', () => {
  it('lists non-empty chart labels in order', () => {
    expect(chartOrder(song)).toEqual(['A', 'B']);
  });
});
