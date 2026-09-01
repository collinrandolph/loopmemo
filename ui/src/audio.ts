import {
  type BackingTracks,
  type ChordTone,
  type DrumKit,
  chordTone,
  drumKit,
} from '../../src/domain/backing.ts';
import { type BackingBar, backingSchedule } from '../../src/domain/backing-schedule.ts';
import type { PassIndex } from '../../src/domain/pass-index.ts';
import {
  type Layer,
  type Project,
  isLayerAudible,
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
import type { Engine } from './sim.ts';

/**
 * A **sounding** engine for the browser build: the backing tracks, synthesised live.
 *
 * This is `sim.ts`'s `Engine` with audio behind it, which is the point — that type was written as
 * the seam a real engine would replace, so this is the substitution actually happening rather than
 * a second thing bolted alongside. Screens keep asking for a frame position and get one; the
 * difference is that the position now comes from an audio clock that something is audibly playing
 * against, which is what §2.4 means by the engine's position being authoritative.
 *
 * **`src/domain` is untouched and stays pure.** Everything here reads `backingSchedule()` — onset
 * frames, frequencies, envelope lengths — and does the two things a domain cannot: converts to the
 * platform's unit, and builds nodes. Frames become seconds in exactly one place (`frameToTime`).
 *
 * **This is browser-only and disposable**, like the rest of `ui/`. It is a port of
 * `prototype/backing-tracks/audio.js`, the sketch the kit and tone decisions were made against;
 * when a platform is chosen, that prototype and this file are both references to translate from,
 * not code to carry over. The recipes live here rather than in the domain deliberately: oscillator
 * graphs, waveshaper curves and the compressor are platform-bound, while the parameters that
 * *shape* them are domain data and come from `DrumKit` and `ChordTone`.
 */

/**
 * The crossfade on every segment join (§2.4), in seconds because it is a physical duration —
 * the same argument that keeps `TOLERANCE_SECONDS` and the envelope times out of frames.
 * 7 ms sits in the middle of the spec's 5–10.
 */
const CROSSFADE_SECONDS = 0.007;

/** Scheduled this far ahead of the playhead, topped up on an interval. */
const AHEAD_SECONDS = 1.2;
const TOPUP_MS = 250;
/** Gap between `start()` and the first onset, so scheduling never races the clock. */
const LEAD_SECONDS = 0.08;

export type BackingEngine = Engine & {
  /**
   * What to play. Safe while running: a change to the tracks is picked up by the next bar
   * scheduled, so swapping a kit or a chord is heard within a bar and never clicks. A change to
   * *timing* re-anchors instead, because every future bar time is derived from the tempo.
   */
  setBacking(backing: BackingTracks, t: Timing): void;
  /**
   * Which traversal of the arrangement is playing (§3.6). **The backing follows the transport**,
   * so the bar being generated is the bar the sweep is over — in bar mode that is one slot held,
   * which is what makes previewing bar 7 sound like bar 7 (§2.6) instead of walking the
   * progression underneath a sweep that is not moving.
   *
   * Defaults to the whole arrangement from slot 1, which is what every screen without a transport
   * means by "play". Safe while running: already-scheduled bars that have not sounded yet are
   * dropped and rebuilt, so the change is heard at the next bar rather than after the lookahead.
   */
  setTransport(transport: Transport): void;
  /**
   * The recorded layers, and which one (if any) is being recorded onto right now.
   *
   * Called whenever a take commits, a level or mute changes, or arming moves — the engine holds
   * no opinion about any of that and simply re-reads what it is given on the next bar.
   *
   * The layer being captured into is silent for the take (§2.2), and that is *derived* here
   * through `isLayerAudible` rather than written into `layer.muted`, because writing it through
   * would make our state indistinguishable from the user's and stopping could not restore
   * theirs.
   */
  setLayers(project: Project, takes: TakeStore, recordingIntoLayerIndex?: number): void;
  /**
   * Open the microphone, ahead of needing it. **Call this when arming, not when recording.**
   *
   * The first call is what raises the browser's permission prompt, and a prompt raised at the
   * downbeat gets answered several seconds into a take that is already running — so the take
   * captures nothing and nothing says why. Arming is the moment the user has declared intent and
   * is not yet counting bars, which makes it the right place to pay for the prompt.
   *
   * Resolves false rather than throwing: a refusal is a state to render, since a take that
   * captures nothing still traverses bars and the transport should not care.
   *
   * Capture lives on the engine because the engine owns the `AudioContext`. Handing the context
   * out instead would put the platform's most replaceable object into every screen that records.
   */
  openInput(): Promise<boolean>;
  /** Why the input is unavailable, for a screen to show. Undefined once it opens. */
  inputError(): string | undefined;
  /**
   * Loudest input sample since the last call, for a meter or a live waveform. Resets on read.
   * 0 when nothing is capturing, which draws as silence rather than as invention.
   */
  inputPeak(): number;
  /** Begin capturing. Opens the input first if arming did not. */
  startCapture(): Promise<boolean>;
  stopCapture(): Promise<Capture | undefined>;
  /** Whether the browser has actually let us make sound yet (autoplay policy). */
  ready(): boolean;
  destroy(): void;
};

type Voice = { nodes: AudioNode[]; startsAt: number; endsAt: number };

/**
 * `latencyFrames` is the measured round trip to subtract from every capture (§2.3). It defaults
 * to 0 — uncompensated and honest — because the number belongs to a calibration this build has
 * not run yet, and a plausible-looking constant would be indistinguishable from a measurement.
 */
export function audioEngine(sampleRate: number, latencyFrames = 0): BackingEngine {
  let ctx: AudioContext | undefined;
  let bus: DynamicsCompressorNode | undefined;
  let drumGain: GainNode | undefined;
  let chordGain: GainNode | undefined;

  let backing: BackingTracks | undefined;
  let timing: Timing | undefined;
  // The whole arrangement from the top: what "play" means on every screen that has no transport
  // of its own. Idle is never stored — a stopped engine schedules nothing anyway, and falling
  // back to the linear walk keeps a caller that hands one over from going silent.
  let transport: Transport = playLoopFrom(0, 0);
  let bars: readonly BackingBar[] = [];
  /** Longest a chord voice may ring, by onset index — see `chordRingCaps`. */
  let chordCaps: readonly number[] = [];

  /**
   * One entry per recorded layer, resolved once per `setLayers` rather than per bar.
   * `layerPassIndex` walks every session's frame count, which is not work for the scheduler to
   * repeat 344 times a second.
   */
  type LayerVoice = {
    layer: Layer;
    index: PassIndex;
    buffers: SessionBuffers;
    chain: LayerChain;
    /** What this layer currently has handed to the graph, so a splice can retire it. */
    scheduled: ScheduledVoice[];
  };
  let layerVoices: LayerVoice[] = [];

  let stream: MediaStream | undefined;
  let inputError: string | undefined;
  let recorder: Recorder | undefined;

  let originFrame = 0;
  /** `ctx.currentTime` corresponding to `originFrame`. Undefined when stopped. */
  let anchorTime: number | undefined;
  let nextBar = 0; // absolute bar index, counting from the loop start
  let voices: Voice[] = [];
  let lastHat: { source: AudioBufferSourceNode; stopAt: number } | undefined;
  let timer: number | undefined;

  // ------------------------------------------------------------------ graph --
  function ensure(): AudioContext {
    if (!ctx) {
      /**
       * **At the project's rate, not the device's.** Omitting this takes the hardware default —
       * 48 kHz on this machine — while `Timing` computes every frame count at the project's
       * quality, 44.1 kHz. The engine then holds two rates: `frameToTime` converts with the
       * domain's, so the backing stays correct, and `scheduleSegments` converts with the
       * context's, so the recorded layers run 8.8% fast against the drums.
       *
       * It was invisible until layers had audio to play, which is the whole reason to close the
       * record-to-playback loop early. One rate, named once, and every conversion agrees.
       */
      ctx = new AudioContext({ sampleRate });
      // A chord is three or four notes, some tones use three oscillators each, and tails overlap
      // — a dense pattern easily has a dozen oscillators sounding at once. Summed straight into
      // `destination` that clips, and hard digital clipping is exactly a harsh arrhythmic screech,
      // because distortion respects neither envelopes nor timing. **Every voice goes through
      // this**, never to the destination.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 12;
      comp.ratio.value = 14;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      /**
       * Unity, not the 0.5 it was.
       *
       * The halving was added alongside the compressor when this bus carried nothing but
       * synthesised backing, and it was belt and braces even then: a `DynamicsCompressorNode`
       * applies **no makeup gain**, so with a −20 dB threshold at 14:1 a full-scale input already
       * leaves around −18 dBFS. There was never 6 dB of clipping risk to spend.
       *
       * It stopped being harmless when recorded layers started passing through here, because
       * they inherited an attenuation chosen for a stack of oscillators they are not part of —
       * and a quiet microphone had no headroom to give away. Reported as "working but very
       * quiet"; this was our share of it.
       */
      const headroom = ctx.createGain();
      headroom.gain.value = 1;
      comp.connect(headroom);
      headroom.connect(ctx.destination);
      bus = comp;

      // One gain per track, so `level` is a property of the track rather than something baked
      // into every voice's peak. Mute is not here — `backingSchedule` omits a muted track's
      // onsets entirely, so there is nothing to turn down.
      drumGain = ctx.createGain();
      chordGain = ctx.createGain();
      drumGain.connect(comp);
      chordGain.connect(comp);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  function applyLevels() {
    if (!backing || !drumGain || !chordGain) return;
    drumGain.gain.value = backing.drums.level;
    chordGain.gain.value = backing.chords.level;
  }

  // ------------------------------------------------------------ bookkeeping --
  /**
   * Cleanup is anchored to the voice's scheduled end **in context time**, not to a wall clock at
   * the moment it was scheduled. Scheduling runs up to `AHEAD_SECONDS` ahead, so "now" when a
   * voice is created can be a second before it starts — anchoring to the wrong one disconnects
   * voices before they ever sound.
   */
  function track(nodes: AudioNode[], startTime: number, seconds: number) {
    voices.push({ nodes, startsAt: startTime, endsAt: startTime + seconds + 0.2 });
  }

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

    // **And the layers.** They are not in `voices` — they are held per layer so a splice can
    // reach them — so nothing here reached them, and `stop()` left up to `AHEAD_SECONDS` of
    // layer audio still running. The next `start()` then laid a fresh plan on top of it, which
    // is how tapping a playing slot and immediately tapping again produced three copies at once.
    //
    // Sounding segments fade over the crossfade rather than cutting: this is what a stop button
    // does, and the drums having always cut is not a reason for the layers to.
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
   * Drop what is scheduled but not yet sounding, and rebuild the horizon from where we are.
   *
   * Scheduling runs `AHEAD_SECONDS` in front of the playhead, so a change to *which bar plays
   * next* would otherwise be heard up to a second and a bit late while the sweep moved at once —
   * long enough to read as the backing being on a different loop from the arrangement, which is
   * exactly the bug this exists to close.
   *
   * **Voices that have already started are left alone.** They were correct when they began, and
   * cutting a chord mid-decay is a click. The current bar is rescheduled rather than skipped —
   * `scheduleBar` drops onsets already in the past, so its remaining beats come back rather than
   * leaving most of a bar silent.
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

    // **And the layers, which are not in `voices`.** Backing voices are tracked by `track()`;
    // layer segments are held per layer so a splice can find them, and dropping only the first
    // list left every queued bar of the old plan in place while `topUp` scheduled the new one
    // beside it. Two copies of the layer, a bar apart in content, until both ran out — which is
    // what a swipe late in a bar and a double tap out of bar mode both produced.
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

  // ----------------------------------------------------------- drum voices --
  function noise(c: AudioContext, seconds: number): AudioBuffer {
    const length = Math.max(1, Math.floor(c.sampleRate * seconds));
    const buffer = c.createBuffer(1, length, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Pitch-swept sine plus a very short click. The sweep alone reads as boomy, not as a hit. */
  function kick(c: AudioContext, dest: AudioNode, at: number, k: DrumKit['kick']) {
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
  function snare(c: AudioContext, dest: AudioNode, at: number, s: DrumKit['snare']) {
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
  function hat(c: AudioContext, dest: AudioNode, at: number, h: DrumKit['hat'], open: boolean) {
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
    src.connect(hp);
    hp.connect(bp);
    bp.connect(gain);
    gain.connect(dest);

    gain.gain.setValueAtTime(open ? 0.32 : 0.38, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);

    if (lastHat && lastHat.stopAt > at) {
      try {
        lastHat.source.stop(at);
      } catch {
        /* already stopped */
      }
    }
    const stopAt = at + seconds + 0.02;
    src.start(at);
    src.stop(stopAt);
    lastHat = { source: src, stopAt };
    track([src, hp, bp, gain], at, seconds);
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
  function tremolo(c: AudioContext, rate: number, depth: number) {
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
    c: AudioContext,
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
  /**
   * How long each chord onset may ring before the next one in the same bar, wrapping past the bar
   * line back to the first.
   *
   * **This is the prototype's overlap rule, and §6.1 has not settled it.** Capping to the gap
   * makes cross-onset pile-up structurally impossible for chords, which is what stopped the
   * cumulative screech in the prototype — but drums are not capped (the hat chokes instead, and
   * kick and snare do neither), and the floor below means the cap stops holding above ~150 BPM on
   * the densest pattern. Recorded rather than quietly fixed: whichever policy wins should be one
   * rule, decided once, not three that happen to coexist here.
   */
  function chordRingCaps(bar: BackingBar, t: Timing): number[] {
    const fpb = framesPerBar(t);
    return bar.chords.map((onset, i) => {
      const next = bar.chords[(i + 1) % bar.chords.length]!;
      const gap =
        i === bar.chords.length - 1
          ? fpb - onset.frameOffset + next.frameOffset
          : next.frameOffset - onset.frameOffset;
      return Math.max(0.15, gap / t.sampleRate - 0.05);
    });
  }

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
    // reads (§3.6). A private `absoluteBar % bars.length` is a second answer to the question the
    // playhead already answers, and it was wrong the moment the two disagreed: bar preview held
    // one slot on screen while this walked the chord progression underneath it.
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
      // And this one went past while we were running: `rescheduleFuture` rewinds into the bar in
      // progress to recover its remaining beats, so its earlier ones have to be dropped here.
      if (at <= c.currentTime) continue;
      if (onset.voice === 'kick') kick(c, drumGain!, at, kit.kick);
      else if (onset.voice === 'snare') snare(c, drumGain!, at, kit.snare);
      else hat(c, drumGain!, at, kit.hat, onset.voice === 'hatOpen');
    }

    // The recorded layers, on the same anchor and the same bar grid as the backing (§0.4). What
    // plays is `segments()`'s decision, taken for the slot the transport resolved and then
    // placed at *this* bar's frame — so bar preview repeats one slot's audio the same way it
    // repeats one slot's chord, and neither knows about the other.
    const crossfade = Math.round(CROSSFADE_SECONDS * t.sampleRate);
    for (const voice of layerVoices) {
      const slotIndex = head ? slotAt(head) : absoluteBar % Math.max(1, t.barCount);
      const segs = segments(voice.layer.barSources, voice.index, slotIndex, 1, voice.layer.mutedSlots)
        .map((s) => ({ ...s, startFrame: barStartFrame }))
        // A bar already under way is never re-scheduled from its downbeat. `start` treats a past
        // time as "now", so this would restart the bar from its beginning on top of the copy
        // already playing — which is what a re-plan mid-bar used to do. Entering an in-progress
        // bar is a splice, and `spliceCurrentBar` is where that happens.
        .filter((s) => frameToTime(s.startFrame) > c.currentTime);
      // `frameToTime(0)` as the anchor, because `scheduleSegments` adds a frame count to it and
      // the engine's own anchor is offset by wherever playback started.
      voice.scheduled.push(
        ...scheduleSegments(c, voice.chain.input, segs, voice.buffers, frameToTime(0), crossfade),
      );
    }

    if (!build) return;
    bar.chords.forEach((onset, i) => {
      const frame = barStartFrame + onset.frameOffset;
      if (frame < originFrame) return;
      const at = frameToTime(frame);
      if (at <= c.currentTime) return;
      const nominal = onset.nominalFrames / t.sampleRate;
      const seconds = Math.min(nominal, chordCaps[i] ?? nominal);
      for (const freq of bar.frequencies) {
        build(c, chordGain!, freq, at, onset.articulation === 'chunk', seconds);
      }
    });
  }

  /**
   * Enter a slot's new source part-way through the bar it is already playing (§2.5).
   *
   * **This is what makes hunting viable.** Committing at the boundary would force the user to
   * wait out the rest of every bar before hearing a comparison, and the whole Edit Layer screen
   * is a comparison being made repeatedly. Swiping the bar that IS playing has to be heard on
   * that bar.
   *
   * The entry point is one crossfade ahead of the playhead — never `now`, which would be in the
   * past by the time the graph acted on it — and the outgoing segment is taken down over exactly
   * that window, so the two are a crossfade rather than a cut plus a gap.
   *
   * `splice()` decides whether it is worth doing at all, and returns undefined for the two cases
   * that are not: a bar with no audio, and a playhead inside the tail guard where the remaining
   * region would be shorter than the crossfade. Both then fall through to the natural boundary,
   * which is a bar away at most.
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

    const enterFrame = now + crossfade;
    const offsetInBar = enterFrame - Math.floor(now / fpb) * fpb;
    const at = frameToTime(enterFrame);

    // Whatever this layer has sounding gives way, muted or not — a slot muted mid-bar goes quiet
    // on that bar rather than finishing it, which is what tap-and-hold looks like it should do.
    for (const sounding of voice.scheduled) {
      if (sounding.at <= at && sounding.endsAt > at) retire(sounding, at, crossfade / t.sampleRate);
    }
    if (!ref || muted) return;

    const region = splice(ref, voice.index, offsetInBar, crossfade);
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
    chordCaps = bars[0] ? chordRingCaps(bars[0], timing) : [];
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

    ready: () => ctx?.state === 'running',

    start(atFrame) {
      const c = ensure();
      killAll();
      originFrame = atFrame;
      anchorTime = c.currentTime + LEAD_SECONDS;
      nextBar = timing ? Math.floor(atFrame / framesPerBar(timing)) : 0;
      applyLevels();
      topUp();
      if (timer === undefined) timer = window.setInterval(topUp, TOPUP_MS);
    },

    stop() {
      originFrame = engine.frame();
      anchorTime = undefined;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      killAll();
    },

    setBacking(next, t) {
      const tempoChanged =
        timing !== undefined &&
        (timing.bpm !== t.bpm || timing.barCount !== t.barCount || timing.beatsPerBar !== t.beatsPerBar);
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
      // Otherwise nothing to do: the next top-up reads the new tracks, so a kit or chord change
      // lands within a bar and no running voice is rebuilt underneath itself.
    },

    setTransport(next) {
      transport = next.mode === 'idle' ? playLoopFrom(0, 0) : next;
      rescheduleFuture();
    },

    async openInput() {
      const c = ensure();
      try {
        if (!stream) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: MUSIC_CONSTRAINTS });
        }
        // The stream is held across takes rather than reopened. Reopening re-negotiates the
        // input route, and the route is what a latency calibration is measured against (§2.3) —
        // a new one per take would invalidate the number every time.
        if (!recorder) {
          recorder = await createRecorder(c, c.createMediaStreamSource(stream), latencyFrames);
        }
        inputError = undefined;
        return true;
      } catch (e) {
        // No device, no permission, or an insecure origin. Kept rather than swallowed: the first
        // version returned a bare false and the screen ignored it, so a browser that refused the
        // microphone recorded a silent take and said nothing at all.
        inputError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        return false;
      }
    },

    inputError: () => inputError,

    inputPeak: () => (recorder?.recording() ? recorder.peak() : 0),

    async startCapture() {
      // Opening here too, for a caller that never armed. It is a no-op once open, so the normal
      // path — armed first — has already paid for the permission prompt by now.
      if (!(await engine.openInput())) return false;
      recorder!.start();
      return true;
    },

    async stopCapture() {
      if (!recorder?.recording()) return undefined;
      return recorder.stop();
    },

    setLayers(project, takes, recordingIntoLayerIndex) {
      const c = ensure();
      const t = timing ?? projectTiming(project);
      // Gains are kept across calls, keyed by layer index, so changing a level does not rebuild
      // a node underneath audio that is already sounding — the same reason the pan presets ramp
      // a wet gain rather than rebuilding the delay.
      // The whole voice is carried across, not just its chain: what it has already handed to the
      // graph is what a splice has to be able to retire.
      const previous = new Map(layerVoices.map((v) => [v.layer.index, v]));
      const wasLayer = new Map(layerVoices.map((v) => [v.layer.index, v.layer]));
      const replaced = new Map(wasLayer);

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
       */
      let replan = false;

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
      // Whatever is left was audible and is not any more. Disconnected rather than silenced, so a
      // muted layer costs nothing per bar.
      for (const gone of previous.values()) gone.chain.disconnect();
      if (wasLayer.size > 0) replan = true; // a layer went silent; its bars must stop
      if (!replan) return;

      // Order matters. Dropping the future first means the bar under the playhead is the only
      // thing still sounding, so the splice has one clear thing to hand over from — and the
      // rebuilt horizon it leaves behind already carries the new arrangement.
      rescheduleFuture();
      for (const voice of layerVoices) {
        const was = replaced.get(voice.layer.index);
        if (was) spliceCurrentBar(voice, was);
      }
    },

    destroy() {
      engine.stop();
      void ctx?.close();
      ctx = undefined;
      bus = undefined;
    },
  };

  void bus; // held only so the graph is not collected; the compressor has no other reader
  return engine;
}
