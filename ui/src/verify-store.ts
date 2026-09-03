import { createProject, projectTiming, recordSession } from '../../src/domain/project.ts';
import { loopFrames } from '../../src/domain/timing.ts';
import { computePeaks } from './peaks.ts';
import { persistentStore } from './store.ts';
import { takeUrl } from './takes.ts';

/**
 * Does a take survive a round trip through storage, sample for sample?
 *
 * This is the whole promise of persistence, and the failure it has to rule out is a *quiet* one:
 * samples truncated, resampled, or silently converted to a narrower type would still play, just
 * not as what was recorded. The signal is a ramp whose value is its own frame number, so any
 * sample that comes back wrong names the frame it should have been.
 *
 * Runs against its own database and deletes it afterwards, so it never touches real projects.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-store.js');
 *     await m.verifyStore();
 */
const DB = 'loop-recorder-verify';

export async function verifyStore() {
  indexedDB.deleteDatabase(DB);
  const store = persistentStore(DB);

  const project = createProject({ id: 'v', name: 'Verify', bpm: 96, barCount: 8, quality: 'standard' });
  const t = projectTiming(project);
  const frames = loopFrames(t);

  const ctx = new OfflineAudioContext(1, frames, t.sampleRate);
  const buffer = ctx.createBuffer(1, frames, t.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) samples[i] = i;

  const session = {
    id: 'v-take',
    audioFileURL: takeUrl('v-take'),
    recordedFrames: frames,
    recordedAt: new Date().toISOString(),
    waveformPeaks: computePeaks(buffer),
  };
  const saved = {
    ...project,
    layers: project.layers.map((l, i) => (i === 0 ? recordSession(l, session, t) : l)),
  };

  store.saveTake('v-take', buffer);
  store.saveProject(saved);
  // Past the project debounce, and long enough for the take write to commit.
  await new Promise((r) => setTimeout(r, 900));

  // A second store over the same database is the reload: nothing is shared but the bytes.
  const reopened = persistentStore(DB);
  const projects = await reopened.loadProjects();
  const audio = await reopened.loadTake('v-take');

  let worst = 0;
  if (audio) {
    for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(audio.samples[i]! - i));
  }

  const back = projects?.[0];
  const backSession = back?.layers[0]?.sessions[0];
  const peaksMatch =
    backSession?.waveformPeaks.length === session.waveformPeaks.length &&
    backSession.waveformPeaks.every((v, i) => v === session.waveformPeaks[i]);

  indexedDB.deleteDatabase(DB);

  return {
    projectsLoaded: projects?.length ?? 0,
    projectName: back?.name,
    arrangementLength: back?.layers[0]?.barSources.length ?? 0,
    peakCount: backSession?.waveformPeaks.length ?? 0,
    peaksMatch,
    takeFrames: audio?.samples.length ?? 0,
    expectedFrames: frames,
    takeSampleRate: audio?.sampleRate,
    // Zero means every sample came back as the frame number it was written as.
    worstSampleError: worst,
    pass:
      projects?.length === 1 &&
      back?.name === 'Verify' &&
      peaksMatch === true &&
      audio?.samples.length === frames &&
      audio.sampleRate === t.sampleRate &&
      worst === 0,
  };
}
