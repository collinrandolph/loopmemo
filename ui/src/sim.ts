import { setSlot, setSlotMuted } from '../../src/domain/arrangement.ts';
import { barRef } from '../../src/domain/bar-ref.ts';
import type { RecordingSession } from '../../src/domain/pass-index.ts';
import {
  type Layer,
  type Project,
  createProject,
  projectTiming,
  recordSession,
} from '../../src/domain/project.ts';
import { framesPerBar, loopFrames } from '../../src/domain/timing.ts';

/**
 * The simulated audio engine and a project to look at.
 *
 * **This file is the only fake part of the UI, and that is the point.** Everything else
 * imports `src/domain` unchanged. The real audio engine replaces exactly this surface — a
 * frame position and some sample data — so if a screen ever needs something from here that a
 * real engine could not provide, the platform-bound surface has grown and the deferral is
 * failing (see the platform section of CLAUDE.md).
 */

/**
 * A frame counter, which is all transport asks of the engine.
 *
 * §2.4's divergence 1 says transport owns no clock because a software clock free-runs against
 * the audible playhead. In simulation there is no audible playhead, so this *is* the engine —
 * but it stays on the engine's side of the line so the substitution is a swap, not a rewrite.
 */
export type Engine = {
  frame(): number;
  running(): boolean;
  start(atFrame: number): void;
  stop(): void;
};

export function simulatedEngine(sampleRate: number): Engine {
  let origin = 0;
  let startedAt: number | undefined;

  return {
    frame: () =>
      startedAt === undefined
        ? origin
        : origin + Math.round(((performance.now() - startedAt) / 1000) * sampleRate),
    running: () => startedAt !== undefined,
    start(atFrame) {
      origin = atFrame;
      startedAt = performance.now();
    },
    stop() {
      origin = this.frame();
      startedAt = undefined;
    },
  };
}

/**
 * Sample amplitude, as the mockup generates it: an envelope keyed to the **global** line
 * index so it flows across bar joins rather than restarting each bar.
 *
 * Keyed on the *source* bar, never the slot — swiping a slot onto another pass has to redraw
 * it with that pass's material, which is the whole point of the two indices (§1.1).
 */
export function amp(layerIndex: number, sourceBarIndex: number, lineIndex: number, linesPerBar: number): number {
  const g = sourceBarIndex * linesPerBar + lineIndex + layerIndex * 613;
  const env = 0.55 + 0.3 * Math.sin(g * 0.055) + 0.12 * Math.sin(g * 0.017 + 1.3);
  const det =
    0.22 * Math.sin(g * 1.31) + 0.14 * Math.sin(g * 2.77 + 0.6) + 0.09 * Math.sin(g * 0.61 + 2.2);
  return Math.min(1, Math.max(0.06, env + det));
}

function session(id: string, frames: number): RecordingSession {
  return {
    id,
    audioFileURL: `sim://${id}`,
    recordedFrames: frames,
    recordedAt: '2026-08-30T00:00:00.000Z',
    waveformPeaks: [],
  };
}

/**
 * A project chosen to show the states that were decided but never seen.
 *
 * - **Layer 1** is §1.4's worked example — two sessions, five passes, and a real gap where
 *   bars 9–16 have no pass 3. Two slots are pulled from elsewhere so the colour jumps, and
 *   one is muted.
 * - **Layer 2** is ordinary: one clean pass, recorded order, nothing muted.
 * - **Layer 3** stopped part way through its first pass, so the slots it never reached hold
 *   `P1/1` placeholders and start muted (§1.6).
 */
export function demoProject(): Project {
  const base = createProject({
    id: 'demo',
    name: 'Rooftop',
    bpm: 96,
    barCount: 16,
    quality: 'standard',
    now: '2026-08-30T09:12:00.000Z',
  });
  const t = projectTiming(base);
  const loop = loopFrames(t);
  const bar = framesPerBar(t);

  const layers: Layer[] = base.layers.map((layer, i) => {
    if (i === 0) {
      let l = recordSession(layer, session('a', 2 * loop + 8 * bar), t);
      l = recordSession(l, session('b', 2 * loop), t);
      let sources = l.barSources;
      sources = setSlot(sources, 2, barRef(4, 11)); // a jump, mid-row
      sources = setSlot(sources, 3, barRef(4, 12));
      sources = setSlot(sources, 9, barRef(2, 3)); // and another, later
      return {
        ...l,
        name: 'Rhodes',
        eq: 'presence',
        pan: 'slightL',
        barSources: sources,
        mutedSlots: setSlotMuted(l.mutedSlots, 13, true),
      };
    }
    if (i === 1) {
      const l = recordSession(layer, session('c', loop), t);
      return { ...l, name: 'Bass', level: 0.82, eq: 'lowCut', pan: 'center' };
    }
    if (i === 2) {
      const l = recordSession(layer, session('d', 9 * bar + bar / 2), t);
      return { ...l, name: 'Shaker', level: 0.55, eq: 'highCut', pan: 'surround' };
    }
    return layer;
  });

  return { ...base, layers };
}
