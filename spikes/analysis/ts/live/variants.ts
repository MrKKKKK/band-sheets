/**
 * LT1 of the live chord-check tool (docs/live-chord-tool-plan.md section 2): the six named logic variants, each a fixed
 * existing config. No value knobs (tuning values by ear would break "values are chosen on the tuning split only").
 * `core.ts analyzeWindow` runs one of them on one window. Labels and notes are the page's Japanese texts.
 */
import { DEFAULT_D2_VALUES, resolveChords2Config, T10_V1_OVERRIDES, T7_E1_D2_VALUES, T7C_E1_CANDIDATE_THETA, type Chords2Config } from '../chords2/config';

export type VariantId = 'v1a' | 'base' | 's7-V1' | 's8-D2' | 's8-D1' | 's8-cand';

/** What a variant runs: v1a's `estimateChords` (with or without spike 6's marks), or chords2 `analyze` + the marks. */
export type Logic = { kind: 'v1a'; marks: boolean } | { kind: 'chords2'; cfg: Chords2Config };

export interface Variant {
  id: VariantId;
  /** the picker's text */
  label: string;
  /** the honest note of plan section 2 (shown with the result) */
  note: string;
  /** null = unavailable (greyed out, `unavailable` says why) */
  logic: Logic | null;
  unavailable?: string;
}

/** s8-cand's config for a θ_c (thetaLow = T5's .3, denominator only; switchPenalty is fixed 0 by resolveChords2Config). */
export const candidateConfig = (theta: number): Chords2Config =>
  resolveChords2Config({ d2: { range: 'E1', theta, thetaLow: DEFAULT_D2_VALUES.thetaLow, output: 'candidate' } });

export const VARIANTS: readonly Variant[] = [
  {
    id: 'v1a',
    label: 'v1a（いまのアプリの和音）',
    note: '2 回目のパス（理論の重み）は無い。',
    logic: { kind: 'v1a', marks: false },
  },
  {
    id: 'base',
    label: 'base: v1a + ベース印',
    note: 'アプリが取る形。/X は転回だけ（ペダル・経過・クリシェ・行末の 6 度は前後の区間が要る）。',
    logic: { kind: 'v1a', marks: true },
  },
  {
    id: 's7-V1',
    label: 's7-V1: 語彙 V1（156 状態）',
    note: '不採用（スパイク 7 G3）。状態の数が違うので、% の大小を他の行と比べない。',
    logic: { kind: 'chords2', cfg: resolveChords2Config(T10_V1_OVERRIDES) },
  },
  {
    id: 's8-D2',
    label: 's8-D2: 三和音のあと足す音（E1）',
    note: '不採用。1 窓では 2 状態のならし（switchPenalty）が効かず、ρ ≥ θ の判定だけ。',
    logic: { kind: 'chords2', cfg: resolveChords2Config({ d2: { range: 'E1', ...T7_E1_D2_VALUES } }) },
  },
  {
    id: 's8-D1',
    label: 's8-D1: F1 のクロマで採点',
    note: '不採用。F1 の床（ファイルの中央値 × floorRatio）が窓の中の自分自身との比になり、静かな窓でも音を拾う。クロマが違うので、% の大小を他の行と比べない。',
    logic: { kind: 'chords2', cfg: resolveChords2Config({ octaveChroma: true }) },
  },
  {
    id: 's8-cand',
    label: 's8-cand: 足す音は候補だけ',
    note: '不採用・持ち越し。',
    ...(T7C_E1_CANDIDATE_THETA === null
      ? {
          logic: null,
          unavailable:
            'θ_c（T7C_E1_CANDIDATE_THETA）がまだ決まっていない（null）。T7c が調整用で選んだ .5 は docs/audio-spike8-t7c.md にあるが、定数には入っていない。',
        }
      : { logic: { kind: 'chords2', cfg: candidateConfig(T7C_E1_CANDIDATE_THETA) } as Logic }),
  },
];

export function variantById(id: VariantId): Variant {
  const v = VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error(`live: unknown variant ${JSON.stringify(id)}`);
  return v;
}

