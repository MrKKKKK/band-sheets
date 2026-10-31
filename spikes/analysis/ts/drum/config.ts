/**
 * Spike 5 T0: drum analyzer config (docs/audio-spike5-plan.md sections 2, 5, 6 decision 2).
 *
 * PROVISIONAL values: the shape is fixed here (T0), the values are set by T5-T7 and tuned in T10-T12 on the
 * synthetic tuning split only (reason for each change goes in a comment at the value). Only values the plan's tasks
 * refer to are listed (YAGNI): onset detection (T5), bands (T5), classify / NMF / refit / HPSS switches (T6), toms and
 * cymbals (T11), strength (T7), grid / swing (T7), scoring tolerance (T3).
 * configHash() = SHA-256 (first 12 hex) over the canonical JSON (sorted keys, compact; same helpers as ts/dsp/config.ts
 * and ts/hum/config.ts), so key order never changes the hash. Keep numbers in a form pyCanonicalJson writes stably.
 */
import { pyCanonicalJson, sha256Hex } from '../dsp/config';

export interface DrumConfig {
  name: string;
  /** Analysis sample rate (plan section 2: 22050, or 44100 for the high bands; T5 decides). */
  audio: { sr: number };
  onset: {
    /** STFT window and hop in samples. */
    win: number;
    hop: number;
    /** Log compression of the band magnitudes: log(1 + gamma * mag). */
    logGamma: number;
    /** Flux difference lag (frames) and frequency maximum filter half-width (bins) of the previous frame (T5, SuperFlux). */
    lag: number;
    maxBins: number;
    /** Centred moving average of the band flux before peak picking (frames, odd; 1 = none) (T5). */
    smoothFrames: number;
    /** Per-recording threshold: median of the onset function + this many MADs (T5). */
    thresholdMads: number;
    /** Local-max picking window (ms) and minimum distance between hits of one band (ms). */
    peakWindowMs: number;
    minDistanceMs: number;
    /** Local threshold: localMult * mean of the band flux over +-localMs (T5). */
    localMs: number;
    localMult: number;
    /** Threshold floor: at least this share of the band flux's 99th percentile (T5). */
    relFloor: number;
    /** Band peaks within this (ms, from the group's first peak) are one onset (T5). */
    mergeMs: number;
    /** Time refinement (onset.ts refineOnset): search radius, envelope block, rise length in blocks, minimum rise, level. */
    refineRadiusMs: number;
    refineBlockMs: number;
    refineRiseBlocks: number;
    refineMinRiseDb: number;
    refineRelDb: number;
    /** Corner (Hz) of the refinement envelope's first-order pre-emphasis, so it does not depend on audio.sr. */
    refinePreEmphHz: number;
    /** Per-band energy feature: max band power over this long after the onset frame (ms). */
    featureMs: number;
  };
  bands: {
    /** Band edges in Hz: low (BD), mid (SD body / noise), high (HH, cymbals). */
    edgesHz: number[];
  };
  classify: {
    /** Switches tried in order by T6 (each gets its own table; classify.ts explains each step). */
    nmf: boolean;
    refit: boolean;
    hpss: boolean;
    nmfIterations: number;
    /** Number of 2nd-candidate instruments kept per hit (plan decision 5). */
    candidatesMax: number;
    /** Band rules (nmf off): onset flux / band threshold of T5 at least rule{Low,Mid,High}; SD needs mid / low flux ratio, HH high / mid. */
    ruleLow: number;
    ruleMid: number;
    ruleHigh: number;
    ruleMidOverLow: number;
    ruleHighOverMid: number;
    /** Onset spectrum (NMF input, also the templates): STFT win / hop, mel bands over [fminHz, fmaxHz] of |X|. */
    win: number;
    hop: number;
    melBands: number;
    fminHz: number;
    fmaxHz: number;
    /** Observation = max(0, mean of postCount frames from onset frame + postFrom - frame (onset - preFrames)) (removes ringing). */
    preFrames: number;
    postFrom: number;
    postCount: number;
    /** NMF divergence: 1 = KL, 2 = Euclidean (multiplicative updates of the activations only, templates fixed). */
    nmfBeta: number;
    /** Absorber templates whose activations are never output: RD CR toms (nmfOthers), CB SD.xs (nmfExt), RD.bell SP CN (nmfExtCymbals). */
    nmfOthers: boolean;
    nmfExt: boolean;
    nmfExtCymbals: boolean;
    /** Metal split (classify.ts step 2b): fast decay (>= hhMinDecayDbPerSec above decayFminHz, measured over decayMinMs..decayMaxMs) -> metal absorbers count for HH. */
    metalDecay: boolean;
    hhMinDecayDbPerSec: number;
    /** Take test of the metal split (classify.ts metalTakeIsHh): share of the metal-dominated onsets that must decay fast (0 = always split). */
    metalTakeFastMin: number;
    /** classify.ts step 2d: rounds of per-take channel equalisation of the templates (0 = off), gain limited to +-eqMaxDb. */
    eqRounds: number;
    eqMaxDb: number;
    decayFminHz: number;
    decayMinMs: number;
    decayMaxMs: number;
    /** Decision: class share of the activations >= shareMin[BD, SD, HH] and level >= levelMinDb re the take's reference. */
    shareMin: number[];
    levelMinDb: number;
    /** Take reference of a class: this quantile of its activation over the onsets it dominates (refMinHits needed). */
    refQuantile: number;
    refMinHits: number;
    /** Refit: confident single-class onsets (share >= refitShare, >= refitMinHits of them) give one more template column per class. */
    refitShare: number;
    refitMinHits: number;
    /** HPSS on the mel spectrogram: harmonic = median over hpssTimeFrames frames, percussive = median over hpssFreqBins bands; soft mask power 2. */
    hpssTimeFrames: number;
    hpssFreqBins: number;
    /**
     * T10 per-take adaptation (classify.ts step 5): adaptIterations rounds of "seeds (present, share >= adaptShare; HH
     * seeds fast-decaying; band gates) -> mean of their class parts per class (>= adaptMinHits seeds; not when within
     * adaptKeepCos of a kit column), kept only in the centroid order BD < SD < HH -> replace the class's kit columns -> NMF again".
     */
    adapt: boolean;
    adaptIterations: number;
    adaptShare: number;
    adaptMinHits: number;
    /** No adaptation of a class whose seeds' mean part is within this cosine of one of its kit columns (the kit is known). */
    adaptKeepCos: number;
    /** Seed band gates: BD part >= adaptLowMin of its mass below adaptLowHz, HH part >= adaptHighMin at or above adaptHighHz, SD neither. */
    adaptLowHz: number;
    adaptLowMin: number;
    adaptHighHz: number;
    adaptHighMin: number;
    /** T11: an HH seed's part keeps (does not subtract) the BD / SD fit when that class's share is below this (0 = subtract all). */
    adaptSubMin: number;
  };
  toms: {
    /**
     * S-9 (T11, toms.ts): a tom is present when the tom template columns (T1 T2 FT) hold >= shareMin of the onset's
     * activations at >= levelMinDb re the take's tom reference; then SD is kept only with share >= sdKeepShare.
     * Names: pitch of the [pitchMinHz, pitchMaxHz] peak of a winSec window delaySec after the onset, split into at most
     * `groups` groups at log2 gaps >= minGapOct.
     */
    groups: number;
    shareMin: number;
    levelMinDb: number;
    /** No toms in a take where the tom onsets would exceed this share of its onsets with SD or a tom (classify.ts s9Hits). */
    maxTakeShare: number;
    sdKeepShare: number;
    delaySec: number;
    winSec: number;
    pitchMinHz: number;
    pitchMaxHz: number;
    /** A peak near half the largest one's frequency with >= subRatio of its magnitude is taken instead (octave error). */
    subRatio: number;
    minGapOct: number;
    /**
     * T11b per-take tom templates (classify.ts step 6, S-9 only): seeds by toms.ts tomSeeds (sub = power share below
     * adaptSubHz of 20 Hz .. adaptLowTopHz, high = share at or above adaptLowTopHz up to 10 kHz, body = share in adaptSubHz .. pitchMaxHz >= adaptBodyMin; pitch below adaptPitchRatio
     * x the take's SD pitch; not an S-3 BD with share >= adaptBdMax; >= adaptMinHits). Seed observations grouped by pitch
     * (groups / minGapOct) -> one column per group replacing the kit's tom columns, unless any group mean is within
     * cosine adaptKeepCos of a kit tom column (a known kit). On a tom onset BD is kept only with S-9 share >= bdKeepShare.
     */
    adapt: boolean;
    adaptSubHz: number;
    adaptLowTopHz: number;
    adaptSubMax: number;
    adaptHighMax: number;
    adaptBodyMin: number;
    adaptPitchRatio: number;
    adaptBdMax: number;
    adaptMinHits: number;
    adaptKeepCos: number;
    bdKeepShare: number;
    /** Pitch re the take's snare pitch typical of T1 / T2 / FT (toms.ts ratioVote; names adapted columns when < 3 groups). */
    nameSdRatios: number[];
    /** With per-take tom columns for all `groups` toms, a tom onset is named by its largest tom column instead of its own pitch group. */
    nameByColumn: boolean;
  };
  cymbals: {
    /**
     * S-9 (T11, cymbals.ts): a metal piece is present on S-3 HH or when the cymbal absorbers hold >= shareMin at >=
     * levelMinDb. drop = dB of the >= fminHz energy dropFrames after its peak (dropMinFrames at least); fastDb / riseDb /
     * slowDb / crOverHh / voteDom / hoCos are the rules of cymbals.ts metalLabel; the closed-HH profile uses bands >=
     * profileFminHz and needs profileMinHits onsets.
     */
    shareMin: number;
    levelMinDb: number;
    fminHz: number;
    dropFrames: number;
    dropMinFrames: number;
    fastDb: number;
    riseDb: number;
    slowDb: number;
    crOverHh: number;
    voteDom: number;
    hoCos: number;
    profileFminHz: number;
    profileMinHits: number;
  };
  ext: {
    /**
     * S-ext (T12, ext.ts; read only at level S-ext): SP / CN on a non-blooming S-9 CR by template vote >= cymVote;
     * RD.bell on an S-9 RD by the RD.bell share of the metal activations >= bellVote, or on an S-9 RD / HH / HO by tonal >= bellTonal at
     * >= bellMinHz; CB by its share >= cbShare or tonal >= cbTonal at cbMinHz .. cbMaxHz with drop < cbMaxDropDb (an
     * S-9 HH / HO / RD on that onset removed when cbDropsMetal); SD.xs by its share >= xsShare (not on a CR). tonal =
     * peak / median magnitude over tonalMinHz .. tonalMaxHz of the tom window.
     */
    cymVote: number;
    bellVote: number;
    bellTonal: number;
    bellMinHz: number;
    cbShare: number;
    cbTonal: number;
    cbMinHz: number;
    cbMaxHz: number;
    cbMaxDropDb: number;
    cbDropsMetal: boolean;
    xsShare: number;
    /** Pedal HH: share of the foot template columns (0 = off). */
    footShare: number;
    tonalMinHz: number;
    tonalMaxHz: number;
  };
  strength: {
    /**
     * T7 (strength.ts): levels relative to the take, per instrument, in dB of the strength (treated as an amplitude).
     * ghost: below (refPercentile of the instrument's hits) + ghostDb. accent: at or above (normalPercentile of the
     * non-ghost hits) + accentDb. Instruments with fewer than minHits hits get no marks. (T0 had ghost / accent
     * percentiles; a fixed share would mark 20 % ghosts in a take without any, so T7 changed the keys.)
     */
    refPercentile: number;
    ghostDb: number;
    normalPercentile: number;
    accentDb: number;
    minHits: number;
  };
  grid: {
    /** Grid per whole note: 16 = 16th-note grid. */
    subdivision: number;
    /** 8th-note triplet grid per beat, chosen by the shuffle decision. */
    triplet: boolean;
    /** Remove the median onset offset first. */
    onsetBias: boolean;
    maxBiasSec: number;
  };
  swing: {
    /** A bar is swung when the median off-beat position ratio exceeds this (0.5 = straight, 0.667 = 2:1). */
    ratioMin: number;
    /** Minimum off-beat pairs in a bar to decide. */
    minPairs: number;
    /**
     * T7 (swing.ts): an off-beat sample is the only onset cluster of a beat pair (span) at a relative position in
     * [innerMin, innerMax); onsets closer than clusterFrac of the span are one cluster (simultaneous hits).
     */
    innerMin: number;
    innerMax: number;
    clusterFrac: number;
  };
  score: {
    /** Onset match tolerance (s): main (mir_eval default) and the tight one (synthetic only). Plan section 3 decision 4. */
    toleranceSec: number;
    tightSec: number;
  };
}

export const DRUM_CONFIG_GROUPS = ['audio', 'onset', 'bands', 'classify', 'toms', 'cymbals', 'ext', 'strength', 'grid', 'swing', 'score'] as const;

export const DEFAULT_DRUM_CONFIG: DrumConfig = deepFreeze({
  name: 'drum-v0',
  // T5 (tuning split only, out of sweeps; plan T5 report): 44100 = same onset F as 22050 (tuning mean F50 .9896 vs
  // .9841 with the top band capped at 10 kHz), keeps 10-16 kHz (the 16 kHz top edge raised D3 F50 .950 -> .970) and
  // skips the resample of 44.1 kHz input (Node: ~280 vs ~660 ms per audio minute). win / hop keep the 22050 time spans.
  audio: { sr: 44100 },
  onset: {
    win: 2048,
    hop: 512,
    logGamma: 10, // 100 let noise / reverb fluctuations count (D2 F50 .894 -> .981)
    lag: 2, // lag 1 without the max filter: D0 precision .68 (BD / tom decays fired the low band)
    maxBins: 1,
    smoothFrames: 3, // with the local threshold: D3 F50 .72 -> .92
    thresholdMads: 4, // 3 -> 4: D3 .952 -> .970; 5 was +.001 (kept 4 for ghost recall)
    peakWindowMs: 30,
    minDistanceMs: 30,
    localMs: 100,
    localMult: 1.5, // cymbal washes (ballad) fired the high band on D0
    relFloor: 0.1,
    mergeMs: 25,
    refineRadiusMs: 25, // 35: D3 p95 error 16 -> 23 ms
    refineBlockMs: 0.5,
    refineRiseBlocks: 4,
    refineMinRiseDb: 6,
    refineRelDb: -30, // the truth onset definition of render/drum/kits.ts
    refinePreEmphHz: 1500, // 180 -> 1500: D2 p95 error 10 -> 5 ms
    featureMs: 30,
  },
  bands: { edgesHz: [30, 250, 5000, 16000] },
  // T6 (tuning split only; per-switch tables in the T6 report): band rules all F50 .52 -> fixed-template NMF .91;
  // RD/CR/tom absorbers (nmfOthers) .87 -> .91; CB/SD.xs (nmfExt) + RD.bell/SP/CN (nmfExtCymbals) absorbers .94 -> .95
  // (cross-sticks / cowbells were SD / HH extras); HH.foot is no template (it absorbed real HH). refit off (D3 HH
  // .73 -> .67, the rest +-.01), hpss off (SD .92 -> .67: the snare's noise is masked as non-percussive).
  classify: {
    nmf: true,
    refit: false,
    hpss: false,
    nmfIterations: 100,
    candidatesMax: 1,
    // rules: only for the step-1 table (tuning all F50 .52; they cannot tell an SD's noise from a HH)
    ruleLow: 2,
    ruleMid: 2,
    ruleHigh: 2,
    ruleMidOverLow: 0.5,
    ruleHighOverMid: 1,
    win: 2048,
    hop: 512,
    melBands: 64, // 40 -> 64: all F50 .930 -> .935
    fminHz: 30,
    fmaxHz: 16000,
    preFrames: 3, // 2 -> 3: SD .908 -> .919 (1: .894)
    postFrom: 0,
    postCount: 3, // 2: .917, 4: .931
    nmfBeta: 1, // KL; Euclidean (2) HH .905 -> .816
    nmfOthers: true,
    nmfExt: true,
    nmfExtCymbals: true,
    // metal split: tuning all .951 -> .940 (thr 100) so off by the tuning rule; dev CHECK: all .762 -> .814 (kit B closed HH
    // looks like kit A's RD template: kit B D0 HH F50 .05 -> .53). Left for T10 / T11 (S-9 cymbals use decay anyway).
    metalDecay: false,
    hhMinDecayDbPerSec: 100, // tuning: 30 .913, 60 .938, 100 .940, 150 .941
    // T10: the take test keeps the known kit (tuning all .940 -> .950 at .5) but adds ~0 on leave-one-preset-out; metalDecay stays off
    metalTakeFastMin: 0,
    // T10 (tuning; leave-one-preset-out LOPO = templates of kit A program 16 / 24 / 25 on the tuning takes): classify-only
    // 1 round: known kit all .951 -> .954, LOPO 16 .903 -> .912, 24 .762 -> .775, 25 .763 -> .743; with adapt LOPO mean
    // .848 (adapt alone .850). OFF: end to end it lowers the known kit's D2 HH F .938 -> .900 (target .90; D3 all .805 -> .828).
    // eqMaxDb 10 = 20 (+-.001).
    eqRounds: 0,
    eqMaxDb: 20,
    decayFminHz: 5000,
    decayMinMs: 35,
    decayMaxMs: 300,
    shareMin: [0.1, 0.05, 0.05], // [.2 .2 .1] -> these: all .912 -> .930 (ghost SD under BD + HH has share < .05: lost)
    levelMinDb: -25, // -20 .. -50 within +-.005
    refQuantile: 0.9,
    refMinHits: 4,
    refitShare: 0.8,
    refitMinHits: 4,
    hpssTimeFrames: 17,
    hpssFreqBins: 9,
    // T10 adapt (tables in docs/audio-spike5-t10.md): classify-only LOPO mean (16 / 24 / 25) .809 -> .850, known kit
    // .951 -> .952; end to end known kit unchanged (+-.003), edits/keyboard D2 .189 -> .156.
    // Without the band gates LOPO 24 .834 -> .674; without the centroid order known .952 -> .947; without the fast-decay
    // HH seeds LOPO 16 .910 -> .897; adding instead of replacing LOPO 24 .842 -> .780; 3-4 iterations +-.01.
    adapt: true,
    adaptIterations: 2,
    adaptShare: 0.2, // .1 / .2 / .3 / .6: LOPO mean .850 / .850 / .840 / -; .2 keeps LOPO 16 SD (.907 at .1)
    adaptMinHits: 4,
    adaptKeepCos: 0.98, // .9 / .95 / .98: LOPO 24 .762 / .800 / .826 (.9 never adapts); known kit .951 / .951 / .950
    adaptLowHz: 150,
    adaptLowMin: 0.3, // kit A presets' one-shots: BD .38-.60 below 150 Hz, SD .04-.27; .2: LOPO 24 .842 -> .835
    adaptHighHz: 5000,
    adaptHighMin: 0.3, // HH .36-.84 at or above 5 kHz, SD .06-.18; .2: known .952 -> .944
    // T11 (classify-only, tuning, HH part only): all F50 0 / .2: known A .952 / .951, D .814 / .812, H (kit A drums + kit D
    // hi-hats) .889 / .914 (SD P: kit D hi-hat mids no longer read as SD), LOPO 16 / 24 / 25 .910 / .908, .842 / .844, .798 / .796.
    // Subtracting from every part instead: H .907 but D HH .755 -> .702, LOPO 16 HH .881 -> .821. .3 / .5 within +-.003 of .2.
    adaptSubMin: 0.2,
  },
  // T11 (S-9, classify-only on tuning A / D / H + LOPO; tables in docs/audio-spike5-t11.md). S-3 output does not use these.
  // toms: shareMin .3 -> .4: H T1 / T2 .85 / .81 -> .88 / .86, LOPO 16 T2 / FT .16 / .16 -> .57 / .65, D .58 / .31 / .15 -> .14 / .06 / 0;
  // maxTakeShare .5: LOPO 25 SD D0 .00 -> .72 (.35: A T1 .93 -> .86); minGapOct .12 -> .07 + subRatio: A D2 T1 / T2 .79 / .87 -> .93 / .94.
  // cymbals (simulated on the per-onset features, then measured): shareMin .1 -> .05 (RD A .88 -> .91, H .51 -> .73); slowDb -3,
  // voteDom .7, hoCos .83: HO D / H ~0 -> .75 / .73 at D2, known A HO .98 -> .89.
  // T11b tom adapt (classify-only D2, tables in docs/audio-spike5-t11.md T11b): D T1 / T2 / FT .14 / .06 / .00 -> .71 / .72 / .71,
  // LOPO 16 T1 / T2 .00 / .57 -> .49 / .85, LOPO 24 T1 / T2 .11 / .39 -> .41 / .57; known A unchanged. keep test "any group" (every
  // group: H T1 .88 -> .84, a cowbell group); adaptBodyMin .4 (cowbell .01, toms >= .3); adaptMinHits 2: A T1 .93 -> .91;
  // adaptBdMax off: D D3 BD .78 -> .70; nameSdRatios (tuning A / A Power / D: T1 .56-.65, T2 .47-.58, FT .31-.39): LOPO 16 T2 .72 -> .85;
  // nameByColumn (only with 3 columns; always: LOPO 16 FT .70 -> .41): D T1 / T2 / FT .63 / .60 / .61 -> .71 / .72 / .71.
  toms: { groups: 3, shareMin: 0.4, levelMinDb: -25, maxTakeShare: 0.5, sdKeepShare: 0.4, delaySec: 0.01, winSec: 0.08, pitchMinHz: 60, pitchMaxHz: 400, subRatio: 0.3, minGapOct: 0.07,
    adapt: true, adaptSubHz: 70, adaptLowTopHz: 2500, adaptSubMax: 0.1, adaptHighMax: 0.1, adaptBodyMin: 0.4, adaptPitchRatio: 0.85, adaptBdMax: 0.5, adaptMinHits: 4, adaptKeepCos: 0.95, bdKeepShare: 0.4, nameSdRatios: [0.62, 0.52, 0.35], nameByColumn: true },
  cymbals: { shareMin: 0.05, levelMinDb: -25, fminHz: 5000, dropFrames: 6, dropMinFrames: 3, fastDb: -4.5, riseDb: 0.5, slowDb: -3, crOverHh: 0.5, voteDom: 0.7, hoCos: 0.83, profileFminHz: 1000, profileMinHits: 4 },
  // T12 S-ext (classify-only on tuning A / D / H incl. the ext2 seeds 21-26, LOPO 16 / 24 / 25; tables in docs/audio-spike5-t12.md).
  ext: { cymVote: 0.8, bellVote: 0.3, bellTonal: 35, bellMinHz: 1500, cbShare: 0.2, cbTonal: 40, cbMinHz: 400, cbMaxHz: 1500, cbMaxDropDb: -8, cbDropsMetal: true, xsShare: 0.3, footShare: 0.4, tonalMinHz: 300, tonalMaxHz: 8000 },
  strength: { refPercentile: 0.9, ghostDb: -10, normalPercentile: 0.25, accentDb: 5, minHits: 4 },
  grid: { subdivision: 16, triplet: false, onsetBias: true, maxBiasSec: 0.08 },
  swing: { ratioMin: 0.58, minPairs: 3, innerMin: 0.25, innerMax: 0.8, clusterFrac: 0.1 },
  score: { toleranceSec: 0.05, tightSec: 0.025 },
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameKind(def: unknown, v: unknown): boolean {
  if (Array.isArray(def)) return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === typeof def;
}

/** Defaults with a (partial, nested) override applied; unknown keys and wrong types throw; result is a new frozen object. */
export function resolveDrumConfig(overrides: unknown = {}): DrumConfig {
  if (!isObj(overrides)) throw new Error(`drum config overrides must be an object, got ${JSON.stringify(overrides)}`);
  const merge = (def: Json, ov: Json, path: string): Json => {
    const out: Json = {};
    for (const k of Object.keys(ov)) if (!(k in def)) throw new Error(`unknown drum config key: ${path}${k}`);
    for (const k of Object.keys(def)) {
      const d = def[k];
      if (!(k in ov)) {
        out[k] = Array.isArray(d) ? [...d] : d;
      } else if (isObj(d)) {
        if (!isObj(ov[k])) throw new Error(`drum config ${path}${k}: expected an object`);
        out[k] = merge(d, ov[k] as Json, `${path}${k}.`);
      } else {
        if (!sameKind(d, ov[k])) throw new Error(`drum config ${path}${k}: expected ${Array.isArray(d) ? 'number[]' : typeof d}, got ${JSON.stringify(ov[k])}`);
        out[k] = Array.isArray(ov[k]) ? [...(ov[k] as number[])] : ov[k];
      }
    }
    return out;
  };
  return deepFreeze(merge(DEFAULT_DRUM_CONFIG as unknown as Json, overrides, '') as unknown as DrumConfig);
}

/** Canonical JSON of the config (sorted keys, compact). */
export function drumConfigCanonical(cfg: DrumConfig = DEFAULT_DRUM_CONFIG): string {
  return pyCanonicalJson(cfg);
}

/** 12 hex chars of SHA-256 over the canonical JSON; independent of key order. */
export function drumConfigHash(cfg: DrumConfig = DEFAULT_DRUM_CONFIG): string {
  return sha256Hex(new TextEncoder().encode(drumConfigCanonical(cfg))).slice(0, 12);
}

/** Leaves whose value differs from the default, as 'group.key' -> value (for logs). */
export function drumConfigSummary(cfg: DrumConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (a: Json, b: Json, p: string) => {
    for (const k of Object.keys(b)) {
      if (isObj(b[k])) walk(a[k] as Json, b[k] as Json, `${p}${k}.`);
      else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[`${p}${k}`] = a[k];
    }
  };
  walk(cfg as unknown as Json, DEFAULT_DRUM_CONFIG as unknown as Json, '');
  return out;
}
