import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  barRef,
  formatBarRef,
  fromAbsolute,
  steppingBar,
  toAbsolute,
} from '../src/domain/bar-ref.ts';

describe('BarRef', () => {
  it('matches the spec’s verified examples', () => {
    // "absolute bar 17 in a 16-bar loop -> P2 / 1; bar 33 -> P3 / 1", stated 1-based.
    // fromAbsolute takes 0-based, so those are 16 and 32.
    assert.deepEqual(fromAbsolute(16, 16), barRef(2, 1));
    assert.deepEqual(fromAbsolute(32, 16), barRef(3, 1));
    assert.deepEqual(fromAbsolute(0, 16), barRef(1, 1));
    assert.deepEqual(fromAbsolute(15, 16), barRef(1, 16));
  });

  it('round-trips through the absolute bar number', () => {
    for (let bar = 0; bar < 200; bar++) {
      assert.equal(toAbsolute(fromAbsolute(bar, 12), 12), bar);
    }
  });

  it('rejects 0-based or non-integer coordinates', () => {
    assert.throws(() => barRef(0, 1), RangeError);
    assert.throws(() => barRef(1, 0), RangeError);
    assert.throws(() => barRef(1.5, 1), RangeError);
    assert.throws(() => fromAbsolute(-1, 16), RangeError);
  });

  describe('horizontal stepping', () => {
    it('stays inside its own pass', () => {
      // §1.3: the two axes are independent. A horizontal swipe off the end of the loop
      // must not also change the pass — that conflates both coordinates into one
      // gesture, which is the whole reason the pair exists rather than a flat index.
      assert.deepEqual(steppingBar(barRef(2, 16), 1, 16), barRef(2, 1));
      assert.deepEqual(steppingBar(barRef(2, 1), -1, 16), barRef(2, 16));
    });

    it('handles large and negative deltas', () => {
      assert.equal(steppingBar(barRef(1, 1), 17, 16).relativeBar, 2);
      assert.equal(steppingBar(barRef(1, 1), -17, 16).relativeBar, 16);
      assert.equal(steppingBar(barRef(1, 1), -1, 16).relativeBar, 16);
    });

    it('never changes the pass, at any delta', () => {
      for (const delta of [-33, -5, -1, 0, 1, 5, 33]) {
        assert.equal(steppingBar(barRef(3, 7), delta, 16).pass, 3);
      }
    });
  });

  it('formats as the label the tiles show', () => {
    assert.equal(formatBarRef(barRef(2, 5)), 'P2/5');
  });
});
