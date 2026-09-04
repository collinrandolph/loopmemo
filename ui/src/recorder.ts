/**
 * PCM capture into one recording session (§1.4, §2.3).
 *
 * What a take *means* is already the domain's — `recordSession` decides whether a traversal
 * earned a pass, `regionFor` resolves a bar to frames. What is left here is platform-bound and
 * small: get float samples out of an input, stamp them against the engine's clock, hand back a
 * buffer.
 *
 * **It takes an `AudioNode`, not a `MediaStream`**, so a known signal can be recorded and
 * compared sample for sample — `verify-capture.ts` checks this without a microphone or a human.
 *
 * **The recording offset is not applied here** (§2.3). It belongs where audio is *scheduled*,
 * which is what lets it be changed after the fact, keeps it out of the pass count, and makes it
 * judgeable by ear. A capture is exactly what arrived, stamped with when it arrived.
 */

export type Capture = {
  readonly buffer: AudioBuffer;
  readonly frames: number;
  /** Engine frame the first captured sample arrived on. Uncompensated: see the note above. */
  readonly arrivedAtFrame: number;
};

export type Recorder = {
  /** Arm the worklet. Capture begins at the next render quantum. */
  start(): void;
  stop(): Promise<Capture>;
  recording(): boolean;
  /**
   * Loudest sample since this was last called; **reading it resets the running maximum**. Taken
   * from the captured chunks rather than an `AnalyserNode`, which reports only what is in its
   * window at the instant it is polled and would unpredictably miss transients.
   */
  peak(): number;
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
  let livePeak = 0;
  let settle: ((c: Chunk[]) => void) | undefined;

  node.port.onmessage = ({ data }) => {
    if (data.done) {
      const collected = chunks;
      chunks = [];
      settle?.(collected);
      settle = undefined;
      return;
    }
    const chunk = data as Chunk;
    for (const s of chunk.samples) {
      const v = s < 0 ? -s : s;
      if (v > livePeak) livePeak = v;
    }
    chunks.push(chunk);
  };

  return {
    start() {
      chunks = [];
      livePeak = 0;
      on = true;
      node.port.postMessage('start');
    },

    recording: () => on,

    peak() {
      const p = livePeak;
      livePeak = 0;
      return p;
    },

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

      return { buffer, frames, arrivedAtFrame };
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

/**
 * Drop everything a capture holds from before the downbeat.
 *
 * **This is what makes §5.1 #3 true.** A count-in runs the transport for a bar or more before the
 * take begins, and the microphone is open across all of it — arming opens the input early on
 * purpose, so that the downbeat is never missed waiting on a permission prompt. What arrives in
 * those bars is real audio that must not become part of the session: §5.1 #3 requires the
 * session's first frame to *be* the downbeat, because `passExists`, `regionFor` and every bar
 * boundary in the app measure from it.
 *
 * Trimming rather than starting the recorder late is deliberate. Starting late would mean timing
 * a call against the audio clock from the main thread, which is the free-running-clock mistake
 * §2.4 rules out; the chunks are already stamped with the worklet's own frame, so where the
 * downbeat falls is arithmetic rather than a race.
 *
 * Returns the capture unchanged when nothing needs dropping, so the no-count-in path allocates
 * nothing and stays bit-identical to what `verify-capture.ts` measures.
 */
export function trimToDownbeat(capture: Capture, downbeatFrame: number): Capture {
  const drop = Math.round(downbeatFrame - capture.arrivedAtFrame);
  if (drop <= 0) return capture;
  if (drop >= capture.buffer.length) {
    // Stopped during the count-in. There is no take, and the domain declines it anyway — this
    // only has to avoid handing back a negative length.
    const empty = new OfflineAudioContext(1, 1, capture.buffer.sampleRate).createBuffer(
      capture.buffer.numberOfChannels,
      1,
      capture.buffer.sampleRate,
    );
    return { buffer: empty, frames: 0, arrivedAtFrame: downbeatFrame };
  }

  const length = capture.buffer.length - drop;
  const out = new OfflineAudioContext(1, length, capture.buffer.sampleRate).createBuffer(
    capture.buffer.numberOfChannels,
    length,
    capture.buffer.sampleRate,
  );
  for (let c = 0; c < capture.buffer.numberOfChannels; c++) {
    out.copyToChannel(capture.buffer.getChannelData(c).subarray(drop), c);
  }
  return { buffer: out, frames: length, arrivedAtFrame: downbeatFrame };
}
