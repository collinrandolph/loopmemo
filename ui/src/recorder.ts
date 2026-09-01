/**
 * PCM capture into one recording session (§1.4, §2.3).
 *
 * The domain already owns what a take *means* — `recordSession` decides whether a traversal
 * earned a pass, `passIndex` numbers them, `regionFor` resolves a bar to frames. None of that
 * needs audio. What is left here is genuinely platform-bound and small: get float samples out of
 * an input, stamp them against the engine's clock, and hand back a buffer.
 *
 * **It takes an `AudioNode`, not a `MediaStream`.** A microphone is one way to produce one, and
 * making that the parameter would mean the capture path could only ever be exercised by speaking
 * into a device. Taking a node instead means a known signal can be recorded and compared sample
 * for sample, which is how `verify-capture.ts` checks this without a microphone, a permission
 * prompt, or a human.
 *
 * ## Latency compensation is applied here, not computed here
 *
 * §2.3 makes compensation mandatory, and `docs/platform-decision.md` records that the first
 * attempt at this app computed a latency and then discarded it — which is worse than not
 * measuring, because it looks done.
 *
 * The correction is one line, and its direction is the part worth stating. The player hears the
 * backing late by the output latency, plays in time with what they heard, and their sound
 * reaches the capture buffer late again by the input latency. So audio arriving at engine frame
 * F was *performed* at frame F − roundTrip. The captured session is therefore anchored earlier
 * than it arrived, never later.
 *
 * `latencyFrames` is an argument because measuring it is a separate job with its own answer per
 * route (§5 of the platform doc: loopback calibration). Passing 0 is honest — uncompensated —
 * rather than a default that pretends.
 */

export type Capture = {
  readonly buffer: AudioBuffer;
  /**
   * Engine frame the first captured sample was *performed* at — arrival, less the round trip.
   * This is what a `RecordingSession`'s frame 0 means (§1.4).
   */
  readonly startFrame: number;
  readonly frames: number;
  /** What arrived, before compensation. Kept so a calibration can be checked after the fact. */
  readonly arrivedAtFrame: number;
};

export type Recorder = {
  /** Arm the worklet. Capture begins at the next render quantum. */
  start(): void;
  stop(): Promise<Capture>;
  recording(): boolean;
  destroy(): void;
};

type Chunk = { frame: number; samples: Float32Array };

const WORKLET_URL = '/ui/worklets/capture.js';

/**
 * `addModule` is per-context and idempotent in effect but not free, so contexts that have
 * already loaded it are remembered rather than re-fetched on every armed take.
 */
const loaded = new WeakSet<BaseAudioContext>();

export async function createRecorder(
  ctx: BaseAudioContext,
  input: AudioNode,
  latencyFrames = 0,
): Promise<Recorder> {
  if (!loaded.has(ctx)) {
    await ctx.audioWorklet.addModule(WORKLET_URL);
    loaded.add(ctx);
  }

  const node = new AudioWorkletNode(ctx, 'lr-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  input.connect(node);

  let chunks: Chunk[] = [];
  let on = false;
  let settle: ((c: Chunk[]) => void) | undefined;

  node.port.onmessage = ({ data }) => {
    if (data.done) {
      const collected = chunks;
      chunks = [];
      settle?.(collected);
      settle = undefined;
      return;
    }
    chunks.push(data as Chunk);
  };

  return {
    start() {
      chunks = [];
      on = true;
      node.port.postMessage('start');
    },

    recording: () => on,

    async stop(): Promise<Capture> {
      on = false;
      // The worklet flushes its partial chunk and then reports done, so waiting for that
      // message is what guarantees the tail of the take is not dropped. Resolving on a timer
      // instead would lose however much had not filled a chunk.
      const collected = await new Promise<Chunk[]>((resolve) => {
        settle = resolve;
        node.port.postMessage('stop');
      });

      const frames = collected.reduce((n, c) => n + c.samples.length, 0);
      const arrivedAtFrame = collected[0]?.frame ?? 0;
      const buffer = ctx.createBuffer(1, Math.max(1, frames), ctx.sampleRate);
      const channel = buffer.getChannelData(0);

      // Written at each chunk's own frame offset rather than end to end. They should be
      // contiguous, and if the audio thread ever drops a quantum they will not be — appending
      // blindly would silently shorten the take and pull everything after the gap early, which
      // is the same failure mode as a narrow retained bar in compress.
      for (const chunk of collected) {
        const at = chunk.frame - arrivedAtFrame;
        if (at >= 0 && at + chunk.samples.length <= channel.length) channel.set(chunk.samples, at);
      }

      return { buffer, frames, arrivedAtFrame, startFrame: arrivedAtFrame - latencyFrames };
    },

    destroy() {
      on = false;
      node.port.onmessage = null;
      try {
        input.disconnect(node);
      } catch {
        /* already disconnected */
      }
      node.disconnect();
    },
  };
}

/**
 * Constraints for a musical capture, which are not the defaults.
 *
 * Every one of these is on by default in a browser and every one of them is wrong here. Echo
 * cancellation exists to remove exactly what this app is trying to record — the backing coming
 * back through the room — and it does so by adaptively filtering, which is a moving delay.
 * Noise suppression gates quiet passages. Auto gain rides the level between passes, so two takes
 * of the same playing come back at different volumes and the layer balance the user set means
 * nothing.
 *
 * `latency: 0` asks for the smallest input buffer the device will give, which is the term §2.3's
 * compensation cannot recover: it is delay before the signal exists, not an offset to subtract.
 */
// `latency` is a constrainable property in the Media Capture spec but is missing from the DOM
// typings, so it is widened rather than dropped — a real hint to the device is worth more than
// a clean type, and dropping it would silently accept whatever buffer size the browser prefers.
export const MUSIC_CONSTRAINTS: MediaTrackConstraints & { latency?: number } = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  latency: 0,
};
