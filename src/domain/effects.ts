import type { Timing } from './timing.ts';

/**
 * Per-layer pan and its delay path (§2.8).
 *
 * EQ is **deliberately absent**. The presets in §2.8 are placeholders — frequencies and
 * directions with no gain, Q or filter type — and inventing the missing numbers here would
 * make guesses look decided. It joins this file once the shapes are settled.
 */

/** Linear gain from decibels. */
export function gainFromDb(db: number): number {
  return 10 ** (db / 20);
}

export type StereoGains = {
  readonly left: number;
  readonly right: number;
};

export const SILENT: StereoGains = { left: 0, right: 0 };

/** ±45° is a hard pan, per the standard equal-power convention (§2.8). */
export const PAN_HARD_DEGREES = 45;

/**
 * Equal-power pan for a mono source.
 *
 * Sources are mono (`CHANNEL_COUNT = 1`), so this is positioning rather than balancing, and
 * linear panning would dip about 3 dB through the centre — audible as a layer switching
 * between Center and Slight L sounding quieter in the middle.
 *
 * The angle **is** the equal-power angle: −45° is hard left, 0° is centre, +45° is hard right.
 * Not 45° of a 90° half-field, which would make "Wide" only half way across.
 */
export function panGains(angleDegrees: number): StereoGains {
  if (Math.abs(angleDegrees) > PAN_HARD_DEGREES) {
    throw new RangeError(`pan angle ${angleDegrees}° outside ±${PAN_HARD_DEGREES}°`);
  }
  const theta = ((angleDegrees + PAN_HARD_DEGREES) * Math.PI) / 180;
  return { left: Math.cos(theta), right: Math.sin(theta) };
}

export function scaleGains(gains: StereoGains, factor: number): StereoGains {
  return { left: gains.left * factor, right: gains.right * factor };
}

/**
 * Delay time as a fraction of a beat, in frames.
 *
 * The same formula as `framesPerBar`, which is a beat count rather than a fraction — so
 * `noteDelayFrames(t, t.beatsPerBar) === framesPerBar(t)`, and there is one piece of
 * tempo-to-frames arithmetic in the codebase rather than two.
 *
 * Takes **beats** rather than a note value because a note value assumes what the beat is.
 * `BEATS` names the common ones for the case where the beat is a quarter note.
 */
export function noteDelayFrames(t: Timing, beats: number): number {
  if (!(beats >= 0)) throw new RangeError(`beats must be non-negative, got ${beats}`);
  return Math.round((t.sampleRate * 60 * beats) / t.bpm);
}

/** Note values as beat counts, assuming a quarter-note beat. */
export const BEATS = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  sixteenth: 0.25,
  thirtySecond: 0.125,
} as const;

/**
 * §2.8 specifies the Surround delay as `7500 / BPM` ms, which is exactly **one eighth of a
 * beat** — a 32nd note at 4/4. `60000/BPM ÷ 8 = 7500/BPM`, so the magic 7500 is just that
 * relationship written out, and expressing it as a division keeps it in frames.
 */
export const HAAS_DIVISION_BEATS = BEATS.thirtySecond;

/**
 * Above roughly 35–40 ms the ear stops fusing the delayed copy into one wider image and
 * starts hearing a second attack. The tempo-synced time only stays inside that window above
 * about 214 BPM — at 120 BPM it is 62.5 ms and at 60 BPM it is 125 ms, both plainly echoes.
 * Clamping keeps the preset doing what its name says at every tempo in range, at the cost of
 * the tempo sync below 214 BPM.
 *
 * The 32nd-note slap the clamp discards is a good effect in its own right; it belongs to the
 * v2 delay (§6.2), not to a width control.
 */
export const HAAS_MAX_SECONDS = 0.035;

export function haasDelayFrames(t: Timing): number {
  const synced = noteDelayFrames(t, HAAS_DIVISION_BEATS);
  // Floored, not rounded: this is a ceiling, and rounding it up puts the result past the
  // limit it exists to enforce (44100 × 0.035 rounds to 1544 frames, which is 35.01 ms).
  return Math.min(synced, Math.floor(t.sampleRate * HAAS_MAX_SECONDS));
}

/**
 * A delay line, as the audio layer needs to configure it.
 *
 * Shaped for the v2 delay effect (§6.2) rather than for Surround alone: Surround is one
 * configuration of this — a single repeat, no feedback, panned opposite — and a delay effect
 * would be others. `feedback` exists at 0 for that reason.
 *
 * **The delayed copy of the last bar runs past the loop end.** Live that is correct and needs
 * nothing: the line keeps running across the boundary the way any delay does. **Bounce and
 * export render a fixed-length file**, so there the tail has to wrap into the start of the
 * loop, or the rendered version has a discontinuity the live one never had.
 */
export type DelaySpec = {
  readonly delayFrames: number;
  /** 0 for every v1 preset. A repeat count above one belongs to the v2 delay. */
  readonly feedback: number;
  /** Where the delayed copy lands, level included. `SILENT` when the preset uses no delay. */
  readonly wet: StereoGains;
};

/** What a pan preset asks the audio layer for. */
export type PanPlan = {
  readonly dry: StereoGains;
  readonly delay: DelaySpec;
};

export type PanPresetId =
  | 'center'
  | 'slightL'
  | 'slightR'
  | 'wideL'
  | 'wideR'
  | 'surround';

export type PanPreset = {
  readonly id: PanPresetId;
  readonly name: string;
  /** Where the dry signal sits. */
  readonly angle: number;
  /** Present only on presets that feed the delay path. */
  readonly haas?: {
    readonly angle: number;
    readonly levelDb: number;
  };
};

/**
 * Surround's delayed copy sits below the dry.
 *
 * **Split the difference between unity and −3 dB; not yet confirmed by ear.** Worth checking
 * against the fact that Surround is the only preset whose two paths both carry signal: dry
 * hard left at unity plus wet hard right at −1.5 dB is about **2.3 dB hotter in total power**
 * than any other preset, so switching to it reads as a level change as well as a width one.
 * If that is the problem in practice, the fix is here or in the dry gain.
 */
export const SURROUND_WET_DB = -1.5;

/** Dry left and delayed right, fixed — otherwise every Surround layer leans the same way. */
export const PAN_PRESETS: readonly PanPreset[] = [
  { id: 'center', name: 'Center', angle: 0 },
  { id: 'slightL', name: 'Slight L', angle: -15 },
  { id: 'slightR', name: 'Slight R', angle: 15 },
  { id: 'wideL', name: 'Wide L', angle: -PAN_HARD_DEGREES },
  { id: 'wideR', name: 'Wide R', angle: PAN_HARD_DEGREES },
  {
    id: 'surround',
    name: 'Surround',
    angle: -PAN_HARD_DEGREES,
    haas: { angle: PAN_HARD_DEGREES, levelDb: SURROUND_WET_DB },
  },
];

export function panPreset(id: PanPresetId): PanPreset {
  const found = PAN_PRESETS.find((p) => p.id === id);
  if (!found) throw new RangeError(`unknown pan preset ${id}`);
  return found;
}

/**
 * Resolve a preset against the project's tempo.
 *
 * **`delayFrames` is the same on every preset, including the five that make no sound with
 * it.** The audio layer builds the delay path once per layer and changes only `wet` — so
 * switching presets is a gain ramp, never a graph rebuild or a change of delay time, both of
 * which click. Preset changes are a live gesture, so that matters. It also means the delay
 * time only ever moves when the tempo does, and tempo locks after the first recording (§4.5).
 */
export function panPlan(preset: PanPreset, t: Timing): PanPlan {
  const delayFrames = haasDelayFrames(t);
  if (!preset.haas) {
    return { dry: panGains(preset.angle), delay: { delayFrames, feedback: 0, wet: SILENT } };
  }
  return {
    dry: panGains(preset.angle),
    delay: {
      delayFrames,
      feedback: 0,
      wet: scaleGains(panGains(preset.haas.angle), gainFromDb(preset.haas.levelDb)),
    },
  };
}
