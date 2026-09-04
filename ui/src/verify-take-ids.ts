import { createProject, projectTiming, recordSession } from '../../src/domain/project.ts';
import { loopFrames } from '../../src/domain/timing.ts';
import { newTakeId, takeStore, takeUrl } from './takes.ts';

/**
 * Does recording into one project still overwrite another project's audio?
 *
 * Reported from an iPhone: record project A, record project B, and A then plays B's layers while
 * A's waveforms still draw correctly. The waveforms were the tell that this was not a playback
 * bug — peaks live on the project's own `RecordingSession`, so they were fine; only the audio was
 * missing, because it had been overwritten.
 *
 * The cause was `${layer.id}-take-${sessions.length + 1}`, and `layer.id` is `layer-0`..`layer-6`
 * in **every** project. So the first take on the first layer was `layer-0-take-1` everywhere, in
 * this map and in IndexedDB.
 *
 * Three claims:
 *
 * 1. **The old scheme collides**, reproduced rather than asserted — otherwise claim 2 proves
 *    nothing about the bug that was reported.
 * 2. **The new scheme does not**, across projects, layers and repeats.
 * 3. **Each project keeps its own audio**, checked through the store the way playback reads it.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-take-ids.js');
 *     m.verifyTakeIds();
 */
export function verifyTakeIds() {
  const make = (id: string, name: string) =>
    createProject({ id, name, bpm: 120, barCount: 4, quality: 'standard' });

  const a = make('proj-a', 'A');
  const b = make('proj-b', 'B');
  const t = projectTiming(a);
  const loop = loopFrames(t);

  // -- 1. the old scheme, reproduced --------------------------------------
  const oldId = (layerId: string, sessionCount: number) => `${layerId}-take-${sessionCount + 1}`;
  const oldA = oldId(a.layers[0]!.id, 0);
  const oldB = oldId(b.layers[0]!.id, 0);

  // -- 2. the new one -----------------------------------------------------
  const minted = new Set<string>();
  let duplicates = 0;
  for (let project = 0; project < 8; project++) {
    for (let layer = 0; layer < 7; layer++) {
      for (let take = 0; take < 12; take++) {
        const id = newTakeId(`layer-${layer}-take`);
        if (minted.has(id)) duplicates++;
        minted.add(id);
      }
    }
  }

  // -- 3. two projects, one store, distinguishable audio -------------------
  const ctx = new OfflineAudioContext(1, loop, t.sampleRate);
  const takes = takeStore();
  const filled = (value: number) => {
    const buffer = ctx.createBuffer(1, loop, t.sampleRate);
    buffer.getChannelData(0).fill(value);
    return buffer;
  };

  const record = (project: typeof a, value: number) => {
    const layer = project.layers[0]!;
    const id = newTakeId(`${layer.id}-take`);
    const session = {
      id,
      audioFileURL: takeUrl(id),
      recordedFrames: loop,
      recordedAt: new Date().toISOString(),
      waveformPeaks: [],
    };
    takes.put(session, filled(value));
    return { ...project, layers: project.layers.map((l, i) => (i === 0 ? recordSession(l, session, t) : l)) };
  };

  // A first, then B — the order that lost A's audio.
  const recordedA = record(a, 0.25);
  const recordedB = record(b, 0.75);

  // Read them back the way `scheduleSegments` does, positionally through the layer's sessions.
  const sampleOf = (project: typeof a) => takes.buffersFor(project.layers[0]!)[0]?.getChannelData(0)[0];
  const heardA = sampleOf(recordedA);
  const heardB = sampleOf(recordedB);

  return {
    oldSchemeCollided: oldA === oldB,
    oldSchemeIds: [oldA, oldB],
    newIdsMinted: minted.size,
    newIdDuplicates: duplicates,
    storeHoldsBothTakes: takes.size() === 2,
    projectAHears: heardA,
    projectBHears: heardB,
    pass:
      oldA === oldB &&
      duplicates === 0 &&
      minted.size === 8 * 7 * 12 &&
      takes.size() === 2 &&
      heardA === 0.25 &&
      heardB === 0.75,
  };
}
