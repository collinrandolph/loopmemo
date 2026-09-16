import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { migrateProject } from '../src/domain/migrate.ts';
import {
  createProject,
  projectTiming,
  projectTotalPasses,
  recordSession,
  sizeProjection,
} from '../src/domain/project.ts';
import { loopFrames } from '../src/domain/timing.ts';
import { session } from './fixtures.ts';

function current() {
  const p = createProject({ id: 'p', name: 'Now', bpm: 96, barCount: 8, quality: 'high' });
  const t = projectTiming(p);
  const layer = recordSession(p.layers[2]!, session(loopFrames(t) * 2, 'take'), t);
  return {
    ...p,
    bouncedFromProjectId: 'older',
    latencyOffsetSeconds: 0.04,
    perfectLoop: false,
    layers: p.layers.map((l) => (l.index === 2 ? { ...layer, level: 1.6, muted: true, eq: 'scoop', pan: 'surround', mutedSlots: [3] } : l)),
  } as ReturnType<typeof createProject>;
}

describe('migrateProject', () => {
  it('leaves a project saved today exactly as it was', () => {
    // The failure this guards is a default overwriting a real value — `false` read as missing.
    const p = current();
    assert.deepEqual(migrateProject(JSON.parse(JSON.stringify(p))), p);
  });

  it('keeps an absent optional field absent', () => {
    const { bouncedFromProjectId: _, ...plain } = current();
    const migrated = migrateProject(plain);
    assert.equal('bouncedFromProjectId' in migrated, false);
  });

  it('defaults perfectLoop to on, not to undefined-as-off', () => {
    const { perfectLoop: _, ...old } = current();
    assert.equal(migrateProject(old).perfectLoop, true);
  });

  it('a session missing recordedFrames holds no passes rather than NaN of them', () => {
    const p = current();
    const broken = JSON.parse(JSON.stringify(p));
    delete broken.layers[2].sessions[0].recordedFrames;
    const migrated = migrateProject(broken);
    assert.equal(projectTotalPasses(migrated), 0);
    assert.ok(Number.isFinite(sizeProjection(migrated).uncompressedBytes));
  });

  it('fills a backing track the project predates from the defaults, field by field', () => {
    const p = current();
    const old = JSON.parse(JSON.stringify(p));
    delete old.backing.chords;
    delete old.backing.drums.kitId;
    old.backing.drums.patternId = 'four-on-the-floor';
    const migrated = migrateProject(old);
    assert.equal(migrated.backing.drums.patternId, 'four-on-the-floor', 'what was stored survives');
    assert.equal(migrated.backing.drums.kitId, p.backing.drums.kitId, 'what was missing is defaulted');
    assert.deepEqual(migrated.backing.chords, p.backing.chords);
  });

  it('always hands back exactly four chord slots', () => {
    const old = JSON.parse(JSON.stringify(current()));
    old.backing.chords.slots = [{ letter: 'D', accidental: 'natural', quality: 'minor' }];
    const slots = migrateProject(old).backing.chords.slots;
    assert.equal(slots.length, 4);
    assert.equal(slots[0]!.letter, 'D');
  });

  it('layer fields a stored layer predates come back neutral', () => {
    const old = JSON.parse(JSON.stringify(current()));
    for (const key of ['level', 'muted', 'eq', 'pan', 'mutedSlots']) delete old.layers[0][key];
    const layer = migrateProject(old).layers[0]!;
    assert.deepEqual(
      { level: layer.level, muted: layer.muted, eq: layer.eq, pan: layer.pan, mutedSlots: layer.mutedSlots },
      { level: 1, muted: false, eq: 'flat', pan: 'center', mutedSlots: [] },
    );
  });
});
