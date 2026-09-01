import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { framesPerBar } from '../src/domain/timing.ts';
import {
  IDLE,
  completedCycleBetween,
  cyclePosition,
  escalate,
  isPlayed,
  passedAt,
  playBar,
  playLoopFrom,
  playheadAt,
  releaseSlots,
  slotAt,
  stop,
} from '../src/domain/transport.ts';
import { T } from './fixtures.ts';

const FPB = framesPerBar(T);
const BARS = T.barCount; // 16
const ORIGIN = 5;
const START = 1_000_000; // an arbitrary engine frame, to catch start-at-zero assumptions

/** Engine frame `slots` into playback. */
const at = (slots: number) => START + Math.round(slots * FPB);

const loop = playLoopFrom(ORIGIN, START);
const head = (slots: number) => playheadAt(loop, at(slots), T);

/** Which slots read as played, `slots` into playback. */
const playedAt = (slots: number) => releaseSlots(head(slots));

describe('Transport', () => {
  describe('idle', () => {
    it('plays nothing and releases nothing', () => {
      assert.equal(playheadAt(IDLE, at(4), T), undefined);
      assert.equal(isPlayed(undefined, 3), false);
      assert.equal(passedAt(undefined, 3, 0, 16), -1);
      assert.deepEqual(releaseSlots(undefined), []);
    });

    it('is where stop lands', () => {
      assert.deepEqual(stop(), IDLE);
    });
  });

  describe('rule 1 — activation is gated to the origin', () => {
    // Symptom when broken: the colour feather reaches backwards across the bar
    // boundary and tints the tail of the previous bar, which never played.
    it('plays nothing at the instant playback starts', () => {
      assert.deepEqual(playedAt(0), []);
    });

    it('leaves every slot before the origin untouched on the outward leg', () => {
      // Four slots in, the playhead sits at the start of slot 9: slots 5-8 have been
      // crossed, slot 9 has not, and nothing below the origin has been touched.
      assert.deepEqual(playedAt(4), [5, 6, 7, 8]);
    });

    it('never lights the slot behind the origin before the wrap', () => {
      for (const slots of [0.5, 3, 7, 10.9]) {
        assert.equal(isPlayed(head(slots), ORIGIN - 1), false, `at ${slots} slots in`);
      }
    });
  });

  describe('rule 2 — the gate releases at the wrap', () => {
    // Symptom when broken: bars before the origin never light on the return leg.
    it('lights slot 0 once the playhead comes round to it', () => {
      // 11 slots in: 5..15 played, playhead now entering slot 0.
      assert.equal(isPlayed(head(11), 0), false);
      assert.equal(isPlayed(head(11.5), 0), true);
    });

    it('has lit everything by the end of the cycle', () => {
      assert.deepEqual(playedAt(15.99), [...Array(16).keys()]);
    });
  });

  describe('rule 3 — lines from the origin onward stay played while wrapped', () => {
    // Symptom when broken: after the wrap the playhead drops to 0, so everything from
    // the origin on recomputes as unplayed and pops back in one frame.
    it('holds the origin as played after the wrap', () => {
      assert.equal(isPlayed(head(11.5), ORIGIN), true);
      assert.equal(isPlayed(head(15.5), BARS - 1), true);
    });

    it('never un-plays a slot mid-cycle', () => {
      const seen = new Set<number>();
      for (let s = 0; s < 15.99; s += 0.25) {
        for (const slot of releaseSlots(head(s))) seen.add(slot);
        for (const slot of seen) {
          assert.equal(isPlayed(head(s), slot), true, `slot ${slot} popped back at ${s}`);
        }
      }
    });
  });

  describe('rule 4 — the cycle closes at the origin, not the arrangement end', () => {
    // Symptom when broken: releasing at the arrangement end fires mid-cycle whenever
    // playback began somewhere other than slot 0 — a jarring flash.
    it('does not complete a cycle when the playhead passes the arrangement end', () => {
      // 11 slots in is where slot 15 gives way to slot 0.
      assert.equal(completedCycleBetween(loop, at(10.9), at(11.1), T), false);
      assert.equal(head(11.1)?.cyclesCompleted, 0);
    });

    it('completes exactly when the playhead returns to the origin', () => {
      assert.equal(completedCycleBetween(loop, at(15.9), at(16.1), T), true);
      assert.equal(head(16.1)?.cyclesCompleted, 1);
    });

    it('releases everything in one frame at the crossing', () => {
      assert.equal(playedAt(15.99).length, 16);
      assert.deepEqual(playedAt(16), []);
    });

    it('counts cycles from an arbitrary origin the same as from slot zero', () => {
      const fromZero = playLoopFrom(0, START);
      assert.equal(playheadAt(fromZero, at(16.1), T)?.cyclesCompleted, 1);
      assert.equal(head(16.1)?.cyclesCompleted, 1);
    });
  });

  describe('rule 5 — the release floor is per slot, never global', () => {
    // Symptom when broken: finishing a one-bar playback flashes every other bar,
    // including ones that never played.
    const bar = playBar(ORIGIN, START);

    it('plays only the repeating slot', () => {
      const h = playheadAt(bar, at(0.5), T);
      assert.deepEqual(releaseSlots(h), [ORIGIN]);
    });

    it('never lights a neighbour, however long it repeats', () => {
      for (const slots of [0.5, 3.5, 7.25, 40.1]) {
        assert.deepEqual(releaseSlots(playheadAt(bar, at(slots), T)), [ORIGIN]);
      }
    });

    it('completes a cycle every bar', () => {
      assert.equal(playheadAt(bar, at(3.5), T)?.cyclesCompleted, 3);
      assert.equal(completedCycleBetween(bar, at(0.9), at(1.1), T), true);
    });
  });

  describe('escalation (§3.7)', () => {
    const bar = playBar(ORIGIN, START);

    it('keeps the origin and the position within the bar', () => {
      // Three repeats in, 0.3 of the way through the bar.
      const escalated = escalate(bar, at(3.3), T);
      const h = playheadAt(escalated, at(3.3), T);

      assert.equal(escalated.mode, 'loop');
      assert.equal(escalated.origin, ORIGIN);
      assert.ok(Math.abs((h?.phaseSlots ?? 0) - 0.3) < 1e-9, 'position within the bar moved');
      assert.equal(h?.cycleLength, BARS);
    });

    it('undoes nothing — the origin stays played across the change', () => {
      // Both taps are "play", so escalating must not reset what has sounded.
      assert.equal(isPlayed(playheadAt(bar, at(3.3), T), ORIGIN), true);
      assert.equal(isPlayed(playheadAt(escalate(bar, at(3.3), T), at(3.3), T), ORIGIN), true);
    });

    it('resets the cycle count, since the cycle is now a different length', () => {
      assert.equal(playheadAt(escalate(bar, at(3.3), T), at(3.3), T)?.cyclesCompleted, 0);
    });

    it('is a no-op on anything but bar mode', () => {
      assert.deepEqual(escalate(loop, at(2), T), loop);
      assert.deepEqual(escalate(IDLE, at(2), T), IDLE);
    });
  });

  describe('slotAt — which bar is playing', () => {
    // The backing tracks are generated rather than read from a file, so something has to say
    // *which* bar to generate. That answer has to be this one: a second one drifts, and it did
    // — the backing walked the whole chord progression underneath a one-bar preview.
    it('is the inverse of cyclePosition, at every slot of every cycle', () => {
      for (let k = 0; k < BARS * 2; k++) {
        const h = head(k + 0.5)!; // mid-bar, so flooring is doing real work
        const slot = slotAt(h);
        assert.equal(cyclePosition(h, slot), k % BARS, `cycle position at slot offset ${k}`);
      }
    });

    it('walks the arrangement from the origin, wrapping', () => {
      assert.equal(slotAt(head(0)!), ORIGIN);
      assert.equal(slotAt(head(2.9)!), ORIGIN + 2);
      // ORIGIN is 5 of 16, so ten slots on is past the end and back round to 15.
      assert.equal(slotAt(head(10)!), (ORIGIN + 10) % BARS);
      assert.equal(slotAt(head(11)!), 0);
      assert.equal(slotAt(head(BARS)!), ORIGIN); // a full cycle returns
    });

    it('holds one slot in bar mode, however long it repeats', () => {
      // §2.6: previewing a bar plays *that* bar. The cycle is one slot long, so there is
      // nowhere else for this to go — which is the point of deriving it rather than counting.
      const bar = playBar(ORIGIN, START);
      for (const slots of [0, 0.5, 1, 3.3, 9, 40.75]) {
        assert.equal(slotAt(playheadAt(bar, at(slots), T)!), ORIGIN, `${slots} slots in`);
      }
    });

    it('holds the origin before playback has moved, whatever the mode', () => {
      assert.equal(slotAt(playheadAt(loop, START, T)!), ORIGIN);
      // Frames before the anchor — the engine's scheduling lead — clamp to phase 0 rather than
      // running backwards off the origin.
      assert.equal(slotAt(playheadAt(loop, START - 5000, T)!), ORIGIN);
    });
  });

  describe('passedAt', () => {
    const LINES = 16;

    it('is negative before the playhead and positive behind it', () => {
      const h = head(2.5); // 2.5 slots past the origin
      assert.ok(passedAt(h, ORIGIN, 0, LINES) > 0, 'the origin has played');
      assert.ok(passedAt(h, ORIGIN + 5, 0, LINES) < 0, 'five slots ahead has not');
    });

    it('measures in lines, and crosses zero exactly at the playhead', () => {
      const h = head(2); // exactly at the start of ORIGIN + 2
      assert.equal(passedAt(h, ORIGIN + 2, 0, LINES), 0);
      assert.equal(passedAt(h, ORIGIN + 1, 0, LINES), LINES);
      assert.equal(passedAt(h, ORIGIN + 1, LINES - 1, LINES), 1);
    });

    it('reaches back across the wrap without tinting what never played', () => {
      // Rule 1 at line resolution: the slot behind the origin must read unreached.
      assert.ok(passedAt(head(0.1), ORIGIN - 1, LINES - 1, LINES) < 0);
    });

    it('stays saturated for slots played earlier in the cycle', () => {
      // Clamped by the renderer, so any value past the feather is the same pixel.
      assert.ok(passedAt(head(15.5), ORIGIN, 0, LINES) > 2.5);
    });
  });

  it('does not assume playback starts at frame zero', () => {
    // The engine's frame counter is free-running; nothing here may treat 0 as the start.
    const late = playLoopFrom(ORIGIN, 987_654_321);
    const h = playheadAt(late, 987_654_321 + 2 * FPB, T);
    assert.equal(h?.phaseSlots, 2);
    assert.equal(h?.cyclesCompleted, 0);
  });
});
