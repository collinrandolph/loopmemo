import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { setSlot, setSlotMuted } from '../src/domain/arrangement.ts';
import { barRef } from '../src/domain/bar-ref.ts';
import {
  type Project,
  compressedProject,
  createProject,
  layerHasRecording,
  projectCompressionPlan,
  projectTiming,
  projectTotalPasses,
  recordSession,
  recordedLayerCount,
  sizeProjection,
} from '../src/domain/project.ts';
import { LOOP, session } from './fixtures.ts';

function project(): Project {
  return createProject({
    id: 'p1',
    name: 'test',
    bpm: 96,
    barCount: 16,
    quality: 'standard',
    now: '2026-08-29T00:00:00.000Z',
  });
}

/** `count` layers, each holding `passes` complete passes in one session. */
function recorded(base: Project, count: number, passes: number): Project {
  const t = projectTiming(base);
  const layers = base.layers.map((layer, i) =>
    i < count ? recordSession(layer, session(passes * LOOP, `s${i}`), t) : layer,
  );
  return { ...base, layers };
}

const oneLoop = (layerIndex: number) => session(LOOP, `c${layerIndex}`);

describe('projectCompressionPlan', () => {
  it('plans one entry per recorded layer, and skips the empty ones', () => {
    // An empty layer has nothing to discard. Refusing on its account would make compress
    // impossible on every project that is not fully tracked, which is most of them.
    const p = recorded(project(), 3, 2);
    const plan = projectCompressionPlan(p);
    assert.ok(plan);
    assert.deepEqual(
      plan.layers.map((l) => l.layerIndex),
      [0, 1, 2],
    );
  });

  it('keeps every slot, so a compressed loop is still barCount long', () => {
    const p = recorded(project(), 1, 2);
    const plan = projectCompressionPlan(p)!;
    assert.equal(plan.layers[0]!.bars.length, 16);
  });

  it('carries the projection the confirmation has to state', () => {
    // §4.1: "214 MB → 26 MB". A projected saving is the entire reason to compress, so the
    // plan carries it rather than leaving the screen to recompute it a second way.
    const p = recorded(project(), 2, 3);
    const plan = projectCompressionPlan(p)!;
    assert.deepEqual(plan.projection, sizeProjection(p));
    assert.equal(plan.projection.isWorthCompressing, true);
  });

  it('refuses the whole project when one audible slot points at audio that is not there', () => {
    // Destructive and irreversible, so a half-compressed project is not an outcome worth
    // having. Same refusal as bounce, for the same reason.
    const p = recorded(project(), 2, 1);
    const broken = {
      ...p,
      layers: p.layers.map((l) =>
        l.index === 1 ? { ...l, barSources: setSlot(l.barSources, 4, barRef(9, 1)) } : l,
      ),
    };
    assert.equal(projectCompressionPlan(broken), undefined);
  });

  it('does not refuse when the missing audio is under a muted slot', () => {
    // It is about to be silence either way.
    const p = recorded(project(), 1, 1);
    const muted = {
      ...p,
      layers: p.layers.map((l) =>
        l.index === 0
          ? {
              ...l,
              barSources: setSlot(l.barSources, 4, barRef(9, 1)),
              mutedSlots: setSlotMuted(l.mutedSlots, 4, true),
            }
          : l,
      ),
    };
    assert.ok(projectCompressionPlan(muted));
  });
});

describe('compressedProject', () => {
  it('leaves every recorded layer holding exactly one pass', () => {
    const p = recorded(project(), 3, 4);
    assert.equal(projectTotalPasses(p), 12);
    const c = compressedProject(p, oneLoop, { now: '2026-08-30T00:00:00.000Z' });
    assert.equal(projectTotalPasses(c), 3);
    assert.equal(recordedLayerCount(c), 3);
  });

  it('reaches the size the projection promised', () => {
    // The two derivations have to agree, or the confirmation lied about the outcome.
    const p = recorded(project(), 3, 4);
    const before = sizeProjection(p);
    const c = compressedProject(p, oneLoop);
    assert.equal(sizeProjection(c).uncompressedBytes, before.compressedBytes);
  });

  it('renumbers to recorded order and spends the mute flags', () => {
    const p = recorded(project(), 1, 3);
    const edited = {
      ...p,
      layers: p.layers.map((l) =>
        l.index === 0
          ? {
              ...l,
              barSources: setSlot(l.barSources, 2, barRef(3, 11)),
              mutedSlots: setSlotMuted(l.mutedSlots, 5, true),
            }
          : l,
      ),
    };
    const c = compressedProject(edited, oneLoop);
    const layer = c.layers[0]!;
    assert.deepEqual(layer.barSources[2], barRef(1, 3));
    assert.deepEqual(layer.mutedSlots, []);
    // The flags are spent, not carried: the silence is in the audio now, and keeping them
    // would silence it twice and hide the take behind an unmute that can never come back.
    assert.equal(layer.barSources.length, 16);
  });

  it('marks the project compressed and touches lastModified', () => {
    const p = recorded(project(), 1, 2);
    const c = compressedProject(p, oneLoop, { now: '2026-08-30T12:00:00.000Z' });
    assert.equal(c.isCompressed, true);
    assert.equal(c.lastModified, '2026-08-30T12:00:00.000Z');
    assert.equal(c.createdDate, p.createdDate);
  });

  it('leaves empty layers untouched and still empty', () => {
    const p = recorded(project(), 2, 2);
    const c = compressedProject(p, oneLoop);
    for (const layer of c.layers.slice(2)) {
      assert.equal(layerHasRecording(layer), false);
      assert.equal(layer.sessions.length, 0);
    }
  });

  it('is idempotent — compressing twice changes nothing but the timestamp', () => {
    const p = recorded(project(), 3, 5);
    const once = compressedProject(p, oneLoop, { now: '2026-08-30T00:00:00.000Z' });
    const twice = compressedProject(once, oneLoop, { now: '2026-08-30T00:00:00.000Z' });
    assert.deepEqual(twice, once);
  });

  it('compresses a project that is already one pass per layer without breaking it', () => {
    // Nothing to save, and §2.7 says say so rather than refuse. The operation still has to be
    // safe if the user does it anyway.
    const p = recorded(project(), 2, 1);
    assert.equal(sizeProjection(p).isWorthCompressing, false);
    const c = compressedProject(p, oneLoop);
    assert.equal(projectTotalPasses(c), 2);
    assert.equal(sizeProjection(c).uncompressedBytes, sizeProjection(p).uncompressedBytes);
  });
});
