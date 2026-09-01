import { type BarRef, barRef } from './bar-ref.ts';
import {
  type Timing,
  barExists,
  frameOffsetInLoop,
  framesPerBar,
  loopFrames,
  passCount,
} from './timing.ts';

/**
 * One continuous recording onto a layer, aligned to the loop grid at its own start.
 *
 * Recording always begins at the top of the loop, so frame 0 of this file is the downbeat
 * of *this session's* first pass — not of the layer's first pass. Sessions are never
 * concatenated into one timeline (§1.4).
 */
export type RecordingSession = {
  readonly id: string;
  readonly audioFileURL: string;
  readonly recordedFrames: number;
  readonly recordedAt: string;
  readonly waveformPeaks: readonly number[];
};

/**
 * Where a bar's audio physically is: which session file, and what range of it.
 *
 * `startFrame` is an offset **within that session's file**. Pass numbers are global across
 * a layer's sessions; frame offsets are session-local. Converting one to the other is the
 * single easiest thing in this codebase to get wrong — an earlier implementation derived
 * the offset from the absolute bar number across the whole layer and asked for frame
 * 5,292,000 of a 3,528,000-frame file. So it happens in exactly one place, `regionFor`,
 * and it is tested.
 */
export type SourceRegion = {
  readonly sessionIndex: number;
  readonly startFrame: number;
  readonly frameCount: number;
};

/**
 * A layer's sessions, indexed for pass lookup.
 *
 * Pass numbering, availability, region lookup and axis stepping all derive from a **single**
 * walk of session order, computed once here. An earlier version counted passes one way for a
 * layer's total and another way for availability; two derivations of the same quantity are
 * how they drift apart (§1.5).
 *
 * Nothing about a pass is stored (§1.4). A pass exists if its audio exists, so a freshly
 * recorded layer, a compressed one, a bounced one and an imported one are all handled
 * identically — no counter to maintain, no flag to clear.
 */
export type PassIndex = {
  readonly timing: Timing;
  readonly sessions: readonly RecordingSession[];
  /** `firstPass[i]` = 1 + Σ passCount(sessions[0..i-1])   (§1.4) */
  readonly firstPass: readonly number[];
};

export function passIndex(sessions: readonly RecordingSession[], t: Timing): PassIndex {
  const firstPass: number[] = [];
  let next = 1;
  for (const session of sessions) {
    firstPass.push(next);
    next += passCount(t, session.recordedFrames);
  }
  return { timing: t, sessions, firstPass };
}

/** Total passes this layer holds, partial ones included. */
export function totalPasses(index: PassIndex): number {
  let total = 0;
  for (const session of index.sessions) {
    total += passCount(index.timing, session.recordedFrames);
  }
  return total;
}

export function isEmpty(index: PassIndex): boolean {
  return index.sessions.length === 0;
}

/** Which session owns a global pass number, and that pass's index within it. */
function locate(
  index: PassIndex,
  pass: number,
): { sessionIndex: number; localPass: number } | undefined {
  if (pass < 1) return undefined;
  for (let i = 0; i < index.sessions.length; i++) {
    const session = index.sessions[i]!;
    const count = passCount(index.timing, session.recordedFrames);
    const local = pass - index.firstPass[i]!;
    if (local >= 0 && local < count) {
      return { sessionIndex: i, localPass: local + 1 };
    }
  }
  return undefined;
}

/**
 * Every pass that has audio for this bar position, ascending.
 *
 * **The set can be non-contiguous** (§1.4). A session that stopped after 8 bars of a 16-bar
 * loop gives bar 1 a pass that bar 12 does not have, so a later session's passes sit on the
 * far side of a real gap. A tile can legitimately read `P4` with no `P3` behind it, and the
 * number preserves provenance.
 */
export function availablePasses(index: PassIndex, relativeBar: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < index.sessions.length; i++) {
    const frames = index.sessions[i]!.recordedFrames;
    const count = passCount(index.timing, frames);
    for (let local = 1; local <= count; local++) {
      if (barExists(index.timing, local, relativeBar, frames)) {
        out.push(index.firstPass[i]! + local - 1);
      }
    }
  }
  return out;
}

/**
 * Resolve a BarRef to the physical audio behind it.
 *
 * Returns undefined when that bar was never recorded — a gap in the available set, or a
 * pass number past the end of the layer.
 *
 * ## `offsetFrames` — the recording offset (§2.3)
 *
 * The player hears the backing late, plays in time with what they heard, and their sound reaches
 * the capture late again. The correction is to read this bar from **further into** the take:
 * everything the performer did lands `offsetFrames` earlier than it arrived, which is the
 * direction that puts it back on the beat.
 *
 * **It is applied here and nowhere else**, for the same reason session-local frame offsets are
 * computed here and nowhere else. This function is already the single conversion from a `BarRef`
 * to a session and a frame range, and a second place that adds frames to a read position is
 * precisely the drift that once asked for frame 5,292,000 of a 3,528,000-frame file.
 *
 * It deliberately does **not** touch `barExists` above. Whether a bar was reached is a fact about
 * the recording, decided by the transport at capture, and it has to give the same answer at every
 * offset — otherwise moving the control would renumber passes and change the pass count of a take
 * that is already on disk. The offset moves where the audio is *read from*, never what exists.
 *
 * The clamp below absorbs the consequence: the last bar of a session runs `offsetFrames` short,
 * because there genuinely is no audio past the end of the take. That is at most 250 ms of a bar
 * and it is the honest answer — the alternative is padding silence and calling it a performance.
 */
export function regionFor(
  index: PassIndex,
  ref: BarRef,
  offsetFrames = 0,
): SourceRegion | undefined {
  const located = locate(index, ref.pass);
  if (!located) return undefined;

  const t = index.timing;
  const frames = index.sessions[located.sessionIndex]!.recordedFrames;
  if (!barExists(t, located.localPass, ref.relativeBar, frames)) return undefined;

  const startFrame =
    (located.localPass - 1) * loopFrames(t) +
    frameOffsetInLoop(t, ref.relativeBar) +
    Math.max(0, offsetFrames);

  // Clamp to what is actually on disk. This is load-bearing, not defensive: `barExists`
  // admits a bar the recording only reached partway into, and this is what makes such a bar
  // behave like an ordinary one — it plays the audio that exists and stops. Nothing is
  // padded, so no silence is ever written to represent the remainder (§5.1 #5's real point).
  const available = frames - startFrame;
  if (available <= 0) return undefined;

  return {
    sessionIndex: located.sessionIndex,
    startFrame,
    frameCount: Math.min(framesPerBar(t), available),
  };
}

export function hasAudio(index: PassIndex, ref: BarRef): boolean {
  return regionFor(index, ref) !== undefined;
}

/**
 * Step the vertical axis, wrapping through the passes that exist for **this bar**.
 *
 * §1.4: the swipe wraps through the available set for the bar being swiped, skipping absent
 * passes rather than assuming a contiguous range. Returns undefined when the bar has no
 * audio at all, and the same ref when it has exactly one pass — which is also the state
 * that disables the axis entirely on the Edit Layer screen (§4.3), derived from audio
 * rather than from a flag.
 */
export function steppingPass(
  index: PassIndex,
  ref: BarRef,
  delta: number,
): BarRef | undefined {
  const passes = availablePasses(index, ref.relativeBar);
  if (passes.length === 0) return undefined;

  const current = passes.indexOf(ref.pass);
  if (current < 0) {
    // The current pass has no audio here; land on the nearest one that does.
    const forward = passes.find((p) => p > ref.pass);
    return barRef(forward ?? passes[passes.length - 1]!, ref.relativeBar);
  }

  const n = passes.length;
  const stepped = (((current + delta) % n) + n) % n;
  return barRef(passes[stepped]!, ref.relativeBar);
}
