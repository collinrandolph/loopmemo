import { type BackingTracks, defaultBacking } from '../../src/domain/backing.ts';
import type { ExportFile, ExportPlan } from '../../src/domain/export.ts';
import { panGains } from '../../src/domain/effects.ts';
import { type Layer, type Project, QUALITY_SPEC, projectTiming } from '../../src/domain/project.ts';
import { loopFrames } from '../../src/domain/timing.ts';
import { audioEngine } from './audio.ts';
import type { OutputFile } from './save.ts';
import type { TakeStore } from './takes.ts';
import { encodeWav } from './wav.ts';

/**
 * Turning an `ExportPlan` into actual files (§2.7).
 *
 * The domain decided *what* comes out — which files, their names, lengths and channel counts —
 * without needing audio. This renders them **through the same engine that plays them**: a second
 * rendering path would be a second set of decisions about crossfades, splices, pan law, the
 * compressor and which bar carries which chord, and every one is a chance for the file to
 * disagree with what was heard.
 *
 * **MP3 is not possible in this build** — no encoder, and no runtime dependencies to add one. It
 * is a limit of the build rather than the design, so the format stays in the domain and `ui/`
 * refuses it; writing a WAV with an `.mp3` name is the one dishonest option.
 */

/** Everything an export needs that the plan does not carry. */
export type RenderContext = {
  readonly project: Project;
  readonly backing: BackingTracks;
  readonly takes: TakeStore;
};

/**
 * Centre pan is equal-power, so a mono source arrives at 0.707 per side. A mono file wants the
 * signal at unity, so the render is scaled back up rather than the pan law being special-cased —
 * `effects.ts` is where the law lives and it should not grow an export-shaped exception.
 */
const CENTRE_MAKEUP = 1 / panGains(0).left;

/** A layer as it is exported dry: its own audio, none of its treatment (§2.7). */
function dry(layer: Layer): Layer {
  return { ...layer, eq: 'flat', pan: 'center', level: 1, muted: false };
}

function soloLayer(project: Project, index: number, treated: boolean): Project {
  return {
    ...project,
    layers: project.layers.map((l) =>
      l.index === index
        ? treated
          ? { ...l, muted: false, level: 1 }
          : dry(l)
        : { ...l, muted: true },
    ),
  };
}

function silentBacking(): BackingTracks {
  const base = defaultBacking();
  return {
    drums: { ...base.drums, muted: true },
    chords: { ...base.chords, muted: true },
  };
}

/**
 * Render one pass through the engine, offline. Always two channels — the merger has two inputs
 * and the pan law fills both — so how many to *write* stays a property of the file, not the render.
 */
async function renderThroughEngine(
  ctx: RenderContext,
  project: Project,
  backing: BackingTracks,
  frames: number,
): Promise<AudioBuffer> {
  const t = projectTiming(project);
  const offline = new OfflineAudioContext(2, frames, t.sampleRate);
  const engine = audioEngine(t.sampleRate, offline);
  engine.setBacking(backing, t);
  engine.setLayers(project, ctx.takes);
  engine.prerender(t.barCount);
  return offline.startRendering();
}

/** Drop to one channel, with the centre-pan makeup applied. */
function toMono(buffer: AudioBuffer, makeup = CENTRE_MAKEUP): AudioBuffer {
  const mono = new OfflineAudioContext(1, buffer.length, buffer.sampleRate).createBuffer(
    1,
    buffer.length,
    buffer.sampleRate,
  );
  const out = mono.getChannelData(0);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  for (let i = 0; i < buffer.length; i++) out[i] = ((left[i]! + right[i]!) / 2) * makeup;
  return mono;
}

/** The planned name without its extension. Everything matched below is in the stem of it. */
function baseName(file: ExportFile): string {
  return file.name.replace(/\.[^.]+$/, '');
}

/**
 * Which layer or backing track a planned file is about, read back out of `Project - Source - kind`.
 * A weaker link than an id and the one the domain offers; if it becomes load-bearing, `ExportFile`
 * should carry the layer index instead.
 */
function sourceOf(
  file: ExportFile,
  project: Project,
): { layer?: Layer | undefined; backing?: 'drums' | 'chords' | undefined } {
  const parts = baseName(file).split(' - ');
  const label = parts.length >= 3 ? parts[1]! : '';
  if (label === 'Drums') return { backing: 'drums' };
  if (label === 'Chords') return { backing: 'chords' };
  const layer = project.layers.find(
    (l) => (l.name || `Layer ${l.index + 1}`) === label && l.sessions.length > 0,
  );
  return { layer };
}

async function renderOne(ctx: RenderContext, file: ExportFile): Promise<AudioBuffer | undefined> {
  const { project, backing, takes } = ctx;
  const t = projectTiming(project);
  const frames = loopFrames(t);

  if (file.kind === 'loop') {
    return renderThroughEngine(ctx, project, backing, frames);
  }

  const source = sourceOf(file, project);

  if (source.backing) {
    // One backing track alone: the other muted, and no layers.
    const only: BackingTracks = {
      drums: { ...backing.drums, muted: source.backing !== 'drums' || backing.drums.muted },
      chords: { ...backing.chords, muted: source.backing !== 'chords' || backing.chords.muted },
    };
    const bare = { ...project, layers: project.layers.map((l) => ({ ...l, muted: true })) };
    return toMono(await renderThroughEngine(ctx, bare, only, frames));
  }

  if (file.kind === 'pass') {
    // No rendering: a pass is the capture as it arrived (§1.4), and sessions are never
    // concatenated, so one file is one session's buffer. Matched against the name *without* its
    // extension — `Number('1.wav')` is NaN, and every pass vanishes from the archive.
    const base = baseName(file);
    const layerFor = project.layers.find((l) =>
      base.startsWith(`${project.name} - ${l.name || `Layer ${l.index + 1}`} - take `),
    );
    const take = Number(base.slice(base.lastIndexOf(' ') + 1));
    const session = layerFor?.sessions[take - 1];
    return session ? takes.get(session.id) : undefined;
  }

  if (!source.layer) return undefined;
  const treated = file.kind === 'stem-fx';
  const solo = soloLayer(project, source.layer.index, treated);
  const rendered = await renderThroughEngine(ctx, solo, silentBacking(), frames);
  return file.channels === 2 ? rendered : toMono(rendered);
}

/**
 * Render every file in the plan, sequentially: each render holds a full loop of float samples per
 * channel, and offline rendering is already faster than real time, so parallelism would hold
 * sixteen of those at once for no gain.
 */
export async function renderExport(
  plan: ExportPlan,
  ctx: RenderContext,
  onProgress?: (done: number, total: number) => void,
): Promise<OutputFile[]> {
  const depth = QUALITY_SPEC[ctx.project.audioQuality].bitDepth === 24 ? 24 : 16;
  const out: OutputFile[] = [];
  for (const [i, file] of plan.files.entries()) {
    const buffer = await renderOne(ctx, file);
    // `ExportFile.name` already carries the extension; the domain appends the format.
    if (buffer) out.push({ name: file.name, blob: encodeWav(buffer, depth) });
    onProgress?.(i + 1, plan.files.length);
  }
  return out;
}
