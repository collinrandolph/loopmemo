import { createProject, projectTiming, recordSession } from '../../src/domain/project.ts';
import { loopFrames } from '../../src/domain/timing.ts';
import { audioEngine } from './audio.ts';
import { renderOffline, silentBacking } from './render.ts';
import { takeStore, takeUrl } from './takes.ts';

/**
 * Is the monitoring level kept out of the files (§4.2)?
 *
 * The decision is that master is how loud you *hear* the loop, not part of the mix — so a file is
 * written at unity however quietly you were listening. That claim is worth a check precisely
 * because breaking it is silent: listen at night, export, and every file is 15 dB down with
 * nothing on screen having said so, and the mistake is baked into audio that has already left.
 *
 * Two claims:
 *
 * 1. **A rendering engine refuses `setMaster`.** Turning it to zero and muting it changes nothing
 *    about what is rendered — bit for bit, not approximately.
 * 2. **The refusal is the guard, not the absence of a caller.** `renderOffline` never calls
 *    `setMaster` today, so claim 1 would pass on an engine that happily applied it. This drives
 *    the render through an engine that has been told, which is the case a future caller reusing
 *    the live engine for a render would create.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-master.js');
 *     await m.verifyMaster();
 */
export async function verifyMaster() {
  const project = createProject({
    id: 'vm',
    name: 'VM',
    bpm: 120,
    barCount: 4,
    quality: 'standard',
  });
  const t = projectTiming(project);
  const loop = loopFrames(t);

  const source = new OfflineAudioContext(1, loop, t.sampleRate).createBuffer(1, loop, t.sampleRate);
  // Something with structure rather than DC, so a level change anywhere shows up in the sum.
  const d = source.getChannelData(0);
  for (let i = 0; i < loop; i++) d[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / t.sampleRate);

  const session = {
    id: 'vm-take',
    audioFileURL: takeUrl('vm-take'),
    recordedFrames: loop,
    recordedAt: new Date().toISOString(),
    waveformPeaks: [],
  };
  const takes = takeStore();
  takes.restore('vm-take', source);
  const withLayer = {
    ...project,
    layers: project.layers.map((l, i) =>
      i === 0 ? { ...recordSession(l, session, t), pan: 'center' as const } : l,
    ),
  };

  const rms = (b: AudioBuffer) => {
    let sum = 0;
    let n = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const x = b.getChannelData(c);
      for (let i = 0; i < x.length; i++) {
        sum += x[i]! * x[i]!;
        n++;
      }
    }
    return Math.sqrt(sum / n);
  };

  // -- 1. the ordinary path ------------------------------------------------
  const baseline = await renderOffline(withLayer, silentBacking(), takes, loop);

  // -- 2. the same render, through an engine that has been told to go quiet --
  // Built the way `renderOffline` builds one, so the only difference is the two `setMaster` calls.
  const offline = new OfflineAudioContext(2, loop, t.sampleRate);
  const engine = audioEngine(t.sampleRate, offline);
  engine.setMaster(0, true);
  engine.setBacking(silentBacking(), t);
  engine.setLayers(withLayer, takes);
  engine.setMaster(0, true); // and again after the graph exists, in case order mattered
  engine.prerender(t.barCount);
  const silenced = await offline.startRendering();

  let worst = 0;
  for (let c = 0; c < baseline.numberOfChannels; c++) {
    const a = baseline.getChannelData(c);
    const b = silenced.getChannelData(c);
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  }

  return {
    baselineRms: +rms(baseline).toFixed(6),
    mutedEngineRms: +rms(silenced).toFixed(6),
    worstSampleDifference: worst,
    // A render that came out silent would make the two agree trivially, so the baseline has to
    // carry signal for the comparison to mean anything.
    baselineHasSignal: rms(baseline) > 1e-4,
    pass: worst === 0 && rms(baseline) > 1e-4,
  };
}
