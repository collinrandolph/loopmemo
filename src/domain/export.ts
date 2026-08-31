import type { ReferenceSource } from './bounce.ts';
import { isStereoPreset, panPreset } from './effects.ts';
import {
  type AudioQuality,
  type Layer,
  type Project,
  bytesPerSecond,
  layerHasRecording,
  projectTiming,
} from './project.ts';
import { loopSeconds } from './timing.ts';

/**
 * What an export produces (§4.5, extended).
 *
 * §4.5 lists format, quality, preview and share, and one deliverable: "it exports the project
 * exactly as it currently sounds". That is the **Full Loop**, and it stays the default. Three
 * more are added at the user's instruction, and each answers a different question:
 *
 * | | Renders | From |
 * |---|---|---|
 * | **Full loop** | the mix as you hear it — level, EQ, pan, references, mutes | the mixdown |
 * | **Stems** | one file per layer, the edited loop and nothing else | `compressionPlan` |
 * | **Stems + effects** | the same, with the layer's level, EQ and pan applied | `compressionPlan` + §2.8 |
 * | **All recorded passes** | every session, unedited | `Layer.sessions` — no rendering at all |
 *
 * **All four start from what is already stored**, which is why all four are possible. The two
 * stem sets share `compressionPlan`'s retained bars with the Full Loop, so none of them can
 * disagree about *what was played* — only about what was done to it afterwards. Passes need no
 * rendering: sessions are never concatenated (§1.4), so every pass on disk is the session set.
 *
 * **A muted layer still produces a stem.** The Full Loop honours the mute, because that is what
 * "as it currently sounds" means; a stem set does not, because a layer is usually muted to hear
 * something else and a set with a track missing is a broken delivery. Per-**bar** mutes bake in
 * either way — those are an arrangement decision, not a mix one, and `compressionPlan` already
 * writes them as real silence for compress and bounce.
 */
export type ExportFormat = 'wav' | 'mp3';

/** CBR, so a size is a multiplication rather than an estimate. */
export type Mp3Bitrate = 128 | 192 | 320;

export const MP3_BITRATES: readonly Mp3Bitrate[] = [128, 192, 320];

export type ExportSelection = {
  readonly fullLoop: boolean;
  readonly stems: boolean;
  readonly stemsWithEffects: boolean;
  readonly allPasses: boolean;
};

/** The loop on, the rest off: one file that matches what you just heard (§4.5). */
export const DEFAULT_SELECTION: ExportSelection = {
  fullLoop: true,
  stems: false,
  stemsWithEffects: false,
  allPasses: false,
};

export type ExportKind = 'loop' | 'stem' | 'stem-fx' | 'pass';

export type ExportFile = {
  readonly kind: ExportKind;
  readonly name: string;
  readonly format: ExportFormat;
  readonly seconds: number;
  readonly bytes: number;
  readonly channels: 1 | 2;
};

export type ExportPlan = {
  readonly files: readonly ExportFile[];
  readonly totalBytes: number;
};

export type ExportOptions = {
  readonly format: ExportFormat;
  readonly mp3Bitrate: Mp3Bitrate;
  /** §2.6's reference tracks, still provisional here — see `bounce.ts`. */
  readonly references?: readonly (ReferenceSource & { readonly label: string })[];
};

/**
 * **Only panning makes a file stereo.**
 *
 * Capture is mono (`CHANNEL_COUNT`), so a dry stem and a recorded pass are mono, and the Full
 * Loop is stereo because the mixdown pans. A stem *with* effects is whichever its layer's preset
 * makes it: Center is the mono capture twice over and writing two identical channels would
 * double the file for nothing, while every other preset is a real stereo image.
 */
function channelsFor(kind: ExportKind, layer?: Layer): 1 | 2 {
  if (kind === 'loop') return 2;
  if (kind === 'stem-fx' && layer && isStereoPreset(panPreset(layer.pan))) return 2;
  return 1;
}

/**
 * Size follows the chosen format for **every** file, passes included.
 *
 * §2.7 keeps *capture* PCM so nothing compounds loss across seven layers and a bounce, and says
 * in the same breath that "lossy encoding belongs at compression and export". Export is
 * therefore exactly where the format setting is meant to apply; forcing passes to WAV read the
 * PCM rule as covering a boundary it explicitly does not.
 *
 * MP3 is CBR, so the bitrate already covers both channels and the size does not move with the
 * channel count. WAV does.
 */
function sizeOf(seconds: number, channels: 1 | 2, quality: AudioQuality, options: ExportOptions): number {
  if (options.format === 'mp3') return Math.round((options.mp3Bitrate * 1000 * seconds) / 8);
  return Math.round(bytesPerSecond(quality) * channels * seconds);
}

function file(
  kind: ExportKind,
  name: string,
  seconds: number,
  project: Project,
  options: ExportOptions,
  layer?: Layer,
): ExportFile {
  const channels = channelsFor(kind, layer);
  return {
    kind,
    name: `${name}.${options.format}`,
    format: options.format,
    seconds,
    bytes: sizeOf(seconds, channels, project.audioQuality, options),
    channels,
  };
}

/** Falls back to the position, matching every other screen's placeholder (§3.9). */
function layerLabel(name: string, index: number): string {
  return name || `Layer ${index + 1}`;
}

export function exportPlan(
  project: Project,
  selection: ExportSelection,
  options: ExportOptions,
): ExportPlan {
  const t = projectTiming(project);
  const loop = loopSeconds(t);
  const files: ExportFile[] = [];
  const references = options.references ?? [];

  if (selection.fullLoop) {
    files.push(file('loop', project.name, loop, project, options));
  }

  // Every file is `Project - Source - kind`, so two sets selected together cannot collide.
  // Without the kind, a layer recorded once names its pass file exactly what its stem is
  // called, and the two land on one name in one folder.
  const stemSet = (kind: 'stem' | 'stem-fx', suffix: string) => {
    // Every recorded layer, muted or not. A stem is the edited loop, so it is one loop long
    // however many passes were recorded to make it.
    for (const layer of project.layers) {
      if (!layerHasRecording(layer)) continue;
      const label = layerLabel(layer.name, layer.index);
      files.push(file(kind, `${project.name} - ${label} - ${suffix}`, loop, project, options, layer));
    }
    // References are not layers, but a stem set without the drums is missing the thing every
    // layer was played against (§2.6). `enabled`, not audible: mute belongs to the mixdown.
    // They carry no EQ or pan of their own, so both sets render them the same and mono.
    for (const reference of references) {
      if (!reference.enabled) continue;
      files.push(file(kind, `${project.name} - ${reference.label} - ${suffix}`, loop, project, options));
    }
  };

  if (selection.stems) stemSet('stem', 'stem');
  if (selection.stemsWithEffects) stemSet('stem-fx', 'stem fx');

  if (selection.allPasses) {
    // One file per session, never per layer: sessions are never concatenated (§1.4), so a layer
    // recorded twice holds two files and that is what "every pass" means on disk.
    for (const layer of project.layers) {
      const label = layerLabel(layer.name, layer.index);
      for (const [i, session] of layer.sessions.entries()) {
        const seconds = session.recordedFrames / t.sampleRate;
        files.push(file('pass', `${project.name} - ${label} - take ${i + 1}`, seconds, project, options));
      }
    }
  }

  return { files, totalBytes: files.reduce((n, f) => n + f.bytes, 0) };
}

/** Nothing selected is not an export. The screen disables its action on this. */
export function isExportable(selection: ExportSelection): boolean {
  return selection.fullLoop || selection.stems || selection.stemsWithEffects || selection.allPasses;
}
