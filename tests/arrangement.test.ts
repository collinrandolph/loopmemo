import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compressionPlan,
  NONE_MUTED,
  isRecordedOrderAt,
  recordedOrder,
  setSlot,
  stepBarAt,
  stepPassAt,
  unresolvedSlots,
} from '../src/domain/arrangement.ts';
import { barRef } from '../src/domain/bar-ref.ts';
import { passIndex, regionFor } from '../src/domain/pass-index.ts';
import { framesPerBar } from '../src/domain/timing.ts';
import { FPB, T, session, singlePassIndex, specIndex } from './fixtures.ts';

describe('Arrangement', () => {
  it('starts in recorded order', () => {
    const arrangement = recordedOrder(4);
    assert.deepEqual(arrangement, [barRef(1, 1), barRef(1, 2), barRef(1, 3), barRef(1, 4)]);
    assert.ok(arrangement.every((_, slot) => isRecordedOrderAt(arrangement, slot)));
  });

  it('never mutates the array it was given', () => {
    const original = recordedOrder(16);
    const edited = setSlot(original, 3, barRef(2, 9));
    assert.deepEqual(original[3], barRef(1, 4), 'the original was mutated');
    assert.deepEqual(edited[3], barRef(2, 9));
  });

  it('rejects a slot outside the arrangement', () => {
    assert.throws(() => setSlot(recordedOrder(4), 4, barRef(1, 1)), RangeError);
    assert.throws(() => stepBarAt(recordedOrder(4), -1, 1, 4, NONE_MUTED), RangeError);
  });

  describe('vertical stepping', () => {
    it('changes only the pass, and only at that slot', () => {
      const before = recordedOrder(16);
      const after = stepPassAt(before, 8, 1, specIndex(), NONE_MUTED); // slot 8 holds P1/9

      assert.deepEqual(after[8], barRef(2, 9), 'bar 9 kept, pass stepped');
      assert.deepEqual(after.slice(0, 8), before.slice(0, 8));
      assert.deepEqual(after.slice(9), before.slice(9));
    });

    it('skips a gap in the available set', () => {
      // Bar 9 has passes 1, 2, -, 4, 5. Stepping from P2 lands on P4.
      const arrangement = setSlot(recordedOrder(16), 8, barRef(2, 9));
      assert.deepEqual(stepPassAt(arrangement, 8, 1, specIndex(), NONE_MUTED)[8], barRef(4, 9));
    });

    it('returns the same arrangement when there is nowhere to go', () => {
      // One available pass is the state that disables the axis entirely (§4.3), and it
      // is derived from audio rather than from a flag.
      const arrangement = recordedOrder(16);
      assert.equal(stepPassAt(arrangement, 0, 1, singlePassIndex(), NONE_MUTED), arrangement);
    });
  });

  describe('horizontal stepping', () => {
    it('changes only the bar, wrapping inside the pass', () => {
      const arrangement = setSlot(recordedOrder(16), 0, barRef(2, 16));
      const after = stepBarAt(arrangement, 0, 1, 16, NONE_MUTED);
      assert.deepEqual(after[0], barRef(2, 1), 'wrapped without touching the pass');
    });

    it('does not consult availability', () => {
      // The horizontal axis rearranges against whatever pass is selected; it is the
      // vertical axis that knows about gaps.
      const arrangement = setSlot(recordedOrder(16), 0, barRef(3, 1));
      assert.deepEqual(stepBarAt(arrangement, 0, 11, 16, NONE_MUTED)[0], barRef(3, 12));
    });
  });

  describe('unresolvedSlots', () => {
    it('is empty for an arrangement the swipes produced', () => {
      assert.deepEqual(unresolvedSlots(recordedOrder(16), specIndex()), []);
    });

    it('names the slots pointing at audio that does not exist', () => {
      const arrangement = setSlot(recordedOrder(16), 5, barRef(3, 12)); // in the gap
      assert.deepEqual(unresolvedSlots(arrangement, specIndex()), [5]);
    });
  });

  describe('compressionPlan', () => {
    it('keeps the arranged audio and renumbers to recorded order', () => {
      // §2.7: the retained loop is standardised to Pass 1 and bars are renumbered to the
      // arranged order, because the original numbering referenced audio that is gone.
      const arrangement = setSlot(recordedOrder(16), 0, barRef(2, 9));
      const plan = compressionPlan(arrangement, specIndex(), NONE_MUTED);
      assert.ok(plan);

      assert.deepEqual(plan.arrangement, recordedOrder(16));
      assert.equal(plan.bars.length, 16);
      // Slot 0 still carries the audio that was selected into it.
      assert.deepEqual(plan.bars[0], {
        kind: 'audio',
        region: regionFor(specIndex(), barRef(2, 9)),
        frameCount: framesPerBar(T),
      });
    });

    it('keeps a partial bar at full width, with the shortfall as a rest', () => {
      // Compress writes the retained bars back to back. A bar narrower than framesPerBar
      // would pull every later bar early and leave the loop physically short — permanently,
      // in the only surviving copy.
      const index = passIndex([session(9 * FPB + FPB / 2)], T);
      const plan = compressionPlan(recordedOrder(16), index, [10, 11, 12, 13, 14, 15]);
      const partial = plan?.bars[9];

      assert.equal(partial?.kind, 'audio');
      assert.equal(partial?.frameCount, FPB, 'occupies a whole bar');
      assert.equal(
        partial?.kind === 'audio' ? partial.region.frameCount : undefined,
        FPB / 2,
        'but only half a bar of audio to copy',
      );
      assert.equal(
        plan?.bars.reduce((sum, b) => sum + b.frameCount, 0),
        16 * FPB,
        'the retained loop is still exactly one loop long',
      );
    });

    it('refuses when a slot points at missing audio', () => {
      // Baking a silent bar into the one copy that survives is unrecoverable.
      const arrangement = setSlot(recordedOrder(16), 5, barRef(3, 12));
      assert.equal(compressionPlan(arrangement, specIndex(), NONE_MUTED), undefined);
    });

    it('is idempotent on an already-compressed arrangement', () => {
      const plan = compressionPlan(recordedOrder(16), singlePassIndex(), NONE_MUTED);
      assert.deepEqual(plan?.arrangement, recordedOrder(16));
    });
  });
});
