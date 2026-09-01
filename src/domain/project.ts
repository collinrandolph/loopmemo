import {
  type Arrangement,
  type MutedSlots,
  NONE_MUTED,
  type RetainedBar,
  compressionPlan,
  initialArrangement,
  recordedOrder,
} from './arrangement.ts';
import { type BackingTracks, defaultBacking } from './backing.ts';
import type { PanPresetId } from './effects.ts';
import type { EqPresetId } from './eq.ts';
import { type PassIndex, type RecordingSession, passIndex, totalPasses } from './pass-index.ts';
import { type Timing, loopFrames, loopSeconds, passExists, timing } from './timing.ts';

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
  /** Layer mute, set on the Playback screen (§3.7). Independent of `mutedSlots`. */
  readonly muted: boolean;
  /** Effects, applied per layer and persisted with the project (§2.8). */
  readonly eq: EqPresetId;
  readonly pan: PanPresetId;
  /** One per time the user records onto this layer. **Never concatenated** (§1.4). */
  readonly sessions: readonly RecordingSession[];
  readonly barSources: Arrangement;
  /**
   * Slots silenced on this layer (§3.7, tap and hold). Sparse, so it carries no length
   * invariant against `barSources`.
   *
   * §1.5's warning about a parallel per-bar map does not apply: that was about a *selection*
   * map restating what `barSources` already encoded. `barSources` says where a slot's audio
   * comes from; this says whether it sounds. Different questions, no duplication.
   *
   * **Layer mute is never written through into this.** Doing so would destroy the record of
   * which bars the user muted deliberately, so unmuting the layer could not restore them —
   * the same trap as writing a derived state into storage anywhere else. The two compose at
   * read time, through `isSilentAt`.
   */
  readonly mutedSlots: MutedSlots;
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
  /**
   * The drum track and chord bed (§2.6).
   *
   * **Not optional, and not locked.** Both tracks always exist — a sketch that does not want the
   * chords mutes them (§1.5) — and unlike `bpm` and `barCount` they stay editable for the whole
   * life of the project. Nothing derived depends on them and no recorded frame references them,
   * so `isConfigurationLocked` deliberately does not cover this field.
   */
  readonly backing: BackingTracks;
  readonly layers: readonly Layer[];
};

/**
 * `eq` and `pan` default to the neutral preset of each. §5.3 makes "which preset a new layer
 * starts on" a live setting, so a caller that has one passes it rather than patching after.
 */
export function emptyLayer(
  index: number,
  id = `layer-${index}`,
  defaults: { eq?: EqPresetId; pan?: PanPresetId } = {},
): Layer {
  return {
    id,
    index,
    name: '',
    level: 1,
    muted: false,
    eq: defaults.eq ?? 'flat',
    pan: defaults.pan ?? 'center',
    sessions: [],
    barSources: [],
    mutedSlots: NONE_MUTED,
  };
}

export function createProject(options: {
  id: string;
  name: string;
  bpm: number;
  barCount: number;
  quality: AudioQuality;
  beatsPerBar?: number;
  now?: string;
  /** Setup picks a starting groove (§4.5); omitted, the project starts on the defaults. */
  backing?: BackingTracks;
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
    backing: options.backing ?? defaultBacking(),
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

/** What the pass badge reads while recording (§3.9). */
export type RecordingBadge = {
  readonly pass: number;
  /**
   * Whether this traversal has passed the one-bar gate and would survive a stop right now.
   * False for the first bar of every traversal, including the first.
   */
  readonly isCommitted: boolean;
};

/**
 * The pass badge during a recording, from the engine's own frame count (§3.9).
 *
 * The number increments the moment a traversal begins, but reads **provisional** until that
 * traversal has completed a bar and become a real pass. Waiting for the bar to increment
 * would leave the badge frozen through the loop point, which reads as broken; showing the
 * number immediately and marking it unearned tells the truth about both.
 *
 * **The provisional number never lies about what it will be.** If the take is stopped before
 * the bar completes, the traversal is discarded (`passExists`) and that same number is what
 * the next take will claim — so it is either committed or handed straight back. The badge
 * cannot show a number that later turns out to belong to something else.
 *
 * Commitment is decided by the very same `passExists` that decides survival after the stop,
 * so this is a live preview of the gate rather than a second rule that could drift from it.
 *
 * `framesRecorded` comes from the engine, not from a software clock — same reason transport
 * owns no clock (§2.4): a free-running counter drifts against the audible playhead, and here
 * it would commit the badge at a different instant than the stop actually would.
 *
 * Takes the layer as it stands **before** the session is appended; `recordSession` adds it at
 * the stop.
 */
export function recordingBadge(layer: Layer, t: Timing, framesRecorded: number): RecordingBadge {
  const elapsed = Math.max(0, framesRecorded);
  const traversal = Math.floor(elapsed / loopFrames(t)) + 1;
  return {
    pass: nextPassNumber(layer, t) + traversal - 1,
    isCommitted: passExists(t, traversal, elapsed),
  };
}

/**
 * Commit a finished recording to a layer.
 *
 * **The arrangement is initialised on the first session only.** Before this a layer's
 * `barSources` is empty, which is not a degenerate arrangement but the absence of one — there
 * is nothing to arrange until audio exists, and §4.2 hides Edit bars until then for the same
 * reason. `initialArrangement` decides what it becomes, including which slots a partial first
 * pass leaves muted.
 *
 * **Every later session leaves the arrangement and the mutes exactly as they are.** By then
 * they are the user's, and a new pass is an *option* the swipe axis gains, not a decision
 * about where it goes. Auto-selecting the newest pass would silently discard hunting the user
 * had already done, which is the whole activity the app exists for.
 *
 * A session with no usable audio is not recorded at all. It would add a file, contribute no
 * passes, and — on an empty layer — trigger the initialisation with nothing behind it,
 * producing an arrangement of entirely muted placeholder slots.
 */
export function recordSession(layer: Layer, session: RecordingSession, t: Timing): Layer {
  if (totalPasses(passIndex([session], t)) === 0) return layer;

  const sessions = [...layer.sessions, session];
  if (layer.sessions.length > 0) return { ...layer, sessions };

  const initial = initialArrangement(passIndex(sessions, t));
  return {
    ...layer,
    sessions,
    barSources: initial.barSources,
    mutedSlots: initial.mutedSlots,
  };
}

/**
 * Whether a layer sounds right now, given what is being recorded (§3.9).
 *
 * §3.9 says "**all other** layers play at their current level, mute, EQ and pan" — the layer
 * being recorded onto is not among them. It falls silent for the take, because the user is
 * presumably playing a replacement for what is already there and would otherwise be
 * performing against the very audio they are trying to replace.
 *
 * **Derived, never written into `layer.muted`.** Writing it through would leave the user's
 * own mute state indistinguishable from ours, so stopping the recording could not restore it
 * — the same trap as `mutedSlots` and layer mute, which is why those also compose at read
 * time rather than being merged (`isSilentAt`).
 *
 * An empty layer makes this a no-op, so it needs no condition: there is nothing to silence.
 */
export function isLayerAudible(layer: Layer, recordingIntoLayerIndex?: number): boolean {
  if (layer.muted) return false;
  return layer.index !== recordingIntoLayerIndex;
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
 * What compressing this project keeps, per layer (§2.7, §4.1).
 *
 * `compressionPlan` already does the per-layer work; this is the project-level pass that the
 * Library's Compress action needs, and it exists here for the same reason `bouncePlan` does —
 * so no screen has to decide what compress means.
 *
 * **Refused whole, never partly.** One layer with an audible slot pointing at audio that does
 * not exist fails the project, because compress is destructive and a half-compressed project
 * is a state nothing else in the app knows how to describe. Empty layers are skipped rather
 * than refused: a layer with no audio has nothing to discard and is not an error.
 */
export type CompressionPlan = {
  readonly layers: readonly {
    readonly layerIndex: number;
    readonly bars: readonly RetainedBar[];
  }[];
  readonly projection: SizeProjection;
};

/**
 * What compressing **one** layer keeps (§4.3). Undefined when an audible slot points at audio
 * that is not there — baking that into the only surviving copy is unrecoverable.
 *
 * The project-level plan is this one over every recorded layer, so the two cannot disagree
 * about what a compress keeps.
 */
export function layerCompressionPlan(layer: Layer, t: Timing): readonly RetainedBar[] | undefined {
  if (!layerHasRecording(layer)) return undefined;
  return compressionPlan(layer.barSources, layerPassIndex(layer, t), layer.mutedSlots)?.bars;
}

/**
 * The passes this layer would discard, and the loops it would keep. The Edit Layer screen states
 * both before asking (§4.1's rule, applied per layer).
 */
export function layerCompressionSaving(
  layer: Layer,
  project: Project,
): { readonly passes: number; readonly discarded: number; readonly bytes: number } {
  const t = projectTiming(project);
  const passes = totalPasses(layerPassIndex(layer, t));
  const discarded = Math.max(0, passes - 1);
  const bytes = Math.round(discarded * loopSeconds(t) * bytesPerSecond(project.audioQuality));
  return { passes, discarded, bytes };
}

/** One layer holding exactly one session of exactly one loop, so it is Pass 1 by construction. */
export function compressedLayer(
  layer: Layer,
  session: RecordingSession,
  barCount: number,
): Layer {
  return {
    ...layer,
    sessions: [session],
    barSources: recordedOrder(barCount),
    mutedSlots: NONE_MUTED,
  };
}

export function projectCompressionPlan(project: Project): CompressionPlan | undefined {
  const t = projectTiming(project);
  const layers: { layerIndex: number; bars: readonly RetainedBar[] }[] = [];

  for (const layer of project.layers) {
    if (!layerHasRecording(layer)) continue;
    const bars = layerCompressionPlan(layer, t);
    if (!bars) return undefined;
    layers.push({ layerIndex: layer.index, bars });
  }

  return { layers, projection: sizeProjection(project) };
}

/**
 * The project a compress produces, given the one loop each layer's audio was written to.
 *
 * The caller supplies the written files — that is the platform-bound half — and everything
 * else is decided here. Each compressed layer holds **exactly one session of exactly one
 * loop**, so it is Pass 1 by construction, its arrangement is recorded order, and its mute
 * flags are spent because the silence is in the audio now (see `compressionPlan`).
 *
 * `isCompressed` is a label and a storage fact only. Recording a new pass clears it, and
 * nothing gates on it — the pass axis re-enables by itself because availability derives from
 * audio (§1.4).
 */
export function compressedProject(
  project: Project,
  sessionFor: (layerIndex: number) => RecordingSession,
  options: { now?: string } = {},
): Project {
  const now = options.now ?? new Date().toISOString();
  const layers = project.layers.map((layer) =>
    layerHasRecording(layer)
      ? compressedLayer(layer, sessionFor(layer.index), project.barCount)
      : layer,
  );
  return { ...project, layers, isCompressed: true, lastModified: now };
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
  return { ...layer, sessions: [], barSources: [], mutedSlots: NONE_MUTED };
}
