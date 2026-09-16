import { createProject, recordSession } from '../../src/domain/project.ts';
import type { Project } from '../../src/domain/project.ts';
import { projectTiming } from '../../src/domain/project.ts';
import { loopFrames } from '../../src/domain/timing.ts';
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

  // -- claim 3: the engine reports what it schedules, and stops when detached --
  const probe = probeReports();

  const claims = {
    newModeStillHoldsDonorAudio: stillHoldingDonor,
    newModeEngineHolds: created.loaded(),
    newModePushedLayers: created.calls.some((c) => c.call === 'setLayers'),
    editModeHoldsOwnAudio: editHoldsOwn,
    donorSessions,
    ...probe,
  };

  const pass =
    claims.newModeStillHoldsDonorAudio.length === 0 &&
    claims.newModePushedLayers &&
    claims.editModeHoldsOwnAudio &&
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
