import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { barRef } from '../src/domain/bar-ref.ts';
import { NONE_MUTED } from '../src/domain/arrangement.ts';
import { availablePasses, passIndex, regionFor, totalPasses } from '../src/domain/pass-index.ts';
import {
  LATENCY_OFFSET_MAX_SECONDS,
  clampLatencyOffset,
  createProject,
  latencyOffsetFrames,
  projectTiming,
} from '../src/domain/project.ts';
import { segments } from '../src/domain/schedule-plan.ts';
import { timing } from '../src/domain/timing.ts';
import { FPB, LOOP, T, session, specIndex } from './fixtures.ts';

/**
 * The recording offset (§2.3).
 *
 * The sign gets its own tests because getting it backwards *doubles* the error instead of
 * removing it — and that sounds like worse playing rather than a broken app, so nothing would
 * ever point at it. The same reasoning as the capture-side sign test this replaces.
 */
describe('latency offset', () => {
  it('is stored in seconds and converts to frames at the project rate', () => {
    // Physical duration, not a frame count: the same 50 ms must mean 2205 frames at 44.1k and
    // 2400 at 48k, which a stored frame count could not.
    assert.equal(latencyOffsetFrames(timing(96, 16, 44_100), 0.05), 2205);
    assert.equal(latencyOffsetFrames(timing(96, 16, 48_000), 0.05), 2400);
  });

  it('clamps to 0..250 ms and never goes negative', () => {
    assert.equal(clampLatencyOffset(-0.01), 0);
    assert.equal(clampLatencyOffset(0.4), LATENCY_OFFSET_MAX_SECONDS);
    assert.equal(clampLatencyOffset(Number.NaN), 0);
    assert.equal(clampLatencyOffset(0.05), 0.05);
    // A negative offset would mean the performance reached the microphone before the cue was
    // heard. The clamp is what stops the control expressing it.
    assert.equal(latencyOffsetFrames(T, -1), 0);
  });

  it('a new project inherits the offset it is given, clamped', () => {
    const base = { id: 'p', name: 'P', bpm: 96, barCount: 16, quality: 'standard' as const };
    assert.equal(createProject(base).latencyOffsetSeconds, 0);
    assert.equal(createProject({ ...base, latencyOffsetSeconds: 0.04 }).latencyOffsetSeconds, 0.04);
    assert.equal(
      createProject({ ...base, latencyOffsetSeconds: 9 }).latencyOffsetSeconds,
      LATENCY_OFFSET_MAX_SECONDS,
    );
  });

  it('reads FURTHER INTO the take, which plays the audio earlier', () => {
    const index = specIndex();
    const plain = regionFor(index, barRef(1, 5))!;
    const shifted = regionFor(index, barRef(1, 5), 2205)!;
    // Later in the source file, so what was captured late arrives on the beat.
    assert.equal(shifted.startFrame, plain.startFrame + 2205);
    assert.equal(shifted.sessionIndex, plain.sessionIndex);
  });

  it('does not change which passes or bars exist, at any offset', () => {
    // The invariant the whole design rests on. `barExists` is decided by the transport at
    // capture; if the offset could move it, dragging the control would renumber passes and
    // change the pass count of a take already on disk.
    const index = specIndex();
    for (const offset of [0, 441, 2205, latencyOffsetFrames(T, LATENCY_OFFSET_MAX_SECONDS)]) {
      assert.equal(totalPasses(index), 5, `totalPasses at ${offset}`);
      assert.deepEqual(availablePasses(index, 1), [1, 2, 3, 4, 5], `bar 1 at ${offset}`);
      assert.deepEqual(availablePasses(index, 12), [1, 2, 4, 5], `bar 12 at ${offset}`);
      // And the bar that does not exist still does not exist.
      assert.equal(regionFor(index, barRef(3, 12), offset), undefined);
    }
  });

  it('runs the last bar of a take short rather than reading past the end', () => {
    // One pass exactly. The final bar has no tail, so the offset eats into it — there is
    // genuinely no audio there, and the alternative is padding silence and calling it a take.
    const index = passIndex([session(LOOP, 'one')], T);
    const last = regionFor(index, barRef(1, 16), 2205)!;
    assert.equal(last.frameCount, FPB - 2205);
    // An earlier bar is unaffected: its tail is the next bar of the same recording.
    assert.equal(regionFor(index, barRef(1, 15), 2205)!.frameCount, FPB);
  });

  it('carries through segments() to every scheduled region', () => {
    const index = specIndex();
    const arrangement = [barRef(1, 1), barRef(2, 2), barRef(1, 3)];
    const plain = segments(arrangement, index, 0, 3, NONE_MUTED);
    const shifted = segments(arrangement, index, 0, 3, NONE_MUTED, 2205);

    assert.equal(shifted.length, plain.length);
    for (const [i, seg] of shifted.entries()) {
      assert.equal(seg.region.startFrame, plain[i]!.region.startFrame + 2205);
      // The *schedule* is untouched — only where the audio is read from moves. A slot still
      // plays at its own bar line, or the offset would shift the arrangement rather than
      // correct the performance.
      assert.equal(seg.startFrame, plain[i]!.startFrame);
      assert.equal(seg.slot, plain[i]!.slot);
    }
  });

  it('leaves the schedule alone when the project is uncompensated', () => {
    const project = createProject({
      id: 'p',
      name: 'P',
      bpm: 96,
      barCount: 16,
      quality: 'standard',
    });
    assert.equal(latencyOffsetFrames(projectTiming(project), project.latencyOffsetSeconds), 0);
  });
});
