import { countInStartFrame } from '../../src/domain/count-in.ts';
import { createProject, projectTiming, recordSession } from '../../src/domain/project.ts';
import { framesPerBar, loopFrames } from '../../src/domain/timing.ts';
import { audioEngine } from './audio.ts';
import { trimToDownbeat } from './recorder.ts';
import { takeStore, takeUrl } from './takes.ts';

/**
 * Is the count-in kept out of the take, and out of nothing else?
 *
 * §5.1 #3 is the whole feature in one sentence: "the session's first frame is the downbeat of
 * Pass 1, or every boundary is offset by a bar." Two independent mechanisms have to hold for that
 * to be true, and they fail in different directions, so they are checked apart.
 *
 * 1. **The capture is trimmed to the downbeat.** The microphone is open across the count-in, so
 *    what it heard has to be dropped — exactly, not approximately. Checked against a ramp whose
 *    every sample equals its own frame number, so a trim that is off by one is a wrong *number*
 *    rather than a subtle difference.
 * 2. **The drums-only window ends at the downbeat.** The engine skips chords and layers for bars
 *    before `setCountIn`'s frame. If that leaked past the downbeat it would silence the take's own
 *    playback; if it applied to a render, exports would lose their layers.
 *
 * **Bit-identity is the wrong bar for claim 2, and finding that out was the point of measuring.**
 * The first version asserted the audio after the downbeat matched an ungated render exactly, and
 * it does not: about 16% of samples differ, concentrated at drum onsets. It is not a timing error
 * — correlation is best at zero shift, worse at ±1 — and the energy is the same to within a third
 * of a percent. It is the `DynamicsCompressor` every voice runs through, which is *stateful*: four
 * bars of a much quieter count-in leave it with less gain reduction, and it keeps being
 * re-triggered rather than settling. Identical scheduling does not imply identical samples once
 * the audio before it differs. So claim 2 is checked as energy and alignment, which is what it
 * actually means.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-count-in.js');
 *     await m.verifyCountIn();
 */
export async function verifyCountIn() {
  const rate = 44100;

  // -- 1. the trim ---------------------------------------------------------
  // A capture that arrived at frame 1000 and runs for 5000 frames; the downbeat is at 3000.
  const arrivedAtFrame = 1000;
  const raw = new OfflineAudioContext(1, 5000, rate).createBuffer(1, 5000, rate);
  const data = raw.getChannelData(0);
  // Sample i holds the engine frame it was captured on, scaled to stay inside float range.
  for (let i = 0; i < data.length; i++) data[i] = (arrivedAtFrame + i) / 1e6;

  const trimmed = trimToDownbeat({ buffer: raw, frames: raw.length, arrivedAtFrame }, 3000);
  const first = Math.round(trimmed.buffer.getChannelData(0)[0]! * 1e6);
  const last = Math.round(
    trimmed.buffer.getChannelData(0)[trimmed.buffer.length - 1]! * 1e6,
  );

  // Nothing to drop must not copy: the no-count-in path stays exactly what `verify-capture` measures.
  const untouched = trimToDownbeat({ buffer: raw, frames: raw.length, arrivedAtFrame }, 0);
  // Stopped inside the count-in: no take, and no negative length.
  const stoppedEarly = trimToDownbeat({ buffer: raw, frames: raw.length, arrivedAtFrame }, 99_999);

  // -- 2. the drums-only window -------------------------------------------
  const project = createProject({ id: 'ci', name: 'CI', bpm: 120, barCount: 4, quality: 'standard' });
  const t = projectTiming(project);
  const loop = loopFrames(t);
  const loud = {
    ...project,
    backing: {
      drums: { ...project.backing.drums, muted: false, level: 1 },
      chords: { ...project.backing.chords, muted: false, level: 1 },
    },
  };

  const src = new OfflineAudioContext(1, loop, rate).createBuffer(1, loop, rate);
  const s = src.getChannelData(0);
  for (let i = 0; i < loop; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / rate);
  const session = {
    id: 'ci-take',
    audioFileURL: takeUrl('ci-take'),
    recordedFrames: loop,
    recordedAt: new Date().toISOString(),
    waveformPeaks: [],
  };
  const takes = takeStore();
  takes.restore('ci-take', src);
  const withLayer = {
    ...loud,
    layers: loud.layers.map((l, i) =>
      i === 0 ? { ...recordSession(l, session, t), pan: 'center' as const } : l,
    ),
  };

  /** Two loops, so there is a window inside the count-in and a window past it. */
  const render = async (countInUntil: number) => {
    const offline = new OfflineAudioContext(2, loop * 2, rate);
    const engine = audioEngine(rate, offline);
    engine.setCountIn(countInUntil);
    engine.setBacking(withLayer.backing, t);
    engine.setLayers(withLayer, takes);
    engine.prerender(t.barCount * 2);
    return offline.startRendering();
  };

  const plain = await render(0);
  const gated = await render(loop);

  const rms = (b: AudioBuffer, from: number, to: number) => {
    let sum = 0;
    let n = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const x = b.getChannelData(c);
      for (let i = from; i < to; i++) {
        sum += x[i]! * x[i]!;
        n++;
      }
    }
    return Math.sqrt(sum / n);
  };

  /** Error between the two renders with one shifted, to tell a state difference from a timing one. */
  const errorAtShift = (shift: number, from: number, length: number) => {
    const x = plain.getChannelData(0);
    const y = gated.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < length; i++) {
      const d = x[from + i]! - y[from + i + shift]!;
      sum += d * d;
    }
    return Math.sqrt(sum / length);
  };

  const gatedCountIn = rms(gated, 0, loop);
  const plainCountIn = rms(plain, 0, loop);
  const gatedAfter = rms(gated, loop, loop * 2);
  const plainAfter = rms(plain, loop, loop * 2);

  const from = loop + 2 * framesPerBar(t);
  const aligned = errorAtShift(0, from, 20_000);
  const shiftedOne = errorAtShift(1, from, 20_000);

  return {
    // 1
    trimmedFirstSampleIsDownbeat: first === 3000,
    trimmedLastSampleUnmoved: last === arrivedAtFrame + 4999,
    trimmedLength: trimmed.buffer.length,
    expectedLength: 5000 - (3000 - arrivedAtFrame),
    nothingToDropIsNotCopied: untouched.buffer === raw,
    stoppedInCountInHasNoTake: stoppedEarly.frames === 0,
    // 2 — the count-in is much quieter (chords and layers gone), and everything is back after it.
    countInRmsRatio: +(gatedCountIn / plainCountIn).toFixed(3),
    afterDownbeatRmsRatio: +(gatedAfter / plainAfter).toFixed(3),
    // Drums still sound during it: the gate skips the other two, it does not silence the bar.
    countInStillHasDrums: gatedCountIn > 0.01,
    // A state difference, not a timing one — shifting by a sample makes it worse, so nothing moved.
    alignedError: +aligned.toFixed(4),
    errorIfShiftedOneSample: +shiftedOne.toFixed(4),
    // And the transport arithmetic the screen uses, end to end.
    oneBarStartsOneBarBeforeTheWrap: countInStartFrame(1, t) === loop - framesPerBar(t),
    pass:
      first === 3000 &&
      last === arrivedAtFrame + 4999 &&
      trimmed.buffer.length === 5000 - (3000 - arrivedAtFrame) &&
      untouched.buffer === raw &&
      stoppedEarly.frames === 0 &&
      gatedCountIn > 0.01 &&
      gatedCountIn / plainCountIn < 0.5 &&
      Math.abs(gatedAfter / plainAfter - 1) < 0.02 &&
      aligned < shiftedOne &&
      countInStartFrame(1, t) === loop - framesPerBar(t),
  };
}

/**
 * Claim 3: **`Capture.arrivedAtFrame` is an engine frame, which is what its type says.**
 *
 * This is the check that was missing, and its absence is why a bar of count-in reached the head
 * of a take on a real device. The trim above is exact — but it was being handed two numbers from
 * *different clocks*. The worklet stamps chunks with `currentFrame`, counting from when the
 * `AudioContext` was created; `countInUntil` is a transport frame, counting from the origin the
 * last `start` set. Subtracting them is meaningless, and which way it fails depends only on how
 * long the context has been alive:
 *
 * - context younger than the loop → a huge positive drop → the whole take discarded as silence
 * - context older → a negative drop → **nothing trimmed, and the count-in stays in the take**
 *
 * The second is what a user hits, because by the time you have opened a project and pressed
 * record the context has been running for a while. Reported as "a considerable delay of more
 * than one bar" at the start of a recording.
 *
 * **Claim 1 passing proved nothing about this**, because it chose both numbers itself and put
 * them in the same space. A helper verified in isolation says nothing about the units its caller
 * hands it.
 *
 * Runs the real path — `openInput` → `startCapture` → `stopCapture` — with `getUserMedia` stubbed
 * to return an oscillator instead of a microphone, so it needs no permission and no human.
 *
 *     const m = await import('/ui/dist/ui/src/verify-count-in.js');
 *     await m.verifyCaptureFrames();
 */
export async function verifyCaptureFrames() {
  const rate = 44100;
  // Fast on purpose: 4 bars at 240 BPM makes a 1-second count-in, so the recording below crosses
  // the downbeat in real time without the check taking a coffee break.
  const project = createProject({ id: 'cf', name: 'CF', bpm: 240, barCount: 4, quality: 'standard' });
  const t = projectTiming(project);
  const loop = loopFrames(t);
  const countInFrom = countInStartFrame(1, t);

  // A real MediaStream carrying a real signal, from an oscillator rather than a device.
  const source = new AudioContext({ sampleRate: rate });
  const dest = source.createMediaStreamDestination();
  const osc = source.createOscillator();
  osc.frequency.value = 440;
  osc.connect(dest);
  osc.start();

  const media = navigator.mediaDevices;
  const realGetUserMedia = media.getUserMedia.bind(media);
  media.getUserMedia = async () => dest.stream;

  const engine = audioEngine(rate);
  let arrivedAtFrame = 0;
  let engineFrameAtCaptureStart = 0;
  let capturedFrames = 0;
  let trimmedFrames = 0;
  try {
    engine.setBacking(project.backing, t);
    engine.setLayers(project, takeStore());
    engine.start(countInFrom);
    await engine.startCapture();
    engineFrameAtCaptureStart = engine.frame();
    // Past the downbeat, so there is a real take on the far side of the count-in to keep.
    await new Promise((r) => setTimeout(r, 1600));
    const capture = await engine.stopCapture();
    arrivedAtFrame = capture?.arrivedAtFrame ?? 0;
    capturedFrames = capture?.buffer.length ?? 0;
    if (capture) trimmedFrames = trimToDownbeat(capture, loop).buffer.length;
  } finally {
    media.getUserMedia = realGetUserMedia;
    engine.destroy();
    osc.stop();
    void source.close();
  }

  // In engine frames this lands within a fraction of a second of where the transport was when
  // capture began — roughly 1.65 million for this project. As a context frame it would be the
  // age of the context in samples, which has no relationship to it at all.
  const errorFrames = Math.abs(arrivedAtFrame - engineFrameAtCaptureStart);

  return {
    countInStartsAt: countInFrom,
    downbeatAt: loop,
    engineFrameAtCaptureStart,
    arrivedAtFrame,
    errorFrames,
    errorSeconds: +(errorFrames / rate).toFixed(3),
    // Anything under half a second is the render-quantum and lead-time gap; a clock mismatch is
    // out by the whole age of the context, which is orders of magnitude larger.
    inEngineFrames: errorFrames < rate / 2,
    // And the consequence: the trim now drops the count-in rather than sailing past it.
    wouldTrimFrames: Math.round(loop - arrivedAtFrame),
    trimsRatherThanSkips: loop - arrivedAtFrame > 0,
    // And the consequence a person hears: what survives is what was played *after* the downbeat.
    capturedFrames,
    trimmedFrames,
    droppedSeconds: +((capturedFrames - trimmedFrames) / rate).toFixed(2),
    countInSeconds: +((loop - countInFrom) / rate).toFixed(2),
    // What was dropped is the count-in, within a chunk of the recorder's own granularity.
    dropIsTheCountIn:
      Math.abs(capturedFrames - trimmedFrames - (loop - arrivedAtFrame)) < 4096,
    takeSurvives: trimmedFrames > rate / 4,
    pass:
      errorFrames < rate / 2 &&
      loop - arrivedAtFrame > 0 &&
      trimmedFrames > rate / 4 &&
      Math.abs(capturedFrames - trimmedFrames - (loop - arrivedAtFrame)) < 4096,
  };
}
