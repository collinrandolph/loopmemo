import type { ScheduledSegment } from '../../src/domain/schedule-plan.ts';

/**
 * Segment-scheduled layer playback (§2.4), the half the domain cannot do.
 *
 * `segments()` has already decided *which region of which file plays when*. Everything here is
 * the other half: turning those frame counts into scheduled buffer sources against one shared
 * clock. That split is why this file is short and why the interesting decisions are all
 * testable in Node without it.
 *
 * **It takes a `BaseAudioContext`, not an `AudioContext`, and that is the point.** The same code
 * runs against an `OfflineAudioContext`, which renders faster than real time into a buffer that
 * can be inspected sample by sample — so "do two segments join without a gap" stops being
 * something to listen for and becomes something to measure. `verify-joins.ts` is that
 * measurement.
 *
 * ## Two players per layer turns out to be an AVFoundation problem
 *
 * §0.4 and CLAUDE.md both call for "two alternating players per layer, so segment N+1 can
 * overlap the tail of N". That is a real constraint of `AVAudioPlayerNode`, where a player is a
 * long-lived object with a queue. Web Audio has no such object: an `AudioBufferSourceNode` is
 * one-shot and disposable, so every segment simply gets its own and overlaps are free. The
 * requirement does not need solving on this API — it dissolves. Worth stating rather than
 * quietly not implementing, because on a platform without that property it comes back.
 */

/** One `AudioBuffer` per recording session, indexed the way `SourceRegion.sessionIndex` is. */
export type SessionBuffers = readonly AudioBuffer[];

export type ScheduledVoice = {
  readonly segment: ScheduledSegment;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  /** Context time the segment's own frame 0 lands on. */
  readonly at: number;
};

/**
 * Equal-power fade curves.
 *
 * `cos` out against `sin` in, so the two sum to constant power through the overlap. Linear
 * ramps are the obvious thing and they are wrong: two linear ramps sum to 0.5 at the midpoint
 * rather than to unity power, which is a 3 dB dip on every bar line — the same argument that
 * makes the pan law equal-power in `effects.ts`.
 *
 * Built as curves rather than as ramps because `AudioParam` has no equal-power ramp;
 * `setValueCurveAtTime` takes an arbitrary shape, which is exactly what this needs.
 */
const CURVE_POINTS = 64;

function fadeCurve(rising: boolean): Float32Array {
  const curve = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const t = (i / (CURVE_POINTS - 1)) * (Math.PI / 2);
    curve[i] = rising ? Math.sin(t) : Math.cos(t);
  }
  return curve;
}

const FADE_IN = fadeCurve(true);
const FADE_OUT = fadeCurve(false);

/**
 * Schedule one layer's segments.
 *
 * `anchorTime` is the context time that arrangement frame 0 sits on, and every segment derives
 * from it rather than from "now" — one shared anchor is what keeps seven layers together
 * (§0.4), and it is also what makes an offline render reproducible.
 *
 * **A segment plays `crossfadeFrames` past its own bar and the next one starts exactly on the
 * boundary.** That is what produces a real overlap without moving any bar off its beat: the
 * extra frames come from the outgoing region's own source, which in a live recording is simply
 * the next bar the player played, so the tail is real material rather than padding. Clamped to
 * what the file holds, so the last bar of a recording fades against silence instead of reading
 * past the end.
 *
 * **The crossfade is unconditional** (§2.4), including a splice into the same source. Bar
 * boundaries in a live recording almost never land on silence, so an unfaded join is a step
 * discontinuity — audible as a click even when both sides come from one continuous take.
 *
 * `crossfadeFrames` of 0 disables it entirely and joins the segments butt-to-butt. That is not
 * a mode anyone should play in; it exists so the join can be measured against the source
 * without a fade in the way.
 */
export function scheduleSegments(
  ctx: BaseAudioContext,
  destination: AudioNode,
  segs: readonly ScheduledSegment[],
  buffers: SessionBuffers,
  anchorTime: number,
  crossfadeFrames: number,
): ScheduledVoice[] {
  const rate = ctx.sampleRate;
  const out: ScheduledVoice[] = [];

  // How much material each segment has on either side of its own bar. Both are needed, because
  // which one carries a join depends on what exists — see `joinWindow`.
  const room = segs.map((segment) => {
    const buffer = buffers[segment.region.sessionIndex];
    if (!buffer) return undefined;
    const end = segment.region.startFrame + segment.region.frameCount;
    return {
      buffer,
      before: Math.max(0, Math.min(crossfadeFrames, segment.region.startFrame)),
      after: Math.max(0, Math.min(crossfadeFrames, buffer.length - end)),
    };
  });

  /** Two segments meet only if the second begins exactly where the first stops. */
  const abuts = (i: number) =>
    i + 1 < segs.length &&
    segs[i + 1]!.startFrame === segs[i]!.startFrame + segs[i]!.region.frameCount;

  /**
   * Where the crossfade for the join after segment `i` sits, relative to the boundary.
   *
   * **After the boundary when the outgoing segment has a tail**, which is the common case and
   * the better one: the tail is the next bar the player actually played, so the overlap is real
   * material and the incoming bar is heard from its first frame.
   *
   * **Before the boundary when it does not** — the outgoing bar is the last in its recording, so
   * there is nothing after it to fade. The outgoing then fades out inside its own final
   * milliseconds and the incoming starts early on its pre-roll, arriving at full gain exactly on
   * the beat. Timing is preserved either way, because the incoming's offset moves with its start.
   *
   * Zero when neither has room, which is only reachable when a recording's last bar is followed
   * by the very first bar of a recording. There is then nothing to fade against and the join is
   * a butt join; that is a real limit of the material rather than something to paper over.
   */
  function joinWindow(i: number): { after: number; before: number } {
    if (!abuts(i)) return { after: room[i]?.after ?? 0, before: 0 };
    const outgoing = room[i]!.after;
    if (outgoing >= crossfadeFrames) return { after: crossfadeFrames, before: 0 };
    const incoming = room[i + 1]!.before;
    if (incoming > 0) return { after: 0, before: Math.min(incoming, crossfadeFrames) };
    return { after: outgoing, before: 0 };
  }

  for (let i = 0; i < segs.length; i++) {
    const segment = segs[i]!;
    const space = room[i];
    if (!space) continue; // the session has no audio loaded; the schedule is ahead of the files

    // The join behind me decides whether I start early, and the join ahead of me decides
    // whether I run late. A segment is only ever asked for material it has.
    const lead = i > 0 && abuts(i - 1) ? joinWindow(i - 1).before : 0;
    const trail = joinWindow(i).after;

    const frames = segment.region.frameCount + lead + trail;
    if (frames <= 0) continue;

    const at = anchorTime + segment.startFrame / rate;
    const from = at - lead / rate;

    const source = ctx.createBufferSource();
    source.buffer = space.buffer;
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(destination);

    if (crossfadeFrames > 0) {
      // Fading in over `lead` when there is a lead, and over the head of the bar otherwise, so
      // the two sides of every join ramp within one shared window rather than two adjacent ones.
      // Two adjacent windows are not a crossfade — they are a fade to silence and back.
      const fadeIn = (lead > 0 ? lead : Math.min(crossfadeFrames, segment.region.frameCount)) / rate;
      const fadeOut = (trail > 0 ? trail : Math.min(crossfadeFrames, segment.region.frameCount)) / rate;
      // Out over the tail when there is one; otherwise inside the bar's own last milliseconds.
      const outAt = at + (segment.region.frameCount - (trail > 0 ? 0 : fadeOut * rate)) / rate;
      gain.gain.setValueCurveAtTime(FADE_IN, from, fadeIn);
      gain.gain.setValueCurveAtTime(FADE_OUT, outAt, fadeOut);
    }

    source.start(from, (segment.region.startFrame - lead) / rate, frames / rate);
    out.push({ segment, source, gain, at });
  }

  return out;
}
