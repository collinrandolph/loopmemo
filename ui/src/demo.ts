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
 * The fixtures — projects to look at, and synthetic waveform peaks for the ones with no audio.
 *
 * **This is the only invented data in the UI.** Everything else runs on the real domain and the
 * real engine. A recorded take draws its own peaks (`peaks.ts`); `amp` covers the demo shelf,
 * whose sessions hold frame counts and nothing else.
 */

/**
 * Sample amplitude, keyed to the **global** line index so the envelope flows across bar joins.
 *
 * Keyed on the *source* bar, never the slot — swiping a slot onto another pass has to redraw it
 * with that pass's material, which is the whole point of the two indices (§1.1).
 */
export function amp(layerIndex: number, sourceBarIndex: number, lineIndex: number, linesPerBar: number): number {
  const g = sourceBarIndex * linesPerBar + lineIndex + layerIndex * 613;
  const env = 0.55 + 0.3 * Math.sin(g * 0.055) + 0.12 * Math.sin(g * 0.017 + 1.3);
  const det =
    0.22 * Math.sin(g * 1.31) + 0.14 * Math.sin(g * 2.77 + 0.6) + 0.09 * Math.sin(g * 0.61 + 2.2);
  return Math.min(1, Math.max(0.06, env + det));
}

/** A stand-in for the file a real recording or a real compress would have written. */
export function simSession(id: string, frames: number): RecordingSession {
  return {
    id,
    audioFileURL: `sim://${id}`,
    recordedFrames: frames,
    recordedAt: '2026-08-30T00:00:00.000Z',
    waveformPeaks: [],
  };
}

/**
 * A prepared, empty project — settings for a song being written, kept so they outlive a reload.
 *
 * Unlike the rest of the shelf it simulates nothing: no sessions, because it is a starting point
 * rather than a fixture. 84 BPM, 24 bars, and the chord bed unmuted (which `defaultBacking` never
 * is) because the progression is the point.
 */
function preparedSong(): Project {
  return createProject({
    id: 'everything-but-the-light',
    name: 'Everything But the Light',
    bpm: 84,
    barCount: 24,
    quality: 'standard',
    now: '2026-09-01T12:00:00.000Z',
    backing: {
      drums: { patternId: 'boom-bap', kitId: 'lofi', level: 0.7, muted: false },
      chords: {
        chordPatternId: 'sparse-half-note',
        tone: 'rhodes',
        octave: -1,
        slots: [
          { letter: 'A', accidental: 'natural', quality: 'min7' },
          { letter: 'F', accidental: 'natural', quality: 'maj7' },
          { letter: 'C', accidental: 'natural', quality: 'maj7' },
          { letter: 'G', accidental: 'natural', quality: 'major' },
        ],
        level: 0.55,
        muted: false,
      },
    },
  });
}

/**
 * A shelf covering the states the Library row has to show: both qualities, compressed, bounced, a
 * single-layer sketch and a full seven.
 *
 * Bar counts walk the tile-fit behaviour rather than looking varied — 8 is well under the
 * threshold, 20 is the last that holds a full 120px tile at 375×812, and 24, 28 and 32 each
 * compact a little harder. `demoProject` covers 16. `lastModified` is spread across a week
 * because §4.1 sorts on it.
 */
export function demoLibrary(): Project[] {
  const specs: {
    id: string;
    name: string;
    bpm: number;
    barCount: number;
    quality: 'standard' | 'high';
    layers: number;
    passes: number;
    modified: string;
    compressed?: boolean;
    bounced?: boolean;
  }[] = [
    { id: 'hallway', name: 'Hallway Idea', bpm: 128, barCount: 8, quality: 'standard', layers: 3, passes: 2, modified: '2026-08-30T07:40:00.000Z' },
    { id: 'kitchen', name: 'Kitchen Take', bpm: 110, barCount: 20, quality: 'high', layers: 4, passes: 1, modified: '2026-08-29T21:05:00.000Z', compressed: true },
    { id: 'stairwell', name: 'Stairwell', bpm: 104, barCount: 24, quality: 'standard', layers: 2, passes: 1, modified: '2026-08-28T11:30:00.000Z' },
    { id: 'latenight', name: 'Late Night', bpm: 72, barCount: 28, quality: 'standard', layers: 1, passes: 1, modified: '2026-08-27T02:11:00.000Z' },
    { id: 'sunday', name: 'Sunday Loop', bpm: 84, barCount: 32, quality: 'standard', layers: 7, passes: 1, modified: '2026-08-24T21:05:00.000Z', bounced: true },
  ];

  const built = specs.map((s) => {
    const base = createProject({
      id: s.id,
      name: s.name,
      bpm: s.bpm,
      barCount: s.barCount,
      quality: s.quality,
      now: s.modified,
    });
    const t = projectTiming(base);
    const layers = base.layers.map((layer, i) =>
      i < s.layers
        ? recordSession(layer, simSession(`${s.id}-${i}`, s.passes * loopFrames(t)), t)
        : layer,
    );
    return {
      ...base,
      layers,
      isCompressed: s.compressed ?? false,
      ...(s.bounced ? { bouncedFromProjectId: 'gone' } : {}),
    };
  });

  // Deliberately unsorted: the screen sorts, and handing it a sorted list would let a broken sort
  // look correct. `preparedSong` skips `richLayer`, which would start writing simulated takes into
  // a project meant to be empty the moment its early return stopped applying.
  return [built[3]!, demoProject(), built[0]!, built[4]!, built[1]!, built[2]!]
    .map(richLayer)
    .concat(preparedSong());
}

/**
 * Give a project's first layer the states `demoProject` carries, at whatever bar count it has.
 *
 * Otherwise every demo layer is one clean pass in recorded order, which says nothing about whether
 * a tile can still show a two-digit pass number, a colour jump or a muted bar once the grid has
 * shrunk to fit. Everything is proportional to `barCount`, so one shape covers all eight lengths.
 */
function richLayer(project: Project): Project {
  const t = projectTiming(project);
  const loop = loopFrames(t);
  const bars = project.barCount;
  const first = project.layers[0]!;
  if (first.sessions.length === 0) return project;

  // §1.4's shape: a long take stopping part way through its third traversal, then a second take.
  // Passes 1, 2, 4 and 5 cover every bar; pass 3 covers only the front half, so the back half of
  // the grid carries a real gap in its available set.
  let l = recordSession(
    { ...first, sessions: [] },
    simSession(`${project.id}-a`, 2 * loop + Math.floor(bars / 2) * framesPerBar(t)),
    t,
  );
  l = recordSession(l, simSession(`${project.id}-b`, 2 * loop), t);

  /** A slot at a fraction of the grid, and a bar number that exists at any length. */
  const at = (fraction: number) => Math.min(bars - 1, Math.floor(bars * fraction));
  const barAt = (fraction: number) => Math.min(bars, Math.max(1, Math.round(bars * fraction)));

  let sources = l.barSources;
  // Two adjacent slots pulled from late in pass 4 — a jump big enough to read as a colour break.
  sources = setSlot(sources, at(0.14), barRef(4, barAt(0.66)));
  sources = setSlot(sources, at(0.17), barRef(4, barAt(0.69)));
  sources = setSlot(sources, at(0.56), barRef(2, barAt(0.22))); // one in the second half
  sources = setSlot(sources, at(0.91), barRef(5, barAt(0.09))); // one in the last row

  return {
    ...project,
    layers: project.layers.map((layer, i) =>
      i === 0
        ? {
            ...l,
            name: layer.name || 'Keys',
            barSources: sources,
            mutedSlots: setSlotMuted(l.mutedSlots, at(0.35), true),
          }
        : layer,
    ),
  };
}

/**
 * A project chosen to show the states that were decided but never seen.
 *
 * - **Layer 1** is §1.4's worked example — two sessions, five passes, and a real gap where bars
 *   9–16 have no pass 3. Two slots are pulled from elsewhere so the colour jumps, and one is muted.
 * - **Layer 2** is ordinary: one clean pass, recorded order, nothing muted.
 * - **Layer 3** stopped part way through its first pass, so the slots it never reached hold `P1/1`
 *   placeholders and start muted (§1.6).
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
      let l = recordSession(layer, simSession('a', 2 * loop + 8 * bar), t);
      l = recordSession(l, simSession('b', 2 * loop), t);
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
      const l = recordSession(layer, simSession('c', loop), t);
      return { ...l, name: 'Bass', level: 0.82, eq: 'lowCut', pan: 'center' };
    }
    if (i === 2) {
      const l = recordSession(layer, simSession('d', 9 * bar + bar / 2), t);
      return { ...l, name: 'Shaker', level: 0.55, eq: 'highCut', pan: 'surround' };
    }
    return layer;
  });

  return { ...base, layers };
}
