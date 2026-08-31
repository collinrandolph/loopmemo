/**
 * The chord vocabulary (§4.4, **with one deliberate reversal**).
 *
 * §4.4 says "do not add a chord-quality picker to the primary interface": a scale plus four
 * roots makes the harmony correct by construction, and choosing quality per chord doubles the
 * decisions. Scale is gone here and quality is picked directly, at the user's instruction —
 * flagged rather than absorbed, because the spec is the authority and this contradicts it.
 *
 * Two things follow from dropping scale, and both are load-bearing. There is no longer any such
 * thing as a **borrowed** chord — "outside the scale" needs a scale to be outside of — so the
 * dashed slot state goes with it. And a slot can no longer be wrong, so nothing has to default
 * an out-of-scale root to a major triad.
 *
 * Screen state, not domain state: §2.6's reference tracks are still unmodelled, so none of this
 * survives a reload. When they are built, this is what has to move.
 */
export type Chord = {
  letter: string;
  accidental: 'natural' | 'flat' | 'sharp';
  quality: 'major' | 'minor' | 'dom7' | 'min7' | 'maj7';
};

export const NOTE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((l) => ({ id: l, label: l }));

// `label` is what the picker shows, `suffix` what the chord button spells.
export const ACCIDENTALS = [
  { id: 'natural', label: '♮', suffix: '' },
  { id: 'flat', label: '♭', suffix: '♭' },
  { id: 'sharp', label: '♯', suffix: '♯' },
];

export const QUALITIES = [
  { id: 'major', label: 'Maj', suffix: '' },
  { id: 'minor', label: 'Min', suffix: 'm' },
  { id: 'dom7', label: '7', suffix: '7' },
  { id: 'min7', label: 'm7', suffix: 'm7' },
  { id: 'maj7', label: 'Maj7', suffix: 'maj7' },
];

/** A slot with nothing chosen yet. */
export function defaultChord(): Chord {
  return { letter: 'C', accidental: 'natural', quality: 'major' };
}

/** Standard spelling, so the slot reads as the chord and not as three settings. */
export function chordLabel(chord: Chord): string {
  const accidental = ACCIDENTALS.find((a) => a.id === chord.accidental)?.suffix ?? '';
  const quality = QUALITIES.find((q) => q.id === chord.quality)?.suffix ?? '';
  return `${chord.letter}${accidental}${quality}`;
}

/**
 * Randomising draws the root from the twelve pitches as they are actually spelled, not from
 * letter × accidental, so it cannot hand back B♯ or F♭ — enharmonically valid, and not how
 * anyone writes a chord. Quality is weighted toward triads for the same reason: uniform over
 * five would make a progression of four sevenths the common case.
 */
const RANDOM_ROOTS: Pick<Chord, 'letter' | 'accidental'>[] = [
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

const RANDOM_QUALITIES: Chord['quality'][] =
  ['major', 'major', 'major', 'minor', 'minor', 'minor', 'dom7', 'min7', 'maj7'];

export function randomChord(): Chord {
  const root = RANDOM_ROOTS[Math.floor(Math.random() * RANDOM_ROOTS.length)]!;
  return { ...root, quality: RANDOM_QUALITIES[Math.floor(Math.random() * RANDOM_QUALITIES.length)]! };
}
