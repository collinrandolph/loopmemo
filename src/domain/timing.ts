/**
 * Frame arithmetic for one project's grid.
 *
 * Everything here is in **sample frames**, never seconds (§1.4). Each boundary is derived
 * from the absolute formula rather than by accumulating bar durations, because accumulated
 * rounding error walks the boundaries out of alignment over a long recording.
 */
export type Timing = {
  readonly bpm: number;
  readonly barCount: number;
  readonly beatsPerBar: number;
  readonly sampleRate: number;
};

/**
 * Stopping has latency, so a pass the user played to completion can land a hair short of
 * the arithmetic and would otherwise vanish (§1.4).
 *
 * Expressed as a **duration**, not a frame count. A hardcoded frame count means a different
 * amount of slack at 44.1 kHz than at 48 kHz, and the thing being forgiven is a physical
 * delay measured in milliseconds.
 *
 * The spec says "a few milliseconds". Do not inflate this: the tolerance admits a bar whose
 * audio does not fully exist, and the scheduler then reads past the end of the file for it.
 * A plausible-looking 2000 frames is 45 ms — enough to admit a pass that stopped most of a
 * beat early.
 */
export const TOLERANCE_SECONDS = 0.004;

export function timing(
  bpm: number,
  barCount: number,
  sampleRate: number,
  beatsPerBar = 4,
): Timing {
  if (!(bpm > 0)) throw new RangeError(`bpm must be positive, got ${bpm}`);
  if (!Number.isInteger(barCount) || barCount < 1) {
    throw new RangeError(`barCount must be a positive integer, got ${barCount}`);
  }
  if (!(sampleRate > 0)) throw new RangeError(`sampleRate must be positive, got ${sampleRate}`);
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) {
    throw new RangeError(`beatsPerBar must be a positive integer, got ${beatsPerBar}`);
  }
  return { bpm, barCount, sampleRate, beatsPerBar };
}

/** `round(sampleRate × 60 × beatsPerBar / bpm)` — §1.4. Never hardcode 240 (§5.1 #1). */
export function framesPerBar(t: Timing): number {
  return Math.round((t.sampleRate * 60 * t.beatsPerBar) / t.bpm);
}

export function loopFrames(t: Timing): number {
  return framesPerBar(t) * t.barCount;
}

/**
 * Seconds for one traversal of the loop.
 *
 * Floating point throughout — integer division silently truncates 9.6 s to 9, a 6% error
 * in every size projection at that tempo.
 */
export function loopSeconds(t: Timing): number {
  return (t.barCount * t.beatsPerBar * 60) / t.bpm;
}

/** The end-of-session slack, in frames at this project's rate. */
export function toleranceFrames(t: Timing): number {
  return Math.round(t.sampleRate * TOLERANCE_SECONDS);
}

/** Frame offset of a bar within a single traversal of the loop. */
export function frameOffsetInLoop(t: Timing, relativeBar: number): number {
  if (!Number.isInteger(relativeBar) || relativeBar < 1 || relativeBar > t.barCount) {
    throw new RangeError(`relativeBar ${relativeBar} outside 1..${t.barCount}`);
  }
  return (relativeBar - 1) * framesPerBar(t);
}

/** Total passes a session of `frames` holds, partial ones included (§1.4). */
export function passCount(t: Timing, frames: number): number {
  if (frames <= 0) return 0;
  return Math.ceil(frames / loopFrames(t));
}

/**
 * Does the `localPass`-th traversal of this session contain `relativeBar`?
 *
 * `barExists` from §1.4, verbatim:
 *     ((localPass - 1) × loopFrames + (r - 1) × framesPerBar) + framesPerBar
 *         <= session.frames + tolerance
 */
export function barExists(
  t: Timing,
  localPass: number,
  relativeBar: number,
  sessionFrames: number,
): boolean {
  if (!Number.isInteger(localPass) || localPass < 1) {
    throw new RangeError(`localPass is 1-based, got ${localPass}`);
  }
  const start = (localPass - 1) * loopFrames(t) + frameOffsetInLoop(t, relativeBar);
  return start + framesPerBar(t) <= sessionFrames + toleranceFrames(t);
}
