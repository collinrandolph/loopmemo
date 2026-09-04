import { framesPerBar, loopFrames } from './timing.ts';
import type { Timing } from './timing.ts';

/**
 * The count-in (§4.6, §5.1 #3).
 *
 * **It is never recorded.** §5.1 #3 states the constraint the whole feature turns on: "the
 * session's first frame is the downbeat of Pass 1, or every boundary is offset by a bar." Every
 * derived quantity — `passExists`, `regionFor`, pass numbering, the arrangement — measures from
 * that first frame, so a count-in that leaked into the captured audio would move every bar line
 * in the app by a bar. The count-in is therefore *time the transport spends before the take*,
 * not audio at the head of it.
 *
 * **It is a preference, not project state.** It never touches the audio, so it needs no
 * per-project snapshot, and it belongs to how a person likes to start playing rather than to any
 * one sketch — the same argument as the monitoring level.
 *
 * There is deliberately no click. §5.1 #8 rules out a metronome because every project already has
 * a drum track, so the count-in is *the loop itself*, played from `countInStartFrame` into its own
 * wrap: the downbeat you record onto is a real bar line rather than a cue that stops. `mode`
 * chooses how much of it you hear.
 */

export const COUNT_IN_BAR_OPTIONS = [0, 1, 2, 3, 4] as const;
export type CountInBars = (typeof COUNT_IN_BAR_OPTIONS)[number];

/**
 * - `loop` — the last bars of the arrangement, exactly as they will sound: drums, chords and
 *   every audible layer. You hear what you are joining, which is what an overdub needs.
 * - `drums` — the drum track alone over those bars. Closer to a click, and it keeps a busy
 *   arrangement from burying the beat you are counting against.
 */
export const COUNT_IN_MODES = ['loop', 'drums'] as const;
export type CountInMode = (typeof COUNT_IN_MODES)[number];

export type CountIn = { readonly bars: CountInBars; readonly mode: CountInMode };

/** One bar of the full loop: enough to place the downbeat, short enough not to be a wait. */
export const COUNT_IN_DEFAULT: CountIn = { bars: 1, mode: 'loop' };

export function countInFrames(bars: CountInBars, t: Timing): number {
  return bars * framesPerBar(t);
}

/**
 * Where the transport starts so that the downbeat arrives after `bars` bars.
 *
 * The count-in runs over the **tail of the loop**, ending at the loop point — so the take begins
 * exactly where it always did, on the wrap, and `loopFrames(t)` is the downbeat in engine frames.
 *
 * It can never be negative: bar counts start at 4 (§1.2) and the count-in caps at 4, so the
 * longest count-in is exactly one shortest loop. `tests/count-in.test.ts` sweeps that.
 */
export function countInStartFrame(bars: CountInBars, t: Timing): number {
  return loopFrames(t) - countInFrames(bars, t);
}
