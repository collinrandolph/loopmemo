import type { RetainedBar } from '../../src/domain/arrangement.ts';
import type { RecordingSession } from '../../src/domain/pass-index.ts';
import type { Layer } from '../../src/domain/project.ts';
import { computePeaks } from './peaks.ts';
import { type TakeStore, takeUrl } from './takes.ts';

/**
 * Writing the loop a compress keeps (§2.7, §4.3).
 *
 * `compressionPlan` decides *which* bars survive and in what order; this is the half the domain
 * says the caller supplies — the audio itself. Both compress actions handed the domain a
 * placeholder session instead, so a compressed layer pointed at a file that had never been
 * written: it played nothing, and its lanes fell back to the synthetic generator, which drew a
 * confident waveform of audio that did not exist.
 *
 * **A straight sample copy, not a render.** Compress keeps the *edited loop* and nothing else —
 * level, EQ and pan stay on the layer and are still applied at playback — so there is no
 * processing to bake and passing this through the engine could only introduce differences.
 */

/** Compressed takes are mono, like the captures they come from. */
const CHANNELS = 1;

/**
 * One loop of audio for a plan, or undefined when a bar it needs has no buffer behind it.
 *
 * **Refused rather than filled with silence.** Compress is irreversible and keeps only what it
 * writes, so baking a gap into the one surviving copy is unrecoverable — and in this build the
 * takes are lost on reload, which is exactly when the buffers go missing.
 */
export function renderRetained(
  bars: readonly RetainedBar[],
  buffers: readonly (AudioBuffer | undefined)[],
  sampleRate: number,
): AudioBuffer | undefined {
  const frames = bars.reduce((n, bar) => n + bar.frameCount, 0);
  if (frames <= 0) return undefined;

  const out = new OfflineAudioContext(CHANNELS, frames, sampleRate).createBuffer(
    CHANNELS,
    frames,
    sampleRate,
  );
  const data = out.getChannelData(0);

  let at = 0;
  for (const bar of bars) {
    if (bar.kind === 'audio') {
      const source = buffers[bar.region.sessionIndex];
      if (!source) return undefined;
      const from = source.getChannelData(0);
      // `region.frameCount` is how much audio there is; `bar.frameCount` is the width of the
      // slot, and for a partial bar it is more. Clamped to the file as well, the same way
      // `regionFor` clamps, so a short take writes what it has and the rest stays silent.
      const copy = Math.min(
        bar.region.frameCount,
        bar.frameCount,
        Math.max(0, from.length - bar.region.startFrame),
      );
      for (let i = 0; i < copy; i++) data[at + i] = from[bar.region.startFrame + i]!;
    }
    // Always the slot width, never what was copied: advancing by the audio would pull every
    // later bar early and leave the loop shorter than `barCount × framesPerBar`.
    at += bar.frameCount;
  }

  return out;
}

/**
 * Render one layer's retained loop and file it, returning the session the domain should keep.
 *
 * The session is a real take — `takeUrl`, with peaks computed from the audio just written — so
 * a compressed layer draws and plays exactly what it holds, like any other recording.
 */
export function compressedTake(
  layer: Layer,
  bars: readonly RetainedBar[],
  takes: TakeStore,
  sampleRate: number,
  id: string,
): RecordingSession | undefined {
  const buffer = renderRetained(bars, takes.buffersFor(layer), sampleRate);
  if (!buffer) return undefined;

  const session: RecordingSession = {
    id,
    audioFileURL: takeUrl(id),
    recordedFrames: buffer.length,
    recordedAt: new Date().toISOString(),
    waveformPeaks: computePeaks(buffer),
  };
  takes.put(session, buffer);
  return session;
}
