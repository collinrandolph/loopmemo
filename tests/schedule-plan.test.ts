import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NONE_MUTED, recordedOrder, setSlot } from '../src/domain/arrangement.ts';
import { barRef } from '../src/domain/bar-ref.ts';
import { segments, splice } from '../src/domain/schedule-plan.ts';
import { FPB, LOOP, specIndex } from './fixtures.ts';

const CROSSFADE = 441; // 10 ms at 44.1 kHz

describe('SchedulePlan', () => {
  describe('segments', () => {
    it('walks the arrangement contiguously from the anchor', () => {
      const plan = segments(recordedOrder(16), specIndex(), 0, 4, NONE_MUTED);
      assert.deepEqual(
        plan.map((s) => s.slot),
        [0, 1, 2, 3],
      );
      assert.deepEqual(
        plan.map((s) => s.startFrame),
        [0, FPB, 2 * FPB, 3 * FPB],
      );
    });

    it('keeps slot and source independent', () => {
      // §1.1: playback progress indexes on the slot, colour on the source. A reordered
      // arrangement keeps the slot ascending while the source jumps.
      const arrangement = setSlot(recordedOrder(16), 0, barRef(2, 9));
      const [first] = segments(arrangement, specIndex(), 0, 1, NONE_MUTED);

      assert.equal(first?.slot, 0);
      assert.equal(first?.startFrame, 0, 'slot 0 always starts at the anchor');
      assert.deepEqual(first?.source, barRef(2, 9));
      assert.equal(first?.region.startFrame, LOOP + 8 * FPB, 'but reads pass 2’s bar 9');
    });

    it('wraps around the arrangement while time keeps moving forward', () => {
      const plan = segments(recordedOrder(16), specIndex(), 14, 4, NONE_MUTED);
      assert.deepEqual(
        plan.map((s) => s.slot),
        [14, 15, 0, 1],
      );
      // startFrame does not reset at the wrap; the engine schedules forward in time.
      assert.deepEqual(
        plan.map((s) => s.startFrame),
        [14 * FPB, 15 * FPB, 16 * FPB, 17 * FPB],
      );
    });

    it('skips a slot pointing at unrecorded audio rather than silencing it', () => {
      const arrangement = setSlot(recordedOrder(16), 2, barRef(3, 12)); // in the gap
      const plan = segments(arrangement, specIndex(), 0, 4, NONE_MUTED);
      assert.deepEqual(
        plan.map((s) => s.slot),
        [0, 1, 3],
      );
    });

    it('schedules nothing for an empty arrangement or a non-positive horizon', () => {
      assert.deepEqual(segments([], specIndex(), 0, 4, NONE_MUTED), []);
      assert.deepEqual(segments(recordedOrder(16), specIndex(), 0, 0, NONE_MUTED), []);
    });
  });

  describe('mid-bar splice', () => {
    it('enters the new source at the same offset', () => {
      // Two beats into bar 5 becomes two beats into pass 2's bar 5 (§2.5).
      const twoBeats = FPB / 2;
      const region = splice(barRef(2, 5), specIndex(), twoBeats, CROSSFADE);

      assert.equal(region?.startFrame, LOOP + 4 * FPB + twoBeats);
      assert.equal(region?.frameCount, FPB - twoBeats);
    });

    it('is the whole bar at the downbeat', () => {
      assert.deepEqual(splice(barRef(1, 1), specIndex(), 0, CROSSFADE), {
        sessionIndex: 0,
        startFrame: 0,
        frameCount: FPB,
      });
    });

    it('refuses inside the tail guard', () => {
      // §2.5: a swipe within ~15 ms of the end would splice into a region shorter than
      // the crossfade. Skip it and let the natural boundary handle it.
      assert.equal(splice(barRef(2, 5), specIndex(), FPB - 100, CROSSFADE), undefined);
      assert.equal(splice(barRef(2, 5), specIndex(), FPB - CROSSFADE, CROSSFADE), undefined);
    });

    it('refuses an offset outside the bar', () => {
      assert.equal(splice(barRef(2, 5), specIndex(), -1, CROSSFADE), undefined);
      assert.equal(splice(barRef(2, 5), specIndex(), FPB, CROSSFADE), undefined);
    });

    it('refuses to splice into unrecorded audio', () => {
      assert.equal(splice(barRef(3, 12), specIndex(), 1000, CROSSFADE), undefined);
    });

    it('respects a short final bar left by stop latency', () => {
      // The bar exists but is clamped; a splice near its end must not outrun it.
      const index = specIndex();
      const region = splice(barRef(5, 16), index, FPB - CROSSFADE - 1, CROSSFADE);
      assert.ok(region === undefined || region.frameCount > CROSSFADE);
    });
  });
});
