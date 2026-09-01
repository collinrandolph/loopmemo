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
 * The domain already decided *what* comes out — which files, their names, lengths and channel
 * counts — and none of that needed audio. This renders them, and it does so **through the same
 * engine that plays them**. An export written as a second rendering path would be a second set
 * of decisions about crossfades, splices, the pan law, the compressor and which bar carries
 * which chord, and every one of those is a chance for the file to disagree with what the user
 * heard. Here the only way they can differ is if `prerender` and the live scheduler differ, and
 * they are the same function.
 *
 * ## MP3 is not possible in this build
 *
 * §2.7 offers WAV and MP3. The browser has no MP3 encoder: `AudioEncoder` reports `mp3` as
 * unsupported while offering AAC and Opus, and this repo carries no runtime dependencies, so
 * shipping a LAME-class encoder is not on the table either.
 *
 * That is a limitation of **this build**, not of the design — a native platform has MP3 or AAC
 * available — so the format stays in the domain and the spec, and `ui/` is where it is refused.
 * The Export screen disables the choice and says why, rather than writing a WAV with an `.mp3`
 * name, which would be the one genuinely dishonest option.
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
 * Render one pass through the engine, offline.
 *
 * `channels` is 2 throughout, and a mono file takes channel 0 afterwards. Rendering mono would
 * mean a different graph — the merger has two inputs and the pan law fills both — so the choice
 * of how many channels to *write* stays with the file rather than with the render.
 */
async function renderThroughEngine(
  ctx: RenderContext,
  project: Project,
  backing: BackingTracks,
  frames: number,
): Promise<AudioBuffer> {
  const t = projectTiming(project);
  const offline = new OfflineAudioContext(2, frames, t.sampleRate);
  const engine = audioEngine(t.sampleRate, 0, offline);
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

/**
 * Which layer or backing track a planned file is about.
 *
 * The plan names files as `Project - Source - kind`, so the source is recoverable from the name.
 * That is a weaker link than an id and it is the one the domain offers; if it ever becomes load
 * bearing, `ExportFile` should carry the layer index instead of this reading it back out.
 */
/** The planned name without its extension. Everything matched below is in the stem of it. */
function baseName(file: ExportFile): string {
  return file.name.replace(/\.[^.]+$/, '');
}

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
    // No rendering at all: a pass is the capture, exactly as it arrived (§1.4). Sessions are
    // never concatenated, so one file is one session's own buffer.
    //
    // Matched against the name *without its extension*. Reading the take number off the full
    // name gave `Number('1.wav')`, which is NaN, so `sessions[NaN - 1]` was undefined and every
    // pass silently vanished from the archive — an export that produced fewer files than it
    // promised and said nothing.
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
 * Render every file in the plan.
 *
 * Sequential on purpose. Each render holds a full loop of float samples per channel, and a
 * sixteen-file export started in parallel would hold all of them at once for no gain — offline
 * rendering is already faster than real time, and the wall-clock cost is dominated by the work
 * rather than by waiting.
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
    // `ExportFile.name` already carries the extension — the domain appends the format, because
    // the format is what decides it. Adding one here produced `Late Night.wav.wav`.
    if (buffer) out.push({ name: file.name, blob: encodeWav(buffer, depth) });
    onProgress?.(i + 1, plan.files.length);
  }
  return out;
}
