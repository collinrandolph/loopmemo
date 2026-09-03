import type { BackingTracks } from './backing.ts';
import { backingBar, chordRingSeconds } from './backing-schedule.ts';
import { haasDelayFrames, isStereoPreset, panPreset } from './effects.ts';
import type { Layer } from './project.ts';
import { type Timing, framesPerBar } from './timing.ts';

/**
 * How far past the loop point anything can still be sounding (§2.6, §2.8).
 *
 * A loop is a loop: when it comes round, whatever is still ringing carries over the start, and
 * live that needs no arithmetic. A **rendered file is a fixed length**, so the same audio is cut
 * instead — and played on repeat that is a seam the live loop never had. This is the number a
 * render has to add and fold back onto the head to avoid one (`wrapTail`).
 *
 * **Deliberately the project's worst case, not a per-file figure.** Over-wrapping is free: the
 * frames past what is actually sounding are silence, and adding silence to the head changes
 * nothing. A per-file figure would be three more code paths to keep in agreement for no audible
 * difference.
 *
 * Three sources, and they are not the same size — at 84 BPM a Haas delay is 35 ms and an
 * off-beat chord pattern with a Rhodes overhangs by 307 ms, so counting only the delay (which
 * `BouncePlan.tailFrames` did) wraps an eighth of the problem.
 */

/**
 * Chords overhang **by design**. `chordRingSeconds` caps a ring to the gap before the next onset,
 * wrapping past the bar line — so for a pattern whose first onset is not the downbeat, the last
 * chord is deliberately allowed to ring into the next bar, to where the next onset lands.
 */
function chordTailFrames(backing: BackingTracks, t: Timing): number {
  if (backing.chords.muted) return 0;
  // The last bar of the loop, since that is the one whose overhang crosses the loop point. Its
  // chord differs from bar 1's, but the *pattern* — which is what decides the overhang — does not.
  const bar = backingBar(backing, t, t.barCount);
  const rings = chordRingSeconds(bar, t);
  const perBar = framesPerBar(t);

  let worst = 0;
  bar.chords.forEach((onset, i) => {
    const ring = Math.min(onset.nominalFrames, Math.round((rings[i] ?? 0) * t.sampleRate));
    worst = Math.max(worst, onset.frameOffset + ring - perBar);
  });
  return Math.max(0, worst);
}

/**
 * Drums overhang **more as the tempo rises**, which reads backwards until you remember that
 * envelope times are seconds and bars are musical: a 0.35 s open hat finishes inside a 2.86 s bar
 * at 84 BPM and hangs 183 ms past a 1.33 s bar at 180.
 *
 * Uncapped, unlike chords — kick and snare overlap and the hat chokes (§2.6), so a voice's
 * nominal length is what it actually rings.
 */
function drumTailFrames(backing: BackingTracks, t: Timing): number {
  if (backing.drums.muted) return 0;
  const bar = backingBar(backing, t, t.barCount);
  const perBar = framesPerBar(t);

  let worst = 0;
  for (const onset of bar.drums) {
    worst = Math.max(worst, onset.frameOffset + onset.nominalFrames - perBar);
  }
  return Math.max(0, worst);
}

/** A Surround layer's delayed copy of the last bar arrives after the loop point (§2.8). */
function layerTailFrames(layers: readonly Layer[], t: Timing): number {
  const delayed = layers.some(
    (l) => !l.muted && l.sessions.length > 0 && isStereoPreset(panPreset(l.pan)),
  );
  return delayed ? haasDelayFrames(t) : 0;
}

/**
 * The frames a fixed-length render must add and wrap, for a mixdown of these layers over this
 * backing. Pass no backing for a render that excludes it — a bounce (§2.7), or a dry stem.
 */
export function loopTailFrames(
  layers: readonly Layer[],
  t: Timing,
  backing?: BackingTracks,
): number {
  return Math.max(
    layerTailFrames(layers, t),
    backing ? chordTailFrames(backing, t) : 0,
    backing ? drumTailFrames(backing, t) : 0,
  );
}
