import { createRecorder } from './recorder.ts';

/**
 * Does the capture path preserve the samples, and does it know when they happened?
 *
 * Same approach as `verify-joins.ts`, for the same reason: a microphone test tells you it made a
 * noise, and this tells you which frame each sample landed on. Recording a *known* signal is
 * what makes that checkable — the input is an `AudioNode`, so it can be a buffer of noise
 * instead of a room.
 *
 * ```js
 * (await import('/ui/dist/ui/src/verify-capture.js')).verifyCapture().then(console.log)
 * ```
 *
 * **This runs in a real-time `AudioContext`, not an offline one**, and that is deliberate rather
 * than a limitation. An `OfflineAudioContext` renders as fast as it can, so a worklet's messages
 * to the main thread arrive in a heap after `startRendering` resolves — which would test the
 * arithmetic while skipping the thing most likely to be wrong, namely whether chunks arrive in
 * order and on time under a real render thread. It costs a couple of seconds of wall clock.
 *
 * What it still cannot answer is the round-trip latency of an actual device, because there is no
 * device in the loop — the signal never becomes sound. That is §5's loopback calibration and it
 * needs a microphone.
 */

const RATE = 48000;
const SECONDS = 1.5;

function noise(length: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(length);
  let seed = 0x9e3779b1;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return out;
}

export async function verifyCapture() {
  const ctx = new AudioContext({ sampleRate: RATE });
  if (ctx.state === 'suspended') await ctx.resume();

  const length = Math.round(RATE * SECONDS);
  const material = noise(length);
  const buffer = ctx.createBuffer(1, length, RATE);
  buffer.copyToChannel(material, 0);

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  // Into the recorder only — never to the destination. The point is to capture it, and routing
  // a full-scale noise burst to the speakers as a side effect of a test is unkind.
  const recorder = await createRecorder(ctx, source, 0);

  recorder.start();
  const startedAt = ctx.currentTime;
  source.start();
  await new Promise((r) => setTimeout(r, SECONDS * 1000 + 250));
  const capture = await recorder.stop();
  const captured = capture.buffer.getChannelData(0);

  // Where in the captured audio the material begins. Capture is armed before the source starts,
  // so there is a run of silence first; finding it is what the alignment check is about.
  let offset = 0;
  while (offset < captured.length && captured[offset] === 0) offset++;

  // Sample-for-sample from that point. Any resampling, any dropped quantum, any reordered chunk
  // shows up here — noise cannot accidentally line up.
  let worst = 0;
  let compared = 0;
  for (let i = 0; i + offset < captured.length && i < length; i++) {
    worst = Math.max(worst, Math.abs(captured[offset + i]! - material[i]!));
    compared++;
  }

  // Every sample of the source should be present, allowing for the tail still in flight when
  // stop was called.
  const missing = length - compared;

  recorder.destroy();
  await ctx.close();

  return {
    contextRate: RATE,
    capturedFrames: capture.frames,
    sourceFrames: length,
    leadingSilenceFrames: offset,
    framesCompared: compared,
    framesMissing: missing,
    worstAbsDiff: worst,
    arrivedAtFrame: capture.arrivedAtFrame,
    // The worklet stamps chunks from the context's own counter, so the first captured frame
    // should sit within a render quantum of where `currentTime` said arming happened.
    armedAtFrameByMainThread: Math.round(startedAt * RATE),
    anchorErrorFrames: Math.abs(capture.arrivedAtFrame - Math.round(startedAt * RATE)),
    pass: worst < 1e-6 && missing <= 0 && compared > length * 0.9,
  };
}

/**
 * The one thing an argument cannot settle: does compensation move the take the right way?
 *
 * A round trip is subtracted, never added, so a capture that arrived at frame F is anchored at
 * F − latency. Asserted rather than described because the sign is the whole of §2.3, and getting
 * it backwards doubles the error instead of removing it — which sounds like a worse take rather
 * than a broken app, so nothing would ever point at it.
 */
export async function verifyCompensationSign() {
  const ctx = new AudioContext({ sampleRate: RATE });
  const silent = ctx.createConstantSource();
  silent.offset.value = 0;
  silent.start();

  const latency = 2400; // 50 ms at 48 kHz, a plausible round trip
  const plain = await createRecorder(ctx, silent, 0);
  const compensated = await createRecorder(ctx, silent, latency);

  plain.start();
  compensated.start();
  await new Promise((r) => setTimeout(r, 200));
  const a = await plain.stop();
  const b = await compensated.stop();

  plain.destroy();
  compensated.destroy();
  await ctx.close();

  return {
    latencyFrames: latency,
    uncompensatedStart: a.startFrame,
    compensatedStart: b.startFrame,
    shift: a.startFrame - b.startFrame,
    // Both armed at the same moment, so the only difference should be the round trip, earlier.
    pass: b.startFrame < a.startFrame && Math.abs(a.startFrame - b.startFrame - latency) <= 128,
  };
}
