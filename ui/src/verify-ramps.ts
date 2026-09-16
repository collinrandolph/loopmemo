import { createProject, projectTiming, recordSession } from '../../src/domain/project.ts';
import type { Project } from '../../src/domain/project.ts';
import { loopFrames, framesPerBar } from '../../src/domain/timing.ts';
import { audioEngine } from './audio.ts';
import { takeStore } from './takes.ts';

/**
 * How big a step does a live control put in the signal?
 *
 * Every gain in this engine is supposed to ramp — CLAUDE.md states it twice, once for the master
 * fader and once for the pan and EQ graph, and the reason is always the same: these are live
 * gestures, a slider emits an event per pixel, and setting a gain outright is a click. The rule
 * was applied where it was learned and left to memory everywhere else, so three places still
 * stepped: the backing faders, the EQ coefficients, and a layer becoming inaudible, which was cut
 * dead with `disconnect()`.
 *
 * **"It clicks" is not a measurement**, and the fix is not obviously worth having until the number
 * is on the page. This renders the same project twice — once changing nothing, once making the
 * change mid-render — and reports the worst sample-to-sample step in each. A discontinuity shows
 * up as a step far larger than anything the audio itself contains.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-ramps.js');
 *     await m.verifyRamps();
 */

/** Worst absolute difference between neighbouring samples — a click's signature. */
function worstStep(data: Float32Array, from: number, to: number): { step: number; at: number } {
  let step = 0;
  let at = from;
  for (let i = Math.max(1, from); i < Math.min(data.length, to); i++) {
    const d = Math.abs(data[i]! - data[i - 1]!);
    if (d > step) {
      step = d;
      at = i;
    }
  }
  return { step, at };
}

function projectWithAudio(): { project: Project; takes: ReturnType<typeof takeStore> } {
  const base = createProject({ id: 'ramps', name: 'Ramps', bpm: 120, barCount: 4, quality: 'standard' });
  const t = projectTiming(base);
  const frames = loopFrames(t);
  const takes = takeStore(() => {});

  // A steady tone, so any step in the output is the graph's and not the source's.
  const buffer = new OfflineAudioContext(1, frames, t.sampleRate).createBuffer(1, frames, t.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) channel[i] = Math.sin((2 * Math.PI * 220 * i) / t.sampleRate) * 0.8;

  const session = {
    id: 'ramps-take-1',
    audioFileURL: 'blob:ramps-take-1',
    recordedFrames: frames,
    recordedAt: new Date().toISOString(),
    waveformPeaks: [],
  };
  takes.restore(session.id, buffer);
  const layer = recordSession(base.layers[0]!, session, t);
  return {
    project: { ...base, layers: base.layers.map((l) => (l.index === 0 ? layer : l)) },
    takes,
  };
}

/**
 * Render two bars, applying a change **part-way through the render**.
 *
 * `OfflineAudioContext.suspend(t)` is the only way to do this and the reason matters: an offline
 * context does not advance until `startRendering()`, so a graph mutation made "before await" is
 * a mutation at time zero. The first version of this file did exactly that and reported a worst
 * step of **0** for a layer mute — not because the mute was smooth, but because the layer was
 * disconnected before a single sample existed. It measured nothing and said everything was fine.
 *
 * It was caught by running the instrument against the unfixed code and getting a *better* number
 * than the fixed code gave. An instrument that has not been checked against a known defect is
 * not evidence.
 */
async function render(changeAtSeconds?: number, change?: (engine: ReturnType<typeof audioEngine>) => void) {
  const { project, takes } = projectWithAudio();
  const t = projectTiming(project);
  const bars = 2;
  const frames = framesPerBar(t) * bars;

  const ctx = new OfflineAudioContext(2, frames, t.sampleRate);
  const engine = audioEngine(t.sampleRate, ctx);
  // Drums and chords muted: the question is about the layer's gain, and a kick transient is a
  // legitimate step that would drown the one being measured.
  engine.setBacking(
    {
      drums: { ...project.backing.drums, muted: true },
      chords: { ...project.backing.chords, muted: true },
    },
    t,
  );
  engine.setLayers(project, takes);
  engine.prerender(bars);

  if (change && changeAtSeconds !== undefined) {
    void ctx.suspend(changeAtSeconds).then(() => {
      change(engine);
      void ctx.resume();
    });
  }

  const rendered = await ctx.startRendering();
  engine.destroy();
  return { data: rendered.getChannelData(0), t, changeFrame: Math.round((changeAtSeconds ?? 0) * t.sampleRate) };
}
export async function verifyRamps() {
  // Half a second in: past the scheduling lead, and well inside the rendered length.
  const at = 0.5;

  // A baseline: the same render, untouched. Whatever step the tone itself contains is the floor.
  const base = await render();
  const baseline = worstStep(base.data, 0, base.data.length);

  const muteRun = await render(at, (engine) => {
    const { project, takes } = projectWithAudio();
    engine.setLayers(
      { ...project, layers: project.layers.map((l) => (l.index === 0 ? { ...l, muted: true } : l)) },
      takes,
    );
  });
  const onMute = worstStep(muteRun.data, 0, muteRun.data.length);

  const eqRun = await render(at, (engine) => {
    const { project, takes } = projectWithAudio();
    engine.setLayers(
      { ...project, layers: project.layers.map((l) => (l.index === 0 ? { ...l, eq: 'lowCut' as const } : l)) },
      takes,
    );
  });
  const onEq = worstStep(eqRun.data, 0, eqRun.data.length);

  // A render that goes silent immediately would report a flattering zero, so the instrument says
  // whether there was any signal to step in the first place.
  const energyAfterChange = (data: Float32Array, frame: number) => {
    let sum = 0;
    for (let i = frame; i < data.length; i++) sum += data[i]! * data[i]!;
    return Number(Math.sqrt(sum / Math.max(1, data.length - frame)).toFixed(6));
  };

  const claims = {
    baselineWorstStep: Number(baseline.step.toFixed(6)),
    onLayerMuteWorstStep: Number(onMute.step.toFixed(6)),
    onEqChangeWorstStep: Number(onEq.step.toFixed(6)),
    muteRatio: Number((onMute.step / Math.max(baseline.step, 1e-9)).toFixed(2)),
    eqRatio: Number((onEq.step / Math.max(baseline.step, 1e-9)).toFixed(2)),
    /** Signal before the change, so a zero step cannot come from silence. */
    energyBeforeMute: energyAfterChange(muteRun.data.slice(0, muteRun.changeFrame), 0),
    energyAfterMute: energyAfterChange(muteRun.data, muteRun.changeFrame),
  };

  const pass =
    claims.energyBeforeMute > 0.01 &&
    claims.muteRatio < 3 &&
    claims.eqRatio < 3;
  return { ...claims, pass };
}
