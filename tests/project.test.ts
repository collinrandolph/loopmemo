import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type Project,
  clearLayer,
  createProject,
  isConfigurationLocked,
  nextPassNumber,
  projectTiming,
  projectTotalPasses,
  recordedLayerCount,
  sizeProjection,
} from '../src/domain/project.ts';
import { LOOP, session } from './fixtures.ts';

function project(overrides: Partial<Parameters<typeof createProject>[0]> = {}): Project {
  return createProject({
    id: 'p1',
    name: 'test',
    bpm: 96,
    barCount: 16,
    quality: 'high',
    now: '2026-08-29T00:00:00.000Z',
    ...overrides,
  });
}

/** Give `count` layers one session each, of `passes` full passes. */
function withRecordings(base: Project, count: number, passes: number): Project {
  const layers = base.layers.map((layer, i) =>
    i < count ? { ...layer, sessions: [session(passes * LOOP, `s${i}`)] } : layer,
  );
  return { ...base, layers };
}

describe('Project', () => {
  it('has exactly seven layers', () => {
    // §5.1 #6: not "7+". The row stack has no defined behaviour otherwise.
    assert.equal(project().layers.length, 7);
  });

  it('rejects configuration outside the spec’s ranges', () => {
    assert.throws(() => project({ bpm: 59 }), RangeError);
    assert.throws(() => project({ bpm: 241 }), RangeError);
    assert.throws(() => project({ barCount: 6 }), RangeError);
    assert.throws(() => project({ barCount: 36 }), RangeError);
  });

  it('accepts every valid bar count', () => {
    for (const barCount of [4, 8, 12, 16, 20, 24, 28, 32]) {
      assert.equal(project({ barCount }).barCount, barCount);
    }
  });

  it('locks configuration once anything is recorded', () => {
    // §5.1 #4: every derived value depends on bpm and bar count.
    const empty = project();
    assert.equal(isConfigurationLocked(empty), false);
    assert.equal(isConfigurationLocked(withRecordings(empty, 1, 1)), true);
  });

  describe('pass counting', () => {
    it('sums across layers rather than taking the maximum', () => {
      // §2.7's table — 5 layers, 12 passes — only holds if this is the total. Taking the
      // max would report 3 here and understate the size by a factor of four.
      const p = withRecordings(project(), 4, 3);
      assert.equal(projectTotalPasses(p), 12);
      assert.equal(recordedLayerCount(p), 4);
    });

    it('names the pass about to be captured', () => {
      const t = projectTiming(project());
      const p = withRecordings(project(), 1, 2);
      assert.equal(nextPassNumber(p.layers[0]!, t), 3, 'two passes recorded, next is 3');
      assert.equal(nextPassNumber(p.layers[1]!, t), 1, 'empty layer starts at Pass 1');
    });
  });

  describe('size projection', () => {
    it('matches the spec’s worked example', () => {
      // §2.7: 16 bars @ 96 BPM, 40 s loop, 5 layers, 12 passes, 24-bit/48k
      //   uncompressed = 12 × 40 × 144000 = 69,120,000 B  (66 MiB, as the table reads)
      //   compressed   =  5 × 40 × 144000 = 28,800,000 B  (27 MiB)
      const layers = project().layers.map((layer, i) => {
        if (i >= 5) return layer;
        // 12 passes over 5 layers: 3,3,2,2,2
        const passes = i < 2 ? 3 : 2;
        return { ...layer, sessions: [session(passes * LOOP, `s${i}`)] };
      });
      const p: Project = { ...project(), layers };

      assert.equal(projectTotalPasses(p), 12);
      const size = sizeProjection(p);
      assert.equal(size.uncompressedBytes, 69_120_000);
      assert.equal(size.compressedBytes, 28_800_000);
      assert.equal(Math.round(size.uncompressedBytes / 1024 / 1024), 66);
      assert.equal(Math.round(size.compressedBytes / 1024 / 1024), 27);
    });

    it('says plainly when compression would not help', () => {
      // "Sometimes the honest answer is 'this won't help.'" (§2.7)
      const p = withRecordings(project(), 3, 1);
      const size = sizeProjection(p);
      assert.equal(size.savingBytes, 0);
      assert.equal(size.isWorthCompressing, false);
    });

    it('is driven by pass count, not layer count', () => {
      // §2.7: "A 5-layer project with 12 passes costs more than a 7-layer project with 7."
      const fiveLayersTwelvePasses = sizeProjection(withRecordings(project(), 4, 3));
      const sevenLayersSevenPasses = sizeProjection(withRecordings(project(), 7, 1));
      assert.ok(
        fiveLayersTwelvePasses.uncompressedBytes > sevenLayersSevenPasses.uncompressedBytes,
      );
    });
  });

  it('clears a layer without touching its neighbours', () => {
    // §5.1 #2: clearing a layer is self-contained; no other layer references its passes.
    const p = withRecordings(project(), 2, 2);
    const cleared = clearLayer(p.layers[0]!);
    assert.deepEqual(cleared.sessions, []);
    assert.deepEqual(cleared.barSources, []);
    assert.equal(p.layers[1]!.sessions.length, 1);
  });
});
