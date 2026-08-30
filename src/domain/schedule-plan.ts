import { type MutedSlots, isSlotMuted } from './arrangement.ts';
import type { BarRef } from './bar-ref.ts';
import { type PassIndex, type SourceRegion, regionFor } from './pass-index.ts';
import { framesPerBar } from './timing.ts';

/**
 * What to hand the audio engine, decided without touching it.
 *
 * Segment-scheduled playback (§2.4) is two separable jobs: working out which regions of
 * which files play when, and calling the platform's scheduling API to make it happen. The
 * first is arithmetic and lives here, where it can be tested on any machine. The second is
 * whatever the platform provides — `AVAudioPlayerNode.scheduleSegment` or Web Audio's
 * `AudioBufferSourceNode.start(when, offset, duration)` — and stays deliberately thin.
 */
export type ScheduledSegment = {
  /** Position in the arrangement. Playback progress indexes on this (§1.1). */
  readonly slot: number;
  /** Where the audio comes from. Colour indexes on this. Never the same thing. */
  readonly source: BarRef;
  /** The physical range, resolved against the owning session's own file. */
  readonly region: SourceRegion;
  /** Frame at which this segment starts, relative to the shared anchor. */
  readonly startFrame: number;
};

/**
 * The next `count` slots from `slot`, wrapping around the arrangement.
 *
 * The horizon is kept short on purpose (§2.4): everything committed to the engine is work a
 * live edit has to either wait out or tear down, so a splice is never far behind the gesture.
 *
 * Slots whose source has no audio are **skipped, not silenced with a shorter segment** — a
 * gap in the available set means that bar was never recorded, and the arrangement should not
 * have pointed at it.
 *
 * `startFrame` keeps counting past the end of the loop rather than resetting, so the engine
 * schedules forward in time across the wrap.
 */
export function segments(
  arrangement: readonly BarRef[],
  index: PassIndex,
  fromSlot: number,
  count: number,
  muted: MutedSlots,
): ScheduledSegment[] {
  if (arrangement.length === 0 || count <= 0) return [];

  const perBar = framesPerBar(index.timing);
  const out: ScheduledSegment[] = [];

  for (let step = 0; step < count; step++) {
    const absolute = fromSlot + step;
    const wrapped = ((absolute % arrangement.length) + arrangement.length) % arrangement.length;

    // A muted slot is a rest, not a deletion: nothing is scheduled, and the slots after it
    // keep the start frames they already had, because those come from the absolute position
    // rather than from what was queued before them. Time advances through the silence.
    if (isSlotMuted(muted, wrapped)) continue;

    const source = arrangement[wrapped]!;
    const region = regionFor(index, source);
    if (!region) continue;
    out.push({ slot: wrapped, source, region, startFrame: absolute * perBar });
  }
  return out;
}

/**
 * Where a mid-bar splice should enter the new source (§2.5).
 *
 * Swiping the bar that IS playing splices immediately: two beats into bar 5 becomes two
 * beats into the alternate pass of bar 5. Mid-bar splice is what makes hunting viable —
 * committing at the boundary would force the user to wait out the rest of every bar before
 * hearing a comparison.
 *
 * Returns undefined when the splice should be skipped and the natural boundary left to
 * handle it: either the bar has no audio, or the playhead is inside the tail guard, where
 * the remaining region would be shorter than the crossfade.
 */
export function splice(
  source: BarRef,
  index: PassIndex,
  offsetInBar: number,
  crossfadeFrames: number,
): SourceRegion | undefined {
  const perBar = framesPerBar(index.timing);
  if (offsetInBar < 0 || offsetInBar >= perBar) return undefined;
  if (perBar - offsetInBar <= crossfadeFrames) return undefined;

  const region = regionFor(index, source);
  if (!region) return undefined;

  const remaining = region.frameCount - offsetInBar;
  if (remaining <= crossfadeFrames) return undefined;

  return {
    sessionIndex: region.sessionIndex,
    startFrame: region.startFrame + offsetInBar,
    frameCount: remaining,
  };
}
