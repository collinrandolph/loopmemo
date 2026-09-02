import { type Timing, framesPerBar } from './timing.ts';

/**
 * Playback position on the **edited** timeline (§3.6).
 *
 * Progress indexes on the slot — where a bar sits in the arrangement — never on the source it
 * came from (§1.1), so a reordered arrangement still sweeps left to right.
 *
 * **The unit is the cycle**: `origin → end of arrangement → wrap to slot 0 → back to origin`.
 * Playback begins wherever the user tapped, so the natural period is a rotation; releasing at the
 * arrangement end instead fires mid-cycle and reads as a flash.
 *
 * **Four of §3.6's six rules are one comparison.** Index on position within the cycle and gating
 * to the origin, releasing at the wrap, holding while wrapped and releasing at the origin
 * crossing all stop being special cases:
 *
 *     isPlayed(slot)  ⟺  cyclePosition(slot) < phase
 *
 * The fifth — the release floor is per slot, never global — falls out of bar mode being a cycle of
 * length 1. The sixth, selection clearing on stop, is UI state and lives in the caller.
 *
 * **This module owns no clock.** The engine's frame position is authoritative (§2.4); a private
 * timer free-runs against the audible playhead, and 1% on a 40-second loop is 400 ms.
 */
export type TransportMode = 'idle' | 'bar' | 'loop';

export type Transport = {
  readonly mode: TransportMode;
  /** Slot playback started from. Cycle position 0. */
  readonly origin: number;
  /** Engine frame at which cycle position 0 sits. Rebased by `escalate`. */
  readonly startFrame: number;
};

export const IDLE: Transport = { mode: 'idle', origin: 0, startFrame: 0 };

/** Single tap: repeat one slot until stopped (§3.7). */
export function playBar(slot: number, positionFrames: number): Transport {
  return { mode: 'bar', origin: slot, startFrame: positionFrames };
}

/** Double tap: play the arrangement from this slot (§3.7). */
export function playLoopFrom(slot: number, positionFrames: number): Transport {
  return { mode: 'loop', origin: slot, startFrame: positionFrames };
}

/**
 * Stop. **Not a pause** — resuming means selecting a new origin, so there is no position to
 * keep. §3.7 calls tapping the origin "pauses", but §3.6's own rule says "on stop, rewind
 * *and* release", and the kit rewinds to zero. It is a stop.
 */
export function stop(): Transport {
  return IDLE;
}

/**
 * Second tap inside 300 ms: let playback continue past the bar end into the full loop (§3.7).
 *
 * Resolved by escalation rather than by waiting, so the first tap can start the bar
 * immediately instead of paying the double-tap window in latency. Both taps are "play", so
 * **nothing is undone** — and keeping that true is what the rebase is for. The cycle grows
 * from one slot to the whole arrangement, so `startFrame` moves to the start of the repeat
 * in progress; two beats into the bar stays two beats into the new cycle.
 */
export function escalate(
  transport: Transport,
  positionFrames: number,
  timing: Timing,
): Transport {
  if (transport.mode !== 'bar') return transport;
  const head = playheadAt(transport, positionFrames, timing);
  if (!head) return transport;
  return {
    mode: 'loop',
    origin: transport.origin,
    startFrame: transport.startFrame + head.cyclesCompleted * framesPerBar(timing),
  };
}

/**
 * The resolved playhead: everything a render pass needs, computed once.
 *
 * §3.6: "The played set must be computed in ONE place. Every bug in this area came from a
 * render pass and a release path disagreeing." Resolving first and querying second is that
 * one place, structurally — nothing can be asked without going through here.
 */
export type Playhead = {
  readonly origin: number;
  readonly barCount: number;
  /** Slots in one cycle: the whole arrangement, or 1 in bar mode. */
  readonly cycleLength: number;
  /** Whole cycles finished since playback began. The release edge (§3.6 rule 4). */
  readonly cyclesCompleted: number;
  /** Distance travelled from the origin, in slots, within the current cycle. */
  readonly phaseSlots: number;
};

/**
 * Resolve the engine's frame position against the transport.
 *
 * Returns undefined when idle — nothing is played, and callers should render the rest state
 * rather than a zero playhead.
 *
 * `cyclesCompleted` comes from integer division of an exact frame count, so the cycle edge
 * is exact. Accumulating a software clock instead lets float error cross the threshold a
 * frame early, which offsets the whole 180 ms release animation; that is observable, and it
 * is why position arrives from outside rather than being integrated here.
 */
export function playheadAt(
  transport: Transport,
  positionFrames: number,
  timing: Timing,
): Playhead | undefined {
  if (transport.mode === 'idle') return undefined;

  const cycleLength = transport.mode === 'bar' ? 1 : timing.barCount;
  const elapsedFrames = Math.max(0, positionFrames - transport.startFrame);
  const elapsedSlots = elapsedFrames / framesPerBar(timing);

  const cyclesCompleted = Math.floor(elapsedSlots / cycleLength);
  const phaseSlots = elapsedSlots - cyclesCompleted * cycleLength;

  return {
    origin: transport.origin,
    barCount: timing.barCount,
    cycleLength,
    cyclesCompleted,
    phaseSlots,
  };
}

/**
 * How far past the origin a slot sits, going forward and wrapping once.
 *
 * A slot outside the current cycle — every slot but one, in bar mode — lands at or beyond
 * `cycleLength`, which puts it past any reachable phase.
 */
export function cyclePosition(head: Playhead, slot: number): number {
  const n = head.barCount;
  return (((slot - head.origin) % n) + n) % n;
}

/**
 * Which slot the playhead is inside — the inverse of `cyclePosition`.
 *
 * `cyclePosition` answers "how far past the origin does this slot sit"; this answers "which slot
 * sits `phaseSlots` past the origin". Rendering needs the first, because it walks every slot and
 * asks about each. **Generating audio needs the second**, because it has to produce the one bar
 * that is playing — and the backing tracks are generated, not read from a file (§2.6).
 *
 * In bar mode `cycleLength` is 1, so this is the origin for as long as playback lasts. That is
 * the whole of bar preview: one slot, so one chord, held rather than walked.
 */
export function slotAt(head: Playhead): number {
  return (head.origin + Math.floor(head.phaseSlots)) % head.barCount;
}

/** Has the playhead crossed this slot in the current cycle? */
export function isPlayed(head: Playhead | undefined, slot: number): boolean {
  if (!head) return false;
  return cyclePosition(head, slot) < head.phaseSlots;
}

/**
 * Distance beyond the playhead for one line, in lines. Negative for lines not yet reached.
 *
 * Feeds the motion model (§3.4): height eases over a one-line window, colour over a
 * 2.5-line feather, so a crisp height edge trails a soft colour one. Both clamp, so the
 * exact magnitude past the window does not matter — the kit returns a saturated constant
 * for held lines and this returns the true distance, which renders identically.
 */
export function passedAt(
  head: Playhead | undefined,
  slot: number,
  lineIndex: number,
  linesPerBar: number,
): number {
  if (!head) return -1;
  const linePosition = cyclePosition(head, slot) * linesPerBar + lineIndex;
  return head.phaseSlots * linesPerBar - linePosition;
}

/**
 * Slots to release when playback stops (§3.6 rule 5).
 *
 * **Per slot, never global.** Releasing everything makes bars that never played flash;
 * releasing nothing leaves played bars stuck spent. Finishing a one-bar playback should
 * animate one bar.
 */
export function releaseSlots(head: Playhead | undefined): number[] {
  if (!head) return [];
  const out: number[] = [];
  for (let slot = 0; slot < head.barCount; slot++) {
    if (isPlayed(head, slot)) out.push(slot);
  }
  return out;
}

/**
 * Whether a cycle boundary was crossed between two frames — the moment the release
 * animation starts.
 *
 * The kit detects this with a `wrapped` flag flipped inside its own tick. That flag turns
 * out to be exactly `head < origin`, so as *state* it is redundant and the comparison above
 * replaces it. As an *edge detector* it is not redundant: it is what fires the release, and
 * dropping it leaves `isPlayed` perfectly correct while the 180 ms ease silently degrades
 * to a one-frame snap. Comparing completed-cycle counts is the same edge without the flag.
 */
export function completedCycleBetween(
  transport: Transport,
  previousFrames: number,
  currentFrames: number,
  timing: Timing,
): boolean {
  const before = playheadAt(transport, previousFrames, timing);
  const after = playheadAt(transport, currentFrames, timing);
  if (!before || !after) return false;
  return after.cyclesCompleted > before.cyclesCompleted;
}
