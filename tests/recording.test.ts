import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { initialArrangement, isSlotMuted, recordedOrder } from '../src/domain/arrangement.ts';
import { barRef } from '../src/domain/bar-ref.ts';
import { availablePasses, hasAudio, passIndex, regionFor } from '../src/domain/pass-index.ts';
import { emptyLayer, isLayerAudible, recordSession } from '../src/domain/project.ts';
import { barExists, loopFrames, passCount, toleranceFrames } from '../src/domain/timing.ts';
import { FPB, LOOP, T, session } from './fixtures.ts';

describe('a partially recorded bar is an ordinary bar', () => {
  // Stopping halfway through bar 10 of a 16-bar loop.
  const HALF = 9 * FPB + FPB / 2;

  it('exists as soon as the recording reaches into it', () => {
    assert.equal(barExists(T, 1, 10, HALF), true, 'bar 10 was reached');
    assert.equal(barExists(T, 1, 11, HALF), false, 'bar 11 never was');
  });

  it('resolves to the audio that exists, and nothing is padded to fill it', () => {
    const region = regionFor(passIndex([session(HALF)], T), barRef(1, 10));
    assert.equal(region?.startFrame, 9 * FPB);
    assert.equal(region?.frameCount, FPB / 2, 'short, not padded out to a full bar');
  });

  it('is offered on the pass axis like any other bar', () => {
    // §5.1 #5 excluded it. The reason given was that padding "creates silent bars that look
    // selectable" — nothing is padded here, so the bar is selectable because it is real.
    const index = passIndex([session(HALF), session(LOOP)], T);
    assert.deepEqual(availablePasses(index, 10), [1, 2]);
    assert.deepEqual(availablePasses(index, 11), [2], 'bar 11 only exists in the second pass');
  });
});

describe('an overrun past the loop point does not manufacture a pass', () => {
  // A junk pass is far worse than a junk bar: it renumbers every pass after it, a single
  // pass cannot be deleted (§5.1 #2), and the only escape is clearing the whole layer.
  it('needs a complete bar before a traversal counts', () => {
    assert.equal(passCount(T, LOOP + 100), 1, 'a few frames over');
    assert.equal(passCount(T, LOOP + FPB / 2), 1, 'half a bar over');
    assert.equal(passCount(T, LOOP + FPB - 300), 1, 'short of a bar by more than latency');
    assert.equal(passCount(T, LOOP + FPB), 2, 'a whole bar is a pass');
  });

  it('forgives stop latency on that bar, so a played pass is not lost', () => {
    // The far-edge tolerance survives here and only here: a completeness test is the one
    // kind that needs it.
    assert.equal(passCount(T, LOOP + FPB - 88), 2, '2 ms short of the bar still counts');
  });

  it('offers no bar of a pass that does not exist', () => {
    assert.equal(barExists(T, 2, 1, LOOP + FPB / 2), false);
    assert.deepEqual(availablePasses(passIndex([session(LOOP + FPB / 2)], T), 1), [1]);
  });

  it('leaves the numbering of a later session alone', () => {
    // The annoyance the gate exists to prevent: without it the overrun takes pass 2, and
    // everything the user records next is misnumbered from there on.
    const index = passIndex([session(LOOP + FPB / 2), session(LOOP)], T);
    assert.deepEqual(index.firstPass, [1, 2]);
    assert.deepEqual(availablePasses(index, 1), [1, 2]);
  });

  it('keeps the size projection honest', () => {
    const index = passIndex([session(LOOP + 100)], T);
    assert.deepEqual(availablePasses(index, 1), [1], 'one pass offered');
    assert.equal(passCount(T, LOOP + 100), 1, 'and one pass counted');
  });

  it('counts exactly the passes that hold their own bar 1, at every length', () => {
    // The guarantee behind deriving one from the other: these were computed independently
    // once, and disagreed on every recording that overran the loop point.
    const L = loopFrames(T);
    const lengths = [0, 1, toleranceFrames(T), 100, FPB - 1, FPB, L - 1, L];
    lengths.push(L + 100, L + FPB / 2, L + FPB - 1, L + FPB, 2 * L + 7);
    for (const frames of lengths) {
      let counted = 0;
      for (let p = 1; p <= 5; p++) if (barExists(T, p, 1, frames)) counted++;
      assert.equal(passCount(T, frames), counted, `at ${frames} frames`);
    }
  });
});

describe('initialArrangement', () => {
  it('is plain recorded order when the first pass completed', () => {
    const initial = initialArrangement(passIndex([session(LOOP)], T));
    assert.deepEqual(initial.barSources, recordedOrder(16));
    assert.deepEqual(initial.mutedSlots, []);
  });

  describe('when the first pass stopped part way', () => {
    // 9½ bars: bars 1-10 hold audio, bars 11-16 were never reached.
    const initial = initialArrangement(passIndex([session(9 * FPB + FPB / 2)], T));

    it('keeps recorded order for every slot that has audio', () => {
      assert.deepEqual(initial.barSources.slice(0, 10), recordedOrder(16).slice(0, 10));
    });

    it('points the rest at the first bar of the pass', () => {
      // Not left dangling: a slot pointing at audio that does not exist draws blank and has
      // no available set to wrap through, so the user could not select their way out of it.
      for (let slot = 10; slot < 16; slot++) {
        assert.deepEqual(initial.barSources[slot], barRef(1, 1), `slot ${slot}`);
      }
    });

    it('mutes exactly those slots, so the placeholder never sounds', () => {
      assert.deepEqual(initial.mutedSlots, [10, 11, 12, 13, 14, 15]);
    });

    it('stays the full bar count', () => {
      assert.equal(initial.barSources.length, 16);
    });

    it('leaves no slot unresolved', () => {
      const index = passIndex([session(9 * FPB + FPB / 2)], T);
      assert.ok(initial.barSources.every((ref) => hasAudio(index, ref)));
    });
  });
});

describe('recordSession', () => {
  const layer = emptyLayer(0);

  it('gives an empty layer its arrangement', () => {
    const after = recordSession(layer, session(LOOP), T);
    assert.equal(after.sessions.length, 1);
    assert.deepEqual(after.barSources, recordedOrder(16));
  });

  it('leaves an existing arrangement and its mutes untouched', () => {
    // A new pass is an option the swipe axis gains, not a decision about where it goes.
    // Auto-selecting it would discard hunting the user had already done.
    const first = recordSession(layer, session(9 * FPB + FPB / 2), T);
    const second = recordSession(first, session(LOOP), T);

    assert.equal(second.sessions.length, 2);
    assert.equal(second.barSources, first.barSources, 'same reference — not rebuilt');
    assert.equal(second.mutedSlots, first.mutedSlots);
    assert.equal(isSlotMuted(second.mutedSlots, 12), true, 'still muted, still the user’s');
  });

  it('offers the newly available passes without selecting them', () => {
    const first = recordSession(layer, session(9 * FPB + FPB / 2), T);
    const second = recordSession(first, session(LOOP), T);
    const index = passIndex(second.sessions, T);

    assert.deepEqual(availablePasses(index, 12), [2], 'bar 12 has audio now');
    assert.deepEqual(second.barSources[11], barRef(1, 1), 'but slot 11 was not moved onto it');
  });

  it('refuses a session that never completed a bar', () => {
    // It contributes no passes, and on an empty layer would initialise an arrangement of
    // nothing but muted placeholders. The gate applies to the first pass like any other:
    // a take shorter than a bar is not a pass.
    assert.equal(recordSession(layer, session(0, 'empty'), T), layer);
    assert.equal(recordSession(layer, session(toleranceFrames(T), 'crumb'), T), layer);
    assert.equal(recordSession(layer, session(FPB / 2, 'half'), T), layer);
  });

  it('accepts a take of one bar, and arranges the rest as muted placeholders', () => {
    const after = recordSession(layer, session(FPB, 'onebar'), T);
    assert.equal(after.sessions.length, 1);
    assert.deepEqual(after.barSources[0], barRef(1, 1));
    assert.deepEqual(after.mutedSlots.length, 15, 'every slot but the one that has audio');
  });

  it('never mutates the layer it was given', () => {
    recordSession(layer, session(LOOP), T);
    assert.deepEqual(layer.sessions, []);
    assert.deepEqual(layer.barSources, []);
  });
});

describe('the layer being recorded onto is silent for the take (§3.9)', () => {
  const target = recordSession(emptyLayer(2), session(LOOP), T);
  const other = recordSession(emptyLayer(3), session(LOOP), T);

  it('silences the target and no one else', () => {
    assert.equal(isLayerAudible(target, 2), false);
    assert.equal(isLayerAudible(other, 2), true);
  });

  it('is audible again the moment nothing is recording', () => {
    assert.equal(isLayerAudible(target, undefined), true);
  });

  it('does not write through into the layer’s own mute', () => {
    // Same trap as layer mute and mutedSlots: written through, the user's state and ours
    // become indistinguishable, and stopping the recording could not restore theirs.
    assert.equal(target.muted, false, 'still the user’s to set');
  });

  it('still respects a layer the user muted', () => {
    const muted = { ...other, muted: true };
    assert.equal(isLayerAudible(muted, 2), false);
    assert.equal(isLayerAudible(muted, undefined), false);
  });
});
