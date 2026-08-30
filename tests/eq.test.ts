import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BUTTERWORTH_Q,
  EQ_PRESETS,
  type EqBand,
  bandResponseDb,
  eqPreset,
  responseCurve,
  responseDb,
} from '../src/domain/eq.ts';

const SR = 44_100;
const at = (id: Parameters<typeof eqPreset>[0], hz: number) =>
  responseDb(eqPreset(id).bands, hz, SR);

const near = (actual: number, expected: number, tol: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < tol, `${what}: ${actual.toFixed(2)} vs ${expected}`);

/** Index of the largest value, and of the smallest. */
function extremes(curve: { db: number }[]) {
  let hi = 0;
  let lo = 0;
  curve.forEach((p, i) => {
    if (p.db > curve[hi]!.db) hi = i;
    if (p.db < curve[lo]!.db) lo = i;
  });
  return { hi, lo };
}

/** Rises to `peak`, falls after it — one hump, no ripple. */
function unimodal(curve: { db: number }[], peak: number, tol = 0.01) {
  for (let i = 1; i <= peak; i++) {
    assert.ok(curve[i]!.db >= curve[i - 1]!.db - tol, `dipped before the peak at point ${i}`);
  }
  for (let i = peak + 1; i < curve.length; i++) {
    assert.ok(curve[i]!.db <= curve[i - 1]!.db + tol, `rose after the peak at point ${i}`);
  }
}

describe('the biquad response', () => {
  it('puts a Butterworth corner at exactly −3 dB', () => {
    // The definition of the cutoff frequency, so this is really a check on the coefficients.
    const hp: EqBand = { kind: 'highpass', frequency: 1000, q: BUTTERWORTH_Q, gainDb: 0 };
    const lp: EqBand = { kind: 'lowpass', frequency: 1000, q: BUTTERWORTH_Q, gainDb: 0 };
    near(bandResponseDb(hp, 1000, SR), -3.01, 0.05, 'highpass at its corner');
    near(bandResponseDb(lp, 1000, SR), -3.01, 0.05, 'lowpass at its corner');
  });

  it('rolls off at 12 dB per octave', () => {
    const hp: EqBand = { kind: 'highpass', frequency: 1000, q: BUTTERWORTH_Q, gainDb: 0 };
    near(bandResponseDb(hp, 500, SR), -12.3, 0.2, 'one octave below');
    near(bandResponseDb(hp, 250, SR), -24.1, 0.3, 'two octaves below');
  });

  it('gives a peaking band exactly its gain at its centre', () => {
    for (const gainDb of [-6, -4, 3.5, 6]) {
      const band: EqBand = { kind: 'peaking', frequency: 1000, q: 1, gainDb };
      near(bandResponseDb(band, 1000, SR), gainDb, 0.02, `${gainDb} dB bell`);
    }
  });

  it('adds bands in series, since magnitudes multiply', () => {
    const a: EqBand = { kind: 'peaking', frequency: 1000, q: 1, gainDb: 3 };
    const b: EqBand = { kind: 'peaking', frequency: 1000, q: 1, gainDb: 2 };
    near(responseDb([a, b], 1000, SR), 5, 0.02, 'two bells at one frequency');
  });
});

describe('each preset does what its name and icon promise', () => {
  it('Flat is 0 dB everywhere', () => {
    for (const { db } of responseCurve(eqPreset('flat').bands, SR)) assert.equal(db, 0);
  });

  it('Low Cut removes the bottom and leaves everything else alone', () => {
    near(at('lowCut', 100), -3.01, 0.05, 'corner');
    // 12 dB/oct, so 40 Hz lands at −16.0 and 50 Hz at −12.3. Deep enough to clear rumble,
    // shallow enough that nothing above the corner is touched.
    near(at('lowCut', 40), -16.0, 0.2, '40 Hz');
    near(at('lowCut', 50), -12.3, 0.2, '50 Hz');
    near(at('lowCut', 1000), 0, 0.1, '1 kHz untouched');
    near(at('lowCut', 10_000), 0, 0.1, '10 kHz untouched');

    // The icon rises from a floor to a flat top and never comes back down.
    const curve = responseCurve(eqPreset('lowCut').bands, SR);
    for (let i = 1; i < curve.length; i++) {
      assert.ok(curve[i]!.db >= curve[i - 1]!.db - 0.01, 'not monotonically rising');
    }
  });

  it('High Cut removes the top and leaves everything else alone', () => {
    near(at('highCut', 8000), -3.01, 0.05, 'corner');
    // Steeper than 12 dB/oct up here: a digital biquad's response is warped toward Nyquist,
    // so it falls away faster than the analogue prototype it is derived from.
    near(at('highCut', 12_000), -10.6, 0.2, '12 kHz');
    near(at('highCut', 18_000), -28.8, 0.3, '18 kHz');
    near(at('highCut', 1000), 0, 0.15, '1 kHz untouched');
    near(at('highCut', 100), 0, 0.05, '100 Hz untouched');

    const curve = responseCurve(eqPreset('highCut').bands, SR);
    for (let i = 1; i < curve.length; i++) {
      assert.ok(curve[i]!.db <= curve[i - 1]!.db + 0.01, 'not monotonically falling');
    }
  });

  it('Presence is one hump at 4 kHz and flat at both ends', () => {
    const curve = responseCurve(eqPreset('presence').bands, SR);
    const { hi } = extremes(curve);

    near(curve[hi]!.hz, 4000, 150, 'peak frequency');
    near(curve[hi]!.db, 3.5, 0.02, 'peak height');
    unimodal(curve, hi);

    near(at('presence', 250), 0, 0.5, 'low mids barely moved');
    near(at('presence', 18_000), 0, 0.5, 'top barely moved');
    assert.ok(at('presence', 8000) > 0.5, 'the shoulder should still be doing something');
  });

  it('Scoop is one dip at 500 Hz and flat at both ends', () => {
    const curve = responseCurve(eqPreset('scoop').bands, SR);
    const { lo } = extremes(curve);

    near(curve[lo]!.hz, 500, 25, 'dip frequency');
    near(curve[lo]!.db, -4, 0.02, 'dip depth');
    // A dip is a hump upside down.
    unimodal(curve.map((p) => ({ db: -p.db })), lo);

    near(at('scoop', 50), 0, 0.5, 'bottom barely moved');
    near(at('scoop', 6000), 0, 0.5, 'top barely moved');
  });

  it('Distant passes the ITU voice band and rolls off both ends', () => {
    // 300 Hz - 3.4 kHz is ITU-T G.101, so these two numbers are a standard, not a taste.
    near(at('distant', 300), -3.1, 0.15, 'lower corner');
    near(at('distant', 3400), -3.1, 0.15, 'upper corner');
    near(at('distant', 1000), 0, 0.2, 'the middle survives intact');

    near(at('distant', 80), -23.0, 0.3, '80 Hz');
    near(at('distant', 12_000), -26.7, 0.3, '12 kHz');

    // The icon is a plateau with both ends on the floor.
    const curve = responseCurve(eqPreset('distant').bands, SR);
    const { hi } = extremes(curve);
    unimodal(curve, hi);
    assert.ok(curve[hi]!.db <= 0.05, 'a band-pass must not boost its passband');
    assert.ok(curve[hi]!.hz > 300 && curve[hi]!.hz < 3400, 'peak sits inside the band');
  });
});

describe('the preset set as a whole', () => {
  it('never boosts except in Presence', () => {
    // Every other preset can only make a layer quieter, so Presence is the single place a
    // preset change can push a seven-layer sum toward clipping.
    for (const preset of EQ_PRESETS) {
      const peak = Math.max(...responseCurve(preset.bands, SR).map((p) => p.db));
      if (preset.id === 'presence') near(peak, 3.5, 0.02, 'presence peak');
      else assert.ok(peak <= 0.05, `${preset.id} boosts by ${peak.toFixed(2)} dB`);
    }
  });

  it('holds up at 48 kHz as well as 44.1', () => {
    // Biquad coefficients are rate-dependent; the corner must land on the same frequency.
    for (const preset of EQ_PRESETS) {
      for (const hz of [100, 500, 1000, 4000, 8000]) {
        const a = responseDb(preset.bands, hz, 44_100);
        const b = responseDb(preset.bands, hz, 48_000);
        assert.ok(Math.abs(a - b) < 0.35, `${preset.id} at ${hz} Hz: ${a} vs ${b}`);
      }
    }
  });

  it('uses only the three filter kinds both platforms ship', () => {
    const kinds = new Set(EQ_PRESETS.flatMap((p) => p.bands.map((b) => b.kind)));
    assert.deepEqual([...kinds].sort(), ['highpass', 'lowpass', 'peaking']);
  });

  it('gives the filters no gain, since they ignore it', () => {
    for (const preset of EQ_PRESETS) {
      for (const band of preset.bands) {
        if (band.kind !== 'peaking') assert.equal(band.gainDb, 0, preset.id);
      }
    }
  });
});
