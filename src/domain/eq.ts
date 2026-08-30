/**
 * EQ presets, and the arithmetic to check them (§2.8).
 *
 * Each preset is a short list of biquad bands. Only three filter kinds are needed and no
 * shelves, which maps 1:1 onto `AVAudioUnitEQFilterType` and Web Audio's `BiquadFilterNode`
 * — so the platform-bound part of EQ is "set four numbers on a stock filter", nothing more.
 *
 * `responseDb` exists so the presets are **falsifiable on this machine**. Values quoted from
 * mixing sources are conventions with wide ranges, and a table of numbers nobody can evaluate
 * is an assertion. Computing the actual curve turns "Scoop cuts the low mids" into something
 * a test either passes or fails, and it is the same discipline as checking the timing rules
 * against the kit rather than trusting them.
 */

export type BiquadKind = 'highpass' | 'lowpass' | 'peaking';

/**
 * Maximally flat, no resonant bump at the corner — a single biquad at this Q is the textbook
 * 12 dB/octave Butterworth.
 *
 * Mixing sources often suggest Q = 1 on a high-pass, which puts a small peak right at the
 * corner. That is a colour worth choosing deliberately on a known source, not a default for
 * presets applied to whatever the user happened to play. A steeper 24 dB/octave slope is two
 * of these cascaded, not a change of Q.
 */
export const BUTTERWORTH_Q = Math.SQRT1_2;

export type EqBand = {
  readonly kind: BiquadKind;
  readonly frequency: number;
  readonly q: number;
  /** Peak height for `peaking`; ignored by the filters, which is why it is 0 there. */
  readonly gainDb: number;
};

export type EqPresetId = 'flat' | 'lowCut' | 'highCut' | 'presence' | 'scoop' | 'distant';

export type EqPreset = {
  readonly id: EqPresetId;
  readonly name: string;
  readonly bands: readonly EqBand[];
};

function cut(kind: 'highpass' | 'lowpass', frequency: number): EqBand {
  return { kind, frequency, q: BUTTERWORTH_Q, gainDb: 0 };
}

function bell(frequency: number, gainDb: number, q = 1): EqBand {
  return { kind: 'peaking', frequency, q, gainDb };
}

/**
 * Frequencies are craft convention rather than standards, and every source quotes a range —
 * these sit mid-range and are a starting point for listening, not settled numbers. The one
 * exception is Distant: 300 Hz to 3.4 kHz is **ITU-T G.101**, the literal bandwidth of a
 * narrowband voice channel.
 *
 * **Presence is the only preset that adds gain.** The other four can only make a layer
 * quieter, so it is the single place a preset change can push a seven-layer sum toward
 * clipping.
 */
export const EQ_PRESETS: readonly EqPreset[] = [
  { id: 'flat', name: 'Flat', bands: [] },
  { id: 'lowCut', name: 'Low Cut', bands: [cut('highpass', 100)] },
  { id: 'highCut', name: 'High Cut', bands: [cut('lowpass', 7000)] },
  { id: 'presence', name: 'Presence', bands: [bell(4000, 3.5)] },
  { id: 'scoop', name: 'Scoop', bands: [bell(500, -4)] },
  { id: 'distant', name: 'Distant', bands: [cut('highpass', 300), cut('lowpass', 3400)] },
];

export function eqPreset(id: EqPresetId): EqPreset {
  const found = EQ_PRESETS.find((p) => p.id === id);
  if (!found) throw new RangeError(`unknown EQ preset ${id}`);
  return found;
}

type Coefficients = {
  b0: number; b1: number; b2: number;
  a0: number; a1: number; a2: number;
};

/** Robert Bristow-Johnson's Audio EQ Cookbook, the formulation both platforms implement. */
function coefficients(band: EqBand, sampleRate: number): Coefficients {
  const w0 = (2 * Math.PI * band.frequency) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * band.q);

  switch (band.kind) {
    case 'lowpass':
      return {
        b0: (1 - cosw) / 2, b1: 1 - cosw, b2: (1 - cosw) / 2,
        a0: 1 + alpha, a1: -2 * cosw, a2: 1 - alpha,
      };
    case 'highpass':
      return {
        b0: (1 + cosw) / 2, b1: -(1 + cosw), b2: (1 + cosw) / 2,
        a0: 1 + alpha, a1: -2 * cosw, a2: 1 - alpha,
      };
    case 'peaking': {
      const A = 10 ** (band.gainDb / 40);
      return {
        b0: 1 + alpha * A, b1: -2 * cosw, b2: 1 - alpha * A,
        a0: 1 + alpha / A, a1: -2 * cosw, a2: 1 - alpha / A,
      };
    }
  }
}

/** One band's gain at `hz`, in dB. */
export function bandResponseDb(band: EqBand, hz: number, sampleRate: number): number {
  const { b0, b1, b2, a0, a1, a2 } = coefficients(band, sampleRate);
  const w = (2 * Math.PI * hz) / sampleRate;

  // |H(e^jw)| with e^-jw = cos w - j sin w.
  const nRe = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
  const nIm = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
  const dRe = a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w);
  const dIm = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w));

  const magnitude = Math.hypot(nRe, nIm) / Math.hypot(dRe, dIm);
  return 20 * Math.log10(magnitude);
}

/**
 * A preset's gain at `hz`, in dB.
 *
 * Bands are in series, so their magnitudes multiply and their decibels add. An empty band
 * list is Flat, which is 0 dB everywhere by construction rather than by a special case.
 */
export function responseDb(
  bands: readonly EqBand[],
  hz: number,
  sampleRate: number,
): number {
  let db = 0;
  for (const band of bands) db += bandResponseDb(band, hz, sampleRate);
  return db;
}

/** Log-spaced response across the audible band, for checking a preset's shape. */
export function responseCurve(
  bands: readonly EqBand[],
  sampleRate: number,
  points = 240,
): { hz: number; db: number }[] {
  const out: { hz: number; db: number }[] = [];
  for (let i = 0; i < points; i++) {
    const hz = 20 * 1000 ** (i / (points - 1)); // 20 Hz .. 20 kHz
    out.push({ hz, db: responseDb(bands, hz, sampleRate) });
  }
  return out;
}
