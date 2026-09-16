import { createProject, recordSession } from '../../src/domain/project.ts';
import type { Project } from '../../src/domain/project.ts';
import { projectTiming } from '../../src/domain/project.ts';
import { framesPerBar, loopFrames } from '../../src/domain/timing.ts';
import type { BackingTracks } from '../../src/domain/backing.ts';
import type { Timing } from '../../src/domain/timing.ts';
import type { Transport } from '../../src/domain/transport.ts';
import { audioEngine } from './audio.ts';
import type { BackingEngine, ScheduledEvent } from './audio.ts';
import { projectSettingsScreen } from './settings.ts';
import { takeStore } from './takes.ts';
import type { TakeStore } from './takes.ts';

/**
 * Does a screen play the project it is about?
 *
 * **The defect this exists for is not arithmetic.** Every instrument in this repo answers "is this
 * number right?" to worst-error-zero precision, and the answer is genuinely yes — while a screen
 * previewed another project's recordings. Nothing measured *which* project reached the engine,
 * because nothing could: the engine is a seam a screen is handed, and the seam had no way to say
 * what it was asked to play.
 *
 * `engine.onSchedule` is that way, and `recordingEngine()` below is the other half — a stand-in
 * that records what it is told instead of making sound. A screen is mounted against it and asked
 * what it pushed. No `AudioContext`, no timing, nothing to be flaky about: these are assertions
 * about which values crossed a function boundary.
 *
 * **Claim 1 is the one that failed.** Project settings in `new` mode is handed the *open* project,
 * because a new project needs somewhere to get its default tempo and length from. The prop's
 * comment said nothing about it is written to, which was true and beside the point: it was played.
 * It still carried the open project's `layers`, sessions and all.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-lifecycle.js');
 *     await m.verifyLifecycle();
 */

/** Everything a screen did to its engine, in order. */
type Call =
  | { call: 'setLayers'; project: Project; sessionIds: readonly string[] }
  | { call: 'setBacking'; backing: BackingTracks; timing: Timing }
  | { call: 'setTransport'; transport: Transport }
  | { call: 'start'; frame: number }
  | { call: 'stop' }
  | { call: 'destroy' };

/**
 * A `BackingEngine` that records rather than sounds.
 *
 * Structural typing is doing real work here: it satisfies the same type the screens take, so a
 * method added to the seam breaks this file at the typecheck rather than at runtime — which is the
 * point, since a screen that starts using a new method is exactly what this needs to see.
 */
function recordingEngine(): {
  engine: BackingEngine;
  calls: Call[];
  /** Whose audio the engine is holding *now* — the question a preview actually turns on. */
  loaded(): readonly string[];
} {
  const calls: Call[] = [];
  let held: readonly string[] = [];
  const engine: BackingEngine = {
    sampleRate: 44100,
    setBacking(backing, timing) {
      calls.push({ call: 'setBacking', backing, timing });
    },
    setTransport(transport) {
      calls.push({ call: 'setTransport', transport });
    },
    setLayers(project) {
      calls.push({
        call: 'setLayers',
        project,
        // Flattened at the moment of the call: the assertion is about what was handed over, and a
        // later edit to the same object must not be able to change the answer retroactively.
        sessionIds: project.layers.flatMap((l) => l.sessions.map((s) => s.id)),
      });
      held = project.layers.flatMap((l) => l.sessions.map((s) => s.id));
    },
    setMaster() {},
    setCountIn() {},
    onSchedule() {},
    start(frame) {
      calls.push({ call: 'start', frame });
    },
    stop() {
      calls.push({ call: 'stop' });
    },
    running: () => false,
    frame: () => 0,
    prerender() {},
    startCapture: async () => false,
    stopCapture: async () => undefined,
    openInput: async () => false,
    inputError: () => undefined,
    hasInput: () => false,
    inputPeak: () => 0,
    ready: () => true,
    destroy() {
      calls.push({ call: 'destroy' });
    },
  };
  return { engine, calls, loaded: () => held };
}

/** A project with real recorded audio in it, so "did the donor leak" has something to leak. */
function donorProject(): Project {
  const base = createProject({ id: 'donor', name: 'Donor', bpm: 96, barCount: 8, quality: 'standard' });
  const t = projectTiming(base);
  const session = {
    id: 'donor-take-1',
    audioFileURL: 'blob:donor-take-1',
    recordedFrames: loopFrames(t) * 2,
    recordedAt: new Date().toISOString(),
    waveformPeaks: [],
  };
  const layer = recordSession(base.layers[0]!, session, t);
  return { ...base, layers: base.layers.map((l) => (l.index === 0 ? layer : l)) };
}

/**
 * Mount the screen the way the shell does: onto an engine that is **already loaded** with whatever
 * the previous screen was playing.
 *
 * That preload is the whole point. The first version of this file mounted onto a blank engine and
 * asked what the screen pushed, which reported the defect as "pushes nothing" — true, and not the
 * mechanism. The engine is stateful and survives the navigation; a screen that pushes nothing does
 * not preview silence, it previews the project before it.
 */
function mountSettings(
  mode: 'new' | 'edit',
  project: Project,
  takes: TakeStore,
  preloadedWith?: Project,
) {
  const { engine, calls, loaded } = recordingEngine();
  if (preloadedWith) engine.setLayers(preloadedWith, takes);
  const callsBeforeMount = calls.length;
  const screen = projectSettingsScreen({
    project,
    mode,
    engine,
    takes,
    onCommit() {},
    onCancel() {},
    onExport() {},
    onCompress() {},
    onBounce() {},
    onDelete() {},
    countIn: () => ({ bars: 1, mode: 'loop' }),
    onCountIn() {},
    audioSession: () => false,
    onAudioSession() {},
  });
  return { screen, calls: calls.slice(callsBeforeMount), engine, loaded };
}

export async function verifyLifecycle() {
  const takes = takeStore(() => {});
  const donor = donorProject();
  const donorSessions = donor.layers.flatMap((l) => l.sessions.map((s) => s.id));

  // -- claim 1: arriving at New Project, the engine stops holding the project you came from --
  const created = mountSettings('new', donor, takes, donor);
  const stillHoldingDonor = created.loaded().filter((id) => donorSessions.includes(id));
  created.screen.destroy();

  // -- claim 2: editing an existing project still previews that project's own audio --
  const edited = mountSettings('edit', donor, takes, donor);
  const editHoldsOwn = donorSessions.every((id) => edited.loaded().includes(id));
  edited.screen.destroy();

  // -- claim 3: a count-in window does not outlive its take --
  const countIn = await countInWindowEnds();

  // -- claim 4: destroy() is terminal --
  const terminal = destroyIsTerminal();

  // -- claim 3: the engine reports what it schedules, and stops when detached --
  const probe = probeReports();

  const claims = {
    newModeStillHoldsDonorAudio: stillHoldingDonor,
    newModeEngineHolds: created.loaded(),
    newModePushedLayers: created.calls.some((c) => c.call === 'setLayers'),
    editModeHoldsOwnAudio: editHoldsOwn,
    donorSessions,
    ...countIn,
    ...terminal,
    ...terminal,
    ...probe,
  };

  const pass =
    claims.newModeStillHoldsDonorAudio.length === 0 &&
    claims.newModePushedLayers &&
    claims.editModeHoldsOwnAudio &&
    claims.countInGoneAfterStop &&
    claims.muteChangeReschedules &&
    claims.countInAppliedDuringTake &&
    claims.destroyBuildsNoSecondContext &&
    claims.destroyIsIdempotent &&
    claims.scheduleHookReports &&
    claims.scheduleHookSilentWhenDetached;

  return { ...claims, pass };
}

/**
 * The hook itself: does detaching actually stop it?
 *
 * A listener that keeps firing after `onSchedule(undefined)` would leak an instrument's array into
 * a later measurement, which is the kind of fault that makes a harness lie rather than fail.
 * Checked against the real engine, offline, because the question is about `audio.ts` and not about
 * a stub of it.
 */
function probeReports(): { scheduleHookReports: boolean; scheduleHookSilentWhenDetached: boolean } {
  const seen: ScheduledEvent[] = [];
  const project = createProject({ id: 'probe', name: 'Probe', bpm: 120, barCount: 4, quality: 'standard' });
  const t = projectTiming(project);
  // An offline context, so this neither needs a user gesture nor makes a sound.
  const ctx = new OfflineAudioContext(2, Math.ceil(t.sampleRate * 2), t.sampleRate);
  const engine = audioEngine(t.sampleRate, ctx);
  engine.setBacking(project.backing, t);
  engine.setLayers(project, takeStore(() => {}));

  engine.onSchedule((e) => seen.push(e));
  engine.prerender(2);
  const whileWatching = seen.length;

  engine.onSchedule(undefined);
  engine.prerender(2);
  const afterDetach = seen.length;

  engine.destroy();
  return {
    scheduleHookReports: whileWatching > 0,
    scheduleHookSilentWhenDetached: afterDetach === whileWatching,
  };
}

/**
 * Is a destroyed engine inert, or merely dormant?
 *
 * It used to be dormant. `destroy()` cleared `ctx` and left `owned` pointing at the context it
 * had just closed, so one stray call fell into `ensure()`, saw no `ctx`, and built a **second**
 * `AudioContext` that nothing would ever close — on a platform that caps how many may exist. A
 * stale call is not exotic: screens are torn down on every navigation, and a render loop or a
 * debounced timer can outlive its screen by a frame.
 *
 * Counted by constructor rather than inspected, because "did a second context appear" is the
 * whole question and an engine does not expose its own.
 */
function destroyIsTerminal(): {
  destroyBuildsNoSecondContext: boolean;
  destroyIsIdempotent: boolean;
} {
  const Real = globalThis.AudioContext;
  let built = 0;
  class Counting extends Real {
    constructor(...args: ConstructorParameters<typeof Real>) {
      super(...args);
      built++;
    }
  }
  globalThis.AudioContext = Counting as unknown as typeof Real;
  try {
    const engine = audioEngine(44100);
    const project = createProject({ id: 'd', name: 'D', bpm: 120, barCount: 4, quality: 'standard' });
    engine.setBacking(project.backing, projectTiming(project));
    const afterSetup = built;

    engine.destroy();
    // Everything a torn-down screen might still be holding a reference to.
    engine.setBacking(project.backing, projectTiming(project));
    engine.setLayers(project, takeStore(() => {}));
    engine.start(0);
    engine.stop();
    engine.prerender(1);
    engine.setMaster(0.5, false);

    let idempotent = true;
    try {
      engine.destroy();
    } catch {
      idempotent = false;
    }

    return {
      destroyBuildsNoSecondContext: built === afterSetup,
      destroyIsIdempotent: idempotent,
    };
  } finally {
    globalThis.AudioContext = Real;
  }
}

/**
 * Does a drums-only count-in stay behind after the take it belonged to?
 *
 * It did. `setCountIn` is a frame threshold compared against `barStartFrame`, which counts from
 * `originFrame` — and `start` re-anchors that — so once set, *every later playback from the top*
 * on the same engine replayed the count-in: first bars without chords or layers, for no reason
 * the screen showed. It cleared when the engine was rebuilt, which happens on navigation, so it
 * looked intermittent: press play again on Playback and it came back, leave the screen and it
 * did not.
 *
 * Asked through `onSchedule`, which reports the kind of every onset — so "were chords scheduled
 * in bar 1" is a fact the engine states rather than something inferred from the graph.
 */
async function countInWindowEnds(): Promise<{
  countInGoneAfterStop: boolean;
  countInAppliedDuringTake: boolean;
  muteChangeReschedules: boolean;
}> {
  const base = createProject({ id: 'ci', name: 'CI', bpm: 120, barCount: 4, quality: 'standard' });
  // **Chords are muted in a new project**, which is what a first draft of this probe missed: with
  // the default backing there are no chord onsets to look for, so the window looked cleared when
  // nothing was being scheduled either way. Unmuted here, deliberately.
  const project = {
    ...base,
    backing: { ...base.backing, chords: { ...base.backing.chords, muted: false } },
  };
  const t = projectTiming(project);
  const ctx = new OfflineAudioContext(2, Math.ceil(t.sampleRate * 4), t.sampleRate);
  const engine = audioEngine(t.sampleRate, ctx);
  engine.setBacking(project.backing, t);
  engine.setLayers(project, takeStore(() => {}));

  const kinds = () => {
    const seen: ScheduledEvent[] = [];
    engine.onSchedule((e) => seen.push(e));
    engine.prerender(2);
    engine.onSchedule(undefined);
    return seen;
  };

  // With a window over the first two bars, those bars are drums and nothing else.
  engine.setCountIn(framesPerBar(t) * 2);
  const during = kinds();
  const countInAppliedDuringTake =
    during.some((e) => e.kind === 'drum') && !during.some((e) => e.kind === 'chord');

  // The take ends. Playing from the top again must be an ordinary loop.
  engine.stop();
  const after = kinds();
  const countInGoneAfterStop = after.some((e) => e.kind === 'chord');

  // -- F4: muting a track has to invalidate the committed horizon, not wait it out --
  //
  // A muted track schedules nothing, so muting only affects bars not yet committed — and the
  // horizon runs `AHEAD_SECONDS` in front. Without a reschedule the drums kept playing for up to
  // 1.2 s after the tap, which at 240 BPM is more than a bar, and the control read as broken.
  const rescheduled: ScheduledEvent[] = [];
  engine.start(0);
  engine.onSchedule((e) => rescheduled.push(e));
  engine.setBacking({ ...project.backing, drums: { ...project.backing.drums, muted: true } }, t);
  engine.onSchedule(undefined);
  // A reschedule re-commits the horizon; the point is that it happened at all, and that what it
  // re-committed has no drums in it.
  const muteChangeReschedules =
    rescheduled.length > 0 && !rescheduled.some((e) => e.kind === 'drum');

  engine.destroy();
  return { countInGoneAfterStop, countInAppliedDuringTake, muteChangeReschedules };
}
