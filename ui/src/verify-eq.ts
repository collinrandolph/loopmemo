import { EQ_PRESETS, type EqPresetId, eqPreset, responseDb } from '../../src/domain/eq.ts';
import { timing } from '../../src/domain/timing.ts';
import { createLayerChain } from './effects-chain.ts';

/**
 * Does the audio graph actually apply the EQ the domain describes?
 *
 * `tests/eq.test.ts` already proves the *presets* are what their icons promise — one hump, one
 * dip, monotone rise, monotone fall — by evaluating `responseDb`, the biquad transfer function,
 * in Node. What no Node test can reach is whether the `BiquadFilterNode` chain in
 * `effects-chain.ts` is wired into the signal path at all, and whether it produces that same
 * curve. Reported as "either not working or too subtle to hear", which are very different
 * faults and cannot be told apart by listening.
 *
 * So: render a sine through the real chain, one frequency at a time, and measure the output.
 * **Measured against Flat rather than against the input**, which cancels the pan law's 0.707
 * and the layer level without having to model either — what is left is the EQ's own
 * contribution, directly comparable to `responseDb`.
 *
 * ```js
 * (await import('/ui/dist/ui/src/verify-eq.js')).verifyEq().then(console.table)
 * ```
 */

const RATE = 44100;
/** Log-ish spread across the range the presets act on, plus two either side of everything. */
const PROBES = [60, 100, 200, 500, 1000, 2000, 4000, 7000, 12000];
/** Long enough that the filter has settled well before the window being measured. */
const SECONDS = 0.25;

async function amplitudeAt(id: EqPresetId, hz: number): Promise<number> {
  const frames = Math.round(RATE * SECONDS);
  const ctx = new OfflineAudioContext(2, frames, RATE);
  const t = timing(96, 16, RATE, 4);

  const chain = createLayerChain(ctx, ctx.destination, t);
  chain.setEq(id);
  chain.setPan('center');
  chain.setLevel(1);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = hz;
  osc.connect(chain.input);
  osc.start();

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);

  // **RMS, not peak.** Peak-of-samples is a biased estimator of a sine's amplitude whenever
  // there are few samples per cycle: at 12 kHz there are 3.7, so the nearest sample can sit up
  // to 49° off the crest and read 3.7 dB low. The first attempt at this measured exactly that
  // and reported it as the graph disagreeing with the domain. RMS is phase-independent over a
  // whole number of cycles and very nearly so over a partial one.
  //
  // Skip the first half either way: a biquad rings on start-up and the pan and level ramp.
  let sum = 0;
  const from = Math.floor(frames / 2);
  for (let i = from; i < frames; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / (frames - from));
}

export async function verifyEq() {
  const flat = new Map<number, number>();
  for (const hz of PROBES) flat.set(hz, await amplitudeAt('flat', hz));

  const rows: Record<string, unknown>[] = [];
  let worstError = 0;

  for (const preset of EQ_PRESETS) {
    if (preset.id === 'flat') continue;
    for (const hz of PROBES) {
      const measured = 20 * Math.log10((await amplitudeAt(preset.id, hz)) / flat.get(hz)!);
      const predicted = responseDb(eqPreset(preset.id).bands, hz, RATE);
      const error = Math.abs(measured - predicted);
      if (Number.isFinite(error)) worstError = Math.max(worstError, error);
      rows.push({
        preset: preset.id,
        hz,
        measuredDb: +measured.toFixed(2),
        predictedDb: +predicted.toFixed(2),
        errorDb: +error.toFixed(2),
      });
    }
  }

  // What a listener would actually notice: the widest swing each preset produces across the
  // probed band. A preset whose extremes are a couple of dB apart is working and gentle; one
  // whose extremes are 0 apart is not in the signal path.
  const swing = EQ_PRESETS.filter((p) => p.id !== 'flat').map((p) => {
    const mine = rows.filter((r) => r.preset === p.id).map((r) => r.measuredDb as number);
    return {
      preset: p.id,
      name: p.name,
      maxBoostDb: +Math.max(...mine).toFixed(2),
      maxCutDb: +Math.min(...mine).toFixed(2),
      swingDb: +(Math.max(...mine) - Math.min(...mine)).toFixed(2),
    };
  });

  return {
    rows,
    swing,
    worstErrorDb: +worstError.toFixed(2),
    graphMatchesDomain: worstError < 0.5,
  };
}
