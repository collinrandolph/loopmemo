import { bouncePlan, bounceSeed } from '../../src/domain/bounce.ts';
import { createProject, projectTiming, recordSession } from '../../src/domain/project.ts';
import { loopFrames } from '../../src/domain/timing.ts';
import { renderOffline, silentBacking, wrapTail } from './render.ts';
import { takeStore, takeUrl } from './takes.ts';

/**
 * Does a bounce mix the layers, leave the backing out, and carry its settings across (§2.7)?
 *
 * Three separable claims, checked separately:
 *
 * 1. **The tail wraps.** Pure arithmetic on a buffer, so it is checked exactly.
 * 2. **The mixdown is the layers, with the backing silent.** A project whose drums are unmuted
 *    and loud still renders to the layer's own level — if the backing leaked in, the sum would
 *    be larger and no longer constant.
 * 3. **The seed carries the backing verbatim**, mute flags included, without it being audible.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-bounce.js');
 *     await m.verifyBounce();
 */
export async function verifyBounce() {
  // -- 1. the tail wrap ----------------------------------------------------
  const rate = 44100;
  const frames = 1000;
  const tail = 100;
  const over = new OfflineAudioContext(2, frames + tail, rate).createBuffer(2, frames + tail, rate);
  for (let c = 0; c < 2; c++) {
    const d = over.getChannelData(c);
    d.fill(0.25); // the loop body
    for (let i = frames; i < frames + tail; i++) d[i] = 0.5; // the overhang
  }
  const wrapped = wrapTail(over, frames, tail);
  const w = wrapped.getChannelData(0);
  let wrapOk = wrapped.length === frames;
  for (let i = 0; i < tail; i++) if (Math.abs(w[i]! - 0.75) > 1e-6) wrapOk = false;
  for (let i = tail; i < frames; i++) if (Math.abs(w[i]! - 0.25) > 1e-6) wrapOk = false;

  // -- 2. the mixdown is the layers only -----------------------------------
  // A controlled comparison rather than a predicted level: crossfades overlap correlated
  // material, so the absolute gain through the chain is not something to assert against.
  const project = createProject({ id: 'v', name: 'V', bpm: 120, barCount: 4, quality: 'standard' });
  const loud = {
    ...project,
    backing: {
      drums: { ...project.backing.drums, muted: false, level: 1 },
      chords: { ...project.backing.chords, muted: false, level: 1 },
    },
  };
  const t = projectTiming(loud);
  const loop = loopFrames(t);

  const ctx = new OfflineAudioContext(1, loop, t.sampleRate);
  const source = ctx.createBuffer(1, loop, t.sampleRate);
  source.getChannelData(0).fill(0.05);

  const session = {
    id: 'v-take',
    audioFileURL: takeUrl('v-take'),
    recordedFrames: loop,
    recordedAt: new Date().toISOString(),
    waveformPeaks: [],
  };
  const takes = takeStore();
  takes.restore('v-take', source);

  const withLayer = {
    ...loud,
    layers: loud.layers.map((l, i) =>
      i === 0 ? { ...recordSession(l, session, t), pan: 'center' as const } : l,
    ),
  };

  const peak = (b: AudioBuffer) => {
    let m = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) if (Math.abs(d[i]!) > m) m = Math.abs(d[i]!);
    }
    return Number(m.toFixed(5));
  };

  const plan = bouncePlan(withLayer);
  // What a bounce renders: the layers, backing silenced.
  const mix = await renderOffline(withLayer, silentBacking(), takes, loop);
  // The control: no layers at all, still bounce's backing argument. Must be exactly silent, which
  // is what proves the loud unmuted drums are excluded rather than merely quiet.
  const empty = await renderOffline(loud, silentBacking(), takes, loop);
  // And the counter-control: the same project with its real backing, so the check above is not
  // vacuous — the drums have to be audible when they are asked for.
  const withBacking = await renderOffline(loud, loud.backing, takes, loop);

  const left = mix.getChannelData(0);
  const right = mix.getChannelData(1);
  let channelDiff = 0;
  for (let i = 0; i < loop; i++) channelDiff = Math.max(channelDiff, Math.abs(left[i]! - right[i]!));

  // -- 3. the seed carries the backing -------------------------------------
  const seed = bounceSeed(withLayer, session, { id: 'v-mix', name: 'V mix' });

  return {
    tailWrapsOntoHead: wrapOk,
    planHasNoBackingField: !('backing' in (plan ?? {})),
    planLayers: plan?.layers.length,
    mixFrames: mix.length,
    expectedFrames: loop,
    // The layer is in the mixdown...
    layerPeak: peak(mix),
    // ...the loud unmuted drums are not, at all...
    backingExcludedPeak: peak(empty),
    // ...and they would have been, had bounce asked for them.
    backingWouldHaveBeenAudible: peak(withBacking),
    channelsIdentical: channelDiff < 1e-7,
    seedBackingCarried:
      seed.backing.drums.kitId === withLayer.backing.drums.kitId &&
      seed.backing.chords.tone === withLayer.backing.chords.tone &&
      seed.backing.drums.muted === withLayer.backing.drums.muted,
    seedIsCompressed: seed.isCompressed,
    pass:
      wrapOk &&
      mix.length === loop &&
      peak(mix) > 0.01 &&
      peak(empty) === 0 &&
      peak(withBacking) > 0.01 &&
      channelDiff < 1e-7 &&
      seed.backing.drums.kitId === withLayer.backing.drums.kitId &&
      seed.isCompressed === false,
  };
}
