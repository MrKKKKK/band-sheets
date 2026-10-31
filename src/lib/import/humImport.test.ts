import { validateHumInfo } from '../analysis/hum/analyze';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_STAGES } from '../../analysis/types';
import { sampleSong } from '../fixtures/sampleSong';
import type { MelodyEvent, TimeSig } from '../melody';
import { readSection } from '../melodyPart';
import { barBeatAt, eventStarts, positionLabel } from '../melodyPosition';
import { parseSong } from '../parseSong';
import { serializeSong } from '../serializeSong';
import type { HumNoteCandidates } from './humDraft';
import {
  beatsLabel,
  shiftLabel,
  firstNoteAt,
  firstNoteTick,
  HUM_STEPS,
  humRunInfo,
  humRunInfoAtBar1,
  humTargets,
  insertHumDraft,
  labelledEvents,
  notePlaceLabel,
  octaveLabel,
  semitoneLabel,
} from './humImport';

const T44: TimeSig = { num: 4, den: 4 };
const T68: TimeSig = { num: 6, den: 8 };
const note = (pitch: string, ticks: number): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks,
});
const rest = (ticks: number): MelodyEvent => ({ kind: 'rest', ticks });

describe('HUM_STEPS', () => {
  it('covers the hum stages in order', () => {
    expect(HUM_STEPS.flatMap((s) => s.stages)).toEqual([
      ...ANALYSIS_STAGES.hum,
    ]);
  });
});

describe('firstNoteTick / humRunInfo', () => {
  it('counts bars and beats of the time signature from bar 1 beat 1', () => {
    expect(firstNoteTick(1, 1, T44)).toBe(0);
    expect(firstNoteTick(1, 4, T44)).toBe(48);
    expect(firstNoteTick(2, 1, T44)).toBe(64);
    expect(firstNoteTick(2, 2, T68)).toBe(48 + 8);
  });

  it('builds the Worker input: bpm in the beat of the time signature, the bar position, key only when set', () => {
    expect(
      humRunInfo({ tempo: 96, ts: T44, key: 'G', bar: 1, beat: 4 }),
    ).toEqual({
      bpm: 96,
      ts: [4, 4],
      firstNoteSec: 0,
      firstNoteTick: 48,
      key: 'G',
    });
    // 6/8: the analyzer counts eighths, {tempo} quarters
    expect(humRunInfo({ tempo: 60, ts: T68, bar: 1, beat: 1 })).toEqual({
      bpm: 120,
      ts: [6, 8],
      firstNoteSec: 0,
      firstNoteTick: 0,
    });
  });
});

describe('humRunInfoAtBar1', () => {
  it('sends only bpm, ts, key and startSec, and passes validateHumInfo', () => {
    const info = humRunInfoAtBar1({
      tempo: 96,
      ts: T44,
      key: 'G',
      bar1Sec: 2.5,
    });
    expect(info).toEqual({ bpm: 96, ts: [4, 4], startSec: 2.5, key: 'G' });
    expect(() => validateHumInfo(info)).not.toThrow();
  });

  it('counts the 6/8 bpm in eighths and omits an unset key', () => {
    const info = humRunInfoAtBar1({ tempo: 60, ts: T68, bar1Sec: 0 });
    expect(info).toEqual({ bpm: 120, ts: [6, 8], startSec: 0 });
    expect('key' in info).toBe(false);
    expect(() => validateHumInfo(info)).not.toThrow();
  });

  it('never carries firstNoteSec / firstNoteTick, whatever bar the singing starts at', () => {
    const setup = { tempo: 100, ts: T44, bar1Sec: 2.4, bar: 3, beat: 2 };
    const info = humRunInfoAtBar1(setup);
    expect(info.firstNoteSec).toBeUndefined();
    expect(info.firstNoteTick).toBeUndefined();
    expect(info.startSec).toBe(2.4);
    expect(() => validateHumInfo(info)).not.toThrow();
  });
});

describe('humTargets', () => {
  it('lists every section with its notes and bars, read-only ones not writable', () => {
    const song = parseSong(
      serializeSong({
        ...sampleSong,
        parts: sampleSong.parts.map((p) =>
          p.name === 'Vocal'
            ? { ...p, body: `${p.body}\n\\section "C"\n:4 (C4 E4) C4 C4 C4 |` }
            : p,
        ),
      }),
    );
    const vocal = song.parts.findIndex((p) => p.name === 'Vocal');
    expect(humTargets(song, vocal, T44)).toEqual([
      { label: 'A', writable: true, notes: 14, bars: 4 },
      { label: 'B', writable: true, notes: 14, bars: 4 },
      { label: 'C', writable: false, notes: 0, bars: 0 },
    ]);
  });

  it('without a melody part every section is writable and empty', () => {
    expect(humTargets(sampleSong, -1, T44)).toEqual([
      { label: 'A', writable: true, notes: 0, bars: 0 },
      { label: 'B', writable: true, notes: 0, bars: 0 },
    ]);
  });
});

describe('insertHumDraft', () => {
  const draft = [
    rest(16),
    note('E4', 16),
    note('G4', 32),
    note('C5', 64),
    rest(64),
  ];

  it('replaces the section in one song and reads back unchanged', () => {
    const vocal = sampleSong.parts.findIndex((p) => p.name === 'Vocal');
    const out = insertHumDraft(sampleSong, vocal, 'B', draft, T44);
    const reread = parseSong(serializeSong(out));
    const body = reread.parts[vocal].body;
    expect(readSection(body, 'B', T44)).toEqual({
      status: 'ok',
      events: draft,
    });
    // section A is untouched
    expect(readSection(body, 'A', T44)).toEqual(
      readSection(sampleSong.parts[vocal].body, 'A', T44),
    );
  });

  it('adds a Vocal part when the song has no melody part', () => {
    const noVocal = {
      ...sampleSong,
      parts: sampleSong.parts.filter((p) => p.name !== 'Vocal'),
    };
    const out = insertHumDraft(noVocal, -1, 'A', draft, T44);
    const vocal = out.parts.find((p) => p.name === 'Vocal');
    expect(vocal && readSection(vocal.body, 'A', T44)).toMatchObject({
      status: 'ok',
    });
  });

  it('throws the editor message for a read-only section', () => {
    const song = {
      ...sampleSong,
      parts: [{ name: 'Vocal', body: '\\section "A"\n:4 (C4 E4) C4 C4 C4 |' }],
    };
    expect(() => insertHumDraft(song, 0, 'A', draft, T44)).toThrow(
      /読み取り専用/,
    );
  });
});

describe('positions', () => {
  const evs = [
    rest(16),
    note('C4', 16),
    note('D4', 32),
    note('E4', 64),
    note('F4', 16),
  ];

  it('eventStarts / firstNoteAt use real positions, tuplet slots included', () => {
    expect(eventStarts(evs)).toEqual([0, 16, 32, 64, 128]);
    expect(firstNoteAt(evs)).toBe(16);
    expect(firstNoteAt([rest(64)])).toBeNull();
    const trip = [
      {
        kind: 'note' as const,
        pitch: 'C4',
        ticks: 8,
        tuplet: { n: 3, slot: 0 },
      },
      {
        kind: 'note' as const,
        pitch: 'D4',
        ticks: 8,
        tuplet: { n: 3, slot: 1 },
      },
      {
        kind: 'note' as const,
        pitch: 'E4',
        ticks: 8,
        tuplet: { n: 3, slot: 2 },
      },
      note('F4', 16),
    ];
    expect(eventStarts(trip)).toEqual([0, 16 / 3, 32 / 3, 16]);
  });

  it('barBeatAt / positionLabel', () => {
    expect(barBeatAt(48, T44)).toEqual({ bar: 1, beat: 4, onBeat: true });
    expect(positionLabel(0, T44)).toBe('1 小節目の 1 拍目');
    expect(positionLabel(64 + 20, T44)).toBe('2 小節目の 2 拍目のすこし後');
  });

  it('notePlaceLabel counts the notes that start in the bar', () => {
    expect(notePlaceLabel(evs, 1, T44)).toBe('1 小節目の 1 つ目の音');
    expect(notePlaceLabel(evs, 2, T44)).toBe('1 小節目の 2 つ目の音');
    expect(notePlaceLabel(evs, 3, T44)).toBe('2 小節目の 1 つ目の音');
    expect(notePlaceLabel(evs, 4, T44)).toBe('3 小節目の 1 つ目の音');
  });
});

describe('labels', () => {
  it('semitoneLabel', () => {
    expect(semitoneLabel(0)).toBe('元の高さ');
    expect(semitoneLabel(1)).toBe('半音上');
    expect(semitoneLabel(-3)).toBe('3 半音下');
  });

  it('beatsLabel in the beat of the time signature', () => {
    expect(beatsLabel(16, T44)).toBe('1 拍');
    expect(beatsLabel(8, T44)).toBe('半拍');
    expect(beatsLabel(24, T44)).toBe('1 拍半');
    expect(beatsLabel(4, T44)).toBe('1/4 拍');
    expect(beatsLabel(12, T44)).toBe('3/4 拍');
    expect(beatsLabel(20, T44)).toBe('1 拍と 1/4');
    expect(beatsLabel(64, T44)).toBe('4 拍');
    expect(beatsLabel(8, T68)).toBe('1 拍');
  });

  it('shiftLabel: beats and 16ths', () => {
    expect(shiftLabel(0, T44)).toBe('なし');
    expect(shiftLabel(16, T44)).toBe('1 拍後');
    expect(shiftLabel(-4, T44)).toBe('16 分 1 つ前');
    expect(shiftLabel(8, T44)).toBe('16 分 2 つ後');
    expect(shiftLabel(20, T44)).toBe('1 拍と 16 分 1 つ後');
    expect(shiftLabel(-4, T68)).toBe('16 分 1 つ前');
    expect(shiftLabel(8, T68)).toBe('1 拍後');
  });

  it('octaveLabel', () => {
    expect(octaveLabel(0)).toBe('そのまま');
    expect(octaveLabel(1)).toBe('1 オクターブ上');
    expect(octaveLabel(-2)).toBe('2 オクターブ下');
  });

  it('labelledEvents puts the name and 「?」 under the notes, display only', () => {
    const evs = [note('C4', 16), rest(16), note('G4', 32)];
    const cands = [
      { low: false } as HumNoteCandidates,
      null,
      { low: true } as HumNoteCandidates,
    ];
    expect(labelledEvents(evs, cands, 'doremi')).toEqual([
      { ...evs[0], lyric: 'ド' },
      evs[1],
      { ...evs[2], lyric: 'ソ?' },
    ]);
    expect(labelledEvents(evs, cands, 'none')).toEqual([
      evs[0],
      evs[1],
      { ...evs[2], lyric: '?' },
    ]);
    expect(evs[0].lyric).toBeUndefined();
  });
});
