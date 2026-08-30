import type { Arrangement } from './arrangement.ts';
import { type PassIndex, type RecordingSession, passIndex, totalPasses } from './pass-index.ts';
import { type Timing, loopSeconds, timing } from './timing.ts';

/**
 * Capture format. Global setting, **snapshotted into each project at creation and immutable
 * thereafter** (§2.7): a project's layers must share a sample rate, or a splice between a
 * 44.1k layer and a 48k one needs a resample at every join.
 *
 * Capture stays PCM in both modes. Layers compound loss across seven tracks and a bounce,
 * and mid-bar splice wants a frame index rather than a decoded packet. Lossy encoding
 * belongs at compression and export.
 */
export type AudioQuality = 'standard' | 'high';

export const QUALITY_SPEC: Record<AudioQuality, { sampleRate: number; bitDepth: number }> = {
  standard: { sampleRate: 44_100, bitDepth: 16 },
  high: { sampleRate: 48_000, bitDepth: 24 },
};

export const CHANNEL_COUNT = 1;

export function bytesPerSecond(quality: AudioQuality): number {
  const { sampleRate, bitDepth } = QUALITY_SPEC[quality];
  return sampleRate * CHANNEL_COUNT * (bitDepth / 8);
}

export const LAYER_COUNT = 7;
export const VALID_BAR_COUNTS = [4, 8, 12, 16, 20, 24, 28, 32] as const;
export const BPM_MIN = 60;
export const BPM_MAX = 240;
export const NAME_CHARACTER_LIMIT = 12;

/** One of exactly seven recorded tracks (§5.1 #6). */
export type Layer = {
  readonly id: string;
  readonly index: number;
  /** Empty means unnamed — the row shows a placeholder rather than a real name (§3.9). */
  readonly name: string;
  readonly level: number;
  readonly muted: boolean;
  /** One per time the user records onto this layer. **Never concatenated** (§1.4). */
  readonly sessions: readonly RecordingSession[];
  readonly barSources: Arrangement;
};

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly createdDate: string;
  readonly lastModified: string;
  readonly bpm: number;
  readonly barCount: number;
  readonly beatsPerBar: number;
  readonly audioQuality: AudioQuality;
  /**
   * A label and a storage fact only; cleared by recording. **Never gate UI on it** — the
   * pass axis re-enables on its own because availability derives from audio (§1.4).
   */
  readonly isCompressed: boolean;
  readonly bouncedFromProjectId?: string;
  readonly layers: readonly Layer[];
};

export function emptyLayer(index: number, id = `layer-${index}`): Layer {
  return { id, index, name: '', level: 1, muted: false, sessions: [], barSources: [] };
}

export function createProject(options: {
  id: string;
  name: string;
  bpm: number;
  barCount: number;
  quality: AudioQuality;
  beatsPerBar?: number;
  now?: string;
}): Project {
  const { id, name, bpm, barCount, quality } = options;
  if (!Number.isInteger(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) {
    throw new RangeError(`bpm ${bpm} outside ${BPM_MIN}..${BPM_MAX}`);
  }
  if (!(VALID_BAR_COUNTS as readonly number[]).includes(barCount)) {
    throw new RangeError(`barCount ${barCount} is not one of ${VALID_BAR_COUNTS.join(', ')}`);
  }
  const now = options.now ?? new Date().toISOString();
  return {
    id,
    name,
    createdDate: now,
    lastModified: now,
    bpm,
    barCount,
    beatsPerBar: options.beatsPerBar ?? 4,
    audioQuality: quality,
    isCompressed: false,
    layers: Array.from({ length: LAYER_COUNT }, (_, i) => emptyLayer(i)),
  };
}

export function projectTiming(project: Project): Timing {
  return timing(
    project.bpm,
    project.barCount,
    QUALITY_SPEC[project.audioQuality].sampleRate,
    project.beatsPerBar,
  );
}

export function layerPassIndex(layer: Layer, t: Timing): PassIndex {
  return passIndex(layer.sessions, t);
}

export function layerHasRecording(layer: Layer): boolean {
  return layer.sessions.length > 0;
}

/** The pass about to be captured: `Pass 1` for an empty layer, `passes + 1` otherwise (§3.9). */
export function nextPassNumber(layer: Layer, t: Timing): number {
  return totalPasses(layerPassIndex(layer, t)) + 1;
}

export function projectHasRecordings(project: Project): boolean {
  return project.layers.some(layerHasRecording);
}

/** Setup is the last point at which BPM and bar count can change (§4.5, §5.1 #4). */
export function isConfigurationLocked(project: Project): boolean {
  return projectHasRecordings(project);
}

/**
 * **Summed across layers, not maxed.** §2.7's worked example — 5 layers, 12 passes, 66 MB —
 * only holds if this is the total, and the whole point of showing it in the Library is that
 * it, not the layer count, explains the size.
 */
export function projectTotalPasses(project: Project): number {
  const t = projectTiming(project);
  return project.layers.reduce((sum, layer) => sum + totalPasses(layerPassIndex(layer, t)), 0);
}

export function recordedLayerCount(project: Project): number {
  return project.layers.filter(layerHasRecording).length;
}

export type SizeProjection = {
  readonly uncompressedBytes: number;
  readonly compressedBytes: number;
  readonly savingBytes: number;
  /**
   * Compression saves nothing on a project with one pass per layer. Show the projection
   * before confirming; sometimes the honest answer is "this won't help" (§2.7).
   */
  readonly isWorthCompressing: boolean;
};

export function sizeProjection(project: Project): SizeProjection {
  const perLoop = loopSeconds(projectTiming(project)) * bytesPerSecond(project.audioQuality);
  const uncompressedBytes = Math.round(projectTotalPasses(project) * perLoop);
  const compressedBytes = Math.round(recordedLayerCount(project) * perLoop);
  const savingBytes = Math.max(0, uncompressedBytes - compressedBytes);
  return {
    uncompressedBytes,
    compressedBytes,
    savingBytes,
    isWorthCompressing: savingBytes > 0,
  };
}

/**
 * Remove every session and reset the arrangement (§4.2 "Clear layer").
 *
 * Self-contained: no other layer references this one's passes. It is the only way to discard
 * a single layer's audio, because an individual pass cannot be deleted — `barSources`
 * references pass numbers, and deleting one renumbers the rest and breaks every reference
 * past it (§5.1 #2).
 */
export function clearLayer(layer: Layer): Layer {
  return { ...layer, sessions: [], barSources: [] };
}
