import { type BiquadKind, type EqPresetId, EQ_PRESETS, eqPreset } from '../../src/domain/eq.ts';
import { type PanPresetId, panPlan, panPreset } from '../../src/domain/effects.ts';
import type { Timing } from '../../src/domain/timing.ts';

/**
 * One layer's signal path: EQ, pan, the Haas delay, and level (§2.8).
 *
 * *What* these do is decided and tested in `src/domain` — `eqPreset` gives bands that map onto a
 * `BiquadFilterNode`, `panPlan` gives two pairs of gains and a delay time. This only builds the
 * graph, which is why the presets could be measured and corrected before there was audio.
 *
 * **The graph is built once and never rebuilt.** Every pan preset reports the same `delayFrames`
 * and the five without a delay silence it with gain, so a preset change is a gain ramp rather
 * than a reconnection — both a rebuild and a change of delay time click, and a preset change is a
 * live gesture. The EQ extends that as far as the API allows: a fixed `EQ_SLOTS` filters, with a
 * preset that uses fewer parking the spare ones as peaking at 0 dB. Only the coefficients move,
 * except `type`, which a high-pass cannot flatten by gain the way a peaking filter can.
 *
 *     source(s) ─▶ eq[0..n] ─┬─▶ dryL  ─▶ ┐
 *                            │            ├─▶ merge ─▶ level ─▶ bus
 *                            ├─▶ dryR  ─▶ ┘
 *                            └─▶ delay ─┬─▶ wetL ─▶ ┘
 *                                       └─▶ wetR ─▶ ┘
 */

/** The widest preset is Distant, at two. A fixed chain means the graph never changes shape. */
const EQ_SLOTS = Math.max(...EQ_PRESETS.map((p) => p.bands.length));

/** Preset changes ramp rather than jump, over a time short enough to feel immediate. */
const RAMP_SECONDS = 0.02;

/**
 * `BiquadFilterNode.Q` is **in decibels for `lowpass` and `highpass`** and linear for `peaking`.
 * The spec converts the first two with `10^(Q/20)`, so handing it the domain's Butterworth 0.7071
 * asks for an effective Q of 1.085 — a resonant bump, the exact colour `BUTTERWORTH_Q` avoids.
 *
 * It does not announce itself: at the corner a Butterworth is −3.01 dB and the browser gave
 * +0.71. `verify-eq.ts` is the guard, and it took both sides to find — the domain's transfer
 * function was right, and the graph was faithfully building the wrong filter.
 */
function webAudioQ(kind: BiquadKind, q: number): number {
  return kind === 'peaking' ? q : 20 * Math.log10(q);
}

export type LayerChain = {
  /** Where segments are scheduled. Everything downstream is this layer's own. */
  readonly input: AudioNode;
  setEq(id: EqPresetId): void;
  setPan(id: PanPresetId): void;
  setLevel(level: number): void;
  disconnect(): void;
};

export function createLayerChain(
  ctx: BaseAudioContext,
  destination: AudioNode,
  t: Timing,
): LayerChain {
  const input = ctx.createGain();
  const level = ctx.createGain();

  const filters = Array.from({ length: EQ_SLOTS }, () => ctx.createBiquadFilter());
  let tail: AudioNode = input;
  for (const f of filters) {
    tail.connect(f);
    tail = f;
  }

  // Two mono gains into a merger rather than a `StereoPannerNode`: the pan law is the domain's
  // (equal power, and ±45° is a hard pan rather than 45° of a half-field), and a panner would
  // impose its own. Surround also needs the delayed copy panned *opposite* the dry signal,
  // which one panner cannot express.
  const merge = ctx.createChannelMerger(2);
  const dryL = ctx.createGain();
  const dryR = ctx.createGain();
  const wetL = ctx.createGain();
  const wetR = ctx.createGain();

  // Built at the tempo's Haas time and left there. `delayFrames` only moves when the tempo
  // does, and tempo locks on the first recording (§4.5) — so in practice this is set once.
  const delay = ctx.createDelay(1);

  tail.connect(dryL);
  tail.connect(dryR);
  tail.connect(delay);
  delay.connect(wetL);
  delay.connect(wetR);
  dryL.connect(merge, 0, 0);
  wetL.connect(merge, 0, 0);
  dryR.connect(merge, 0, 1);
  wetR.connect(merge, 0, 1);
  merge.connect(level);
  level.connect(destination);

  function ramp(param: AudioParam, value: number) {
    // `setTargetAtTime` rather than a linear ramp: it needs no end time, so overlapping preset
    // changes compose instead of fighting over a scheduled endpoint.
    param.setTargetAtTime(value, ctx.currentTime, RAMP_SECONDS / 3);
  }

  const chain: LayerChain = {
    input,

    setEq(id) {
      const bands = eqPreset(id).bands;
      filters.forEach((filter, i) => {
        const band = bands[i];
        if (band) {
          filter.type = band.kind;
          filter.frequency.value = band.frequency;
          filter.Q.value = webAudioQ(band.kind, band.q);
          filter.gain.value = band.gainDb;
        } else {
          // Unity, exactly: a peaking filter at 0 dB passes its input unchanged, so a spare slot
          // costs nothing and the chain length stays constant.
          filter.type = 'peaking';
          filter.frequency.value = 1000;
          filter.Q.value = 1;
          filter.gain.value = 0;
        }
      });
    },

    setPan(id) {
      const plan = panPlan(panPreset(id), t);
      delay.delayTime.value = plan.delay.delayFrames / t.sampleRate;
      ramp(dryL.gain, plan.dry.left);
      ramp(dryR.gain, plan.dry.right);
      ramp(wetL.gain, plan.delay.wet.left);
      ramp(wetR.gain, plan.delay.wet.right);
    },

    setLevel(value) {
      ramp(level.gain, value);
    },

    disconnect() {
      level.disconnect();
    },
  };

  return chain;
}
