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
 * Stop latency, expressed as a **duration** rather than a frame count — a hardcoded frame
 * count means different slack at 44.1 kHz than at 48 kHz, and the thing being absorbed is a
 * physical delay measured in milliseconds.
 *
 * **It absorbs the crumb at the near edge of a bar, not a shortfall at the far edge.** Under
 * `barExists` a bar exists once the session captured any of it, so a bar that stopped a hair
 * short is admitted for free and needs no forgiveness. What needs absorbing is the opposite
 * case: stopping a recording is never instant, so a pass played to exactly the loop point
 * captures a few milliseconds past it. Without this the overrun becomes a whole phantom bar —
 * and, through `passCount`, a whole phantom pass that inflates the size projection.
 *
 * The spec says "a few milliseconds". Inflating this is no longer *unsafe* the way it was
 * when the tolerance admitted audio that did not exist — `regionFor` clamps to the file, so
 * an over-large value only discards a genuinely short bar. It is a measured latency figure,
 * and the right time to tune it is against the loopback calibration in
 * `docs/platform-decision.md` §5, on real hardware.
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
 * This is the one place §1.4's original formula still applies, and the question it was always
 * really asking. Stopping late overruns the loop point, and without this the overrun becomes
 * a whole numbered pass holding nothing but junk — which **renumbers every pass after it,
 * permanently**. A single pass cannot be deleted (§5.1 #2: `barSources` references pass
 * numbers, so removing one breaks every reference past it), leaving no escape but clearing
 * the entire layer. It also inflates the size projection the Library exists to show.
 *
 * Gated in bars rather than in milliseconds because that is what a pass is worth: a traversal
 * that has not completed bar 1 contributes a fragment to one bar position and nothing to any
 * other, so it is near-worthless even when it *was* intended. Discarding it costs at most one
 * bar of a take the user can play again; admitting it costs a renumbering they cannot undo.
 *
 * **Deliberately not applied at the bar level.** A partial bar *inside* a pass is kept and
 * exposed (see `barExists`) — an overrun there is a minor annoyance the user silences with
 * one tap-and-hold, and guessing at their intent would cost more than it saves.
 *
 * The tolerance appears here at the **far** edge of the bar, which is a completeness test and
 * is the only kind that needs it: stop latency must not lose a pass whose final bar the user
 * played to the end.
 */
export function passExists(t: Timing, localPass: number, sessionFrames: number): boolean {
  const start = (localPass - 1) * loopFrames(t);
  return start + framesPerBar(t) <= sessionFrames + toleranceFrames(t);
}

/**
 * Total passes a session of `frames` holds, partial ones included (§1.4).
 *
 * **Derived from `passExists`, not counted separately.** This and `barExists` used to be
 * computed independently — `ceil(frames / loopFrames)` here against the tolerance formula
 * there — and they disagreed on every recording that overran the loop point. A session of two
 * complete passes plus 20 ms reported three passes to the size projection while offering two
 * to the swipe axis, so the Library over-stated the project by 50%. One derivation per
 * quantity (§1.5).
 */
export function passCount(t: Timing, frames: number): number {
  const usable = frames + toleranceFrames(t) - framesPerBar(t);
  if (usable < 0) return 0;
  return Math.floor(usable / loopFrames(t)) + 1;
}

/**
 * Does the `localPass`-th traversal of this session contain any of `relativeBar`?
 *
 * **Deliberately not §1.4's formula, which required the bar to be whole:**
 *
 *     ((localPass - 1) × loopFrames + (r - 1) × framesPerBar) + framesPerBar
 *         <= session.frames + tolerance
 *
 * A bar now exists once the recording reaches into it. Stopping halfway through bar 9 keeps
 * bar 9 as an ordinary, fully selectable bar that happens to run out of audio partway — the
 * silence at its end is not a special case, because `regionFor` clamps the region to what is
 * on disk and the next segment starts at its own scheduled frame regardless.
 *
 * This reverses §5.1 #5 ("kept but not exposed"), whose stated reason was that padding
 * "creates silent bars that look selectable". Nothing is padded here — no silence is written
 * and the region stays short — and a bar the recording never reached is still excluded, so
 * the failure that rule guarded against cannot occur. What it buys is that a partial pass
 * yields usable bars instead of discarding the user's last few seconds of playing.
 *
 * The tolerance moves to the near edge accordingly: see `TOLERANCE_SECONDS`.
 *
 * The pass gate comes first, so no bar can outlive the pass that would hold it. That also
 * keeps this in exact agreement with `passCount` at `relativeBar = 1` — the two thresholds
 * are different, but the pass floor is a whole bar and the bar floor a few milliseconds, so
 * clearing the former always clears the latter.
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
