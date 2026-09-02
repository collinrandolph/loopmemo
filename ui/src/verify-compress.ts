import { setSlot, setSlotMuted } from '../../src/domain/arrangement.ts';
import { barRef } from '../../src/domain/bar-ref.ts';
import { regionFor } from '../../src/domain/pass-index.ts';
import {
  type Layer,
  createProject,
  layerCompressionPlan,
  layerPassIndex,
  projectTiming,
  recordSession,
} from '../../src/domain/project.ts';
import { framesPerBar, loopFrames } from '../../src/domain/timing.ts';
import { renderRetained } from './compress.ts';
import { takeUrl } from './takes.ts';

/**
 * Does a compress write the loop the plan describes, sample for sample?
 *
 * Compress is irreversible and keeps only what it writes, so "the right audio ended up in the
 * right bar" is the one thing that has to be exact. The source is a ramp whose value *is* its
 * frame number, so every output sample names the source frame it came from and a bar written
 * from the wrong place is not a subtle difference — it is a wrong number.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-compress.js');
 *     await m.verifyCompress();
 */
export async function verifyCompress() {
  const project = createProject({ id: 'v', name: 'Verify', bpm: 120, barCount: 8, quality: 'standard' });
  const t = projectTiming(project);
  const perBar = framesPerBar(t);
  const loop = loopFrames(t);
  const PASSES = 2;

  // Float32 holds integers exactly to 2^24, and two passes here is 1.4M frames — so the value at
  // frame i can simply be i, and provenance survives the copy.
  const ctx = new OfflineAudioContext(1, PASSES * loop, t.sampleRate);
  const source = ctx.createBuffer(1, PASSES * loop, t.sampleRate);
  const samples = source.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = i;

  const session = {
    id: 'v-take',
    audioFileURL: takeUrl('v-take'),
    recordedFrames: PASSES * loop,
    recordedAt: new Date().toISOString(),
    waveformPeaks: [],
  };

  let layer: Layer = recordSession(project.layers[0]!, session, t);
  // A reordering, so recorded order is not what is being checked, and a muted slot, which must
  // come out as real silence occupying a full bar (§2.7).
  let sources = setSlot(layer.barSources, 0, barRef(2, 5));
  sources = setSlot(sources, 6, barRef(2, 2));
  layer = { ...layer, barSources: sources, mutedSlots: setSlotMuted(layer.mutedSlots, 3, true) };

  const index = layerPassIndex(layer, t);
  const bars = layerCompressionPlan(layer, t);
  if (!bars) return { pass: false, reason: 'no plan' };

  const out = renderRetained(bars, [source], t.sampleRate);
  if (!out) return { pass: false, reason: 'no render' };

  let worstWrong = 0;
  let checked = 0;
  let silentSlotNonZero = 0;

  for (let slot = 0; slot < project.barCount; slot++) {
    const at = slot * perBar;
    if (slot === 3) {
      for (let i = 0; i < perBar; i++) if (out.getChannelData(0)[at + i] !== 0) silentSlotNonZero++;
      continue;
    }
    const region = regionFor(index, layer.barSources[slot]!)!;
    for (let i = 0; i < region.frameCount; i++) {
      const got = out.getChannelData(0)[at + i]!;
      const want = region.startFrame + i;
      if (got !== want) worstWrong = Math.max(worstWrong, Math.abs(got - want));
      checked++;
    }
  }

  const expectedFrames = project.barCount * perBar;
  return {
    bars: bars.length,
    renderedFrames: out.length,
    expectedFrames,
    framesChecked: checked,
    // Zero means every retained bar was copied from exactly the frames the plan named.
    worstFrameError: worstWrong,
    mutedSlotNonZeroSamples: silentSlotNonZero,
    pass: out.length === expectedFrames && worstWrong === 0 && silentSlotNonZero === 0,
  };
}
