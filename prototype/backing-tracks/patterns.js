// Pattern data for the backing-tracks prototype (drums + chords only, for now).
//
// Plain globals, no ES module — loads the same way via file:// or a static server, no build
// step. This is the finalized baseline set from the design discussion: 6 drum patterns, 7 chord
// strum patterns, both capped by the same rule ("more than 5 needs justification for the value
// it adds"), no swing or triplet subdivision in either.
//
// One bar each, looped. Beat positions are 1-based within a 4-beat bar; ".5" is the off-beat
// ("&") halfway between two counted beats — e.g. 2.5 is "the and of 2".

/**
 * Each drum pattern is several single-voice onset lists running in parallel (kick, snare, hat).
 *
 * Used to carry a `kit` field describing the sample-kit character each pattern implied, back
 * when drums were one-shot samples and kit was deliberately baked into the pattern to dodge a
 * sourcing/testing combinatorial problem. Drums are synthesized now (spec §2.6), so that problem
 * doesn't exist — kit and pattern are two independent axes, same as tone and pattern already are
 * for chords. See DRUM_KITS below.
 */
const DRUM_PATTERNS = [
  {
    id: 'four-on-the-floor',
    name: 'Four on the Floor',
    feel: 'Steady dance pulse',
    voices: {
      kick: [1, 2, 3, 4],
      snare: [2, 4],
      hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5],
    },
  },
  {
    id: 'backbeat-pop',
    name: 'Backbeat Pop',
    feel: 'Generic rock/pop default',
    voices: {
      kick: [1, 3],
      snare: [2, 4],
      hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5],
    },
  },
  {
    id: 'boom-bap',
    name: 'Boom Bap',
    feel: 'Head-nod hip-hop',
    voices: {
      kick: [1, 2.5],
      snare: [2, 4],
      hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5],
    },
  },
  {
    id: 'half-time',
    name: 'Half-Time',
    feel: 'Modern half-time hip-hop/rock',
    voices: {
      kick: [1],
      snare: [3],
      hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5],
    },
  },
  {
    id: 'syncopated-pop',
    name: 'Syncopated Pop',
    feel: 'Contemporary R&B/pop',
    voices: {
      kick: [1, 2.5, 3],
      snare: [2, 4],
      hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5],
      // open accent on 4& — modeled as a separate voice so it can ring past the loop point
      hatOpen: [4.5],
    },
  },
  {
    id: 'one-drop',
    name: 'One-Drop',
    feel: 'Reggae',
    voices: {
      kick: [3],
      snare: [3],
      hat: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5],
    },
  },
];

/**
 * Synthesized drum kits — each one a full set of kick/snare/hat parameters, independent of
 * pattern. Four, matching the small-named-list convention already used for chord tone.
 * Parameters live here as data; audio.js's playKick/playSnare/playHat read them rather than
 * hardcoding a single voice.
 *
 * `description` is reference material for whoever is reading or tuning these, NOT UI copy —
 * kit and tone descriptions are deliberately absent from the interface, here and in the app.
 */
const DRUM_KITS = [
  {
    id: 'tight',
    name: 'Tight',
    description: 'Punchy and modern — the default character',
    kick: { startFreq: 150, endFreq: 48, sweepTime: 0.09, duration: 0.26, clickGain: 0.45, clickFreq: 1400 },
    snare: { body1: 190, body2: 240, bodyDecay: 0.08, noiseHp: 1200, duration: 0.19 },
    hat: { hp: 7000, bp: 10000, closedDuration: 0.06, openDuration: 0.35 },
  },
  {
    id: 'deep',
    name: 'Deep',
    description: '808-leaning — long sub kick, clap-like snare',
    kick: { startFreq: 120, endFreq: 38, sweepTime: 0.15, duration: 0.4, clickGain: 0.28, clickFreq: 1000 },
    snare: { body1: 170, body2: 210, bodyDecay: 0.06, noiseHp: 900, duration: 0.24 },
    hat: { hp: 6000, bp: 8500, closedDuration: 0.05, openDuration: 0.3 },
  },
  {
    id: 'punchy',
    name: 'Punchy',
    description: 'Short and bright — trap-leaning, tight and clicky',
    // Pushed hard toward short+bright, not just nudged — every duration here is the shortest
    // of any kit (Tight's are the next shortest and still 2x+ longer), which is what actually
    // makes a kit read as a different kit rather than a quieter variation on another one.
    kick: { startFreq: 200, endFreq: 55, sweepTime: 0.035, duration: 0.14, clickGain: 0.6, clickFreq: 2200 },
    snare: { body1: 220, body2: 300, bodyDecay: 0.04, noiseHp: 2000, duration: 0.13 },
    hat: { hp: 9000, bp: 12000, closedDuration: 0.03, openDuration: 0.22 },
  },
  {
    id: 'lofi',
    name: 'Lo-fi',
    description: 'Darker and softer, dusty character',
    kick: { startFreq: 110, endFreq: 42, sweepTime: 0.12, duration: 0.3, clickGain: 0.18, clickFreq: 650 },
    snare: { body1: 160, body2: 200, bodyDecay: 0.09, noiseHp: 700, duration: 0.24 },
    hat: { hp: 4200, bp: 5800, closedDuration: 0.08, openDuration: 0.32 },
  },
];

/**
 * Each chord pattern is a single voice — the chord itself. An onset is either a strike (full,
 * lets the chord ring per the tone's own envelope) or a chunk (short, damped). Tone
 * (Rhodes/Pad/Nylon/Organ) and octave are both independent of pattern — picking a pattern never
 * changes either.
 */
const CHORD_PATTERNS = [
  { id: 'sustain', name: 'Sustain', feel: 'Holds the chord, no rhythm', strikes: [1], chunks: [] },
  {
    id: 'sparse-half-note',
    name: 'Sparse / Half-note',
    feel: 'Between Sustain and Steady Quarters',
    strikes: [1, 3],
    chunks: [],
  },
  {
    id: 'steady-quarters',
    name: 'Steady Quarters',
    feel: 'Plain pulse',
    strikes: [1, 2, 3, 4],
    chunks: [],
  },
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

/** Chord tone — independent of strum pattern, exactly as drum kit is independent of drum pattern. */
const CHORD_TONES = ['Rhodes', 'Pad', 'Wurly', 'Organ'];

/**
 * The settled chord vocabulary — scale is gone, quality is picked directly (see the
 * chord-bed-no-scales decision). Mirrors ui/src/chords.ts's constants; this is the standalone
 * prototype's own copy, not an import, since the two are deliberately kept separate.
 */
const NOTE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const ACCIDENTALS = [
  { id: 'natural', label: '♮' },
  { id: 'flat', label: '♭' },
  { id: 'sharp', label: '♯' },
];
const QUALITIES = [
  { id: 'major', label: 'Maj' },
  { id: 'minor', label: 'Min' },
  { id: 'dom7', label: '7' },
  { id: 'min7', label: 'm7' },
  { id: 'maj7', label: 'Maj7' },
];

/**
 * Octave adjustment: a persistent, per-project, whole-progression setting — not per chord slot.
 * Narrowed from the original ±2 (five positions) to ±1 after listening — the outer two octaves
 * were hard to listen to and didn't earn their place. Labels are Low/Default/High rather than
 * signed numbers, since three named positions read better than a numeric range this narrow.
 */
const OCTAVE_RANGE = [-1, 0, 1];
const OCTAVE_DEFAULT = 0;
const OCTAVE_LABELS = { '-1': 'Low', '0': 'Default', '1': 'High' };

// Exposed as globals for the prototype UI script.
window.DRUM_PATTERNS = DRUM_PATTERNS;
window.DRUM_KITS = DRUM_KITS;
window.CHORD_PATTERNS = CHORD_PATTERNS;
window.CHORD_TONES = CHORD_TONES;
window.OCTAVE_RANGE = OCTAVE_RANGE;
window.OCTAVE_DEFAULT = OCTAVE_DEFAULT;
window.OCTAVE_LABELS = OCTAVE_LABELS;
window.NOTE_LETTERS = NOTE_LETTERS;
window.ACCIDENTALS = ACCIDENTALS;
window.QUALITIES = QUALITIES;
window.BPM_MIN = 60;
window.BPM_MAX = 240;
window.BPM_DEFAULT = 96;
