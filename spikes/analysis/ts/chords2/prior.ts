/**
 * Transition prior over the expanded state space (plan §2.2, note §1.4). v1a's TheoryPrior (read only) computes
 * the tiers from the 11 v1a qualities; a new quality borrows the row and column of its family (vocab.FAMILY_OF) by
 * being passed to it under that quality's name. Only sus2 ("the stronger of maj and min") needs two priors: its
 * entries are the elementwise max of a prior that reads sus2 as maj and one that reads it as min.
 */
import type { PriorRows } from '../dsp/chords';
import type { MemTracker } from '../dsp/core/mem';
import { TheoryPrior } from '../dsp/harmony';
import type { BarKey } from '../dsp/keytrack';
import type { ChordState } from '../dsp/vocab';
import { familyOf } from './vocab';

export class FamilyPrior implements PriorRows {
  readonly rows: number;
  private readonly primary: TheoryPrior;
  private readonly alts: TheoryPrior[];
  private readonly multi: Uint8Array; // 1 = the state has several family qualities
  private readonly k: number;
  private readonly buf: Float64Array;
  private anyMulti = false;

  constructor(states: readonly ChordState[], barKeys: readonly BarKey[], barOfBeat: ArrayLike<number>, strength: number, mem?: MemTracker) {
    this.k = states.length;
    this.rows = barOfBeat.length;
    const pick = (i: number) => (s: ChordState): ChordState => ({ root: s.root, quality: familyOf(s.quality)[i] ?? familyOf(s.quality)[0] });
    this.primary = new TheoryPrior(states.map(pick(0)), barKeys, barOfBeat, strength, { mem });
    this.multi = Uint8Array.from(states, (s) => (familyOf(s.quality).length > 1 ? 1 : 0));
    this.anyMulti = this.multi.some(Boolean);
    this.alts = [];
    const maxFam = Math.max(...states.map((s) => familyOf(s.quality).length));
    for (let i = 1; i < maxFam; i++) this.alts.push(new TheoryPrior(states.map(pick(i)), barKeys, barOfBeat, strength, { mem }));
    this.buf = new Float64Array(this.anyMulti ? this.k * this.k : 0);
  }

  isZero(): boolean {
    return this.primary.isZero();
  }

  row(t: number): ArrayLike<number> {
    const a = this.primary.row(t);
    if (!this.anyMulti || this.primary.isZero()) return a;
    const k = this.k;
    this.buf.set(a);
    for (const alt of this.alts) {
      const b = alt.row(t);
      for (let i = 0; i < k; i++) {
        const mi = this.multi[i];
        for (let j = 0; j < k; j++) {
          if (!mi && !this.multi[j]) continue;
          const p = i * k + j;
          if (b[p] > this.buf[p]) this.buf[p] = b[p];
        }
      }
    }
    return this.buf;
  }
}
