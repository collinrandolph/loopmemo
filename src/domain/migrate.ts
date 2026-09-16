import type { BarRef } from './bar-ref.ts';
import { type BackingTracks, type ChordBed, type DrumTrack, defaultBacking } from './backing.ts';
import type { RecordingSession } from './pass-index.ts';
import { type Layer, type Project, LEVEL_UNITY } from './project.ts';

/**
 * Bringing a stored project up to today's shape.
 *
 * **A stored project is only as new as the day it was saved**, and `Project` gains fields. A field
 * added today reads `undefined` on everything saved before today, and the failures are silent: a
 * boolean reads as *off*, so a default of true inverts itself on existing work; a missing
 * `recordedFrames` makes pass count and size `NaN`, and the layer quietly stops sounding.
 *
 * **The rule used to be a comment — "add a line here" — and a comment is not a rule.** Every type
 * below is filled through a `Fill<T>`, which has one required entry per key of `T`, optional keys
 * included. Adding a field to `Project`, `Layer`, `RecordingSession` or either backing track is a
 * compile error until someone has written down what an old project gets for it. That is the whole
 * point of this file; the defaults are the easy part.
 *
 * **Default on load, never refuse.** Refusing a project that does not match loses the user's work
 * over a field they never saw, and repairing it is exactly this with more ceremony (decided
 * 2026-09-16). Pure, so it is tested under `npm test` rather than only in a browser.
 *
 * **Identity is carried, not invented.** An `id`, a `createdDate` or a take's `audioFileURL` has
 * no meaningful default — a made-up one points at nothing — so those entries pass the stored value
 * through. They are still listed, which is the point: a decision was made about each.
 */

/** A stored value of unknown vintage: any key may be missing. */
type Stored<T> = { readonly [K in keyof T]?: unknown };

/** One entry per key of `T`, optional keys included (`-?`), each saying what an old value becomes. */
type Fill<T> = { readonly [K in keyof T]-?: (stored: Stored<T>) => T[K] };

function fill<T>(spec: Fill<T>, raw: unknown): T {
  const stored = (raw !== null && typeof raw === 'object' ? raw : {}) as Stored<T>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(spec) as (keyof T & string)[]) {
    const value = spec[key](stored);
    // `exactOptionalPropertyTypes`: an absent optional key stays absent rather than becoming
    // `key: undefined`, which is a different value to that compiler and to `in`.
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
/** Identity: carried as stored. See the file comment. */
const carried = <V>(v: unknown) => v as V;

const SESSION: Fill<RecordingSession> = {
  id: (s) => carried(s.id),
  audioFileURL: (s) => carried(s.audioFileURL),
  // Zero, not a guess from the peaks: a session with no frames holds no passes, which is honest
  // and resolves nothing, where a guess would claim audio of a length nobody measured.
  recordedFrames: (s) => num(s.recordedFrames, 0),
  recordedAt: (s) => str(s.recordedAt, ''),
  waveformPeaks: (s) => list(s.waveformPeaks).filter((p): p is number => typeof p === 'number'),
};

const LAYER: Fill<Layer> = {
  id: (s) => carried(s.id),
  index: (s) => carried(s.index),
  name: (s) => str(s.name, ''),
  level: (s) => num(s.level, LEVEL_UNITY),
  muted: (s) => bool(s.muted, false),
  eq: (s) => str(s.eq, 'flat') as Layer['eq'],
  pan: (s) => str(s.pan, 'center') as Layer['pan'],
  sessions: (s) => list(s.sessions).map((x) => fill(SESSION, x)),
  barSources: (s) => list(s.barSources) as readonly BarRef[],
  mutedSlots: (s) => list(s.mutedSlots).filter((n): n is number => typeof n === 'number'),
};

function drums(base: DrumTrack): Fill<DrumTrack> {
  return {
    patternId: (s) => str(s.patternId, base.patternId),
    kitId: (s) => str(s.kitId, base.kitId),
    level: (s) => num(s.level, base.level),
    muted: (s) => bool(s.muted, base.muted),
  };
}

function chords(base: ChordBed): Fill<ChordBed> {
  return {
    chordPatternId: (s) => str(s.chordPatternId, base.chordPatternId),
    tone: (s) => str(s.tone, base.tone) as ChordBed['tone'],
    octave: (s) => num(s.octave, base.octave) as ChordBed['octave'],
    // Exactly `CHORD_SLOT_COUNT` — the default's length — whatever was stored: the tiling rule
    // indexes into it.
    slots: (s) => {
      const stored = list(s.slots) as ChordBed['slots'];
      return base.slots.map((slot, i) => stored[i] ?? slot);
    },
    level: (s) => num(s.level, base.level),
    muted: (s) => bool(s.muted, base.muted),
  };
}

function backing(): Fill<BackingTracks> {
  const base = defaultBacking();
  return {
    drums: (s) => fill(drums(base.drums), s.drums),
    chords: (s) => fill(chords(base.chords), s.chords),
  };
}

const PROJECT: Fill<Project> = {
  id: (s) => carried(s.id),
  name: (s) => str(s.name, ''),
  createdDate: (s) => carried(s.createdDate),
  lastModified: (s) => str(s.lastModified, str(s.createdDate, '')),
  bpm: (s) => carried(s.bpm),
  barCount: (s) => carried(s.barCount),
  beatsPerBar: (s) => num(s.beatsPerBar, 4),
  audioQuality: (s) => (s.audioQuality === 'high' ? 'high' : 'standard'),
  isCompressed: (s) => bool(s.isCompressed, false),
  bouncedFromProjectId: (s) => (typeof s.bouncedFromProjectId === 'string' ? s.bouncedFromProjectId : undefined),
  backing: (s) => fill(backing(), s.backing),
  latencyOffsetSeconds: (s) => num(s.latencyOffsetSeconds, 0),
  // True, and this is the case the rule exists for: `undefined` would read as off.
  perfectLoop: (s) => bool(s.perfectLoop, true),
  layers: (s) => list(s.layers).map((x) => fill(LAYER, x)),
};

/** Every project read from storage goes through here. */
export function migrateProject(stored: unknown): Project {
  return fill(PROJECT, stored);
}
