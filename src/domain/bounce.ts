import { type RetainedBar, compressionPlan } from './arrangement.ts';
import { type PanPlan, haasDelayFrames, panPlan, panPreset } from './effects.ts';
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

/**
 * Enough of a reference track to apply the mixdown rule to it.
 *
 * ⚠️ **Provisional.** §2.6's drum loop and chord bed are not modelled yet — no `originalBPM`,
 * no playback ratio, no chord settings — so this is the subset bounce needs rather than a
 * definition of what they are. When §2.6 is built this should be absorbed, not duplicated.
 */
export type ReferenceSource = {
  readonly id: string;
  readonly enabled: boolean;
  readonly muted: boolean;
  readonly level: number;
};

/**
 * §2.6's export rule: *what you hear is what you export*, and it applies identically to a
 * bounce mixdown. Any enabled track is included; to exclude one, mute it.
 *
 * Shared with export deliberately — two implementations of "was this audible" would let the
 * bounced mixdown and the exported file disagree about the same project.
 */
export function isAudibleInMixdown(track: {
  readonly enabled?: boolean;
  readonly muted: boolean;
}): boolean {
  return track.enabled !== false && !track.muted;
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
  readonly references: readonly ReferenceSource[];
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
 * Refused in two cases. A slot pointing at audio that does not exist means the project is in
 * a broken state, and baking a hole into the seed is not a repair — the same reason compress
 * refuses, even though bounce leaves the original intact. And a mixdown with nothing audible
 * in it would seed a project with a loop of silence, which is worse than declining.
 */
export function bouncePlan(
  project: Project,
  references: readonly ReferenceSource[] = [],
): BouncePlan | undefined {
  const t = projectTiming(project);
  const layers: MixSource[] = [];
  let usesDelay = false;

  for (const layer of project.layers) {
    if (layer.muted || layer.sessions.length === 0) continue;

    const plan = compressionPlan(layer.barSources, layerPassIndex(layer, t), layer.mutedSlots);
    if (!plan) return undefined;
    if (!contributes(plan.bars)) continue;

    const pan = panPlan(panPreset(layer.pan), t);
    if (pan.delay.wet.left > 0 || pan.delay.wet.right > 0) usesDelay = true;

    layers.push({
      layerIndex: layer.index,
      bars: plan.bars,
      gain: layer.level,
      eq: eqPreset(layer.eq).bands,
      pan,
    });
  }

  const audibleReferences = references.filter(isAudibleInMixdown);
  if (layers.length === 0 && audibleReferences.length === 0) return undefined;

  return {
    frameCount: loopFrames(t),
    layers,
    references: audibleReferences,
    tailFrames: usesDelay ? haasDelayFrames(t) : 0,
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
 * list names BPM, bar count and chord settings but omits it; the mixdown is a sum of the
 * source's layers and therefore sits at the source's sample rate, so seeding a project at any
 * other rate would need a resample at every splice — precisely what snapshotting quality at
 * creation exists to prevent.
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

  return { ...seeded, bouncedFromProjectId: source.id, layers };
}
