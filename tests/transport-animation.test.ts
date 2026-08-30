import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { framesPerBar } from '../src/domain/timing.ts';
import {
  isPlayed,
  passedAt,
  playLoopFrom,
  playheadAt,
  releaseSlots,
} from '../src/domain/transport.ts';
import { T } from './fixtures.ts';

/**
 * Guards the animation, not just the state.
 *
 * The state-level equivalence between this transport and the kit's is not enough on its
 * own. The Edit Layer mockup renders
 *
 *     passed = max(transport.passedAt(...), tile.resetA)
 *
 * where `resetA` is set to 1 by the cycle event and decays over TAU.reset = 180 ms. That
 * decay *is* the release: without the event the played set stays perfectly correct while
 * the reset degrades from a 180 ms ease into a one-frame snap — invisible to any test that
 * only compares played sets.
 *
 * So this compares what the renderer would actually draw, every frame, for several cycles.
 */

const FPB = framesPerBar(T);
const BARS = T.barCount;
const LINES_PER_BAR = 16;
const COLOR_FEATHER = 2.5;
const TAU_RESET = 180;
const ORIGIN = 5;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeIn = (t: number) => t * t * t;
/** §3.4: full height to 80% as the playhead passes, over a one-line window. */
const heightScale = (passed: number) => 1 - 0.2 * easeIn(clamp01(passed));
/** §3.4: colour fades to spent over a wider 2.5-line feather. */
const colourMix = (passed: number) => clamp01(passed / COLOR_FEATHER);
const approach = (v: number, target: number, tau: number, dt: number) =>
  v + (target - v) * (1 - Math.exp(-dt / tau));

/** `LR.Transport.passedAt`, transcribed from docs/kit/lr-kit.js. */
function kitPassedAt(progress: number, origin: number, globalLine: number): number {
  const head = progress * BARS * LINES_PER_BAR;
  const originLine = origin * LINES_PER_BAR;
  const wrapped = progress * BARS < origin; // the kit's flag, proven equal to this
  if (wrapped && globalLine >= originLine) return COLOR_FEATHER;
  if (globalLine >= (wrapped ? 0 : originLine)) return head - globalLine;
  return -1;
}

/** `LR.Transport.isPlayed`, transcribed from docs/kit/lr-kit.js. */
function kitIsPlayed(progress: number, origin: number, slot: number): boolean {
  const head = progress * BARS;
  const wrapped = head < origin;
  if (wrapped && slot >= origin) return true;
  return slot >= (wrapped ? 0 : origin) && head > slot;
}

describe('transport animation matches the kit', () => {
  const FPS = 60;
  const FRAME_MS = 1000 / FPS;
  const loopSeconds = (BARS * FPB) / T.sampleRate;
  const transport = playLoopFrom(ORIGIN, 0);

  it('draws identical height and colour, frame by frame, over three cycles', () => {
    let ours = 0;
    let kit = 0;
    let compared = 0;
    let worstHeight = 0;
    let worstColour = 0;

    const totalFrames = Math.round(loopSeconds * FPS * 3);

    for (let frame = 0; frame <= totalFrames; frame++) {
      const elapsedSeconds = (frame * FRAME_MS) / 1000;
      const positionFrames = elapsedSeconds * T.sampleRate;
      const head = playheadAt(transport, positionFrames, T);
      assert.ok(head);

      // Both release paths fire off the same cycle edge.
      const cycleJustClosed =
        frame > 0 &&
        Math.floor((elapsedSeconds - FRAME_MS / 1000) / loopSeconds) < head.cyclesCompleted;
      if (cycleJustClosed) {
        ours = 1;
        kit = 1;
      }
      ours = ours > 0.001 ? approach(ours, 0, TAU_RESET, FRAME_MS) : 0;
      kit = kit > 0.001 ? approach(kit, 0, TAU_RESET, FRAME_MS) : 0;

      // The kit indexes progress over the whole arrangement, from slot 0.
      const progress = ((ORIGIN + head.phaseSlots) % BARS) / BARS;
      const wrapped = progress * BARS < ORIGIN;

      for (let slot = 0; slot < BARS; slot += 3) {
        for (let line = 0; line < LINES_PER_BAR; line += 5) {
          const mine = Math.max(passedAt(head, slot, line, LINES_PER_BAR), ours);
          const theirs = Math.max(
            kitPassedAt(progress, ORIGIN, slot * LINES_PER_BAR + line),
            kit,
          );

          // Height agrees everywhere: its window is one line, so both clamp.
          worstHeight = Math.max(worstHeight, Math.abs(heightScale(mine) - heightScale(theirs)));

          // Colour diverges in exactly one place, deliberately — see the test below.
          // Skip the kit's saturating branch and compare everywhere else.
          const kitIsSaturating = wrapped && slot * LINES_PER_BAR + line >= ORIGIN * LINES_PER_BAR;
          if (!kitIsSaturating) {
            worstColour = Math.max(worstColour, Math.abs(colourMix(mine) - colourMix(theirs)));
          }
          compared++;
        }
      }
    }

    assert.ok(compared > 50_000, `only compared ${compared} line-frames`);
    assert.ok(worstHeight < 1e-9, `height diverged by ${worstHeight}`);
    assert.ok(worstColour < 1e-9, `colour diverged by ${worstColour}`);
  });

  it('keeps the colour feather continuous across the wrap — a deliberate divergence', () => {
    // The kit satisfies rule 3 ("hold lines from the origin onward as played") with a
    // blunt constant: `if (wrapped && lineIndex >= originLine) return COLOR_FEATHER`.
    // That holds them, but it also SNAPS the trailing feather. At the instant the
    // playhead leaves the last slot, that slot's final line is one line behind it and
    // should be ~40% spent, still fading; the kit jumps it to 100% in a frame.
    //
    // §3.4 wants "a soft colour edge trailing a crisp height edge", so truncating the
    // soft edge at an arbitrary moment is the discontinuity the motion model exists to
    // avoid. We return the true distance, which holds the line just as played while
    // letting the feather finish.
    const lastLine = LINES_PER_BAR - 1;
    const lastSlot = BARS - 1;

    let previous: number | undefined;
    let worstJump = 0;

    // Walk the playhead across the wrap in fine steps.
    for (let phase = 10.8; phase < 11.4; phase += 0.01) {
      const head = playheadAt(transport, phase * FPB, T);
      const mix = colourMix(passedAt(head, lastSlot, lastLine, LINES_PER_BAR));
      if (previous !== undefined) worstJump = Math.max(worstJump, Math.abs(mix - previous));
      previous = mix;
    }

    // A 0.01-slot step is 0.16 lines, so a continuous feather moves 0.16/2.5 = 0.064 per
    // step. A snap is an order of magnitude bigger than that.
    assert.ok(worstJump < 0.15, `the feather jumped by ${worstJump} across the wrap`);

    // And the kit, for contrast: it snaps.
    const before = kitPassedAt(((ORIGIN + 10.99) % BARS) / BARS, ORIGIN, lastSlot * LINES_PER_BAR + lastLine);
    const after = kitPassedAt(((ORIGIN + 11.01) % BARS) / BARS, ORIGIN, lastSlot * LINES_PER_BAR + lastLine);
    assert.ok(
      Math.abs(colourMix(after) - colourMix(before)) > 0.5,
      'the kit no longer snaps here — re-check whether this divergence is still wanted',
    );
  });

  it('agrees with the kit about the played set at every point in a cycle', () => {
    for (let step = 0; step < BARS * 8; step++) {
      const phase = step / 8;
      const positionFrames = phase * FPB;
      const head = playheadAt(transport, positionFrames, T);
      const progress = ((ORIGIN + phase) % BARS) / BARS;

      for (let slot = 0; slot < BARS; slot++) {
        assert.equal(
          isPlayed(head, slot),
          kitIsPlayed(progress, ORIGIN, slot),
          `slot ${slot} at phase ${phase}`,
        );
      }
    }
  });

  it('releases only what played, which is what the mockup asks isPlayed for', () => {
    // The mockup's stop path is: tiles.forEach((t, i) => { if (isPlayed(i)) t.resetA = 1 })
    const head = playheadAt(transport, 3.5 * FPB, T);
    const mockupWouldRelease = [...Array(BARS).keys()].filter((slot) => isPlayed(head, slot));
    assert.deepEqual(releaseSlots(head), mockupWouldRelease);
    // 3.5 slots in the playhead sits mid-slot-8, so 5, 6, 7 are behind it and 8 has been
    // entered. A slot counts as played from the moment the playhead crosses into it —
    // the kit agrees (`head > slot`), and the test above holds them to that.
    assert.deepEqual(releaseSlots(head), [5, 6, 7, 8]);
  });

  it('starts the release exactly once per cycle', () => {
    const totalFrames = Math.round(loopSeconds * FPS * 3);
    let edges = 0;
    let previous = 0;

    for (let frame = 1; frame <= totalFrames; frame++) {
      const positionFrames = ((frame * FRAME_MS) / 1000) * T.sampleRate;
      const cycles = playheadAt(transport, positionFrames, T)?.cyclesCompleted ?? 0;
      if (cycles > previous) edges++;
      previous = cycles;
    }
    assert.equal(edges, 3, 'the release must fire once per cycle, no more and no fewer');
  });
});
