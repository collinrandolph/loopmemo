import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COUNT_IN_BAR_OPTIONS,
  COUNT_IN_DEFAULT,
  countInFrames,
  countInStartFrame,
} from '../src/domain/count-in.ts';
import { BPM_MAX, BPM_MIN, VALID_BAR_COUNTS } from '../src/domain/project.ts';
import { framesPerBar, loopFrames, timing } from '../src/domain/timing.ts';
import { FPB, LOOP, T } from './fixtures.ts';

describe('Count-in', () => {
  it('is a whole number of bars', () => {
    assert.equal(countInFrames(0, T), 0);
    assert.equal(countInFrames(1, T), FPB);
    assert.equal(countInFrames(4, T), 4 * FPB);
  });

  it('ends on the loop point, so the downbeat is where it always was', () => {
    // The transport starts this far in and runs to the wrap; the take begins on the wrap.
    assert.equal(countInStartFrame(1, T), LOOP - FPB);
    assert.equal(countInStartFrame(4, T), LOOP - 4 * FPB);
  });

  it('off starts where recording has always started', () => {
    assert.equal(countInStartFrame(0, T), LOOP);
    assert.equal(LOOP - countInStartFrame(0, T), 0);
  });

  /**
   * The property the feature rests on: the count-in is carved out of the loop's own tail, so it
   * must never ask the transport to start before the loop does. The shortest loop is 4 bars
   * (§1.2) and the longest count-in is 4, so the tightest case is exactly zero — never negative.
   */
  it('never starts before the beginning of the loop, at any tempo or length', () => {
    let tightest = Number.POSITIVE_INFINITY;
    for (const bpm of [BPM_MIN, 96, 120, 137, BPM_MAX]) {
      for (const barCount of VALID_BAR_COUNTS) {
        for (const rate of [44100, 48000]) {
          const t = timing(bpm, barCount, rate, 4);
          for (const bars of COUNT_IN_BAR_OPTIONS) {
            const start = countInStartFrame(bars, t);
            assert.ok(start >= 0, `bpm ${bpm} bars ${barCount} count-in ${bars} -> ${start}`);
            // And the count-in plus the run to the wrap is the whole distance, exactly.
            assert.equal(start + countInFrames(bars, t), loopFrames(t));
            tightest = Math.min(tightest, start);
          }
        }
      }
    }
    // The 4-bar loop with a 4-bar count-in: one whole loop of lead-in, and not a frame more.
    assert.equal(tightest, 0);
  });

  it('counts in whole bars of the project, not of some fixed tempo', () => {
    const slow = timing(60, 8, 44100, 4);
    const fast = timing(240, 8, 44100, 4);
    assert.equal(countInFrames(2, slow), 2 * framesPerBar(slow));
    assert.equal(countInFrames(2, fast), 2 * framesPerBar(fast));
    assert.ok(countInFrames(2, slow) > countInFrames(2, fast));
  });

  it('defaults to one bar of the full loop', () => {
    assert.deepEqual(COUNT_IN_DEFAULT, { bars: 1, mode: 'loop' });
  });
});
