/**
 * T4 parity: STFT, HPSS and onset strength against the Python dumps (py/tools/dump_stages.py)
 * in out/parity/<variant>/, with the plan section 4 tolerances (= librosa notes section 15).
 * Each stage gets the PYTHON input of that stage (y for STFT / HPSS, y_perc for onset).
 * The dumps are gitignored: without them (CI) every case is skipped.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { correlation, maxErrorOverPeak, signalToErrorDb } from '../parity/compare';
import { readMeta, readStage } from '../parity/stageFile';
import { hpss, onsetStrength } from './audio';
import { MemTracker } from './core/mem';
import { stft } from './core/stft';

const PARITY = join(import.meta.dirname, '../../out/parity');
const VARIANTS: [level: string, name: string][] = [
  ['L0', 'full-t116-straight'],
  ['L2', 'full-t116-straight-drift'],
  ['LR', 'piano-t124-straight-rec'],
];

const MB = (b: number) => (b / 2 ** 20).toFixed(1);

for (const [level, name] of VARIANTS) {
  const dir = join(PARITY, name);
  const present = existsSync(join(dir, 'meta.json'));
  const label = present ? `${level} ${name}` : `${level} ${name} (SKIPPED: no dumps in out/parity)`;

  describe.skipIf(!present)(`audio parity ${label}`, () => {
    const meta = present ? readMeta(dir) : { stages: {} };
    const stage = (s: string) => readStage(dir, s, meta);

    it('STFT: ||diff|| / ||X|| <= 1e-6, per frame max|diff| <= 1e-5 max|X|', () => {
      const y = stage('y').data;
      const pre = stage('stft_re');
      const pim = stage('stft_im').data;
      const [B, F] = pre.shape;
      const s = stft(y);
      expect([s.bins, s.frames]).toEqual([B, F]);
      let num = 0;
      let den = 0;
      let worstFrame = 0;
      for (let t = 0; t < F; t++) {
        let mx = 0;
        let md = 0;
        for (let b = 0; b < B; b++) {
          const er = pre.data[b * F + t];
          const ei = pim[b * F + t];
          const dr = s.re[t * B + b] - er;
          const di = s.im[t * B + b] - ei;
          num += dr * dr + di * di;
          den += er * er + ei * ei;
          mx = Math.max(mx, Math.hypot(er, ei));
          md = Math.max(md, Math.hypot(dr, di));
        }
        const r = mx === 0 ? (md === 0 ? 0 : Infinity) : md / mx;
        worstFrame = Math.max(worstFrame, r);
      }
      const rel = Math.sqrt(num / den);
      console.log(`[T4 parity] ${level} STFT relNorm=${rel.toExponential(2)} worstFrame=${worstFrame.toExponential(2)}`);
      expect(rel).toBeLessThanOrEqual(1e-6);
      expect(worstFrame).toBeLessThanOrEqual(1e-5);
    });

    it('HPSS: y_harm / y_perc SER >= 60 dB (target 80 recorded), masked magnitudes, sum vs y', () => {
      const y = stage('y').data;
      const mem = new MemTracker();
      const r = hpss(y, mem, { keepMaskedMagnitudes: true });
      const harm = signalToErrorDb(r.yHarm, stage('y_harm').data);
      const perc = signalToErrorDb(r.yPerc, stage('y_perc').data);
      const hm = stage('hpss_harm_mag');
      const pm = stage('hpss_perc_mag').data;
      const [B, F] = hm.shape;
      const tH = new Float32Array(B * F);
      const tP = new Float32Array(B * F);
      for (let t = 0; t < F; t++) {
        for (let b = 0; b < B; b++) {
          tH[b * F + t] = r.harmMag![t * B + b];
          tP[b * F + t] = r.percMag![t * B + b];
        }
      }
      const magH = signalToErrorDb(tH, hm.data);
      const magP = signalToErrorDb(tP, pm);
      const sum = Float32Array.from(r.yHarm, (v, i) => v + r.yPerc[i]);
      const sumVsY = signalToErrorDb(sum, y);
      const pyH = stage('y_harm').data;
      const pyP = stage('y_perc').data;
      const pySum = pyH.map((v, i) => v + pyP[i]);
      const pySumVsY = signalToErrorDb(pySum, y);
      // memory excluding the parity-only magnitude copies
      const peakNoCopies = mem.peak - 2 * B * F * 4;
      console.log(
        `[T4 parity] ${level} HPSS y_harm=${harm.toFixed(1)}dB y_perc=${perc.toFixed(1)}dB ` +
          `harmMag=${magH.toFixed(1)}dB percMag=${magP.toFixed(1)}dB sumVsY TS=${sumVsY.toFixed(1)}dB ` +
          `Py=${pySumVsY.toFixed(1)}dB | n=${y.length} F=${F} peak=${MB(peakNoCopies)}MB (w/o parity copies)`,
      );
      expect(harm).toBeGreaterThanOrEqual(60);
      expect(perc).toBeGreaterThanOrEqual(60);
    });

    it('onset strength (Python y_perc in): corr >= .99999, max|diff| <= 1e-3 max env', () => {
      const yp = stage('y_perc').data;
      const exp = stage('onset_env').data;
      const mem = new MemTracker();
      const env = onsetStrength(yp, mem);
      expect(env.length).toBe(exp.length);
      const corr = correlation(env, exp);
      const err = maxErrorOverPeak(env, exp);
      console.log(
        `[T4 parity] ${level} onset corr=${corr.toFixed(9)} maxErr/peak=${err.toExponential(2)} peak=${MB(mem.peak)}MB`,
      );
      expect(corr).toBeGreaterThanOrEqual(0.99999);
      expect(err).toBeLessThanOrEqual(1e-3);
    });
  });
}
