import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { framesPerBar } from '../src/domain/timing.ts';
import { isPlayed, passedAt, playBar, playLoopFrom, playheadAt } from '../src/domain/transport.ts';
import { T } from './fixtures.ts';

/**
 * Does the gradient bleed onto a bar that never played?
 *
 * §3.6 rule 1 names this symptom directly: "the colour feather reaches backwards across the
 * bar boundary and tints the tail of the previous bar, which never played". It is the most
 * visible failure in the whole transport, and single-bar playback is where it shows worst —
 * one bar sounds and its neighbour lights up.
 *
 * The feather is 2.5 lines wide and trails the playhead, so any line whose `passed` goes
 * positive is tinted. These tests assert that only slots actually reached ever do.
 */

const FPB = framesPerBar(T);
const BARS = T.barCount;
const LINES_PER_BAR = 16;
const COLOR_FEATHER = 2.5;

/** Any positive `passed` is visible tint; the renderer clamps below zero. */
const isTinted = (passed: number) => passed > 0;
const tintAmount = (passed: number) => Math.min(Math.max(passed / COLOR_FEATHER, 0), 1);

/** Every (slot, line) showing any tint at this position. */
function tintedSlots(head: ReturnType<typeof playheadAt>): number[] {
  const out = new Set<number>();
  for (let slot = 0; slot < BARS; slot++) {
    for (let line = 0; line < LINES_PER_BAR; line++) {
      if (isTinted(passedAt(head, slot, line, LINES_PER_BAR))) out.add(slot);
    }
  }
  return [...out].sort((a, b) => a - b);
}

describe('the gradient never reaches a bar that did not play', () => {
  describe('single-bar playback (§3.7 single tap)', () => {
    it('tints only the bar being repeated, at every point in the bar', () => {
      for (const origin of [0, 1, 5, 8, BARS - 1]) {
        const bar = playBar(origin, 0);
        for (let step = 0; step <= 64; step++) {
          const phase = step / 64;
          const head = playheadAt(bar, phase * FPB, T);
          const tinted = tintedSlots(head);

          assert.ok(
            tinted.length === 0 || (tinted.length === 1 && tinted[0] === origin),
            `origin ${origin} at phase ${phase.toFixed(3)} tinted ${JSON.stringify(tinted)}`,
          );
        }
      }
    });

    it('leaves the previous bar completely untouched — the reported bug', () => {
      // The neighbour behind the origin is where the feather would reach if the gate
      // were missing, and its LAST lines are the closest to the playhead.
      for (const origin of [0, 1, 5, BARS - 1]) {
        const previous = (origin - 1 + BARS) % BARS;
        const bar = playBar(origin, 0);

        for (let step = 0; step <= 64; step++) {
          const head = playheadAt(bar, (step / 64) * FPB, T);
          for (let line = LINES_PER_BAR - 4; line < LINES_PER_BAR; line++) {
            const passed = passedAt(head, previous, line, LINES_PER_BAR);
            assert.equal(
              tintAmount(passed),
              0,
              `origin ${origin}: previous bar ${previous} line ${line} tinted at step ${step}`,
            );
          }
          assert.equal(isPlayed(head, previous), false);
        }
      }
    });

    it('stays clean across a repeat boundary', () => {
      // The bar loops every framesPerBar. Nothing may leak at the seam.
      const bar = playBar(5, 0);
      for (let step = 0; step <= 40; step++) {
        const phase = 0.98 + step * 0.001; // straddles the repeat at 1.0
        const head = playheadAt(bar, phase * FPB, T);
        assert.deepEqual(tintedSlots(head), phase % 1 === 0 ? [] : [5]);
      }
    });

    it('tints nothing at all at the very first frame', () => {
      assert.deepEqual(tintedSlots(playheadAt(playBar(5, 0), 0, T)), []);
    });
  });

  describe('loop playback', () => {
    it('never tints a slot the playhead has not reached', () => {
      const origin = 5;
      const loop = playLoopFrom(origin, 0);

      for (let step = 0; step <= BARS * 16; step++) {
        const phase = step / 16;
        if (phase >= BARS) break;
        const head = playheadAt(loop, phase * FPB, T);

        for (const slot of tintedSlots(head)) {
          const cyclePos = (((slot - origin) % BARS) + BARS) % BARS;
          assert.ok(
            cyclePos < phase,
            `slot ${slot} (cycle position ${cyclePos}) tinted at phase ${phase}, ` +
              `before the playhead reached it`,
          );
        }
      }
    });

    it('does not tint backwards across the wrap', () => {
      // Immediately after wrapping to slot 0, the slot BEFORE the origin on the return
      // leg has still not played. The feather must not reach it.
      const origin = 5;
      const loop = playLoopFrom(origin, 0);
      const head = playheadAt(loop, 11.05 * FPB, T); // just into slot 0

      assert.equal(isPlayed(head, 4), false, 'slot 4 plays last, not first');
      for (let line = 0; line < LINES_PER_BAR; line++) {
        assert.equal(tintAmount(passedAt(head, 4, line, LINES_PER_BAR)), 0);
      }
    });

    it('tints the origin from its first line, not from the line before it', () => {
      const loop = playLoopFrom(5, 0);
      const head = playheadAt(loop, 0.05 * FPB, T);

      assert.ok(passedAt(head, 5, 0, LINES_PER_BAR) > 0, 'the origin has started');
      assert.equal(tintAmount(passedAt(head, 4, LINES_PER_BAR - 1, LINES_PER_BAR)), 0);
    });
  });

  it('idle tints nothing anywhere', () => {
    assert.deepEqual(tintedSlots(undefined), []);
  });
});
