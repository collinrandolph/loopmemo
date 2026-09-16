import {
  type BackingTracks,
  type ChordTone,
  type DrumKit,
  chordTone,
  drumKit,
} from '../../src/domain/backing.ts';
import {
  type BackingBar,
  backingSchedule,
  chordRingSeconds,
} from '../../src/domain/backing-schedule.ts';
import type { PassIndex } from '../../src/domain/pass-index.ts';
import {
  type Layer,
  type Project,
  isLayerAudible,
  latencyOffsetFrames,
  layerPassIndex,
  projectTiming,
} from '../../src/domain/project.ts';
import { segments, splice } from '../../src/domain/schedule-plan.ts';
import { type Timing, framesPerBar } from '../../src/domain/timing.ts';
import { isSlotMuted } from '../../src/domain/arrangement.ts';
import { type LayerChain, createLayerChain } from './effects-chain.ts';
import {
  type ScheduledVoice,
  type SessionBuffers,
  cancel,
  retire,
  scheduleSegments,
} from './layer-audio.ts';
import { type Capture, MUSIC_CONSTRAINTS, type Recorder, createRecorder } from './recorder.ts';
import type { TakeStore } from './takes.ts';
import { type Transport, playLoopFrom, playheadAt, slotAt } from '../../src/domain/transport.ts';
import type { Engine } from './engine.ts';

/**
 * The `Engine` seam with audio behind it: the backing tracks synthesised live, and the recorded
 * layers scheduled as regions (§2.4). The frame position screens read comes from the audio clock,
 * which is what makes it authoritative.
 *
 * It reads onset frames, frequencies and envelope lengths from `src/domain` and does the two
 * things a domain cannot: convert to the platform's unit, and build nodes. **Frames become seconds
 * in exactly one place** (`frameToTime`). Oscillator graphs, waveshaper curves and the compressor
 * are platform-bound and live here; the parameters that shape them are domain data.
 *
 * Browser-only and disposable, like the rest of `ui/`. When a platform is chosen this file and
 * `prototype/backing-tracks/` are both references to translate from, not code to carry over.
 */

/** The crossfade on every segment join (§2.4). Seconds, because it is a physical duration. */
const CROSSFADE_SECONDS = 0.007;

/** Scheduled this far ahead of the playhead, topped up on an interval. */
const AHEAD_SECONDS = 1.2;
const TOPUP_MS = 250;
/** Gap between `start()` and the first onset, so scheduling never races the clock. */
const LEAD_SECONDS = 0.08;

export type BackingEngine = Engine & {
  /**
   * What to play. Safe while running: a track change is picked up by the next bar scheduled, so a
   * kit or chord swap is heard within a bar and never clicks. A *timing* change re-anchors,
   * because every future bar time is derived from the tempo.
   */
  setBacking(backing: BackingTracks, t: Timing): void;
  /**
   * Which traversal of the arrangement is playing (§3.6). The backing follows the transport, so
   * the bar generated is the bar the sweep is over — in bar mode, one slot held, which is what
   * makes previewing bar 7 sound like bar 7 (§2.6).
   *
   * Defaults to the whole arrangement from slot 1. Safe while running: scheduled bars that have
   * not sounded are rebuilt, so the change lands at the next bar rather than after the lookahead.
   */
  setTransport(transport: Transport): void;
  /**
   * The recorded layers, and which one (if any) is being recorded onto. Called whenever a take
   * commits, a level or mute changes, or arming moves; the engine re-reads on the next bar.
   *
   * The layer being captured into is silent for the take (§2.2), *derived* through
   * `isLayerAudible` rather than written into `layer.muted` — writing it through would make our
   * state indistinguishable from the user's, so stopping could not restore theirs.
   */
  setLayers(project: Project, takes: TakeStore, recordingIntoLayerIndex?: number): void;
  /**
   * Open the microphone. **Call this when arming, not when recording**: the first call raises the
   * permission prompt, and one raised at the downbeat is answered seconds into a running take.
   *
   * Resolves false rather than throwing — a refusal is a state to render, not an exception. It
   * lives on the engine because the engine owns the `AudioContext`.
   */
  openInput(): Promise<boolean>;
  /** Why the input is unavailable, for a screen to word. Undefined once it opens. */
  inputError(): InputFailure | undefined;
  /**
   * Is the microphone already open? Arming can then be instant instead of pending — the prompt is
   * paid for once, and every later arm must not flicker through a waiting state it does not need.
   */
  hasInput(): boolean;
  /** Loudest input sample since the last call; resets on read. 0 when nothing is capturing. */
  inputPeak(): number;
  /**
   * Bars starting before `untilFrame` are a **drums-only count-in**: chords and recorded layers
   * are not scheduled for them (§4.6). 0 disables it, which is every case but one.
   *
   * It has to be a scheduling rule rather than a mute, and that is not a preference. Mute here
   * means *schedules nothing* — a muted track produces no voices at all — so flipping it at the
   * downbeat cannot work: `topUp` runs `AHEAD_SECONDS` ahead, and at 240 BPM a bar is one second,
   * so the downbeat is often already scheduled before the count-in has even started. Deciding per
   * bar at schedule time is the only place the answer is still open.
   *
   * Set before `start`. Nothing clears it — once the transport is past `untilFrame` every bar
   * schedules in full — and a render never sets it, so an exported file has no count-in in it.
   */
  setCountIn(untilFrame: number): void;
  /**
   * How loud the loop is *monitored* at (§4.2) — not part of the mix.
   *
   * The last stage before the destination, and deliberately the one thing a render never sees:
   * `renderOffline` builds its own engine on an `OfflineAudioContext` and this refuses to act on
   * one, so a file is written at unity however quietly you were listening. Baking it would be
   * silent and permanent — listen at night, export, and every file is 15 dB down with nothing
   * having said so. Mix decisions live on `Layer.level`, which runs to +6 dB for that reason.
   *
   * `level` is 0..1: monitoring only ever trims down, and the compressor is immediately upstream,
   * so there is no headroom above unity to spend.
   */
  setMaster(level: number, muted: boolean): void;
  /**
   * Schedule `bars` bars from frame 0 at once, for an offline render (§2.7's export).
   *
   * An `OfflineAudioContext` does not advance until `startRendering`, so the live lookahead loop
   * would schedule one horizon and wait forever. Rendering through **this** engine is the point:
   * a second path would be a second set of decisions about crossfades, splices, pan law and the
   * compressor, and every one is a chance for the file to disagree with what was heard.
   */
  prerender(bars: number): void;
  /** Begin capturing. Opens the input first if arming did not. */
  startCapture(): Promise<boolean>;
  stopCapture(): Promise<Capture | undefined>;
  /** Whether the browser has actually let us make sound yet (autoplay policy). */
  ready(): boolean;
  /**
   * **Watch what this engine schedules.** Pass a listener to observe, `undefined` to stop.
   *
   * For instruments, and it exists because the alternative is worse: the audit harness observed
   * scheduling by monkeypatching `OscillatorNode.prototype.start` from outside, which sees voices
   * it did not cause, cannot tell a layer segment from a drum, and produced two measurements that
   * had to be retracted. Reporting from inside the one function that schedules removes the whole
   * class — an instrument asks the engine what it did rather than inferring it from the graph.
   *
   * It costs one `undefined` check per onset when nothing is listening, which is why it is not
   * behind a build flag: a flagged hook is a hook that is not there when someone needs it.
   */
  onSchedule(listen: ((event: ScheduledEvent) => void) | undefined): void;
  destroy(): void;
};

/**
 * One thing the engine put on the graph, as the engine understands it.
 *
 * `frame` is a transport frame, which is what every assertion wants — `time` is its context time,
 * kept because a test that suspects the frame-to-time conversion needs both to say so.
 */
export type ScheduledEvent =
  | { kind: 'drum'; voice: 'kick' | 'snare' | 'hat' | 'hatOpen'; frame: number; time: number }
  | { kind: 'chord'; frame: number; time: number; frequency: number }
  | {
      kind: 'layer';
      /** Which layer, by its index in the project — not its position in `layerVoices`. */
      layer: number;
      /** The session the audio is read from, which is what says *whose* recording this is. */
      sessionId: string | undefined;
      /** Arrangement slot this bar is playing. */
      slot: number;
      frame: number;
      time: number;
    };

/**
 * Why the input could not be opened, classified rather than described.
 *
 * The three cases need three different things from the user and only one of them is recoverable
 * without leaving the app, so the screen has to tell them apart. Classifying here and wording it
 * there keeps platform knowledge on this side and copy on that one.
 */
export type InputFailure = {
  readonly kind: 'denied' | 'missing' | 'insecure' | 'unknown';
  /** The raw error, for a case the four kinds do not cover. */
  readonly detail: string;
};

function classify(e: unknown): InputFailure {
  const name = e instanceof Error ? e.name : '';
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  // A page served over plain http has no `mediaDevices` at all, so the throw is a TypeError
  // rather than one of the permission errors.
  if (!globalThis.isSecureContext) return { kind: 'insecure', detail };
  if (name === 'NotAllowedError' || name === 'SecurityError') return { kind: 'denied', detail };
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return { kind: 'missing', detail };
  }
  return { kind: 'unknown', detail };
}

type Voice = { nodes: AudioNode[]; startsAt: number; endsAt: number };

export function audioEngine(sampleRate: number, context?: BaseAudioContext): BackingEngine {
  // Typed as the base class because an export renders through this same engine into an
  // `OfflineAudioContext`. `owned` is the live one, and the only one to resume or close.
  let ctx: BaseAudioContext | undefined;
  let owned: AudioContext | undefined;
  let bus: DynamicsCompressorNode | undefined;
  let drumGain: GainNode | undefined;
  let chordGain: GainNode | undefined;
  /** Bars before this frame schedule drums only — see `setCountIn`. 0 for everything else. */
  let countInUntilFrame = 0;
  /** Monitoring, not mix. Unity until the shell says otherwise, which it never does offline. */
  let masterGain: GainNode | undefined;
  let masterLevel = 1;
  let masterMuted = false;

  let backing: BackingTracks | undefined;
  let timing: Timing | undefined;
  // The whole arrangement from the top: what "play" means on every screen that has no transport
  // of its own. Idle is never stored — a stopped engine schedules nothing anyway, and falling
  // back to the linear walk keeps a caller that hands one over from going silent.
  let transport: Transport = playLoopFrom(0, 0);
  let bars: readonly BackingBar[] = [];
  /** Longest a chord voice may ring, by onset index — see `chordRingCaps`. */
  let chordCaps: readonly number[] = [];

  /** One per recorded layer, resolved on `setLayers` — `layerPassIndex` walks every session. */
  type LayerVoice = {
    layer: Layer;
    index: PassIndex;
    buffers: SessionBuffers;
    chain: LayerChain;
    /** What this layer currently has handed to the graph, so a splice can retire it. */
    scheduled: ScheduledVoice[];
  };
  let layerVoices: LayerVoice[] = [];
  /**
   * The recording offset in frames (§2.3), read off the project on every `setLayers`. It shifts
   * where recorded layers are *read from* and nothing else — not the transport, and not the
   * backing, which is already on time and is the reference being corrected against.
   */
  let latencyFrames = 0;

  /**
   * Terminal. **A destroyed engine is inert, not dormant.**
   *
   * `destroy()` used to clear `ctx` and leave `owned` pointing at the context it had just
   * closed, so the next stray call fell into `ensure()`, found no `ctx`, and built a **second**
   * `AudioContext` — which nothing would ever close, on a platform that caps how many may
   * exist. A stale reference is not exotic: screens are torn down on every navigation, and a
   * render loop or a debounced timer can outlive the screen that started it by a frame.
   */
  let destroyed = false;

  /** Set by `onSchedule`. Undefined whenever nothing is watching, which is always in production. */
  let watching: ((event: ScheduledEvent) => void) | undefined;

  let stream: MediaStream | undefined;
  let inputError: InputFailure | undefined;
  let recorder: Recorder | undefined;

  /**
   * Whether the stream still has a track the device is actually feeding.
   *
   * `readyState` is the only thing that says so. A `MediaStream` and its `MediaStreamTrack` are
   * ordinary objects that survive the device: `ended` is terminal and nothing about the reference
   * changes, so every existence check keeps passing.
   */
  function inputIsLive() {
    return !!stream && stream.getAudioTracks().some((t) => t.readyState === 'live');
  }

  /**
   * Drop the input and everything built on it, so the next `openInput` re-acquires.
   *
   * The tracks are stopped explicitly. A track left running holds the device — on iOS it also
   * holds the audio session in a record category, which is a routing variable the device checklist
   * has to control for — and the browser's recording indicator stays lit over an app that is not
   * recording.
   */
  function releaseInput() {
    recorder?.destroy();
    recorder = undefined;
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = undefined;
  }
  /**
   * Added to a captured chunk's context frame to get an engine frame. Set at `startCapture`; see
   * the note there for why it cannot be computed at the stop.
   */
  let captureFrameOffset = 0;

  let originFrame = 0;
  /** `ctx.currentTime` corresponding to `originFrame`. Undefined when stopped. */
  let anchorTime: number | undefined;
  let nextBar = 0; // absolute bar index, counting from the loop start
  let voices: Voice[] = [];
  let lastHat: { out: GainNode; source: AudioBufferSourceNode; stopAt: number } | undefined;
  let timer: number | undefined;

  // ------------------------------------------------------------------ graph --
  function ensure(): BaseAudioContext {
    // Loud rather than quiet: every public entry point already refuses when destroyed, so
    // reaching here means one was added without a guard. Rebuilding silently is the old bug.
    if (destroyed) throw new Error('audioEngine: used after destroy()');
    if (!ctx) {
      /**
       * **At the project's rate, never the device's.** Omitting it takes the hardware default
       * while `Timing` computes frame counts at the project's quality, and the engine then holds
       * two rates: `frameToTime` converts with the domain's, `scheduleSegments` with the
       * context's, so recorded layers run 8.8% fast against the drums.
       */
      ctx = context ?? (owned = new AudioContext({ sampleRate }));
      /**
       * **The request is not a guarantee, and three consumers depend on it being one.**
       *
       * `sampleRate` in the constructor is a preference the platform may decline. iOS ignored it
       * for years, and a Bluetooth HFP route still forces the hardware rate even where it is
       * honoured otherwise. When it is declined the engine holds two rates without knowing it —
       * `frameToTime` converts with the domain's, `scheduleSegments` with the context's — and the
       * recorded layers run fast against the drums: 8.8% at 44.1 against 48, which is a bar
       * measuring 2.297 s instead of 2.5.
       *
       * **Invisible until a layer has audio to play**, which is why it is worth throwing over. A
       * silent wrong answer here is a project that sounds broken for a reason nothing reports;
       * a thrown one is a screen that can say the device would not give the rate this project
       * needs. The check is one comparison and it is the only place the assumption is made.
       */
      if (ctx.sampleRate !== sampleRate) {
        const got = ctx.sampleRate;
        if (owned) {
          void owned.close();
          owned = undefined;
        }
        ctx = undefined;
        throw new Error(
          `audioEngine: asked for ${sampleRate} Hz and the device gave ${got} Hz. ` +
            'Every frame count in this project is computed at the project rate, so the layers ' +
            'would run against the backing.',
        );
      }
      // Every voice goes through this, never straight to `destination`. A dense pattern easily has
      // a dozen oscillators sounding at once, and summing those into the destination clips.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 12;
      comp.ratio.value = 14;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      /**
       * Unity. The compressor applies no makeup gain, so at −20 dB and 14:1 a full-scale input
       * already leaves around −18 dBFS — there is no clipping headroom left to spend, and a
       * recorded layer passing through here has none to give.
       */
      const headroom = ctx.createGain();
      headroom.gain.value = 1;
      comp.connect(headroom);
      // The monitoring stage, after everything and before the destination — see `setMaster`. It
      // exists on an offline context too, and stays at unity there because `setMaster` refuses to
      // act on one, so the graph shape does not differ between what is heard and what is written.
      masterGain = ctx.createGain();
      masterGain.gain.value = masterMuted ? 0 : masterLevel;
      headroom.connect(masterGain);
      masterGain.connect(ctx.destination);
      bus = comp;

      // One gain per track, so `level` is not baked into every voice's peak. Mute is not here:
      // `backingSchedule` omits a muted track's onsets, so there is nothing to turn down.
      drumGain = ctx.createGain();
      chordGain = ctx.createGain();
      drumGain.connect(comp);
      chordGain.connect(comp);
    }
    if (owned?.state === 'suspended') void owned.resume();
    return ctx;
  }

  /**
   * Ramp rather than assign: the slider emits an event per pixel, and setting a gain outright is
   * a click — a drag would be a few hundred of them. Same rule as every other live gain here.
   */
  function applyMaster() {
    if (!masterGain || !ctx) return;
    masterGain.gain.setTargetAtTime(masterMuted ? 0 : masterLevel, ctx.currentTime, 0.01);
  }

  /**
   * **Ramped, for the same reason `applyMaster` is.** These assigned `.value` directly while the
   * function immediately above them ramps, and the two are driven by the same kind of control:
   * a `levelSlider` emitting an event per pixel. Setting a gain outright is a step, and a drag
   * is a few hundred of them.
   *
   * A muted track is not handled here — `backingSchedule` omits its onsets, so it produces no
   * voices at all rather than voices that are then turned down.
   */
  function applyLevels() {
    if (!backing || !drumGain || !chordGain || !ctx) return;
    drumGain.gain.setTargetAtTime(backing.drums.level, ctx.currentTime, 0.01);
    chordGain.gain.setTargetAtTime(backing.chords.level, ctx.currentTime, 0.01);
  }

  // ------------------------------------------------------------ bookkeeping --
  /**
   * Cleanup is anchored to the voice's scheduled end **in context time**, not to now. Scheduling
   * runs `AHEAD_SECONDS` ahead, so "now" can be a second before the voice starts.
   */
  function track(nodes: AudioNode[], startTime: number, seconds: number) {
    voices.push({ nodes, startsAt: startTime, endsAt: startTime + seconds + 0.2 });
  }

  /**
   * Drop what has finished sounding — **from both lists**.
   *
   * This walked `voices` only, and layer segments are not in `voices`: they are held per layer in
   * `LayerVoice.scheduled`, because a splice has to be able to find and retire them. So nothing
   * ever released a layer segment that had simply played out. `rescheduleFuture` keeps everything
   * already started, by design, and `killAll` only runs on a stop — which means during ordinary
   * playback the list grew by one entry per bar per layer, each holding an
   * `AudioBufferSourceNode` and a `GainNode` that stay referenced and connected long after they
   * are silent. Seven layers at 120 BPM is around 210 retained pairs a minute.
   *
   * **This is the third time that split has cost something.** `rescheduleFuture` and `killAll`
   * both pruned one list and left the other; CLAUDE.md records both. The lists stay separate for
   * a real reason, so the rule is that every path which touches one walks both.
   *
   * `endsAt` already carries the tail, so nothing new had to be tracked to know when it is safe.
   */
  function sweep() {
    if (!ctx) return;
    const now = ctx.currentTime;
    voices = voices.filter((v) => {
      if (v.endsAt > now) return true;
      for (const n of v.nodes) {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
      return false;
    });

    for (const voice of layerVoices) {
      voice.scheduled = voice.scheduled.filter((v) => {
        if (v.endsAt > now) return true;
        // `cancel` rather than a bare disconnect: it stops the source first, and a source that
        // has already ended tolerates that. Nothing is fading here — this is past `endsAt`.
        cancel(v);
        return false;
      });
    }
  }

  function silence(nodes: AudioNode[]) {
    for (const n of nodes) {
      try {
        (n as OscillatorNode).stop?.();
      } catch {
        /* not started, or already stopped */
      }
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  function killAll() {
    for (const v of voices) silence(v.nodes);
    voices = [];
    lastHat = undefined;

    // **And the layers, which are not in `voices`** — they are held per layer so a splice can
    // reach them, so every teardown path has to walk both lists. Sounding segments fade over the
    // crossfade rather than cutting; the drums having always cut is not a reason for these to.
    const now = ctx?.currentTime ?? 0;
    for (const voice of layerVoices) {
      for (const v of voice.scheduled) {
        if (v.at <= now) retire(v, now, CROSSFADE_SECONDS);
        else cancel(v);
      }
      voice.scheduled = [];
    }
  }

  /**
   * Drop what is scheduled but not yet sounding, and rebuild the horizon from here.
   *
   * A change to *which bar plays next* would otherwise be heard `AHEAD_SECONDS` after the sweep
   * moved — long enough to read as the backing being on a different loop.
   *
   * **Voices already started are left alone**: they were correct when they began, and cutting a
   * chord mid-decay is a click. The current bar is rescheduled rather than skipped, and
   * `scheduleBar` drops the onsets of it that are already past.
   */
  function rescheduleFuture() {
    if (anchorTime === undefined || !ctx || !timing) return;
    const now = ctx.currentTime;
    voices = voices.filter((v) => {
      if (v.startsAt <= now) return true;
      silence(v.nodes);
      return false;
    });
    lastHat = undefined; // it may well have been one of those

    // The layers again — dropping only `voices` leaves every queued bar of the old plan running
    // while `topUp` schedules the new one beside it.
    for (const voice of layerVoices) {
      voice.scheduled = voice.scheduled.filter((v) => {
        if (v.at <= now) return true; // sounding: `spliceCurrentBar` decides its fate, not this
        cancel(v);
        return false;
      });
    }

    nextBar = Math.floor(Math.max(originFrame, engine.frame()) / framesPerBar(timing));
    topUp();
  }

  // ------------------------------------------------------- overlap policy --
  /**
   * §6.1's overlap question, settled: **the three voice types differ, deliberately.**
   *
   * - **Chords cap** their envelope to the gap before the next onset (`chordRingSeconds`).
   * - **The hat chokes** its predecessor — a real hi-hat is one pair of cymbals, so a new hit
   *   stops whatever is still ringing.
   * - **Kick and snare overlap.** Their decays outlive the gap only on dense patterns above
   *   ~200 BPM, and only in the exponential tail where there is nothing left to hear.
   *
   * A uniform choke was built and judged by ear against this, and rejected (§5.2): letting a
   * chord ring its full recipe length and cutting it when the next lands is 1.6–1.8× the energy
   * on dense patterns, and it sounds wrong.
   */

  /** Long enough not to click, short enough to read as a stop rather than a fade. */
  const CHOKE_SECONDS = 0.005;

  /** The hat's own output gain, so a choke closes a tap rather than interrupting an envelope. */
  function voiceOut(c: BaseAudioContext, dest: AudioNode): GainNode {
    const out = c.createGain();
    out.gain.value = 1;
    out.connect(dest);
    return out;
  }

  // ----------------------------------------------------------- drum voices --
  function noise(c: BaseAudioContext, seconds: number): AudioBuffer {
    const length = Math.max(1, Math.floor(c.sampleRate * seconds));
    const buffer = c.createBuffer(1, length, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Pitch-swept sine plus a very short click. The sweep alone reads as boomy, not as a hit. */
  function kick(c: BaseAudioContext, dest: AudioNode, at: number, k: DrumKit['kick']) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    const gain = c.createGain();
    osc.connect(gain);
    gain.connect(dest);

    const click = c.createOscillator();
    click.type = 'square';
    click.frequency.value = k.clickFreq;
    const clickGain = c.createGain();
    click.connect(clickGain);
    clickGain.connect(dest);

    osc.frequency.setValueAtTime(k.startFreq, at);
    osc.frequency.exponentialRampToValueAtTime(k.endFreq, at + k.sweepSeconds);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(0.9, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + k.seconds);
    clickGain.gain.setValueAtTime(k.clickGain, at);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.012);

    osc.start(at);
    osc.stop(at + k.seconds + 0.05);
    click.start(at);
    click.stop(at + 0.02);
    track([osc, gain, click, clickGain], at, k.seconds);
  }

  /** Two detuned tonal oscillators (the shell) plus a highpassed noise burst (the buzz). */
  function snare(c: BaseAudioContext, dest: AudioNode, at: number, s: DrumKit['snare']) {
    const body = c.createGain();
    const o1 = c.createOscillator();
    o1.type = 'triangle';
    o1.frequency.value = s.body1;
    const o2 = c.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = s.body2;
    o1.connect(body);
    o2.connect(body);

    const src = c.createBufferSource();
    src.buffer = noise(c, s.seconds + 0.05);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = s.noiseHighpass;
    const nGain = c.createGain();
    src.connect(hp);
    hp.connect(nGain);

    const out = c.createGain();
    out.gain.value = 0.6;
    body.connect(out);
    nGain.connect(out);
    out.connect(dest);

    body.gain.setValueAtTime(0.5, at);
    body.gain.exponentialRampToValueAtTime(0.0001, at + s.bodySeconds);
    nGain.gain.setValueAtTime(0.7, at);
    nGain.gain.exponentialRampToValueAtTime(0.0001, at + s.seconds);

    const stopAt = at + s.seconds + 0.05;
    o1.start(at);
    o1.stop(stopAt);
    o2.start(at);
    o2.stop(stopAt);
    src.start(at);
    src.stop(stopAt);
    track([o1, o2, body, src, hp, nGain, out], at, s.seconds);
  }

  /**
   * Filtered noise. Closed and open share the recipe and differ only in decay — the same way
   * strike and chunk are one chord voice with two envelopes, not a fourth sound (§2.6).
   *
   * **Choke**: a real hi-hat is one pair of cymbals, so any new hit cuts off whatever is still
   * ringing. Scheduling always proceeds in ascending time, so "most recently scheduled" and
   * "immediately preceding in playback" are the same hat even though we run ahead of the playhead.
   */
  function hat(c: BaseAudioContext, dest: AudioNode, at: number, h: DrumKit['hat'], open: boolean) {
    const seconds = open ? h.openSeconds : h.closedSeconds;
    const src = c.createBufferSource();
    src.buffer = noise(c, seconds + 0.05);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = h.highpass;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = h.bandpass;
    bp.Q.value = 0.8;
    const gain = c.createGain();
    const out = voiceOut(c, dest);
    src.connect(hp);
    hp.connect(bp);
    bp.connect(gain);
    gain.connect(out);

    gain.gain.setValueAtTime(open ? 0.32 : 0.38, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);

    // One pair of cymbals: a new hit ends whatever is still ringing. Ramped over `CHOKE_SECONDS`
    // on the output gain rather than stopped dead, so the choke itself is not a step.
    if (lastHat && lastHat.stopAt > at) {
      lastHat.out.gain.setValueAtTime(1, at);
      lastHat.out.gain.linearRampToValueAtTime(0, at + CHOKE_SECONDS);
      try {
        lastHat.source.stop(at + CHOKE_SECONDS);
      } catch {
        /* already stopped */
      }
    }

    const stopAt = at + seconds + 0.02;
    src.start(at);
    src.stop(stopAt);
    lastHat = { out, source: src, stopAt };
    track([src, hp, bp, gain, out], at, seconds);
  }

  // ---------------------------------------------------------- chord voices --
  /**
   * A gentle bounded soft-clip for the Wurly's reed growl — a real Wurlitzer reed distorts
   * slightly when struck, and that is much of what separates it from a Rhodes. `tanh` saturates
   * smoothly and cannot blow up however many voices sum into it. Normalised, so the curve itself
   * adds no gain.
   */
  const WURLY_CURVE = (() => {
    const n = 1024;
    const k = 2.2;
    const curve = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) curve[i] = Math.tanh(k * (((i / (n - 1)) * 2 - 1) * 1)) / norm;
    return curve;
  })();

  /**
   * Multiplicative tremolo: a gain stage in series oscillating around 1, **never** an additive
   * wobble on the envelope's own gain. Additive is a fixed depth no matter how far the note has
   * decayed, so it dwarfs the signal exactly as it fades and reads as a stutter rather than
   * tremolo. In series it scales down with the note.
   */
  function tremolo(c: BaseAudioContext, rate: number, depth: number) {
    const stage = c.createGain();
    stage.gain.value = 1;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = rate;
    const amount = c.createGain();
    amount.gain.value = depth;
    osc.connect(amount);
    amount.connect(stage.gain);
    return { stage, osc, amount };
  }

  type ToneBuilder = (
    c: BaseAudioContext,
    dest: AudioNode,
    freq: number,
    at: number,
    chunk: boolean,
    seconds: number,
  ) => void;

  /**
   * Envelope breakpoints are **fractions of the duration**, never fixed offsets. The duration is
   * clamped to the gap before the next onset, so a hardcoded 0.35 s breakpoint can land *after*
   * the end — a non-monotonic automation sequence, which throws. Scaling keeps every case valid
   * by construction.
   */
  const TONES: Record<string, ToneBuilder> = {
    rhodes(c, dest, freq, at, chunk, seconds) {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const bark = c.createOscillator(); // the tine's bright attack
      bark.type = 'sine';
      bark.frequency.value = freq * 2;
      const barkGain = c.createGain();
      const main = c.createGain();
      const trem = tremolo(c, 4.5, 0.06);

      osc.connect(main);
      bark.connect(barkGain);
      barkGain.connect(main);
      main.connect(trem.stage);
      trem.stage.connect(dest);

      const peak = chunk ? 0.22 : 0.3;
      main.gain.setValueAtTime(0.0001, at);
      main.gain.linearRampToValueAtTime(peak, at + Math.min(chunk ? 0.004 : 0.008, seconds * 0.2));
      if (chunk) {
        main.gain.setValueAtTime(peak, at + seconds * 0.3);
      } else {
        main.gain.exponentialRampToValueAtTime(peak * 0.45, at + seconds * 0.3);
        main.gain.setValueAtTime(peak * 0.45, at + seconds * 0.65);
      }
      main.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
      barkGain.gain.setValueAtTime(peak * 0.5, at);
      barkGain.gain.exponentialRampToValueAtTime(0.0001, at + Math.min(chunk ? 0.05 : 0.18, seconds));

      const stopAt = at + seconds + 0.05;
      for (const n of [osc, bark, trem.osc]) {
        n.start(at);
        n.stop(stopAt);
      }
      track([osc, bark, barkGain, main, trem.stage, trem.osc, trem.amount], at, seconds);
    },

    pad(c, dest, freq, at, chunk, seconds) {
      const main = c.createGain();
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = chunk ? 900 : 1800;
      filter.Q.value = 0.7;
      const oscs = [-6, 0, 6].map((cents) => {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq;
        o.detune.value = cents;
        o.connect(filter);
        return o;
      });
      filter.connect(main);
      main.connect(dest);

      const peak = chunk ? 0.16 : 0.22;
      main.gain.setValueAtTime(0.0001, at);
      if (chunk) {
        main.gain.linearRampToValueAtTime(peak, at + Math.min(0.01, seconds * 0.2));
        main.gain.setValueAtTime(peak, at + seconds * 0.3);
      } else {
        // The swell is the tone: a slow attack and release are its whole identity.
        main.gain.linearRampToValueAtTime(peak, at + seconds * 0.25);
        main.gain.setValueAtTime(peak, at + seconds * 0.55);
      }
      main.gain.exponentialRampToValueAtTime(0.0001, at + seconds);

      const stopAt = at + seconds + 0.05;
      for (const o of oscs) {
        o.start(at);
        o.stop(stopAt);
      }
      track([...oscs, filter, main], at, seconds);
    },

    wurly(c, dest, freq, at, chunk, seconds) {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const shaper = c.createWaveShaper();
      shaper.curve = WURLY_CURVE;
      shaper.oversample = '2x';
      // Brighter and faster than the Rhodes' bark, at the third partial — closer to a reed.
      const bark = c.createOscillator();
      bark.type = 'sine';
      bark.frequency.value = freq * 3;
      const barkGain = c.createGain();
      const main = c.createGain();
      const trem = tremolo(c, 5.5, 0.07);

      osc.connect(shaper);
      shaper.connect(main);
      bark.connect(barkGain);
      barkGain.connect(main);
      main.connect(trem.stage);
      trem.stage.connect(dest);

      const peak = chunk ? 0.2 : 0.26;
      main.gain.setValueAtTime(0.0001, at);
      main.gain.linearRampToValueAtTime(peak, at + Math.min(chunk ? 0.003 : 0.005, seconds * 0.15));
      if (chunk) {
        main.gain.setValueAtTime(peak, at + seconds * 0.25);
      } else {
        main.gain.exponentialRampToValueAtTime(peak * 0.35, at + seconds * 0.2);
        main.gain.setValueAtTime(peak * 0.35, at + seconds * 0.5);
      }
      main.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
      barkGain.gain.setValueAtTime(peak * 0.65, at);
      barkGain.gain.exponentialRampToValueAtTime(0.0001, at + Math.min(chunk ? 0.03 : 0.1, seconds));

      const stopAt = at + seconds + 0.05;
      for (const n of [osc, bark, trem.osc]) {
        n.start(at);
        n.stop(stopAt);
      }
      track([osc, shaper, bark, barkGain, main, trem.stage, trem.osc, trem.amount], at, seconds);
    },

    organ(c, dest, freq, at, chunk, seconds) {
      const main = c.createGain();
      main.connect(dest);
      const oscs = [1, 2, 3, 4].map((harmonic, i) => {
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.value = freq * harmonic;
        const g = c.createGain();
        g.gain.value = [1, 0.5, 0.28, 0.16][i]!;
        o.connect(g);
        g.connect(main);
        return o;
      });

      const peak = chunk ? 0.14 : 0.18;
      // Near-instant attack, flat while held, quick release — an organ does not decay under a
      // held key, which is most of what makes it read as an organ.
      main.gain.setValueAtTime(0.0001, at);
      main.gain.linearRampToValueAtTime(peak, at + Math.min(0.004, seconds * 0.15));
      main.gain.setValueAtTime(peak, at + seconds * (chunk ? 0.75 : 0.9));
      main.gain.exponentialRampToValueAtTime(0.0001, at + seconds);

      const stopAt = at + seconds + 0.05;
      for (const o of oscs) {
        o.start(at);
        o.stop(stopAt);
      }
      track([...oscs, main], at, seconds);
    },
  };

  // -------------------------------------------------------------- schedule --
  /** The one place frames become seconds. Project frames, so the ratio is real time. */
  function frameToTime(frame: number): number {
    return anchorTime! + (frame - originFrame) / sampleRate;
  }

  function scheduleBar(absoluteBar: number) {
    const c = ctx!;
    const t = timing!;
    const b = backing!;
    const barStartFrame = absoluteBar * framesPerBar(t);
    // **Which slot this bar is** comes from the transport, through the same resolver the sweep
    // reads (§3.6). A private `absoluteBar % bars.length` would be a second answer to a question
    // the playhead already answers, and the two disagree in bar preview.
    const head = playheadAt(transport, barStartFrame, t);
    const bar = head ? bars[slotAt(head)] : bars[absoluteBar % bars.length];
    if (!bar) return;

    const kit = drumKit(b.drums.kitId);
    const tone = chordTone(b.chords.tone);
    const build = TONES[tone.id];

    for (const onset of bar.drums) {
      const frame = barStartFrame + onset.frameOffset;
      if (frame < originFrame) continue; // started mid-loop; this one already went past
      const at = frameToTime(frame);
      // And this one went past while running: `rescheduleFuture` rewinds into the bar in progress
      // to recover its remaining beats, so its earlier ones are dropped here.
      if (at < c.currentTime) continue;
      if (onset.voice === 'kick') kick(c, drumGain!, at, kit.kick);
      else if (onset.voice === 'snare') snare(c, drumGain!, at, kit.snare);
      else hat(c, drumGain!, at, kit.hat, onset.voice === 'hatOpen');
      watching?.({ kind: 'drum', voice: onset.voice, frame, time: at });
    }

    // A drums-only count-in stops here: the beat is scheduled, the chords and the layers under it
    // are not. Decided per bar at schedule time because that is the last moment the answer is
    // still open — see `setCountIn`.
    if (barStartFrame < countInUntilFrame) return;

    // The recorded layers, on the same anchor and bar grid as the backing (§0.4). `segments()`
    // decides what plays for the slot the transport resolved, placed at *this* bar's frame — so
    // bar preview repeats one slot's audio the same way it repeats one slot's chord.
    const crossfade = Math.round(CROSSFADE_SECONDS * t.sampleRate);
    for (const voice of layerVoices) {
      const slotIndex = head ? slotAt(head) : absoluteBar % Math.max(1, t.barCount);
      const segs = segments(
        voice.layer.barSources,
        voice.index,
        slotIndex,
        1,
        voice.layer.mutedSlots,
        latencyFrames,
      )
        .map((s) => ({ ...s, startFrame: barStartFrame }))
        // A bar already under way is never re-scheduled from its downbeat: `start` treats a past
        // time as "now", which restarts it on top of the copy already playing. Entering an
        // in-progress bar is `spliceCurrentBar`'s job.
        .filter((s) => frameToTime(s.startFrame) >= c.currentTime);
      // `frameToTime(0)` is the anchor because `scheduleSegments` adds a frame count to it.
      voice.scheduled.push(
        ...scheduleSegments(c, voice.chain.input, segs, voice.buffers, frameToTime(0), crossfade),
      );
      // Reported per segment rather than per bar, and carrying the session id: *whose* recording
      // this is, which is the question a preview playing the wrong project's audio turns on.
      for (const s of segs) {
        watching?.({
          kind: 'layer',
          layer: voice.layer.index,
          sessionId: voice.layer.sessions[s.region.sessionIndex]?.id,
          slot: slotIndex,
          frame: s.startFrame,
          time: frameToTime(s.startFrame),
        });
      }
    }

    if (!build) return;
    bar.chords.forEach((onset, i) => {
      const frame = barStartFrame + onset.frameOffset;
      if (frame < originFrame) return;
      const at = frameToTime(frame);
      if (at < c.currentTime) return;
      const nominal = onset.nominalFrames / t.sampleRate;
      const seconds = Math.min(nominal, chordCaps[i] ?? nominal);
      for (const freq of bar.frequencies) {
        build(c, chordGain!, freq, at, onset.articulation === 'chunk', seconds);
        watching?.({ kind: 'chord', frame, time: at, frequency: freq });
      }
    });
  }

  /**
   * Enter a slot's new source part-way through the bar it is already playing (§2.5), which is
   * what makes hunting viable — swiping the bar that IS playing has to be heard on that bar.
   *
   * The entry point is one crossfade ahead of the playhead (never `now`, which is already past by
   * the time the graph acts on it) and the outgoing segment comes down over exactly that window.
   *
   * `splice()` declines the two cases not worth it — no audio, and a playhead inside the tail
   * guard — and both fall through to the natural boundary, a bar away at most.
   */
  function spliceCurrentBar(voice: LayerVoice, was: Layer) {
    if (anchorTime === undefined || !ctx || !timing) return;
    const t = timing;
    const c = ctx;
    const fpb = framesPerBar(t);
    const crossfade = Math.round(CROSSFADE_SECONDS * t.sampleRate);

    const now = engine.frame();
    const head = playheadAt(transport, now, t);
    if (!head) return;
    const slot = slotAt(head);

    // Only the slot under the playhead splices. Every other edit is ahead of the horizon and
    // `rescheduleFuture` has already dealt with it.
    const ref = voice.layer.barSources[slot];
    const before = was.barSources[slot];
    const muted = isSlotMuted(voice.layer.mutedSlots, slot);
    const wasMuted = isSlotMuted(was.mutedSlots, slot);
    const sameSource =
      ref && before && ref.pass === before.pass && ref.relativeBar === before.relativeBar;
    if (sameSource && muted === wasMuted) return;

    enterCurrentBar(voice, now);
  }

  /**
   * Enter the bar already under way, at the offset the playhead has reached (§2.5).
   *
   * Split out of `spliceCurrentBar` so **seeking can use it too**. A seek lands wherever the
   * finger did, which is almost never a bar line: `start` sets `nextBar` to the bar containing
   * the target, and `scheduleBar` then drops that bar's layer segment as being in the past —
   * correctly, since scheduling a bar from its downbeat when the downbeat has gone would restart
   * it on top of itself. The consequence was that seeking into a bar played the drums, whose
   * onsets are filtered individually, and **none of the recorded layers** until the next bar line.
   * Up to a full bar of a project sounding like it lost its takes.
   *
   * `fromFrame` is the caller's idea of now, and the two callers disagree on purpose. A splice
   * asks the engine, because the playhead has moved since the gesture. A seek passes the frame it
   * is seeking *to*: `frame()` reads behind `originFrame` for the length of the scheduling lead,
   * and entering from there would place the segment before the anchor — in the past, which
   * `start` treats as "now" and which is the restart this exists to avoid.
   */
  function enterCurrentBar(voice: LayerVoice, fromFrame: number) {
    if (anchorTime === undefined || !ctx || !timing) return;
    const t = timing;
    const c = ctx;
    const fpb = framesPerBar(t);
    const crossfade = Math.round(CROSSFADE_SECONDS * t.sampleRate);

    const head = playheadAt(transport, fromFrame, t);
    if (!head) return;
    const slot = slotAt(head);
    const ref = voice.layer.barSources[slot];
    const muted = isSlotMuted(voice.layer.mutedSlots, slot);

    const enterFrame = fromFrame + crossfade;
    const offsetInBar = enterFrame - Math.floor(fromFrame / fpb) * fpb;
    const at = frameToTime(enterFrame);

    // Whatever this layer has sounding gives way, muted or not — a slot muted mid-bar goes quiet
    // on that bar rather than finishing it, which is what tap-and-hold looks like it should do.
    // After a seek there is nothing sounding, because `start` has just called `killAll`.
    for (const sounding of voice.scheduled) {
      if (sounding.at <= at && sounding.endsAt > at) retire(sounding, at, crossfade / t.sampleRate);
    }
    if (!ref || muted) return;

    // The offset applies here too, or a splice lands at a different place in the take than a join.
    const region = splice(ref, voice.index, offsetInBar, crossfade, latencyFrames);
    if (!region) return;

    voice.scheduled.push(
      ...scheduleSegments(
        c,
        voice.chain.input,
        [{ slot, source: ref, region, startFrame: enterFrame }],
        voice.buffers,
        frameToTime(0),
        crossfade,
      ),
    );
    // Reported like any other scheduling. A splice and a mid-bar seek both put audio on the
    // graph, and an instrument that only saw `scheduleBar` would call that silence.
    watching?.({
      kind: 'layer',
      layer: voice.layer.index,
      sessionId: voice.layer.sessions[region.sessionIndex]?.id,
      slot,
      frame: enterFrame,
      time: at,
    });
  }

  function topUp() {
    if (anchorTime === undefined || !ctx || !timing || !backing) return;
    sweep();
    const horizon = ctx.currentTime + AHEAD_SECONDS;
    // Guarded rather than `while (true)`: a pathological tempo must not spin the main thread.
    for (let n = 0; n < 64; n++) {
      const startTime = frameToTime(nextBar * framesPerBar(timing));
      if (startTime > horizon) break;
      scheduleBar(nextBar);
      nextBar++;
    }
  }

  function rebuild() {
    if (!backing || !timing) return;
    bars = backingSchedule(backing, timing);
    // Every bar carries the same chord onsets — the pattern is one bar — so one bar decides them.
    chordCaps = bars[0] ? chordRingSeconds(bars[0], timing) : [];
    applyLevels();
  }

  // ----------------------------------------------------------------- engine --
  const engine: BackingEngine = {
    sampleRate,

    frame: () =>
      anchorTime === undefined || !ctx
        ? originFrame
        : originFrame + Math.round((ctx.currentTime - anchorTime) * sampleRate),

    running: () => anchorTime !== undefined,

    ready: () => (context ? true : owned?.state === 'running'),

    start(atFrame) {
      if (destroyed) return;
      const c = ensure();
      killAll();
      originFrame = atFrame;
      anchorTime = c.currentTime + LEAD_SECONDS;
      nextBar = timing ? Math.floor(atFrame / framesPerBar(timing)) : 0;
      applyLevels();
      topUp();
      // **Starting mid-bar is a seek, and the bar you land in has to sound.** `topUp` schedules
      // from the bar boundary, and `scheduleBar` then drops that bar's layer segment for being
      // in the past — right, because scheduling a bar from a downbeat that has gone restarts it
      // on top of itself. Drums survive it, their onsets being filtered one at a time; the
      // layers did not, so seeking into a bar played the backing with no takes under it for up
      // to a whole bar. Entering at the offset is what `spliceCurrentBar` already does for a
      // swipe, which is why that half is now its own function.
      if (timing && atFrame % framesPerBar(timing) !== 0) {
        for (const voice of layerVoices) enterCurrentBar(voice, atFrame);
      }
      if (timer === undefined) timer = window.setInterval(topUp, TOPUP_MS);
    },

    stop() {
      if (destroyed) return;
      // **The count-in window dies with the transport that carried it.**
      //
      // `setCountIn` is set before a take and was never cleared. It is a comparison against
      // `barStartFrame`, which counts from `originFrame` — and `start` re-anchors that — so after
      // one Drums-only take, *every later playback from the top* of that engine replayed the
      // count-in: the first bars came back without chords or layers, for no reason the screen
      // showed. It survived until the engine was rebuilt, which happens on navigation, so it
      // looked intermittent — pressing play again on Playback reproduced it, leaving the screen
      // did not.
      //
      // Cleared here rather than asked of the caller: the engine knows when the take the window
      // belonged to has ended, and every caller remembering is what this file keeps getting
      // wrong.
      countInUntilFrame = 0;
      originFrame = engine.frame();
      anchorTime = undefined;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      killAll();
    },

    setBacking(next, t) {
      if (destroyed) return;
      const tempoChanged =
        timing !== undefined &&
        (timing.bpm !== t.bpm || timing.barCount !== t.barCount || timing.beatsPerBar !== t.beatsPerBar);
      // **Mute is not like a kit change, and the difference is which bars are already decided.**
      // A muted track schedules *nothing* — `backingSchedule` omits its onsets — so muting only
      // affects bars not yet committed. The horizon runs `AHEAD_SECONDS` in front, which at
      // 240 BPM is more than a bar, so the drums kept playing for up to 1.2 s after the tap and
      // the control read as broken. A kit or chord change needs no reschedule for the opposite
      // reason: the onsets are the same, only the voice built from them differs.
      const muteChanged =
        backing !== undefined &&
        (backing.drums.muted !== next.drums.muted || backing.chords.muted !== next.chords.muted);
      backing = next;
      timing = t;
      rebuild();
      if (anchorTime === undefined) return;
      if (tempoChanged) {
        // Every future bar time is derived from the tempo, so a live change has to re-anchor —
        // patching the horizon would leave already-scheduled bars at the old spacing.
        const at = engine.frame();
        engine.stop();
        engine.start(at);
      }
      if (muteChanged) {
        // Only the future: a voice already sounding is left alone, because cutting a chord
        // mid-decay is the click this engine spends everywhere else avoiding.
        rescheduleFuture();
        return;
      }
      // Otherwise nothing to do: the next top-up reads the new tracks, so a kit or chord change
      // lands within a bar and no running voice is rebuilt underneath itself.
    },

    setTransport(next) {
      if (destroyed) return;
      transport = next.mode === 'idle' ? playLoopFrom(0, 0) : next;
      rescheduleFuture();
    },

    async openInput() {
      if (destroyed) return false;
      ensure();
      // Capture needs the live context specifically. An offline render has no input to open, and
      // asking for one would be a category error rather than a failure to report.
      const c = owned;
      if (!c) return false;
      try {
        // **A dead stream is discarded rather than reused.** See `inputIsLive` — the object
        // outlives the device, so `if (!stream)` reopened nothing and the take was silent.
        if (stream && !inputIsLive()) releaseInput();
        if (!stream) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: MUSIC_CONSTRAINTS });
        }
        // Held across takes while it is *live*: reopening re-negotiates the input route, and that
        // route is what the recording offset was set against (§2.3).
        if (!recorder) {
          recorder = await createRecorder(c, c.createMediaStreamSource(stream));
        }
        inputError = undefined;
        return true;
      } catch (e) {
        // No device, no permission, or an insecure origin. Kept, not swallowed: a browser that
        // refuses the microphone otherwise records a silent take and says nothing.
        inputError = classify(e);
        return false;
      }
    },

    inputError: () => inputError,

    /**
     * **Live, not merely present.** This used to be `!!recorder`, and a `MediaStreamTrack` outlives
     * the device behind it: unplug the headset, revoke permission in another tab, let the OS take
     * the route for a call, and the track goes to `ended` while every object involved stays exactly
     * where it was. So the row armed, the take recorded, and §3.5's whole point — that a row
     * refuses to arm without an input, because everything downstream is correct *given a take* —
     * was defeated by a stream that had been valid when it was asked for.
     *
     * It is the same failure the denied-microphone guard was written for: a take of silence
     * committed as a real pass, with the badge advanced, the arrangement built on it, and the pass
     * count and size projection both up by audio that does not exist.
     */
    hasInput: () => !!recorder && inputIsLive(),

    inputPeak: () => (recorder?.recording() ? recorder.peak() : 0),

    onSchedule(listen) {
      watching = listen;
    },

    setCountIn(untilFrame) {
      if (destroyed) return;
      countInUntilFrame = Math.max(0, untilFrame);
    },

    setMaster(level, muted) {
      if (destroyed) return;
      // An engine handed a context is rendering (`render.ts`), and monitoring is not part of the
      // mix. Refusing here makes that structural rather than a convention a future caller could
      // break by reusing the live engine for a render.
      if (context) return;
      masterLevel = Math.min(Math.max(level, 0), 1);
      masterMuted = muted;
      applyMaster();
    },

    prerender(bars) {
      if (destroyed) return;
      ensure();
      killAll();
      // Anchored at exactly 0: there is no clock to race offline, and a lead would put silence
      // at the head of every exported file.
      originFrame = 0;
      anchorTime = 0;
      nextBar = 0;
      applyLevels();
      for (let bar = 0; bar < bars; bar++) scheduleBar(bar);
      nextBar = bars;
    },

    async startCapture() {
      if (destroyed) return false;
      // For a caller that never armed. A no-op once open, so the armed path has already paid.
      if (!(await engine.openInput())) return false;
      /**
       * **The two clocks meet here, and they are not the same clock.**
       *
       * The worklet stamps every chunk with `currentFrame`, which counts from when the
       * *AudioContext* was created. Everything else in this engine counts from the transport's
       * `originFrame`, re-anchored on every `start`. `Capture.arrivedAtFrame` is documented as an
       * engine frame and was being handed back as a context one, so any caller comparing it
       * against a transport frame was subtracting two different origins — see `stopCapture`.
       *
       * Taken now rather than at the stop, because by then the transport may already have
       * stopped: `stop()` clears `anchorTime` and moves `originFrame`, so the mapping would be
       * gone at exactly the moment it is needed. Nothing re-anchors during a take — seeking is
       * refused and the tempo is locked — so one reading holds for the whole recording.
       */
      // **Re-checked after the await, not only before it.** `openInput` can take as long as a
      // permission prompt, and anything can happen while it is open — navigating away destroys
      // the engine and `releaseInput` clears the recorder. The guard at the top of this function
      // ran before that window, and the `recorder!` below asserted through it: the resolved
      // promise then called `.start()` on undefined.
      if (destroyed || !recorder) return false;
      captureFrameOffset =
        anchorTime === undefined || !ctx ? 0 : originFrame - anchorTime * ctx.sampleRate;
      recorder.start();
      return true;
    },

    async stopCapture() {
      if (!recorder?.recording()) return undefined;
      // **Both of these are read before the await, and that is the fix.** `recorder.stop()`
      // waits for the worklet to flush its partial chunk, which is what keeps the tail of a take
      // — and during that wait the engine can be destroyed, clearing `recorder` and resetting
      // `captureFrameOffset`. Reading them afterwards meant a take that survived the stop could
      // still be converted with the wrong origin, which is the count-in bug by a slower route.
      const from = recorder;
      const offset = captureFrameOffset;
      const capture = await from.stop();
      // Into engine frames, which is what the type has always claimed to return.
      return {
        ...capture,
        arrivedAtFrame: Math.round(capture.arrivedAtFrame + offset),
      };
    },

    setLayers(project, takes, recordingIntoLayerIndex) {
      if (destroyed) return;
      const c = ensure();
      const t = timing ?? projectTiming(project);
      // The whole voice is carried across, keyed by layer index: a level change must not rebuild
      // a node under sounding audio, and what the voice handed the graph is what a splice retires.
      const previous = new Map(layerVoices.map((v) => [v.layer.index, v]));
      const wasLayer = new Map(layerVoices.map((v) => [v.layer.index, v.layer]));
      const replaced = new Map(wasLayer);

      // The recording offset is baked into every scheduled buffer's read position, so a change
      // to it has to reach the horizon the same way an arrangement edit does. It is caught here
      // rather than by the identity checks below, which compare *layers* — an offset change
      // touches none of them, so without this the slider would move and nothing would be heard
      // until some other edit happened to force a re-plan.
      const wasLatency = latencyFrames;
      latencyFrames = latencyOffsetFrames(t, project.latencyOffsetSeconds);
      let replan = latencyFrames !== wasLatency;

      /**
       * Did anything change that is baked into *already scheduled* audio?
       *
       * An edit to the arrangement has to be heard now — §2.4 calls applying an edit to playing
       * audio core functionality, not polish, and the horizon is deliberately short so a splice
       * is never far behind the gesture. But a level, EQ or pan change needs no rescheduling at
       * all: those live on the chain, which the scheduled buffers are already routed through.
       *
       * Distinguished by *identity*, which works because layers are immutable values: an edit
       * produces a new `barSources` array, while dragging the level slider leaves it the same
       * reference. That matters — a slider emits an event per pixel, and rescheduling on each
       * one would tear down and rebuild the horizon dozens of times a second.
       *
       * The recording offset is the exception, and it is handled above: it *is* baked into the
       * scheduled buffers, but it lives on the project rather than on any layer, so no identity
       * check here would ever see it move.
       */
      layerVoices = project.layers
        .filter((layer) => layer.sessions.length > 0)
        .filter((layer) => isLayerAudible(layer, recordingIntoLayerIndex))
        .map((layer) => {
          // Reused where it exists, so a level or preset change ramps a running graph instead of
          // rebuilding one under audio that is already sounding (§2.8).
          const kept = previous.get(layer.index);
          const chain = kept?.chain ?? createLayerChain(c, bus!, t);
          const was = wasLayer.get(layer.index);
          if (
            !was ||
            was.barSources !== layer.barSources ||
            was.mutedSlots !== layer.mutedSlots ||
            was.sessions !== layer.sessions
          ) {
            replan = true;
          }
          previous.delete(layer.index);
          wasLayer.delete(layer.index);
          chain.setEq(layer.eq);
          chain.setPan(layer.pan);
          chain.setLevel(layer.level);
          return {
            layer,
            index: layerPassIndex(layer, t),
            buffers: takes.buffersFor(layer),
            chain,
            scheduled: kept?.scheduled ?? [],
          };
        });
      // Whatever is left was audible and is not any more. **Faded, then disconnected** — cutting
      // it outright steps the signal from wherever the waveform was to zero between two render
      // quanta, which fires on every layer mute and at the top of every take on a layer that
      // already has audio, since the layer being recorded onto is derived-silent (§2.2). It still
      // ends disconnected, so a muted layer costs nothing per bar.
      for (const gone of previous.values()) gone.chain.fadeOutAndDisconnect();
      if (wasLayer.size > 0) replan = true; // a layer went silent; its bars must stop
      if (!replan) return;

      // Order matters: dropping the future first leaves the bar under the playhead as the only
      // thing sounding, so the splice has one clear thing to hand over from.
      rescheduleFuture();
      for (const voice of layerVoices) {
        const was = replaced.get(voice.layer.index);
        if (was) spliceCurrentBar(voice, was);
      }
    },

    destroy() {
      if (destroyed) return;
      engine.stop();
      // **The microphone goes with it.** Arming opens an input and the engine holds it across
      // takes; a navigation builds a new engine and opens another. Nothing stopped the old one,
      // so each arm-after-navigation leaked a live `MediaStream` — the browser's recording
      // indicator stays lit over an app that is not recording, and on iOS a live capture track
      // holds the audio session in a record category, which is a routing variable
      // docs/device-check.md §1 has to control for.
      releaseInput();
      // Unplug before letting go: a shared context outlives this engine, and every engine builds
      // its own compressor and monitoring gain into the destination.
      try {
        masterGain?.disconnect();
      } catch {
        /* already disconnected */
      }
      void owned?.close();
      // `owned` too, not only `ctx`. Leaving it set is what let a stale call build a second
      // context and then fail on a closed one.
      owned = undefined;
      ctx = undefined;
      bus = undefined;
      masterGain = undefined;
      watching = undefined;
      destroyed = true;
    },
  };

  void bus; // held only so the graph is not collected; the compressor has no other reader
  return engine;
}
