import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NONE_MUTED,
  canSwipeSlot,
  compressionPlan,
  isSilentAt,
  isSlotMuted,
  recordedOrder,
  setSlot,
  setSlotMuted,
  stepBarAt,
  stepPassAt,
  toggleSlotMute,
} from '../src/domain/arrangement.ts';
import { barRef } from '../src/domain/bar-ref.ts';
import { segments } from '../src/domain/schedule-plan.ts';
import { framesPerBar } from '../src/domain/timing.ts';
import { FPB, T, singlePassIndex, specIndex } from './fixtures.ts';

describe('per-bar mute', () => {
  describe('the set of muted slots', () => {
    it('starts empty and toggles', () => {
      assert.equal(isSlotMuted(NONE_MUTED, 3), false);
      const one = toggleSlotMute(NONE_MUTED, 3);
      assert.equal(isSlotMuted(one, 3), true);
      assert.equal(isSlotMuted(toggleSlotMute(one, 3), 3), false);
    });

    it('holds many slots at once, up to all of them', () => {
      let muted = NONE_MUTED;
      for (let slot = 0; slot < 16; slot++) muted = setSlotMuted(muted, slot, true);
      assert.equal(muted.length, 16);
      for (let slot = 0; slot < 16; slot++) assert.equal(isSlotMuted(muted, slot), true);
    });

    it('never records a slot twice', () => {
      let muted = setSlotMuted(NONE_MUTED, 3, true);
      muted = setSlotMuted(muted, 3, true);
      assert.deepEqual(muted, [3]);
    });

    it('returns the same reference when nothing changes', () => {
      const muted = setSlotMuted(NONE_MUTED, 3, true);
      assert.equal(setSlotMuted(muted, 3, true), muted);
      assert.equal(setSlotMuted(NONE_MUTED, 9, false), NONE_MUTED);
    });

    it('stays sorted, so equality does not depend on the order they were muted in', () => {
      const forwards = [3, 7, 1].reduce((m, s) => setSlotMuted(m, s, true), NONE_MUTED);
      const backwards = [7, 1, 3].reduce((m, s) => setSlotMuted(m, s, true), NONE_MUTED);
      assert.deepEqual(forwards, backwards);
      assert.deepEqual(forwards, [1, 3, 7]);
    });

    it('does not mutate what it was given', () => {
      const original = setSlotMuted(NONE_MUTED, 3, true);
      setSlotMuted(original, 8, true);
      assert.deepEqual(original, [3]);
    });

    it('allows muting a slot whose audio does not exist', () => {
      // Pointless, harmless, and not worth a special case.
      assert.equal(isSlotMuted(setSlotMuted(NONE_MUTED, 5, true), 5), true);
    });
  });

  describe('layer mute and bar mute are independent', () => {
    // Either silences; there is no per-bar override that plays through a muted layer,
    // because that would be solo, and §5.1 #9 rules solo out.
    const muted = setSlotMuted(NONE_MUTED, 4, true);

    it('silences a slot if either is set', () => {
      assert.equal(isSilentAt(muted, 4, false), true, 'bar muted');
      assert.equal(isSilentAt(NONE_MUTED, 4, true), true, 'layer muted');
      assert.equal(isSilentAt(muted, 4, true), true, 'both');
      assert.equal(isSilentAt(NONE_MUTED, 4, false), false, 'neither');
    });

    it('leaves the per-bar record intact when the layer is muted', () => {
      // Layer mute must never be written through into the muted slots. If it were, there
      // would be no way to tell which bars the user muted on purpose, so unmuting the
      // layer could not restore them.
      assert.deepEqual(muted, [4]);
      assert.equal(isSilentAt(muted, 7, true), true, 'slot 7 silent while the layer is');
      assert.equal(isSilentAt(muted, 7, false), false, 'and audible again when it is not');
    });
  });

  describe('swiping is locked while a bar is muted (§3.7)', () => {
    // A muted tile shows no contraction and no redraw, so a swipe would change the pass
    // with no feedback at all — silent state mutation discovered much later.
    const arrangement = recordedOrder(16);
    const muted = setSlotMuted(NONE_MUTED, 8, true);

    it('reports the gate', () => {
      assert.equal(canSwipeSlot(muted, 8), false);
      assert.equal(canSwipeSlot(muted, 9), true);
    });

    it('refuses to step the pass', () => {
      assert.equal(stepPassAt(arrangement, 8, 1, specIndex(), muted), arrangement);
    });

    it('refuses to step the bar', () => {
      assert.equal(stepBarAt(arrangement, 8, 1, specIndex(), muted), arrangement);
    });

    it('still allows swiping every other slot', () => {
      assert.notEqual(stepPassAt(arrangement, 9, 1, specIndex(), muted), arrangement);
      assert.notEqual(stepBarAt(arrangement, 9, 1, specIndex(), muted), arrangement);
    });

    it('allows it again once unmuted', () => {
      const unmuted = setSlotMuted(muted, 8, false);
      assert.notEqual(stepPassAt(arrangement, 8, 1, specIndex(), unmuted), arrangement);
    });
  });

  describe('a muted slot is a rest, not a deletion', () => {
    const muted = setSlotMuted(NONE_MUTED, 1, true);

    it('schedules no audio for it', () => {
      const plan = segments(recordedOrder(16), specIndex(), 0, 4, muted);
      assert.deepEqual(
        plan.map((s) => s.slot),
        [0, 2, 3],
      );
    });

    it('does not shift the slots after it — time advances through the silence', () => {
      const plan = segments(recordedOrder(16), specIndex(), 0, 4, muted);
      const bySlot = new Map(plan.map((s) => [s.slot, s.startFrame]));
      assert.equal(bySlot.get(0), 0);
      assert.equal(bySlot.get(2), 2 * FPB, 'slot 2 did not slide into the gap');
      assert.equal(bySlot.get(3), 3 * FPB);
    });

    it('schedules nothing at all when every slot is muted', () => {
      let all = NONE_MUTED;
      for (let slot = 0; slot < 16; slot++) all = setSlotMuted(all, slot, true);
      assert.deepEqual(segments(recordedOrder(16), specIndex(), 0, 16, all), []);
    });
  });

  describe('compress bakes the mute in', () => {
    // Compress and bounce are both deliberately destructive to reclaim space, so a muted
    // slot is written as real silence rather than kept as a flag over inaudible audio.
    const muted = setSlotMuted(setSlotMuted(NONE_MUTED, 2, true), 5, true);

    it('writes a silent bar of full length, keeping the bar in the order', () => {
      const plan = compressionPlan(recordedOrder(16), specIndex(), muted);
      assert.ok(plan);

      assert.equal(plan.bars.length, 16, 'a rest is still a bar');
      assert.deepEqual(plan.bars[2], { kind: 'silence', frameCount: framesPerBar(T) });
      assert.deepEqual(plan.bars[5], { kind: 'silence', frameCount: framesPerBar(T) });
      assert.equal(plan.bars[3]?.kind, 'audio', 'the bar after a rest is untouched');
    });

    it('does not renumber around the rests', () => {
      const plan = compressionPlan(recordedOrder(16), specIndex(), muted);
      assert.deepEqual(plan?.arrangement, recordedOrder(16));
    });

    it('clears the flags, because the silence lives in the audio now', () => {
      // Keeping them would silence it twice, and unmuting afterwards would reveal
      // silence rather than the take that used to be there.
      assert.deepEqual(compressionPlan(recordedOrder(16), specIndex(), muted)?.mutedSlots, []);
    });

    it('does not need a source for a muted slot', () => {
      // The slot is about to be silence either way, so missing audio behind it is not an
      // error the way it is for an audible slot.
      const arrangement = setSlot(recordedOrder(16), 5, barRef(3, 12)); // in the gap
      assert.equal(compressionPlan(arrangement, specIndex(), NONE_MUTED), undefined);
      assert.ok(compressionPlan(arrangement, specIndex(), muted), 'muting it made it fine');
    });

    it('compresses an entirely muted layer to a full loop of silence', () => {
      let all = NONE_MUTED;
      for (let slot = 0; slot < 16; slot++) all = setSlotMuted(all, slot, true);
      const plan = compressionPlan(recordedOrder(16), singlePassIndex(), all);
      assert.equal(plan?.bars.length, 16);
      assert.ok(plan?.bars.every((b) => b.kind === 'silence'));
    });
  });
});
