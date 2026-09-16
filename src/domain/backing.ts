/**
 * Backing tracks (§2.6, §4.4): the drum track and the chord bed.
 *
 * **Both are synthesised, so neither is a file.** No `audioFileURL`, no `originalBPM`, no playback
 * ratio — that apparatus existed to stretch a sampled loop to the project tempo, and synthesis
 * deleted the problem rather than solving it (§5.2). `patternId` and `kitId` name recipes.
 *
 * **This is the whole model, not a subset**: one definition of the chord vocabulary and of what a
 * track is, so nothing can hold a second copy that drifts.
 *
 * Pure data and pure arithmetic. Turning it into sound is the platform's job; `backing-schedule.ts`
 * is the frame arithmetic between the two.
 */

// ---------------------------------------------------------------- chords --

export type Accidental = 'natural' | 'flat' | 'sharp';
export type ChordQuality = 'major' | 'minor' | 'dom7' | 'min7' | 'maj7';

/**
 * One chord slot.
 *
 * **There is no scale, and quality is stored rather than derived** (§4.4, deprecated on this
 * point). The user picks "D minor", not "D in the key of C". Two things follow: *outside the
 * scale* cannot exist without a scale, so there is no marked slot state; and a slot can never be
 * wrong, so nothing is corrected on the user's behalf.
 */
export type Chord = {
  readonly letter: string;
  readonly accidental: Accidental;
  readonly quality: ChordQuality;
};

export const NOTE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

/** `label` is what a picker shows; `suffix` is what the chord spells. */
export const ACCIDENTALS: readonly { id: Accidental; label: string; suffix: string }[] = [
  { id: 'natural', label: '♮', suffix: '' },
  { id: 'flat', label: '♭', suffix: '♭' },
  { id: 'sharp', label: '♯', suffix: '♯' },
];

export const QUALITIES: readonly { id: ChordQuality; label: string; suffix: string }[] = [
  { id: 'major', label: 'Maj', suffix: '' },
  { id: 'minor', label: 'Min', suffix: 'm' },
  { id: 'dom7', label: '7', suffix: '7' },
  { id: 'min7', label: 'm7', suffix: 'm7' },
  { id: 'maj7', label: 'Maj7', suffix: 'maj7' },
];

/**
 * Five qualities, deliberately. Diminished, augmented, suspended and anything past the seventh
 * were left out on the same footing as swung chord patterns (§2.6): the bed gives a sketch a
 * harmonic floor, and a vocabulary that needs scrolling is slower than the thing it is backing.
 */
const QUALITY_INTERVALS: Record<ChordQuality, readonly number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
};

const LETTER_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL_OFFSET: Record<Accidental, number> = { natural: 0, flat: -1, sharp: 1 };

/** Standard spelling, so a slot reads as one chord rather than as three settings. */
export function chordLabel(chord: Chord): string {
  const accidental = ACCIDENTALS.find((a) => a.id === chord.accidental)?.suffix ?? '';
  const quality = QUALITIES.find((q) => q.id === chord.quality)?.suffix ?? '';
  return `${chord.letter}${accidental}${quality}`;
}

// ---------------------------------------------------------------- octave --

/**
 * Three positions, ±1 from the mid-register default (§4.4).
 *
 * Built as ±2 and narrowed after listening: the outer two octaves were hard to listen to and
 * bought nothing. Once there are only three, Low / Default / High reads better than signed
 * numbers, which is why the labels are words.
 */
export type Octave = -1 | 0 | 1;

export const OCTAVES: readonly { value: Octave; label: string }[] = [
  { value: -1, label: 'Low' },
  { value: 0, label: 'Default' },
  { value: 1, label: 'High' },
];

/**
 * Root before the octave setting is applied. MIDI 60 is C4 — the mid-register default §4.4 asks
 * for, so that the bed sits under vocals.
 */
const ROOT_MIDI = 60;

/** Concert A. The one number in here that is a standard rather than a choice. */
const A4_HZ = 440;
const A4_MIDI = 69;

/** The chord's notes as MIDI numbers, lowest first. */
export function chordMidiNotes(chord: Chord, octave: Octave = 0): readonly number[] {
  const letter = LETTER_SEMITONE[chord.letter];
  if (letter === undefined) throw new RangeError(`unknown note letter ${chord.letter}`);
  const root = ROOT_MIDI + letter + ACCIDENTAL_OFFSET[chord.accidental] + octave * 12;
  return QUALITY_INTERVALS[chord.quality].map((interval) => root + interval);
}

/**
 * The chord's notes in Hz, twelve-tone equal temperament.
 *
 * Frequencies rather than frames, and that is not a units slip: a pitch is not a duration, so it
 * does not convert to sample frames and does not depend on the project's rate. **This is exactly
 * why the chord bed is immune to time-stretch** (§2.6) — the note is generated at the right
 * frequency whatever the tempo, so changing BPM moves only when it fires.
 */
export function chordFrequencies(chord: Chord, octave: Octave = 0): readonly number[] {
  return chordMidiNotes(chord, octave).map((midi) => A4_HZ * 2 ** ((midi - A4_MIDI) / 12));
}

// ------------------------------------------------------------ drum voices --

export type DrumVoice = 'kick' | 'snare' | 'hat' | 'hatOpen';

/**
 * Scheduling order within a bar. Ties are broken by this order rather than left to sort
 * stability, because the hat choke depends on hats being reached in a defined sequence
 * (`backing-schedule.ts`), and "whatever `sort` happened to do" is not a rule.
 */
export const DRUM_VOICES: readonly DrumVoice[] = ['kick', 'snare', 'hat', 'hatOpen'];

/**
 * One bar of onsets, looped for the whole project (§2.6).
 *
 * Beats are **1-based within the bar**, and `.5` is the off-beat halfway to the next count — 2.5
 * is "the and of 2". Every onset in the library lands on a straight beat or eighth; no swung or
 * triplet-subdivided pattern is accepted, because it would introduce a second timing grammar
 * alongside the straight one everything else uses.
 */
export type DrumPattern = {
  readonly id: string;
  readonly name: string;
  readonly feel: string;
  readonly voices: Readonly<Partial<Record<DrumVoice, readonly number[]>>>;
};

/**
 * Six. The cap is ten per track type, with more than five needing a justification for the value
 * it adds — these are the ones that cleared it.
 *
 * An earlier design baked a sample kit into each of these, specifically to avoid auditioning
 * every kit against every pattern as recorded audio. Synthesis makes a kit a parameter set, so
 * that cost is zero and the two are independent axes now (§5.2). The beat positions are unchanged
 * from that design; only the kit coupling went.
 */
export const DRUM_PATTERNS: readonly DrumPattern[] = [
  {
    id: 'four-on-the-floor',
    name: 'Four on the Floor',
    feel: 'Steady dance pulse',
    voices: { kick: [1, 2, 3, 4], snare: [2, 4], hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5] },
  },
  {
    id: 'backbeat-pop',
    name: 'Backbeat Pop',
    feel: 'Generic rock/pop default',
    voices: { kick: [1, 3], snare: [2, 4], hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5] },
  },
  {
    id: 'boom-bap',
    name: 'Boom Bap',
    feel: 'Head-nod hip-hop',
    voices: { kick: [1, 2.5], snare: [2, 4], hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5] },
  },
  {
    id: 'half-time',
    name: 'Half-Time',
    feel: 'Modern half-time hip-hop/rock',
    voices: { kick: [1], snare: [3], hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5] },
  },
  {
    id: 'syncopated-pop',
    name: 'Syncopated Pop',
    feel: 'Contemporary R&B/pop',
    voices: {
      kick: [1, 2.5, 3],
      snare: [2, 4],
      hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5],
      // A separate voice rather than a flag on the hat, so the open accent can ring past the
      // loop point on its own decay while the closed hats keep their own.
      hatOpen: [4.5],
    },
  },
  {
    id: 'one-drop',
    name: 'One-Drop',
    feel: 'Reggae',
    voices: { kick: [3], snare: [3], hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5] },
  },
];

export function drumPattern(id: string): DrumPattern {
  const found = DRUM_PATTERNS.find((p) => p.id === id);
  if (!found) throw new RangeError(`unknown drum pattern ${id}`);
  return found;
}

// -------------------------------------------------------------- drum kits --

/**
 * A kit's voice parameters.
 *
 * **Times are seconds, not frames, and that is deliberate** — the same reasoning as
 * `TOLERANCE_SECONDS`. A kick's decay is a physical envelope, not a musical duration: it is the
 * same length at 60 BPM and at 240, so a frame count here would silently mean different envelopes
 * at 44.1 kHz and 48 kHz. `kitFrames` converts at the boundary.
 *
 * Frequencies stay in Hz for the reason `chordFrequencies` does: a pitch is not a duration.
 */
export type DrumKit = {
  readonly id: string;
  readonly name: string;
  /** Reference material for whoever is tuning these — **not UI copy** (§2.6). */
  readonly description: string;
  readonly kick: {
    readonly startFreq: number;
    readonly endFreq: number;
    readonly sweepSeconds: number;
    readonly seconds: number;
    readonly clickGain: number;
    readonly clickFreq: number;
  };
  readonly snare: {
    readonly body1: number;
    readonly body2: number;
    readonly bodySeconds: number;
    readonly noiseHighpass: number;
    readonly seconds: number;
  };
  readonly hat: {
    readonly highpass: number;
    readonly bandpass: number;
    readonly closedSeconds: number;
    readonly openSeconds: number;
  };
};

/**
 * Four, matching the size of the chord-tone list.
 *
 * **A kit has to occupy a genuinely different region of the parameter space to read as distinct.**
 * A fifth that only nudged another's numbers by 10–15% was indistinguishable by ear and was cut;
 * Punchy replaced it by pushing hard toward short-and-bright, which is why every duration in it is
 * the shortest of any kit rather than merely shorter.
 */
export const DRUM_KITS: readonly DrumKit[] = [
  {
    id: 'tight',
    name: 'Tight',
    description: 'Punchy and modern — the default character',
    kick: { startFreq: 150, endFreq: 48, sweepSeconds: 0.09, seconds: 0.26, clickGain: 0.45, clickFreq: 1400 },
    snare: { body1: 190, body2: 240, bodySeconds: 0.08, noiseHighpass: 1200, seconds: 0.19 },
    hat: { highpass: 7000, bandpass: 10000, closedSeconds: 0.06, openSeconds: 0.35 },
  },
  {
    id: 'deep',
    name: 'Deep',
    description: '808-leaning — long sub kick, clap-like snare',
    kick: { startFreq: 120, endFreq: 38, sweepSeconds: 0.15, seconds: 0.4, clickGain: 0.28, clickFreq: 1000 },
    snare: { body1: 170, body2: 210, bodySeconds: 0.06, noiseHighpass: 900, seconds: 0.24 },
    hat: { highpass: 6000, bandpass: 8500, closedSeconds: 0.05, openSeconds: 0.3 },
  },
  {
    id: 'punchy',
    name: 'Punchy',
    description: 'Short and bright — trap-leaning, tight and clicky',
    kick: { startFreq: 200, endFreq: 55, sweepSeconds: 0.035, seconds: 0.14, clickGain: 0.6, clickFreq: 2200 },
    snare: { body1: 220, body2: 300, bodySeconds: 0.04, noiseHighpass: 2000, seconds: 0.13 },
    hat: { highpass: 9000, bandpass: 12000, closedSeconds: 0.03, openSeconds: 0.22 },
  },
  {
    id: 'lofi',
    name: 'Lo-fi',
    description: 'Darker and softer, dusty character',
    kick: { startFreq: 110, endFreq: 42, sweepSeconds: 0.12, seconds: 0.3, clickGain: 0.18, clickFreq: 650 },
    snare: { body1: 160, body2: 200, bodySeconds: 0.09, noiseHighpass: 700, seconds: 0.24 },
    hat: { highpass: 4200, bandpass: 5800, closedSeconds: 0.08, openSeconds: 0.32 },
  },
];

export function drumKit(id: string): DrumKit {
  const found = DRUM_KITS.find((k) => k.id === id);
  if (!found) throw new RangeError(`unknown drum kit ${id}`);
  return found;
}

/**
 * How long a voice of this kit rings, in frames at the project's rate.
 *
 * Closed and open hat share one recipe and differ only here — the same way strike and chunk are
 * one chord voice with two envelopes, not a fourth sound (§2.6).
 */
export function kitVoiceFrames(kit: DrumKit, voice: DrumVoice, sampleRate: number): number {
  const seconds =
    voice === 'kick'
      ? kit.kick.seconds
      : voice === 'snare'
        ? kit.snare.seconds
        : voice === 'hat'
          ? kit.hat.closedSeconds
          : kit.hat.openSeconds;
  return Math.round(seconds * sampleRate);
}

// ---------------------------------------------------------- chord patterns --

/** A strike rings per the tone's own envelope; a chunk is short, damped and quieter. */
export type Articulation = 'strike' | 'chunk';

/**
 * The chord bed's rhythm, on the same one-bar straight-eighth grid as the drums.
 *
 * **One setting for the whole progression, not one per slot** (§2.6). A per-slot pattern was
 * considered and rejected: it is the axis most likely to make a four-bar bed sound arranged
 * rather than supportive, and it is a fourth per-slot decision in a control whose justification
 * is that it is quick.
 */
export type ChordPattern = {
  readonly id: string;
  readonly name: string;
  readonly feel: string;
  readonly strikes: readonly number[];
  readonly chunks: readonly number[];
};

export const CHORD_PATTERNS: readonly ChordPattern[] = [
  { id: 'sustain', name: 'Sustain', feel: 'Holds the chord, no rhythm', strikes: [1], chunks: [] },
  {
    id: 'sparse-half-note',
    name: 'Sparse / Half-note',
    feel: 'Between Sustain and Steady Quarters',
    strikes: [1, 3],
    chunks: [],
  },
  { id: 'steady-quarters', name: 'Steady Quarters', feel: 'Plain pulse', strikes: [1, 2, 3, 4], chunks: [] },
  {
    id: 'backbeat-strum',
    name: 'Backbeat Strum',
    feel: 'Classic pop/folk down-strum',
    strikes: [1, 3],
    chunks: [2.5, 4.5],
  },
  {
    id: 'off-beat-skank',
    name: 'Off-beat Skank',
    feel: 'Reggae/ska, nothing on the downbeat',
    strikes: [],
    chunks: [1.5, 2.5, 3.5, 4.5],
  },
  {
    id: 'syncopated-push',
    name: 'Syncopated Push',
    feel: 'Chord arrives early into the next bar',
    strikes: [1, 3, 4.5],
    chunks: [2.5],
  },
  {
    id: 'fast-8th-note',
    name: 'Fast 8th-note',
    feel: 'Every 8th filled — busy, driving',
    strikes: [1, 2, 3, 4],
    chunks: [1.5, 2.5, 3.5, 4.5],
  },
];

export function chordPattern(id: string): ChordPattern {
  const found = CHORD_PATTERNS.find((p) => p.id === id);
  if (!found) throw new RangeError(`unknown chord pattern ${id}`);
  return found;
}

// ------------------------------------------------------------ chord tones --

export type ChordToneId = 'rhodes' | 'pad' | 'wurly' | 'organ';

export type ChordTone = {
  readonly id: ChordToneId;
  readonly name: string;
  /**
   * How long a strike rings before the chord pattern's next onset is even considered, in seconds.
   * Seconds for the same reason a kit's are: an envelope is physical, not musical.
   *
   * **Pad's is the number that makes backing tails a real problem** (§2.6) — 2.2 s outlives most
   * bars in the app's tempo range, so a strike late in the last bar is still sounding when a
   * fixed-length bounce stops. Live it simply overlaps the next pass, which is correct.
   */
  readonly strikeSeconds: number;
  readonly chunkSeconds: number;
};

/**
 * Four. Wurly replaced a nylon-guitar tone whose plucked-string model was unfixably prone to
 * resonant buildup under dense patterns; a plain oscillator-and-envelope recipe replaced it
 * outright, matching how the other three are built.
 */
export const CHORD_TONES: readonly ChordTone[] = [
  { id: 'rhodes', name: 'Rhodes', strikeSeconds: 1.5, chunkSeconds: 0.12 },
  { id: 'pad', name: 'Pad', strikeSeconds: 2.2, chunkSeconds: 0.15 },
  { id: 'wurly', name: 'Wurly', strikeSeconds: 1.1, chunkSeconds: 0.12 },
  { id: 'organ', name: 'Organ', strikeSeconds: 1.0, chunkSeconds: 0.1 },
];

export function chordTone(id: ChordToneId): ChordTone {
  const found = CHORD_TONES.find((t) => t.id === id);
  if (!found) throw new RangeError(`unknown chord tone ${id}`);
  return found;
}

/** How long an articulation of this tone rings, in frames at the project's rate. */
export function toneFrames(tone: ChordTone, articulation: Articulation, sampleRate: number): number {
  const seconds = articulation === 'strike' ? tone.strikeSeconds : tone.chunkSeconds;
  return Math.round(seconds * sampleRate);
}

// ----------------------------------------------------------- the two tracks --

/**
 * The chord bed is a recurring **4-bar** progression, one chord per bar. Bar counts are always
 * multiples of 4 (§1.2), so it tiles evenly into every valid project length and no
 * partial-progression case exists at any bar count.
 */
export const CHORD_SLOT_COUNT = 4;

export type DrumTrack = {
  readonly patternId: string;
  readonly kitId: string;
  readonly level: number;
  readonly muted: boolean;
};

export type ChordBed = {
  readonly chordPatternId: string;
  readonly tone: ChordToneId;
  readonly octave: Octave;
  /** Exactly `CHORD_SLOT_COUNT` of them. */
  readonly slots: readonly Chord[];
  readonly level: number;
  readonly muted: boolean;
};

export type BackingTracks = {
  readonly drums: DrumTrack;
  readonly chords: ChordBed;
};

/**
 * **Neither track is optional and neither has an `enabled` flag** (§1.5). Both always exist on
 * the project; a sketch that does not want the chords mutes them.
 *
 * Earlier drafts carried `enabled` alongside `muted`, which were two spellings of one state — and
 * only `muted` was ever reachable from the interface, so `enabled` was a field the user could not
 * set that nonetheless decided whether a backing stem was written (§5.2).
 *
 * The chord bed starts muted and the drums do not. A project without a groove has nothing to play
 * against, which is the one thing §5.1 #8 relies on when it removes the metronome; a project
 * without chords is an ordinary way to work, and four C major bars nobody asked for is a harmonic
 * decision made on the user's behalf.
 */
export function defaultBacking(): BackingTracks {
  return {
    drums: { patternId: 'backbeat-pop', kitId: 'tight', level: 0.7, muted: false },
    chords: {
      chordPatternId: 'sustain',
      tone: 'rhodes',
      octave: 0,
      slots: Array.from({ length: CHORD_SLOT_COUNT }, () => defaultChord()),
      level: 0.55,
      muted: true,
    },
  };
}

/** A slot with nothing chosen yet. */
function defaultChord(): Chord {
  return { letter: 'C', accidental: 'natural', quality: 'major' };
}

/**
 * The twelve pitches **as they are actually spelled**, which is not letter × accidental.
 *
 * Drawing a letter and an accidental independently produces B♯ and F♭ — enharmonically valid, and
 * not how anyone writes a chord. Twenty-one combinations collapse to twelve sounds, so the extra
 * nine are all spellings nobody wants.
 */
const RANDOM_ROOTS: readonly Pick<Chord, 'letter' | 'accidental'>[] = [
  { letter: 'C', accidental: 'natural' },
  { letter: 'C', accidental: 'sharp' },
  { letter: 'D', accidental: 'natural' },
  { letter: 'E', accidental: 'flat' },
  { letter: 'E', accidental: 'natural' },
  { letter: 'F', accidental: 'natural' },
  { letter: 'F', accidental: 'sharp' },
  { letter: 'G', accidental: 'natural' },
  { letter: 'A', accidental: 'flat' },
  { letter: 'A', accidental: 'natural' },
  { letter: 'B', accidental: 'flat' },
  { letter: 'B', accidental: 'natural' },
];

/** Weighted toward triads: uniform over five would make four sevenths the common progression. */
const RANDOM_QUALITIES: readonly ChordQuality[] = [
  'major', 'major', 'major',
  'minor', 'minor', 'minor',
  'dom7', 'min7', 'maj7',
];

/**
 * A random chord, for the blank slate §6.1 names.
 *
 * `rand` is injectable so this is testable — the distribution is the point, and a function whose
 * only source of randomness is a global cannot be checked against the two rules above.
 */
export function randomChord(rand: () => number = Math.random): Chord {
  const root = RANDOM_ROOTS[Math.floor(rand() * RANDOM_ROOTS.length)] ?? RANDOM_ROOTS[0]!;
  const quality = RANDOM_QUALITIES[Math.floor(rand() * RANDOM_QUALITIES.length)] ?? 'major';
  return { ...root, quality };
}

/**
 * Which chord owns an arrangement slot (§2.6).
 *
 * ```
 * chordSlotFor(slot) = ((slot − 1) mod 4) + 1
 * ```
 *
 * So chord 2 plays in slots 2, 6, 10, 14, 18, 22. **Bar-preview mode uses this too**, playing the
 * one chord that owns the previewed slot rather than the first chord or none — what you hear in
 * preview is what you hear in the loop.
 *
 * Both indices are 1-based, like every other bar index in the domain (§1.3).
 */
export function chordSlotFor(arrangementSlot: number): number {
  if (!Number.isInteger(arrangementSlot) || arrangementSlot < 1) {
    throw new RangeError(`arrangementSlot is 1-based, got ${arrangementSlot}`);
  }
  return ((arrangementSlot - 1) % CHORD_SLOT_COUNT) + 1;
}

/** The chord sounding in a given arrangement slot. */
export function chordForSlot(bed: ChordBed, arrangementSlot: number): Chord {
  const chord = bed.slots[chordSlotFor(arrangementSlot) - 1];
  if (!chord) throw new RangeError(`chord bed has ${bed.slots.length} slots, needs ${CHORD_SLOT_COUNT}`);
  return chord;
}

/**
 * The two tracks as a uniform list, for the mixdown and export rules that treat them alike.
 *
 * Bounce and export do not care that one is a drum pattern and the other a progression — they ask
 * *was this audible*, and name the file. Flattening once here is what stops each of them growing
 * its own idea of what a backing track is, which is exactly how the provisional type this replaces
 * came to sit beside the real model instead of being it.
 *
 * `label` is the file name a stem gets, so it is a proper noun rather than an id.
 */
export type BackingMixSource = {
  readonly id: string;
  readonly label: string;
  readonly muted: boolean;
  readonly level: number;
};

export function backingMixSources(backing: BackingTracks): readonly BackingMixSource[] {
  return [
    { id: 'drums', label: 'Drums', muted: backing.drums.muted, level: backing.drums.level },
    { id: 'chords', label: 'Chords', muted: backing.chords.muted, level: backing.chords.level },
  ];
}
