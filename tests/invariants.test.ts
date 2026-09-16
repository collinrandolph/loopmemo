import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canSwipeSlot,
  setSlot,
  compressionPlan,
  initialArrangement,
  isSlotMuted,
  stepBarAt,
  stepPassAt,
  toggleSlotMute,
  unresolvedSlots,
} from '../src/domain/arrangement.ts';
import type { Arrangement, MutedSlots } from '../src/domain/arrangement.ts';
import { availableBars, availablePasses, regionFor, totalPasses } from '../src/domain/pass-index.ts';
import type { PassIndex } from '../src/domain/pass-index.ts';
import type { BarRef } from '../src/domain/bar-ref.ts';
import { framesPerBar } from '../src/domain/timing.ts';
import { barRef } from '../src/domain/bar-ref.ts';
import { FPB, T, session, specIndex } from './fixtures.ts';
import { passIndex } from '../src/domain/pass-index.ts';

/**
 * What must be true after *any* sequence of edits, rather than after one.
 *
 * Every other suite here checks an operation against a case someone thought of. Two of the three
 * worst findings in the audit were compositions — two features that are individually correct, put
 * in sequence — and nothing in the repo tested a composition, which is why they survived 359 green
 * tests. This walks random sequences of the real edit operations and asserts the same four things
 * after every single step.
 *
 * **The sequences are seeded and printed on failure**, because a property test that cannot be
 * re-run is a rumour. The generator is a plain LCG rather than a dependency — the repo has one
 * devDependency and that is load-bearing.
 */

/** Deterministic, so a failure names the seed that produced it. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes' LCG. Fine for choosing which edit to make next; not for anything else.
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Step = { op: string; slot: number; direction?: number };

/**
 * Apply one edit, returning the new state — or the same state when the domain refuses, which is a
 * legitimate outcome and not a failure.
 */
function applyStep(
  step: Step,
  arrangement: Arrangement,
  muted: MutedSlots,
  index: PassIndex,
): { arrangement: Arrangement; muted: MutedSlots } {
  switch (step.op) {
    case 'stepPass':
      return { arrangement: stepPassAt(arrangement, step.slot, step.direction!, index, muted), muted };
    case 'stepBar':
      return {
        arrangement: stepBarAt(arrangement, step.slot, step.direction!, index, muted),
        muted,
      };
    case 'toggleMute':
      return { arrangement, muted: toggleSlotMute(muted, step.slot) };
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

function randomSequence(seed: number, barCount: number, length: number): Step[] {
  const next = rng(seed);
  const ops = ['stepPass', 'stepBar', 'toggleMute'];
  return Array.from({ length }, () => ({
    op: ops[Math.floor(next() * ops.length)]!,
    slot: Math.floor(next() * barCount),
    direction: next() < 0.5 ? -1 : 1,
  }));
}

describe('invariants hold after any sequence of edits', () => {
  const index = specIndex();
  const barCount = T.barCount;

  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`seed ${seed}: 200 random edits`, () => {
      const start = initialArrangement(index);
      let arrangement: Arrangement = start.barSources;
      let muted: MutedSlots = start.mutedSlots;
      const history: Step[] = [];

      for (const step of randomSequence(seed, barCount, 200)) {
        history.push(step);
        const where = () => `seed ${seed}, after ${history.length} steps: ${JSON.stringify(step)}`;

        const before = { arrangement, muted };
        ({ arrangement, muted } = applyStep(step, arrangement, muted, index));

        // 1. The arrangement is always exactly barCount long. Every screen indexes it by slot and
        //    a short one is an out-of-range read rather than a visible error.
        assert.equal(arrangement.length, barCount, `length changed — ${where()}`);

        // 2. Every audible slot resolves to audio. A blank tile is a slot the user cannot hear and
        //    Compress refuses, so no edit may produce one. This found the stranded-slot defect on
        //    its first run (seed 1337) — see "a horizontal step stays inside a partial pass".
        assert.deepEqual(
          unresolvedSlots(arrangement, index).filter((slot) => !isSlotMuted(muted, slot)),
          [],
          `an audible slot points at nothing — ${where()}`,
        );

        // 3. A muted slot never moves. §3.7 locks swiping while a bar is muted, so no gesture can
        //    carry a mute onto different audio — which is what makes "scope is the slot" and
        //    "scope is the source" indistinguishable in use rather than merely agreed upon.
        if (step.op !== 'toggleMute' && isSlotMuted(before.muted, step.slot)) {
          assert.deepEqual(
            arrangement[step.slot],
            before.arrangement[step.slot],
            `a muted slot was stepped — ${where()}`,
          );
          assert.equal(canSwipeSlot(before.muted, step.slot), false, `canSwipeSlot disagreed — ${where()}`);
        }

        // 4. Every reference names a pass the vertical axis would actually offer for that bar, so
        //    the tile's label and its available set cannot disagree.
        arrangement.forEach((ref: BarRef | undefined, slot: number) => {
          if (!ref || isSlotMuted(muted, slot)) return;
          const passes = availablePasses(index, ref.relativeBar);
          assert.ok(
            passes.includes(ref.pass),
            `slot ${slot} holds P${ref.pass} which bar ${ref.relativeBar} does not offer ` +
              `(${passes.join(', ')}) — ${where()}`,
          );
        });
      }
    });
  }
});

describe('compression preserves the loop, whatever the arrangement became', () => {
  const index = specIndex();

  for (const seed of [3, 11, 808]) {
    it(`seed ${seed}: the plan is barCount slots of framesPerBar`, () => {
      const start = initialArrangement(index);
      let arrangement: Arrangement = start.barSources;
      let muted: MutedSlots = start.mutedSlots;
      for (const step of randomSequence(seed, T.barCount, 120)) {
        ({ arrangement, muted } = applyStep(step, arrangement, muted, index));
      }

      const plan = compressionPlan(arrangement, index, muted);
      // Undefined means an *audible* slot pointed at audio that is not there. Invariant 2 above
      // forbids exactly that, so a refusal here is that invariant failing by another route.
      assert.ok(plan, 'compress refused: an audible slot resolves to nothing');
      assert.equal(plan.bars.length, T.barCount, 'a rest is still a bar');

      // **Advance by the slot width, never by what was copied.** A partial bar's region is shorter
      // than its slot; adding up regions instead would pull every later bar early and leave the
      // compressed loop shorter than the original, in the only surviving copy.
      const total = plan.bars.reduce((n, b) => n + b.frameCount, 0);
      assert.equal(
        total,
        T.barCount * framesPerBar(T),
        'compressed loop length moved away from barCount x framesPerBar',
      );

      for (const bar of plan.bars) {
        assert.equal(bar.frameCount, framesPerBar(T), 'a retained bar is one slot wide');
        if (bar.kind === 'audio') {
          assert.ok(
            bar.region.frameCount <= bar.frameCount,
            'a region cannot be wider than the slot it fills',
          );
        }
      }
    });
  }
});

describe('pass counting agrees with pass availability at every length', () => {
  // `passCount` drives the size projection and `availablePasses` drives the swipe axis. They were
  // computed independently once and disagreed on every recording that overran the loop point — two
  // complete passes plus 20 ms reported three to one and offered two to the other, so the Library
  // over-stated the project by 50%.
  it('across a sweep of session lengths', () => {
    for (let bars = 1; bars <= T.barCount * 3; bars++) {
      for (const extra of [0, 1, FPB - 1, Math.floor(FPB / 2)]) {
        const frames = bars * FPB + extra;
        const index = passIndex([session(frames, `sweep-${frames}`)], T);
        const total = totalPasses(index);

        // Every pass the axis offers for any bar must be within the counted total, and pass 1 of
        // bar 1 must resolve whenever any pass is counted at all.
        for (let bar = 1; bar <= T.barCount; bar++) {
          for (const pass of availablePasses(index, bar)) {
            assert.ok(
              pass >= 1 && pass <= total,
              `bar ${bar} offers P${pass} but only ${total} passes are counted (${frames} frames)`,
            );
            assert.ok(
              regionFor(index, { pass, relativeBar: bar }, 0),
              `bar ${bar} offers P${pass} with no region behind it (${frames} frames)`,
            );
          }
        }
      }
    }
  });
});

describe('a horizontal step stays inside a partial pass', () => {
  /**
   * **Was an open defect; fixed 2026-09-16.** Found by the sequence walk above on its first run.
   *
   * §1.4's example has a partial pass 3 covering bars 1-8 only. Stepping bar by bar across the
   * whole loop took P3 / bar 8 one step to P3 / bar 9, which has no audio: the tile drew blank and
   * `compressionPlan` refused the project with a message about damage, for a state a swipe made.
   *
   * The decision was that **a partial pass is as long as the recording got**: the horizontal axis
   * wraps through the bars this pass has, the way the vertical axis wraps through the passes a bar
   * has. The pass never changes, so §1.3 holds.
   */
  it('P3 / bar 8 steps forward to P3 / bar 1, not onto bar 9', () => {
    const index = specIndex();
    const start = initialArrangement(index);

    assert.deepEqual(availablePasses(index, 9), [1, 2, 4, 5], 'bar 9 genuinely lacks pass 3');
    assert.deepEqual(availableBars(index, 3), [1, 2, 3, 4, 5, 6, 7, 8], 'pass 3 is eight bars long');

    const placed = setSlot(start.barSources, 7, barRef(3, 8));
    const stepped = stepBarAt(placed, 7, 1, index, start.mutedSlots);
    assert.deepEqual(stepped[7], barRef(3, 1), 'wrapped at the end of the pass, pass unchanged');
    assert.deepEqual(unresolvedSlots(stepped, index), []);
  });

  it('and P3 / bar 1 steps backward to P3 / bar 8, not bar 16', () => {
    const index = specIndex();
    const start = initialArrangement(index);
    const placed = setSlot(start.barSources, 7, barRef(3, 1));
    assert.deepEqual(stepBarAt(placed, 7, -1, index, start.mutedSlots)[7], barRef(3, 8));
  });

  it('a complete pass still wraps across the whole loop, so nothing familiar changed', () => {
    const index = specIndex();
    const start = initialArrangement(index);
    const placed = setSlot(start.barSources, 7, barRef(4, 16));
    assert.deepEqual(stepBarAt(placed, 7, 1, index, start.mutedSlots)[7], barRef(4, 1));
  });

  it('a slot already stranded by an older build steps back into the pass', () => {
    const index = specIndex();
    const start = initialArrangement(index);
    const stranded = setSlot(start.barSources, 7, barRef(3, 12));
    assert.deepEqual(stepBarAt(stranded, 7, 1, index, start.mutedSlots)[7], barRef(3, 1), 'forward wraps to the start');
    assert.deepEqual(stepBarAt(stranded, 7, -1, index, start.mutedSlots)[7], barRef(3, 8), 'back lands on the last bar it has');
  });
});
