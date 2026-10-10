import { describe, expect, it } from 'vitest';
import type { DrumEvent, DrumHit } from './drum';
import {
  announcement,
  beatLabel,
  describeBeat,
  durationLabel,
  hitsLabel,
  instrumentLabel,
  rejectionMessage,
  shuffleMessage,
  stateChangeMessage,
  toggleOnPreviousMessage,
  tupletInsertedMessage,
  tupletRemovedMessage,
  tupletSlotLabel,
} from './drumLabels';
import { durationTicks } from './melody';

const hit = (inst: DrumHit['inst'], extra: Partial<DrumHit> = {}): DrumHit => ({
  inst,
  ...extra,
});

describe('instrumentLabel', () => {
  it('plain hit is just the Japanese name', () => {
    expect(instrumentLabel(hit('BD'))).toBe('バスドラム');
    expect(instrumentLabel(hit('HH'))).toBe('ハイハット（クローズ）');
  });

  it('ghost / accent / heavy accent are suffixed in parens', () => {
    expect(instrumentLabel(hit('SD', { ghost: true }))).toBe(
      'スネア（ゴースト）',
    );
    expect(instrumentLabel(hit('CR', { accent: 'normal' }))).toBe(
      'クラッシュ（アクセント）',
    );
    expect(instrumentLabel(hit('CR', { accent: 'heavy' }))).toBe(
      'クラッシュ（強いアクセント）',
    );
  });
});

describe('hitsLabel', () => {
  it('empty hits is 休符', () => {
    expect(hitsLabel([])).toBe('休符');
  });

  it('single hit is its instrument label', () => {
    expect(hitsLabel([hit('SD', { ghost: true })])).toBe('スネア（ゴースト）');
  });

  it('multiple hits are joined with ＋ in staff order regardless of input order', () => {
    expect(hitsLabel([hit('BD'), hit('HH')])).toBe(
      'ハイハット（クローズ）＋バスドラム',
    );
  });
});

describe('durationLabel', () => {
  it('plain values', () => {
    expect(durationLabel(durationTicks('8', false))).toBe('8分');
    expect(durationLabel(durationTicks('1', false))).toBe('全');
    expect(durationLabel(durationTicks('16', false))).toBe('16分');
  });

  it('dotted values', () => {
    expect(durationLabel(durationTicks('4', true))).toBe('付点4分');
  });

  it('falls back to the raw ticks for a value that is not a plain duration', () => {
    expect(durationLabel(5)).toBe('5');
  });
});

describe('tupletSlotLabel', () => {
  it('describes n and the 1-based slot', () => {
    expect(tupletSlotLabel({ n: 3, slot: 1 })).toBe('3連の 2 つ目');
    expect(tupletSlotLabel({ n: 6, slot: 0 })).toBe('6連の 1 つ目');
    expect(tupletSlotLabel({ n: 6, slot: 5 })).toBe('6連の 6 つ目');
  });
});

describe('beatLabel', () => {
  it('rest', () => {
    const ev: DrumEvent = { hits: [], ticks: durationTicks('4', true) };
    expect(beatLabel(ev)).toBe('付点4分 休符');
  });

  it('a struck beat', () => {
    const ev: DrumEvent = {
      hits: [hit('BD'), hit('HH')],
      ticks: durationTicks('8', false),
    };
    expect(beatLabel(ev)).toBe('8分 ハイハット（クローズ）＋バスドラム');
  });

  it('a tuplet slot uses the slot label instead of the duration', () => {
    const ev: DrumEvent = {
      hits: [hit('SD', { ghost: true })],
      ticks: durationTicks('16', false),
      tuplet: { n: 3, slot: 1 },
    };
    expect(beatLabel(ev)).toBe('3連の 2 つ目、スネア（ゴースト）');
  });

  it('a rest tuplet slot', () => {
    const ev: DrumEvent = {
      hits: [],
      ticks: durationTicks('16', false),
      tuplet: { n: 3, slot: 0 },
    };
    expect(beatLabel(ev)).toBe('3連の 1 つ目、休符');
  });
});

describe('describeBeat', () => {
  it('prefixes with the 1-based beat number', () => {
    const ev: DrumEvent = {
      hits: [hit('SD')],
      ticks: durationTicks('8', false),
    };
    expect(describeBeat(ev, 0)).toBe('1 番目: 8分 スネア');
    expect(describeBeat(ev, 3)).toBe('4 番目: 8分 スネア');
  });
});

describe('announcement', () => {
  const sd: DrumEvent = { hits: [hit('SD')], ticks: durationTicks('8', false) };
  const bd: DrumEvent = { hits: [hit('BD')], ticks: durationTicks('8', false) };
  const events = [sd, bd];

  it('no events', () => {
    expect(announcement([], 0, null)).toBe('拍なし');
  });

  it('cursor at the very start', () => {
    expect(announcement(events, 0, null)).toBe('先頭');
  });

  it('cursor describes the beat just before it', () => {
    expect(announcement(events, 1, null)).toBe('1 番目: 8分 スネア');
    expect(announcement(events, 2, null)).toBe('2 番目: 8分 バスドラム');
  });

  it('a selection takes priority and is marked 選択中', () => {
    expect(announcement(events, 0, 1)).toBe('選択中 2 番目: 8分 バスドラム');
  });

  it('a stale selection index is ignored', () => {
    expect(announcement(events, 1, 5)).toBe('1 番目: 8分 スネア');
  });
});

describe('stateChangeMessage', () => {
  const base = { duration: '4', dotted: false } as const;

  it('duration changed', () => {
    expect(stateChangeMessage(base, { ...base, duration: '8' })).toBe('8分');
  });

  it('dot toggled on / off', () => {
    expect(stateChangeMessage(base, { ...base, dotted: true })).toBe(
      '付点あり',
    );
    expect(
      stateChangeMessage({ ...base, dotted: true }, { ...base, dotted: false }),
    ).toBe('付点なし');
  });

  it('duration and dot together report the combined duration label', () => {
    expect(
      stateChangeMessage(base, { ...base, duration: '2', dotted: true }),
    ).toBe('付点2分');
  });

  it('null when nothing changed', () => {
    expect(stateChangeMessage(base, { ...base })).toBeNull();
  });
});

describe('shuffleMessage', () => {
  it('none / 8 / 16', () => {
    expect(shuffleMessage('none')).toBe('シャッフルなし');
    expect(shuffleMessage('8')).toBe('シャッフル 8分');
    expect(shuffleMessage('16')).toBe('シャッフル 16分');
  });
});

describe('tupletInsertedMessage / tupletRemovedMessage', () => {
  it('inserted names the count', () => {
    expect(tupletInsertedMessage(3)).toBe('3連符を挿入しました');
    expect(tupletInsertedMessage(13)).toBe('13連符を挿入しました');
  });

  it('removed has no count', () => {
    expect(tupletRemovedMessage()).toBe('連符を削除しました');
  });
});

describe('toggleOnPreviousMessage', () => {
  it('added', () => {
    const before: DrumEvent = { hits: [], ticks: durationTicks('8', false) };
    const after: DrumEvent = {
      hits: [hit('BD')],
      ticks: durationTicks('8', false),
    };
    expect(toggleOnPreviousMessage('BD', before, after)).toBe(
      'バスドラムを追加しました',
    );
  });

  it('removed', () => {
    const before: DrumEvent = {
      hits: [hit('BD')],
      ticks: durationTicks('8', false),
    };
    const after: DrumEvent = { hits: [], ticks: durationTicks('8', false) };
    expect(toggleOnPreviousMessage('BD', before, after)).toBe(
      'バスドラムを外しました',
    );
  });
});

describe('rejectionMessage', () => {
  it('passes a rejection reason through unchanged', () => {
    expect(rejectionMessage('連符の中の音価は変えられません')).toBe(
      '連符の中の音価は変えられません',
    );
  });

  it('null when the command was not rejected', () => {
    expect(rejectionMessage(undefined)).toBeNull();
  });
});
