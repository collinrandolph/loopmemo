import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { setSlot, setSlotMuted } from '../src/domain/arrangement.ts';
import { barRef } from '../src/domain/bar-ref.ts';
import {
  type BackingMixSource,
  bouncePlan,
  bounceSeed,
  isAudibleInMixdown,
} from '../src/domain/bounce.ts';
import { haasDelayFrames } from '../src/domain/effects.ts';
import { eqPreset } from '../src/domain/eq.ts';
import { totalPasses, passIndex } from '../src/domain/pass-index.ts';
import {
  type Layer,
  type Project,
  createProject,
  isConfigurationLocked,
  layerPassIndex,
  projectTiming,
  recordSession,
} from '../src/domain/project.ts';
import { loopFrames } from '../src/domain/timing.ts';
import { FPB, LOOP, T, session } from './fixtures.ts';

function project(): Project {
  return createProject({
    id: 'src',
    name: 'Sketch',
    bpm: 96,
    barCount: 16,
    quality: 'standard',
    now: '2026-08-30T00:00:00.000Z',
  });
}

/** Give `count` layers one full pass each. */
function withLayers(p: Project, count: number, edit?: (l: Layer, i: number) => Layer): Project {
  const t = projectTiming(p);
  const layers = p.layers.map((layer, i) => {
    if (i >= count) return layer;
    const recorded = recordSession(layer, session(LOOP, `s${i}`), t);
    return edit ? edit(recorded, i) : recorded;
  });
  return { ...p, layers };
}

const ref = (over: Partial<BackingMixSource> = {}): BackingMixSource => ({
  id: 'drums',
  label: 'Drums',
  muted: false,
  level: 1,
  ...over,
});

describe('the mixdown rule (§2.6)', () => {
  it('includes anything not muted', () => {
    assert.equal(isAudibleInMixdown(ref()), true);
    assert.equal(isAudibleInMixdown(ref({ muted: true })), false, 'mute is how you exclude');
  });

  it('carries audible backing tracks into the plan', () => {
    const plan = bouncePlan(withLayers(project(), 2), [ref(), ref({ id: 'chords', muted: true })]);
    assert.deepEqual(plan?.backing.map((r: BackingMixSource) => r.id), ['drums']);
  });
});

describe('bouncePlan', () => {
  it('takes one contribution per audible layer', () => {
    const plan = bouncePlan(withLayers(project(), 3));
    assert.deepEqual(plan?.layers.map((l) => l.layerIndex), [0, 1, 2]);
    assert.equal(plan?.frameCount, loopFrames(T), 'exactly one loop');
  });

  it('leaves out a muted layer, because the mixdown is what was audible', () => {
    const p = withLayers(project(), 3, (l, i) => (i === 1 ? { ...l, muted: true } : l));
    assert.deepEqual(bouncePlan(p)?.layers.map((l) => l.layerIndex), [0, 2]);
  });

  it('leaves out an empty layer without treating it as an error', () => {
    assert.equal(bouncePlan(withLayers(project(), 2))?.layers.length, 2);
  });

  it('leaves out a layer whose every slot is muted', () => {
    // Its bars are all silence, so it contributes nothing but would still count as a source
    // and let an otherwise-silent bounce through.
    const p = withLayers(project(), 2, (l, i) => {
      if (i !== 1) return l;
      let muted = l.mutedSlots;
      for (let s = 0; s < 16; s++) muted = setSlotMuted(muted, s, true);
      return { ...l, mutedSlots: muted };
    });
    assert.deepEqual(bouncePlan(p)?.layers.map((l) => l.layerIndex), [0]);
  });

  it('bakes each layer’s level, EQ and pan', () => {
    const p = withLayers(project(), 1, (l) => ({ ...l, level: 0.5, eq: 'scoop', pan: 'wideR' }));
    const src = bouncePlan(p)?.layers[0];

    assert.equal(src?.gain, 0.5);
    assert.deepEqual(src?.eq, eqPreset('scoop').bands);
    assert.ok(Math.abs(src!.pan.dry.left) < 1e-12, 'hard right, so nothing on the left');
    assert.ok(Math.abs(src!.pan.dry.right - 1) < 1e-12);
  });

  it('keeps a muted slot as a silent bar, not a shorter loop', () => {
    const p = withLayers(project(), 1, (l) => ({ ...l, mutedSlots: setSlotMuted([], 3, true) }));
    const bars = bouncePlan(p)?.layers[0]?.bars;

    assert.equal(bars?.length, 16, 'a rest is still a bar');
    assert.equal(bars?.[3]?.kind, 'silence');
    assert.equal(
      bars?.reduce((sum, b) => sum + b.frameCount, 0),
      loopFrames(T),
      'the mixdown is still exactly one loop long',
    );
  });

  describe('the Surround tail', () => {
    it('reports the frames that must wrap', () => {
      const p = withLayers(project(), 2, (l, i) => (i === 1 ? { ...l, pan: 'surround' } : l));
      assert.equal(bouncePlan(p)?.tailFrames, haasDelayFrames(T));
    });

    it('is zero when nothing uses the delay', () => {
      assert.equal(bouncePlan(withLayers(project(), 3))?.tailFrames, 0);
    });

    it('is zero when the only Surround layer is muted', () => {
      const p = withLayers(project(), 2, (l, i) =>
        i === 1 ? { ...l, pan: 'surround', muted: true } : l,
      );
      assert.equal(bouncePlan(p)?.tailFrames, 0);
    });
  });

  describe('refusing', () => {
    it('refuses when a slot points at audio that does not exist', () => {
      // Same reason compress refuses. The original survives, but baking a hole into the seed
      // is not a repair.
      const p = withLayers(project(), 1, (l) => ({
        ...l,
        barSources: setSlot(l.barSources, 5, barRef(9, 3)),
      }));
      assert.equal(bouncePlan(p), undefined);
    });

    it('refuses a project with nothing recorded', () => {
      assert.equal(bouncePlan(project()), undefined);
    });

    it('refuses when every layer is muted and no reference is audible', () => {
      const p = withLayers(project(), 3, (l) => ({ ...l, muted: true }));
      assert.equal(bouncePlan(p), undefined);
      assert.equal(bouncePlan(p, [ref({ muted: true })]), undefined);
    });

    it('allows a reference-only mixdown', () => {
      // Every layer muted but the drum loop audible is still something to hear.
      const p = withLayers(project(), 2, (l) => ({ ...l, muted: true }));
      assert.deepEqual(bouncePlan(p, [ref()])?.layers, []);
      assert.equal(bouncePlan(p, [ref()])?.backing.length, 1);
    });
  });
});

describe('bounceSeed', () => {
  const source = withLayers(project(), 3, (l, i) => ({ ...l, level: 0.4, eq: 'scoop', muted: i === 2 }));
  const mixdown = session(LOOP, 'mix');
  const seed = bounceSeed(source, mixdown, { id: 'new', name: 'Sketch 2' });

  it('carries the grid, so the arrangement still lines up', () => {
    assert.equal(seed.bpm, source.bpm);
    assert.equal(seed.barCount, source.barCount);
    assert.equal(seed.beatsPerBar, source.beatsPerBar);
  });

  it('carries the quality, which is forced rather than chosen', () => {
    // The mixdown is a sum of the source's layers and sits at its sample rate. Seeding at any
    // other rate would need a resample at every splice — what the snapshot exists to prevent.
    assert.equal(seed.audioQuality, source.audioQuality);
    assert.equal(projectTiming(seed).sampleRate, projectTiming(source).sampleRate);
  });

  it('makes the mixdown layer 1, as Pass 1', () => {
    const layer = seed.layers[0]!;
    assert.equal(layer.sessions.length, 1);
    assert.equal(totalPasses(layerPassIndex(layer, projectTiming(seed))), 1);
    assert.deepEqual(layer.barSources[0], barRef(1, 1));
    assert.equal(layer.barSources.length, 16, 'a full arrangement, in recorded order');
    assert.deepEqual(layer.mutedSlots, [], 'nothing muted — the mix is what it is');
  });

  it('starts layer 1 neutral, because the processing is already in the audio', () => {
    assert.equal(seed.layers[0]?.level, 1);
    assert.equal(seed.layers[0]?.eq, 'flat');
    assert.equal(seed.layers[0]?.pan, 'center');
    assert.equal(seed.layers[0]?.muted, false);
  });

  it('leaves layers 2–7 empty and available', () => {
    assert.equal(seed.layers.length, 7);
    for (const layer of seed.layers.slice(1)) {
      assert.deepEqual(layer.sessions, []);
      assert.deepEqual(layer.barSources, []);
    }
  });

  it('records where it came from, and is not marked compressed', () => {
    // The flag means this project's recorded passes were discarded; a new project never had
    // any, so the Library label would be a lie.
    assert.equal(seed.bouncedFromProjectId, 'src');
    assert.equal(seed.isCompressed, false);
  });

  it('leaves the original untouched', () => {
    assert.equal(source.layers[0]?.sessions.length, 1);
    assert.equal(source.layers[0]?.level, 0.4);
    assert.equal(source.bouncedFromProjectId, undefined);
  });

  it('is immediately recordable, and already configuration-locked', () => {
    // Layer 1 holds a pass, so BPM and bar count are fixed — as they must be, since the
    // mixdown's bar boundaries were cut at the source's tempo (§4.5).
    assert.equal(isConfigurationLocked(seed), true);
  });

  it('can be bounced again', () => {
    const twice = bounceSeed(seed, session(LOOP, 'mix2'), { id: 'newer', name: 'Sketch 3' });
    assert.equal(twice.bouncedFromProjectId, 'new');
    assert.ok(bouncePlan(seed));
  });

  it('treats a mixdown shorter than a loop the way any recording is treated', () => {
    // Not a special case: the pass gate applies, so a truncated render simply yields a layer
    // with fewer usable bars rather than a silently wrong arrangement.
    const short = bounceSeed(source, session(9 * FPB, 'short'), { id: 'x', name: 'x' });
    const index = passIndex(short.layers[0]!.sessions, projectTiming(short));
    assert.equal(totalPasses(index), 1);
    assert.ok(short.layers[0]!.mutedSlots.length > 0, 'the bars with no audio start muted');
  });
});
