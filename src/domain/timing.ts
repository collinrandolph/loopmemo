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
 * Stop latency, as a **duration** rather than a frame count: a frame count means different slack
 * at 44.1 kHz than at 48 kHz, and what is absorbed is a physical delay in milliseconds.
 *
 * **It guards the near edge of a bar, not the far edge.** A bar exists once the session captured
 * any of it (`barExists`), so a bar stopping short needs no forgiveness. What needs absorbing is
 * the overrun — stopping is never instant, so a pass played to the loop point captures a few ms
 * past it, and that crumb would otherwise be a phantom bar and a phantom pass.
 *
 * A measured figure; tune it against real hardware (`docs/platform-decision.md` §5).
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

/**
 * Does the `localPass`-th traversal hold **at least one complete bar**? (§1.4)
 *
 * A stop overruns the loop point, and without this the overrun becomes a numbered pass holding
 * junk — which **renumbers every pass after it, permanently**. A single pass cannot be deleted
 * (§5.1 #2), so the only escape would be clearing the layer.
 *
 * **Gated in bars, not milliseconds.** A stop overrun is roughly constant in absolute time, so a
 * percentage threshold cannot work at both 60 and 240 BPM; and a traversal that has not completed
 * bar 1 contributes a fragment to one bar position and nothing to any other.
 *
 * **Not applied at the bar level**: a partial bar inside a pass is kept and exposed
 * (`barExists`), because it is one tap-and-hold from silence and local to its slot.
 *
 * The only use of the tolerance at the **far** edge of a bar, which a completeness test needs.
 */
export function passExists(t: Timing, localPass: number, sessionFrames: number): boolean {
  const start = (localPass - 1) * loopFrames(t);
  return start + framesPerBar(t) <= sessionFrames + toleranceFrames(t);
}

/**
 * Total passes a session of `frames` holds, partial ones included (§1.4).
 *
 * **Derived from `passExists`, not counted separately** — computed independently the two disagree
 * on every recording that overruns the loop point, offering one pass count to the size projection
 * and another to the swipe axis. One derivation per quantity (§1.5).
 */
export function passCount(t: Timing, frames: number): number {
  const usable = frames + toleranceFrames(t) - framesPerBar(t);
  if (usable < 0) return 0;
  return Math.floor(usable / loopFrames(t)) + 1;
}

/**
 * Does the `localPass`-th traversal of this session contain any of `relativeBar`?
 *
 * **A bar exists once the recording reaches into it**, which is deliberately not §1.4's formula
 * (that required the bar to be whole). Stopping halfway through bar 9 keeps bar 9 as an ordinary
 * selectable bar that runs out of audio partway; `regionFor` clamps to what is on disk, and the
 * next segment starts at its own scheduled frame regardless.
 *
 * **This reverses §5.1 #5** ("kept but not exposed"), whose reason was that padding creates
 * silent bars that look selectable. Nothing is padded, and a bar the recording never reached is
 * still excluded, so that failure cannot occur — and a partial pass yields usable bars instead of
 * discarding the user's last seconds of playing. The tolerance moves to the near edge accordingly.
 *
 * The pass gate comes first, so no bar outlives the pass that would hold it.
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
  if (!passExists(t, localPass, sessionFrames)) return false;
  const start = (localPass - 1) * loopFrames(t) + frameOffsetInLoop(t, relativeBar);
  return start + toleranceFrames(t) < sessionFrames;
}
