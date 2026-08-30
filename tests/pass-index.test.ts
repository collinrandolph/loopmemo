import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { barRef } from '../src/domain/bar-ref.ts';
import {
  availablePasses,
  hasAudio,
  passIndex,
  regionFor,
  steppingPass,
  totalPasses,
} from '../src/domain/pass-index.ts';
import { FPB, LOOP, T, session, singlePassIndex, specIndex } from './fixtures.ts';

describe('PassIndex', () => {
  it('numbers passes by session order, partials included', () => {
    const index = specIndex();
    assert.equal(totalPasses(index), 5);
    assert.deepEqual(index.firstPass, [1, 4]);
  });

  it('reports nothing for an empty layer', () => {
    const index = passIndex([], T);
    assert.equal(totalPasses(index), 0);
    assert.deepEqual(availablePasses(index, 1), []);
    assert.equal(regionFor(index, barRef(1, 1)), undefined);
  });

  describe('availability is per bar position and can be non-contiguous', () => {
    it('gives early bars every pass', () => {
      assert.deepEqual(availablePasses(specIndex(), 1), [1, 2, 3, 4, 5]);
      assert.deepEqual(availablePasses(specIndex(), 8), [1, 2, 3, 4, 5]);
    });

    it('leaves a gap in late bars where the session stopped', () => {
      assert.deepEqual(availablePasses(specIndex(), 9), [1, 2, 4, 5]);
      assert.deepEqual(availablePasses(specIndex(), 16), [1, 2, 4, 5]);
    });
  });

  describe('region lookup', () => {
    // Pass numbers are global across a layer's sessions; frame offsets are session-local.
    // Deriving the offset from the absolute bar number across the whole layer asked for
    // frame 5,292,000 of a 3,528,000-frame file — 40 seconds past the end, returning
    // silent garbage rather than crashing.
    it('resolves a pass in a later session to that session’s own frame zero', () => {
      assert.deepEqual(regionFor(specIndex(), barRef(4, 1)), {
        sessionIndex: 1,
        startFrame: 0,
        frameCount: FPB,
      });
    });

    it('never reads past the end of the session it landed in', () => {
      const index = specIndex();
      for (let pass = 1; pass <= 6; pass++) {
        for (let bar = 1; bar <= 16; bar++) {
          const region = regionFor(index, barRef(pass, bar));
          if (!region) continue;
          const length = index.sessions[region.sessionIndex]!.recordedFrames;
          assert.ok(
            region.startFrame + region.frameCount <= length,
            `P${pass}/${bar} reads past the end of session ${region.sessionIndex}`,
          );
        }
      }
    });

    it('resolves the partial pass for early bars', () => {
      assert.deepEqual(regionFor(specIndex(), barRef(3, 1)), {
        sessionIndex: 0,
        startFrame: 2 * LOOP,
        frameCount: FPB,
      });
    });

    it('returns nothing for the gap, or for a pass past the end', () => {
      assert.equal(regionFor(specIndex(), barRef(3, 9)), undefined);
      assert.equal(hasAudio(specIndex(), barRef(3, 16)), false);
      assert.equal(regionFor(specIndex(), barRef(6, 1)), undefined);
    });

    it('resolves the last bar of the last pass', () => {
      assert.deepEqual(regionFor(specIndex(), barRef(5, 16)), {
        sessionIndex: 1,
        startFrame: LOOP + 15 * FPB,
        frameCount: FPB,
      });
    });
  });

  describe('stop latency', () => {
    it('keeps a pass that stopped just short, clamped to what exists', () => {
      const index = passIndex([session(2 * LOOP - 100)], T);
      assert.ok(availablePasses(index, 16).includes(2), 'stop latency lost a completed pass');
      assert.equal(regionFor(index, barRef(2, 16))?.frameCount, FPB - 100);
    });

    it('admits a bar that stopped well short, because its audio is real', () => {
      // 40 ms short of completing bar 16. §1.4's original formula dropped this bar; it now
      // stands as an ordinary bar that runs 40 ms short, with nothing padded to fill it.
      const index = passIndex([session(2 * LOOP - 1764)], T);
      assert.equal(availablePasses(index, 16).includes(2), true);
      assert.equal(regionFor(index, barRef(2, 16))?.frameCount, FPB - 1764);
    });

    it('still discards the crumb an overrun leaves behind', () => {
      // The guard the old tolerance provided, in its new place. Stopping a few frames past
      // the loop point must not become a bar — and through passCount, a whole pass.
      const index = passIndex([session(2 * LOOP + 100)], T);
      assert.equal(availablePasses(index, 1).includes(3), false);
      assert.equal(totalPasses(index), 2);
    });
  });

  describe('vertical stepping wraps through the available set', () => {
    it('skips the gap', () => {
      assert.equal(steppingPass(specIndex(), barRef(2, 9), 1)?.pass, 4);
    });

    it('wraps at both ends', () => {
      assert.equal(steppingPass(specIndex(), barRef(5, 9), 1)?.pass, 1);
      assert.equal(steppingPass(specIndex(), barRef(1, 9), -1)?.pass, 5);
    });

    it('is contiguous where the audio is', () => {
      assert.equal(steppingPass(specIndex(), barRef(2, 1), 1)?.pass, 3);
    });

    it('never leaves its own bar', () => {
      assert.equal(steppingPass(specIndex(), barRef(2, 9), 1)?.relativeBar, 9);
    });

    it('stays put when only one pass is available', () => {
      assert.deepEqual(steppingPass(singlePassIndex(), barRef(1, 4), 1), barRef(1, 4));
    });

    it('gives nothing when the bar has no audio at all', () => {
      assert.equal(steppingPass(passIndex([], T), barRef(1, 1), 1), undefined);
    });
  });
});
