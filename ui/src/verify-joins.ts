import { barRef } from '../../src/domain/bar-ref.ts';
import { type RecordingSession, passIndex, regionFor } from '../../src/domain/pass-index.ts';
import { segments } from '../../src/domain/schedule-plan.ts';
import { type Timing, framesPerBar, loopFrames, timing } from '../../src/domain/timing.ts';
import { scheduleSegments } from './layer-audio.ts';

/**
 * Does §2.4 actually hold? Measured, not listened to.
 *
 * `docs/platform-decision.md` §8 lists six things that need a physical device, and says the
 * first "decides whether the architecture holds at all": do two buffer sources scheduled back
 * to back against one clock join without a gap or a click? If they do not, segment-scheduled
 * playback is not viable and everything downstream changes.
 *
 * It turns out four of those six are answerable on a development machine with no device and no
 * money, because `OfflineAudioContext` renders the same graph faster than real time into a
 * buffer that can be read sample by sample. That is a stronger check than listening on
 * hardware, not a weaker one: "no audible click" is a judgement, and "the rendered output is
 * bit-identical to the source region" is not.
 *
 * **Run it from the browser console**, since Node has no Web Audio:
 *
 * ```js
 * (await import('/ui/dist/ui/src/verify-joins.js')).verifyJoins().then(console.log)
 * ```
 *
 * What it cannot answer is the real-time half: an offline render has no output device, no
 * buffer underruns and no scheduling jitter, so a clean result here means the *arithmetic* and
 * the API are sound, not that a phone keeps up. That part still needs hardware, and it is a far
 * smaller question than whether the design works.
 */

const BPM = 96;
const BARS = 8;
const RATE = 44100;
const PASSES = 2;

function fixture(): { t: Timing; sessions: readonly RecordingSession[] } {
  const t = timing(BPM, BARS, RATE, 4);
  return {
    t,
    sessions: [
      {
        id: 'verify',
        audioFileURL: 'verify://take',
        recordedFrames: loopFrames(t) * PASSES,
        recordedAt: '2026-08-31T00:00:00.000Z',
        waveformPeaks: [],
      },
    ],
  };
}

/**
 * `copyToChannel` will not take a view over a `SharedArrayBuffer`, so the samples have to be
 * typed as plainly backed. Annotated rather than cast: the constructor really does allocate an
 * ordinary `ArrayBuffer`, so this states a fact instead of overriding one.
 */
type Samples = Float32Array<ArrayBuffer>;

/**
 * A deterministic PRNG, so a rerun compares the same material and a failure can be chased.
 * `Math.random` would make every run a different experiment.
 *
 * Noise rather than a tone for the accuracy tests, because it makes a coincidence impossible:
 * two different frames of a sine can hold the same value, so a one-sample slip could pass. Two
 * different frames of noise cannot.
 */
function noise(length: number): Samples {
  const out = new Float32Array(length);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return out;
}

/**
 * A single ramp across the whole take, for the click test.
 *
 * **Not a tone, and the first attempt at this was worthless because it was one.** 220 Hz at
 * 110,250 frames per bar is exactly 550 cycles, so every bar boundary falls on the same phase
 * and a butt join is continuous no matter which bars are joined — the test reported no click
 * because there was none to find, not because the crossfade did anything. Any *integer*
 * frequency has this problem here, landing on a whole or half cycle per bar.
 *
 * A ramp has no period to align with. Its value encodes absolute position in the take, so
 * joining two non-adjacent bars is a step of exactly their distance apart, while the signal's
 * own sample-to-sample slope is 2/length — six orders of magnitude smaller. That makes the
 * discontinuity unmissable and the baseline unambiguous.
 */
function ramp(length: number): Samples {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = (i / (length - 1)) * 2 - 1;
  return out;
}

function bufferOf(ctx: BaseAudioContext, data: Samples): AudioBuffer {
  const buffer = ctx.createBuffer(1, data.length, RATE);
  buffer.copyToChannel(data, 0);
  return buffer;
}

async function render(
  t: Timing,
  sessions: readonly RecordingSession[],
  arrangement: ReturnType<typeof barRef>[],
  material: Samples,
  crossfadeFrames: number,
  muted: readonly number[] = [],
): Promise<Float32Array> {
  const frames = loopFrames(t);
  const ctx = new OfflineAudioContext(1, frames, RATE);
  const index = passIndex(sessions, t);
  const segs = segments(arrangement, index, 0, t.barCount, muted);
  scheduleSegments(ctx, ctx.destination, segs, [bufferOf(ctx, material)], 0, crossfadeFrames);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

/** Worst single-sample disagreement, and where it first exceeds the float noise floor. */
function compare(got: Float32Array, want: Float32Array) {
  let worst = 0;
  let firstBad = -1;
  let badCount = 0;
  const limit = Math.min(got.length, want.length);
  for (let i = 0; i < limit; i++) {
    const d = Math.abs(got[i]! - want[i]!);
    if (d > worst) worst = d;
    if (d > 1e-6) {
      badCount++;
      if (firstBad < 0) firstBad = i;
    }
  }
  return { worstAbsDiff: worst, framesDiffering: badCount, firstDifferingFrame: firstBad };
}

/** Largest sample-to-sample step inside a window around each bar boundary. */
function maxStepAtJoins(data: Float32Array, t: Timing, radius = 4): number {
  const perBar = framesPerBar(t);
  let worst = 0;
  for (let slot = 1; slot < t.barCount; slot++) {
    const edge = slot * perBar;
    for (let i = Math.max(1, edge - radius); i < Math.min(data.length, edge + radius); i++) {
      worst = Math.max(worst, Math.abs(data[i]! - data[i - 1]!));
    }
  }
  return worst;
}

/** The same measurement well away from any boundary, as the baseline it has to be judged against. */
function maxStepWithinBars(data: Float32Array, t: Timing): number {
  const perBar = framesPerBar(t);
  let worst = 0;
  for (let slot = 0; slot < t.barCount; slot++) {
    const from = slot * perBar + 64;
    const to = Math.min(data.length, (slot + 1) * perBar - 64);
    for (let i = from + 1; i < to; i++) worst = Math.max(worst, Math.abs(data[i]! - data[i - 1]!));
  }
  return worst;
}

function rms(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  const a = Math.max(0, from);
  const b = Math.min(data.length, to);
  for (let i = a; i < b; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / Math.max(1, b - a));
}

/**
 * Energy through each join, against the same width of the same bar well away from it.
 *
 * A step and a hole are different failures and only the first is a click. Where a join has
 * neither an outgoing tail nor an incoming pre-roll — the last bar of a recording followed by
 * the first bar of one — the two fades cannot share a window, so they run back to back and the
 * sum passes through zero. That is inaudible as a click and audible as a dip, so it needs its
 * own number rather than a note.
 */
function joinEnergy(data: Float32Array, t: Timing, half: number) {
  const perBar = framesPerBar(t);
  return Array.from({ length: t.barCount - 1 }, (_, k) => {
    const edge = (k + 1) * perBar;
    const here = rms(data, edge - half, edge + half);
    const away = rms(data, edge + perBar / 2 - half, edge + perBar / 2 + half);
    return Number((here / away).toFixed(3));
  });
}

export async function verifyJoins() {
  const { t, sessions } = fixture();
  const perBar = framesPerBar(t);
  const frames = loopFrames(t);
  const index = passIndex(sessions, t);
  const material = noise(sessions[0]!.recordedFrames);

  // ---- A. In recorded order, no crossfade: the render must reproduce the take exactly. ----
  const inOrder = Array.from({ length: BARS }, (_, i) => barRef(1, i + 1));
  const a = compare(await render(t, sessions, inOrder, material, 0), material.subarray(0, frames));

  // ---- B. Reordered, no crossfade: every slot must carry its own source region, exactly. ----
  // Deliberately mixes passes and jumps around, which is the feature (§1.1) rather than a
  // degenerate case: slot 0 plays pass 2's bar 5, and so on.
  const shuffled = [
    barRef(2, 5), barRef(1, 3), barRef(2, 8), barRef(1, 1),
    barRef(2, 2), barRef(1, 7), barRef(1, 4), barRef(2, 6),
  ];
  const wantShuffled = new Float32Array(frames);
  shuffled.forEach((ref, slot) => {
    const region = regionFor(index, ref)!;
    for (let j = 0; j < Math.min(region.frameCount, perBar); j++) {
      wantShuffled[slot * perBar + j] = material[region.startFrame + j]!;
    }
  });
  const b = compare(await render(t, sessions, shuffled, material, 0), wantShuffled);

  // ---- C. The click, and whether the crossfade removes it. ----
  // Judged as a reduction rather than against the signal's own slope. A step spread over 309
  // samples is not a click even though it is still, summed, the same distance travelled — so
  // the question is by what factor the worst single-sample jump comes down, not whether it
  // reaches the noise floor of a ramp.
  const smooth = ramp(sessions[0]!.recordedFrames);
  const XF = Math.round(0.007 * RATE); // 7 ms, inside §2.4's 5-10 ms
  const butt = await render(t, sessions, shuffled, smooth, 0);
  const faded = await render(t, sessions, shuffled, smooth, XF);
  const buttStep = maxStepAtJoins(butt, t);
  const fadedStep = maxStepAtJoins(faded, t);

  // ---- E. Does the crossfade hold its level, or dig a hole? ----
  // Noise, because RMS over a ramp is dominated by where in the ramp the window sits.
  const fadedNoise = await render(t, sessions, shuffled, material, XF);
  const energy = joinEnergy(fadedNoise, t, XF);

  // ---- D. A muted slot is a rest, and the bars after it do not move up. ----
  const mutedRender = await render(t, sessions, inOrder, material, 0, [3]);
  const wantMuted = new Float32Array(frames);
  wantMuted.set(material.subarray(0, frames));
  wantMuted.fill(0, 3 * perBar, 4 * perBar);
  const d = compare(mutedRender, wantMuted);

  return {
    fixture: { bpm: BPM, bars: BARS, sampleRate: RATE, framesPerBar: perBar, loopFrames: frames },
    A_recordedOrder: { ...a, pass: a.framesDiffering === 0 },
    B_reordered: { ...b, pass: b.framesDiffering === 0 },
    C_click: {
      signalBaselineStep: maxStepWithinBars(butt, t),
      stepAtJoinsButtJoined: buttStep,
      stepAtJoinsCrossfaded: fadedStep,
      reductionFactor: fadedStep > 0 ? buttStep / fadedStep : Infinity,
      crossfadeFrames: XF,
      pass: fadedStep * 10 < buttStep,
    },
    D_mutedSlotIsARest: { ...d, pass: d.framesDiffering === 0 },
    E_levelThroughJoins: {
      // One per bar line, as a ratio against the same bar away from the join. 1.0 is level.
      ratioPerJoin: energy,
      worst: Math.min(...energy),
      // The join with no material on either side is expected to dip; nothing should be near
      // silent, and nothing should bulge, which is what a double-counted overlap would do.
      pass: Math.min(...energy) > 0.6 && Math.max(...energy) < 1.25,
    },
  };
}
