import type { ReferenceSource } from './bounce.ts';
import {
  type AudioQuality,
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
 * exactly as it currently sounds". That is the **Full Loop**, and it stays the default. Two more
 * are added here at the user's instruction, and each is cheaper than the last:
 *
 * | | Renders | From |
 * |---|---|---|
 * | **Full Loop** | arrangement, level, EQ, pan, references, mutes baked | the mixdown |
 * | **Stems** | one file per layer, the edited loop and nothing else | `compressionPlan`, minus the processing |
 * | **Raw** | every session file, untouched | `Layer.sessions` — no rendering at all |
 *
 * **Stems and the Full Loop start from the same plan.** Both take each layer's retained bars, so
 * they cannot disagree about *what was played* — only about what was done to it afterwards.
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
  readonly raw: boolean;
};

/** The loop on, the rest off: one file that matches what you just heard (§4.5). */
export const DEFAULT_SELECTION: ExportSelection = { fullLoop: true, stems: false, raw: false };

export type ExportFile = {
  readonly kind: 'loop' | 'stem' | 'raw';
  readonly name: string;
  readonly format: ExportFormat;
  readonly seconds: number;
  readonly bytes: number;
  /** Stereo only where panning made it so; see `channelsFor`. */
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
 * **The Full Loop is stereo; everything else is mono.**
 *
 * Capture is mono (`CHANNEL_COUNT`), and a dry stem is exactly the capture with an arrangement
 * applied, so it stays mono. Pan is the only thing in the project that makes two channels out of
 * one, and it is applied in the mixdown alone — so the loop is the one file that doubles.
 */
function channelsFor(kind: ExportFile['kind']): 1 | 2 {
  return kind === 'loop' ? 2 : 1;
}

/**
 * **Raw is always WAV.** §2.7 keeps capture PCM through the whole project precisely so nothing
 * compounds loss across seven layers and a bounce; handing back a re-encoded "raw" file would
 * defeat the word. The format choice applies to what is *rendered*, not to what is copied.
 */
function formatFor(kind: ExportFile['kind'], chosen: ExportFormat): ExportFormat {
  return kind === 'raw' ? 'wav' : chosen;
}

function sizeOf(
  kind: ExportFile['kind'],
  seconds: number,
  quality: AudioQuality,
  options: ExportOptions,
): number {
  const format = formatFor(kind, options.format);
  if (format === 'mp3') return Math.round((options.mp3Bitrate * 1000 * seconds) / 8);
  return Math.round(bytesPerSecond(quality) * channelsFor(kind) * seconds);
}

function file(
  kind: ExportFile['kind'],
  name: string,
  seconds: number,
  project: Project,
  options: ExportOptions,
): ExportFile {
  return {
    kind,
    name: `${name}.${formatFor(kind, options.format)}`,
    format: formatFor(kind, options.format),
    seconds,
    bytes: sizeOf(kind, seconds, project.audioQuality, options),
    channels: channelsFor(kind),
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

  if (selection.fullLoop) {
    files.push(file('loop', project.name, loop, project, options));
  }

  if (selection.stems) {
    // Every recorded layer, muted or not. A stem is the edited loop, so it is one loop long
    // however many passes were recorded to make it.
    for (const layer of project.layers) {
      if (!layerHasRecording(layer)) continue;
      const label = layerLabel(layer.name, layer.index);
      files.push(file('stem', `${project.name} - ${label}`, loop, project, options));
    }
    // References are not layers, but a stem set without the drums is missing the thing every
    // layer was played against (§2.6). `enabled`, not audible: mute belongs to the mixdown.
    for (const reference of options.references ?? []) {
      if (!reference.enabled) continue;
      files.push(file('stem', `${project.name} - ${reference.label}`, loop, project, options));
    }
  }

  if (selection.raw) {
    // One file per session, never per layer: sessions are never concatenated (§1.4), so a layer
    // recorded twice holds two files and that is what "every pass" means on disk.
    for (const layer of project.layers) {
      const label = layerLabel(layer.name, layer.index);
      for (const [i, session] of layer.sessions.entries()) {
        const seconds = session.recordedFrames / t.sampleRate;
        // The take number is always present, even for a single take. Without it a layer
        // recorded once produces `Rooftop - Bass.wav` for both its stem and its raw capture,
        // and selecting Stems and Raw together writes two different files to one name.
        files.push(file('raw', `${project.name} - ${label} - take ${i + 1}`, seconds, project, options));
      }
    }
  }

  return { files, totalBytes: files.reduce((n, f) => n + f.bytes, 0) };
}

/** Nothing selected is not an export. The screen disables its action on this. */
export function isExportable(selection: ExportSelection): boolean {
  return selection.fullLoop || selection.stems || selection.raw;
}
