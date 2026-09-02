import type { ScheduledSegment } from '../../src/domain/schedule-plan.ts';

/**
 * Segment-scheduled layer playback (§2.4), the half the domain cannot do: `segments()` decides
 * which region of which file plays when, and this turns those frame counts into scheduled buffer
 * sources against one shared clock.
 *
 * **A `BaseAudioContext`, not an `AudioContext`**, so the same code runs against an
 * `OfflineAudioContext` and a join can be measured sample by sample rather than listened for.
 * `verify-joins.ts` is that measurement.
 *
 * **§0.4's "two alternating players per layer" is an AVFoundation constraint, not a requirement.**
 * An `AudioBufferSourceNode` is one-shot, so every segment gets its own and overlaps are free. It
 * comes back on a platform where a player is a long-lived queued object.
 */

/**
 * One `AudioBuffer` per recording session, indexed the way `SourceRegion.sessionIndex` is.
 *
 * Entries may be missing, and that is a real state rather than an error: a demo project's
 * simulated takes have no audio behind them, and a reload loses what was captured. A layer then
 * plays the bars it can and skips the rest, which is better than refusing to play at all.
 */
export type SessionBuffers = readonly (AudioBuffer | undefined)[];

export type ScheduledVoice = {
  readonly segment: ScheduledSegment;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  /** Context time the segment's own frame 0 lands on. */
  readonly at: number;
  /** Context time it stops, tail included. Kept so a splice knows what is still sounding. */
  readonly endsAt: number;
};

/**
 * Drop a segment that has not started yet — the queued half of a re-plan. No fade, because it is
 * silent until its start time. `retire` is what a *sounding* segment needs.
 */
export function cancel(voice: ScheduledVoice): void {
  try {
    voice.source.stop();
  } catch {
    /* already stopped */
  }
  try {
    voice.source.disconnect();
    voice.gain.disconnect();
  } catch {
    /* already disconnected */
  }
}

/**
 * Take a sounding segment down over one crossfade and stop it — the outgoing half of a mid-bar
 * splice (§2.5).
 *
 * `cancelAndHoldAtTime`, not `cancelScheduledValues`: the voice may be part-way through its own
 * fade, and holding the value it has reached is what makes the hand-off continuous. Cancelling
 * snaps back to whatever was last set explicitly, which is a click.
 */
export function retire(voice: ScheduledVoice, at: number, fadeSeconds: number): void {
  voice.gain.gain.cancelAndHoldAtTime(at);
  voice.gain.gain.setValueCurveAtTime(FADE_OUT, at, fadeSeconds);
  try {
    voice.source.stop(at + fadeSeconds);
  } catch {
    /* already stopped */
  }
}

/**
 * Equal-power fade curves: `cos` out against `sin` in, so the two sum to constant power through
 * the overlap. Two linear ramps sum to 0.5 at the midpoint — a 3 dB dip on every bar line.
 * Curves rather than ramps because `AudioParam` has no equal-power ramp.
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
 * `anchorTime` is the context time arrangement frame 0 sits on, and every segment derives from it
 * rather than from "now" — one shared anchor keeps seven layers together (§0.4) and makes an
 * offline render reproducible.
 *
 * **A segment plays `crossfadeFrames` past its own bar and the next starts on the boundary**, so
 * the overlap is real material — the next bar the player actually played — and no bar moves off
 * its beat. Clamped to what the file holds.
 *
 * **The crossfade is unconditional** (§2.4), including a splice into the same source: bar
 * boundaries in a live recording rarely land on silence, so an unfaded join is a step
 * discontinuity. `crossfadeFrames` of 0 joins butt-to-butt, which exists only so a join can be
 * measured against the source without a fade in the way.
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
   * Where the crossfade after segment `i` sits, relative to the boundary.
   *
   * **After it when the outgoing segment has a tail** — the common case, and the better one: the
   * overlap is real material and the incoming bar is heard from its first frame.
   *
   * **Before it when there is no tail**, i.e. the outgoing bar is last in its recording. The
   * incoming then starts early on its pre-roll and reaches full gain on the beat, so timing holds
   * either way. Zero when neither has room, which is a butt join and a limit of the material.
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
    out.push({ segment, source, gain, at, endsAt: from + frames / rate });
  }

  return out;
}
