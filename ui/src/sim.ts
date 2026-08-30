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

/** Deterministic, so the same bar of the same pass always draws the same way. */
function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Peak heights for one absolute bar of a layer.
 *
 * Keyed on the **source** bar rather than the slot, so swiping a slot onto another pass
 * redraws it with that pass's material — which is the whole point of the two indices (§1.1).
 */
export function barPeaks(layerIndex: number, absoluteBar: number, count: number): number[] {
  const rnd = noise(layerIndex * 7919 + absoluteBar * 104729);
  const out: number[] = [];
  let env = 0.35 + rnd() * 0.35;
  for (let i = 0; i < count; i++) {
    env = Math.min(1, Math.max(0.12, env + (rnd() - 0.48) * 0.35));
    const accent = i % 4 === 0 ? 1.25 : 1;
    out.push(Math.min(1, env * accent));
  }
  return out;
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
