import { type BackingTracks, defaultBacking } from '../../src/domain/backing.ts';
import type { Project } from '../../src/domain/project.ts';
import { projectTiming } from '../../src/domain/project.ts';
import { audioEngine } from './audio.ts';
import type { TakeStore } from './takes.ts';

/**
 * Rendering a project offline, **through the engine that plays it**.
 *
 * Export and bounce both need this and neither may have its own. A second rendering path is a
 * second set of decisions about crossfades, splices, pan law, the compressor and which bar
 * carries which chord, and every one of them is a chance for the file to disagree with what the
 * user heard. Here the only way they can differ is if `prerender` and the live scheduler differ,
 * and they are the same function.
 */

/** Both tracks off, for a render that is layers only — every stem, and every bounce (§2.7). */
export function silentBacking(): BackingTracks {
  const base = defaultBacking();
  return {
    drums: { ...base.drums, muted: true },
    chords: { ...base.chords, muted: true },
  };
}

/**
 * Two channels throughout: the merger has two inputs and the pan law fills both, so how many
 * channels to *write* stays a property of the file rather than of the render.
 */
export async function renderOffline(
  project: Project,
  backing: BackingTracks,
  takes: TakeStore,
  frames: number,
): Promise<AudioBuffer> {
  const t = projectTiming(project);
  const offline = new OfflineAudioContext(2, frames, t.sampleRate);
  const engine = audioEngine(t.sampleRate, offline);
  engine.setBacking(backing, t);
  engine.setLayers(project, takes);
  engine.prerender(t.barCount);
  return offline.startRendering();
}

/**
 * Fold a rendered overhang back onto the head of the loop.
 *
 * Live, a Surround layer's delayed copy of the last bar simply runs past the loop point and the
 * delay line keeps going. A fixed-length render has nowhere to put it, so truncating leaves the
 * bounced loop with a seam the original never had. Rendering `frames + tail` and adding the
 * overhang onto the start is what the live loop does when it comes round.
 *
 * Returns the buffer unchanged when there is no tail, so the common case copies nothing.
 */
export function wrapTail(rendered: AudioBuffer, frames: number, tailFrames: number): AudioBuffer {
  if (tailFrames <= 0 || rendered.length <= frames) return rendered;

  const out = new OfflineAudioContext(
    rendered.numberOfChannels,
    frames,
    rendered.sampleRate,
  ).createBuffer(rendered.numberOfChannels, frames, rendered.sampleRate);

  const overhang = Math.min(tailFrames, rendered.length - frames, frames);
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    const from = rendered.getChannelData(c);
    const to = out.getChannelData(c);
    to.set(from.subarray(0, frames));
    for (let i = 0; i < overhang; i++) to[i] = (to[i] ?? 0) + (from[frames + i] ?? 0);
  }
  return out;
}
