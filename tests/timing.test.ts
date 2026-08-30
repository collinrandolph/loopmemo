import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  barExists,
  framesPerBar,
  loopFrames,
  loopSeconds,
  passCount,
  timing,
  toleranceFrames,
} from '../src/domain/timing.ts';
import { FPB, LOOP, T } from './fixtures.ts';

describe('Timing', () => {
  it('matches the spec formula for frames per bar', () => {
    // round(44100 × 60 × 4 / 96) = 110250, exactly.
    assert.equal(FPB, 110_250);
    assert.equal(LOOP, 16 * 110_250);
  });

  it('honours beatsPerBar rather than hardcoding 240', () => {
    // §5.1 #1: beatsPerBar stays a named constant.
    const fourFour = timing(120, 8, 44_100, 4);
    const threeFour = timing(120, 8, 44_100, 3);
    assert.equal(framesPerBar(fourFour) * 3, framesPerBar(threeFour) * 4);
  });

  it('does not truncate loopSeconds', () => {
    // Integer division silently rounds 9.6 s down to 9 — a 6% error in every size
    // projection at that tempo.
    assert.equal(loopSeconds(timing(100, 4, 44_100)), 9.6);
  });

  it('matches the spec’s size-table loop lengths', () => {
    assert.equal(loopSeconds(T), 40);
    assert.equal(loopSeconds(timing(128, 8, 44_100)), 15);
    assert.ok(Math.abs(loopSeconds(timing(84, 32, 44_100)) - 91.43) < 0.01);
  });

  it('counts partial passes', () => {
    assert.equal(passCount(T, 0), 0);
    assert.equal(passCount(T, LOOP), 1);
    assert.equal(passCount(T, LOOP + 1), 2);
    assert.equal(passCount(T, 2 * LOOP + 8 * FPB), 3);
  });

  describe('tolerance', () => {
    it('is a few milliseconds, not tens of them', () => {
      // A frame count large enough to admit a bar most of a beat short is not a
      // tolerance, it is a silent truncation. §1.4 says "a few milliseconds".
      assert.equal(toleranceFrames(T), 176);
      assert.ok(toleranceFrames(T) / T.sampleRate < 0.01);
    });

    it('is the same duration at every sample rate', () => {
      const high = timing(96, 16, 48_000);
      assert.notEqual(toleranceFrames(high), toleranceFrames(T));
      const drift = Math.abs(
        toleranceFrames(high) / high.sampleRate - toleranceFrames(T) / T.sampleRate,
      );
      assert.ok(drift < 0.0005, `tolerance drifted by ${drift}s across sample rates`);
    });
  });

  describe('barExists', () => {
    it('includes bars inside a partial pass and excludes those past it', () => {
      const partial = 8 * FPB;
      assert.equal(barExists(T, 1, 1, partial), true);
      assert.equal(barExists(T, 1, 8, partial), true);
      assert.equal(barExists(T, 1, 9, partial), false);
    });

    it('rejects a relative bar outside the loop', () => {
      assert.throws(() => barExists(T, 1, 17, LOOP), RangeError);
      assert.throws(() => barExists(T, 1, 0, LOOP), RangeError);
    });
  });
});
