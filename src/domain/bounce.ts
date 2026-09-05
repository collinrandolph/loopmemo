import { type RetainedBar, compressionPlan } from './arrangement.ts';
import type { BackingMixSource } from './backing.ts';
import { type PanPlan, panPlan, panPreset } from './effects.ts';
import { type EqBand, eqPreset } from './eq.ts';
import type { RecordingSession } from './pass-index.ts';
import {
  LAYER_COUNT,
  type Layer,
  type Project,
  createProject,
  emptyLayer,
  layerPassIndex,
  projectTiming,
  recordSession,
} from './project.ts';
import { loopTailFrames } from './tail.ts';
import { loopFrames } from './timing.ts';

/**
 * Bounce (§2.7): mix everything audible into one file and seed a **new** project with it.
 *
 * Almost all of the arithmetic already exists. Per layer, what survives is exactly what
 * compress keeps — `compressionPlan` — and what gets baked on top is that layer's level, EQ
 * and pan. Bounce is compress applied to every layer at once, plus a mix.
 *
 * Nothing here renders audio. It decides what goes into the mixdown and what the new project
 * looks like; the audio layer does the summing.
 */

export type { BackingMixSource } from './backing.ts';

/**
 * §2.6's export rule: *what you hear is what you export*. Used by **export**, for whether a
 * backing track writes a stem, and by the Playback rows for whether one reads as audible.
 *
 * **Not by bounce.** A bounce mixes the layers only (§2.7), so a backing track's mute has no
 * bearing on it either way.
 *
 * A muted *layer* is a performance the user made and is not using right now, so it still exports
 * as a stem. A muted *backing track* is a decision that the sketch does not have one.
 */
export function isAudibleInMixdown(track: { readonly muted: boolean }): boolean {
  return !track.muted;
}

/** One layer's contribution: the bars to read, and the processing to bake onto them. */
export type MixSource = {
  readonly layerIndex: number;
  readonly bars: readonly RetainedBar[];
  /** Linear gain, baked in — the new project's layer 1 has no separate level to inherit. */
  readonly gain: number;
  readonly eq: readonly EqBand[];
  readonly pan: PanPlan;
};

export type BouncePlan = {
  /** The mixdown is exactly one loop, which is what makes it Pass 1 of the new project. */
  readonly frameCount: number;
  readonly layers: readonly MixSource[];
  /**
   * Frames of delay tail that must **wrap to the start of the loop** rather than being
   * truncated (§2.8).
   *
   * Live, a Surround layer's delayed copy of the last bar simply runs past the loop point and
   * the delay line keeps going. A bounce renders a fixed-length file, so that tail has
   * nowhere to go — truncate it and the bounced project has a seam at the loop point that the
   * original never had. Zero when no audible layer uses Surround.
   */
  readonly tailFrames: number;
};

function contributes(bars: readonly RetainedBar[]): boolean {
  return bars.some((bar) => bar.kind === 'audio');
}

/**
 * What the mixdown is made of, or undefined if it should not be offered.
 *
 * **The layers only — the backing tracks are not in a bounce** (§2.7). Their settings carry to
 * the seeded project instead (`bounceSeed`), so the drums and the bed come across live and still
 * editable rather than baked into layer 1. Baking them *and* carrying them would play the drums
 * twice; baking without carrying would freeze a groove §1.2 says never locks.
 *
 * **`MixSource` is the domain's account of what goes in, not a rendering recipe the browser
 * follows.** `ui/` renders a bounce through the same engine that plays the project, because a
 * second rendering path is a second set of decisions about crossfades, splices and pan law. A
 * platform without that option has everything it needs here.
 *
 * Refused in two cases. A slot pointing at audio that does not exist means the project is in
 * a broken state, and baking a hole into the seed is not a repair — the same reason compress
 * refuses, even though bounce leaves the original intact. And a mixdown with nothing audible
 * in it would seed a project with a loop of silence, which is worse than declining.
 */
export function bouncePlan(project: Project): BouncePlan | undefined {
  const t = projectTiming(project);
  const layers: MixSource[] = [];

  for (const layer of project.layers) {
    if (layer.muted || layer.sessions.length === 0) continue;

    const plan = compressionPlan(layer.barSources, layerPassIndex(layer, t), layer.mutedSlots);
    if (!plan) return undefined;
    if (!contributes(plan.bars)) continue;

    const pan = panPlan(panPreset(layer.pan), t);

    layers.push({
      layerIndex: layer.index,
      bars: plan.bars,
      gain: layer.level,
      eq: eqPreset(layer.eq).bands,
      pan,
    });
  }

  if (layers.length === 0) return undefined;

  return {
    frameCount: loopFrames(t),
    layers,
    // Through `loopTailFrames` so bounce and export cannot disagree about what is still
    // sounding. No backing argument: a bounce does not contain it (§2.7).
    tailFrames: loopTailFrames(project.layers, t),
  };
}

/**
 * The project the mixdown seeds, given the rendered file (§2.7).
 *
 * **The original is untouched** — nothing here reads back into `source` beyond copying its
 * configuration, which is the whole reason bounce makes a new project rather than collapsing
 * layers in place (§5.2): nothing is destroyed, no partially-editable layer state has to exist
 * inside a project, and the seven-layer ceiling becomes a stage rather than a wall.
 *
 * **Quality carries from the source, and that is forced rather than chosen.** §2.7's bounce
 * list names BPM and bar count but omits it; the mixdown is a sum of the source's layers and
 * therefore sits at the source's sample rate, so seeding a project at any other rate would need
 * a resample at every splice — precisely what snapshotting quality at creation exists to prevent.
 *
 * **The backing carries across verbatim, mute flags included** (§2.7). It is not in the mixdown,
 * so there is no double-tracking to avoid, and copying it whole means the new sketch opens on the
 * groove the old one was played against — still live, still editable, never frozen into layer 1
 * (§1.2). Carried even when a track is muted: that is the user's setting, and the new project is
 * the place to change it.
 *
 * **`isCompressed` is false.** The flag means this project's recorded passes were discarded;
 * a new project never had any, so the label would be a lie in the Library.
 *
 * Layer 1 is filled through `recordSession` rather than by hand: the mixdown is exactly one
 * loop, so it is exactly Pass 1, and the arrangement it should start with is the ordinary
 * first-pass one (§1.6). Bounce needs no arrangement logic of its own.
 */
export function bounceSeed(
  source: Project,
  session: RecordingSession,
  options: { id: string; name: string; now?: string },
): Project {
  const seeded = createProject({
    id: options.id,
    name: options.name,
    bpm: source.bpm,
    barCount: source.barCount,
    beatsPerBar: source.beatsPerBar,
    quality: source.audioQuality,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const first = recordSession(emptyLayer(0), session, projectTiming(seeded));
  const layers: Layer[] = [
    first,
    ...Array.from({ length: LAYER_COUNT - 1 }, (_, i) => emptyLayer(i + 1)),
  ];

  return { ...seeded, bouncedFromProjectId: source.id, backing: source.backing, layers };
}

/**
 * What a bounce is called (§2.7).
 *
 * **The name carries the provenance, not a badge.** A bounced project used to wear a `Bounced`
 * tag on its Library row, which said the right thing and could not be argued with — the user had
 * no way to rename, qualify or dismiss it. A suffix says the same thing in a place they own: keep
 * it, reword it, or delete it once the sketch has become its own piece.
 *
 * `bouncedFromProjectId` still records the source. That is a fact about the project rather than a
 * label, and nothing renders it.
 *
 * **It does not stack.** Bouncing a bounce is a new generation, but the suffix only has one thing
 * to say — that this started as a mixdown — and saying it twice only spends a name that is short
 * to begin with.
 */
export const BOUNCE_SUFFIX = ' (Bounce)';

export function bouncedName(sourceName: string): string {
  const name = sourceName.trim();
  return name.endsWith(BOUNCE_SUFFIX) ? name : `${name}${BOUNCE_SUFFIX}`;
}
