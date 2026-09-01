import {
  type Articulation,
  type BackingTracks,
  type Chord,
  DRUM_VOICES,
  type DrumVoice,
  chordForSlot,
  chordFrequencies,
  chordTone,
  drumKit,
  drumPattern,
  kitVoiceFrames,
  chordPattern,
  toneFrames,
} from './backing.ts';
import { type Timing, frameOffsetInLoop, framesPerBar } from './timing.ts';

/**
 * What the backing tracks play, and when (§2.6).
 *
 * **Everything here is sample frames.** The reference implementation this is ported from schedules
 * in seconds, because a browser's audio clock wants seconds — that is a platform unit, and
 * converting to it happens at the platform boundary, not here (§1.4, and `timing.ts`'s header).
 * Scheduling in seconds inside the domain would also reintroduce exactly the drift `Transport`
 * already rejects a software clock over.
 *
 * **This decides onsets, not sound.** Which oscillators exist and how they are wired is the
 * platform's job; the frequencies, envelope lengths and onset frames it needs are all here.
 *
 * Backing shares layer playback's timing math but not its scheduling type. `segments()` schedules
 * *regions of a recorded file* — it reads audio that already exists, keyed by `BarRef`. A backing
 * voice is generated at the moment it is needed: no file, no region, no `BarRef`. One shared
 * anchor (§0.4), two schedule builders.
 */

/**
 * Frame offset of a beat within its bar.
 *
 * Beats are 1-based and `.5` is the off-beat, so beat 1 is the downbeat at offset 0.
 *
 * **Derived from `framesPerBar`, not from an independent frames-per-beat.** `framesPerBar` is
 * already rounded, so a separately-rounded beat length would put the eighth-note grid on a
 * slightly different footing than the bar grid it sits inside, and the two would disagree by a
 * frame or so at some tempos. Dividing the bar the domain actually uses keeps one grid.
 */
export function beatFrameOffset(t: Timing, beat: number): number {
  if (!(beat >= 1) || !(beat < t.beatsPerBar + 1)) {
    throw new RangeError(`beat ${beat} outside 1..<${t.beatsPerBar + 1}`);
  }
  return Math.round(((beat - 1) / t.beatsPerBar) * framesPerBar(t));
}

/**
 * `nominalFrames` is how long the voice rings **on its own recipe alone**.
 *
 * It is not necessarily how long it ends up sounding. How voices that outlive the gap to the next
 * onset are handled is deliberately unsettled (§6.1): chords currently cap to that gap, hats choke
 * their predecessor, and kick and snare do neither. Whatever policy wins will shorten some of
 * these, so treat this as the recipe's length rather than the final one.
 */
export type DrumOnset = {
  readonly voice: DrumVoice;
  readonly beat: number;
  readonly frameOffset: number;
  readonly nominalFrames: number;
};

export type ChordOnset = {
  readonly articulation: Articulation;
  readonly beat: number;
  readonly frameOffset: number;
  readonly nominalFrames: number;
};

/**
 * One bar's worth of backing. Onsets are relative to the bar; `frameOffset` places the bar within
 * one traversal of the loop.
 */
export type BackingBar = {
  /** 1-based arrangement slot (§1.1). */
  readonly slot: number;
  readonly frameOffset: number;
  readonly drums: readonly DrumOnset[];
  /** The chord that owns this slot — `((slot − 1) mod 4) + 1`. */
  readonly chord: Chord;
  readonly frequencies: readonly number[];
  readonly chords: readonly ChordOnset[];
};

/**
 * The drum onsets of one bar, in scheduling order.
 *
 * Sorted by frame, then by `DRUM_VOICES` order for ties. **The tie-break is load-bearing, not
 * tidiness**: the hat choke depends on hats being reached in a defined sequence, and a kick and a
 * hat sharing beat 1 must not be able to swap places between two runs of the same pattern.
 */
export function drumBarOnsets(t: Timing, patternId: string, kitId: string): readonly DrumOnset[] {
  const pattern = drumPattern(patternId);
  const kit = drumKit(kitId);
  const onsets: DrumOnset[] = [];

  for (const voice of DRUM_VOICES) {
    for (const beat of pattern.voices[voice] ?? []) {
      onsets.push({
        voice,
        beat,
        frameOffset: beatFrameOffset(t, beat),
        nominalFrames: kitVoiceFrames(kit, voice, t.sampleRate),
      });
    }
  }

  return onsets.sort(
    (a, b) =>
      a.frameOffset - b.frameOffset ||
      DRUM_VOICES.indexOf(a.voice) - DRUM_VOICES.indexOf(b.voice),
  );
}

/**
 * The chord onsets of one bar, in scheduling order.
 *
 * A strike and a chunk cannot share a beat in any pattern in the library, so the sort needs no
 * tie-break — but ordering by articulation after frame keeps it deterministic if one ever does.
 */
export function chordBarOnsets(
  t: Timing,
  chordPatternId: string,
  toneId: Parameters<typeof chordTone>[0],
): readonly ChordOnset[] {
  const pattern = chordPattern(chordPatternId);
  const tone = chordTone(toneId);

  const onsets: ChordOnset[] = [
    ...pattern.strikes.map((beat) => ({ beat, articulation: 'strike' as const })),
    ...pattern.chunks.map((beat) => ({ beat, articulation: 'chunk' as const })),
  ].map(({ beat, articulation }) => ({
    articulation,
    beat,
    frameOffset: beatFrameOffset(t, beat),
    nominalFrames: toneFrames(tone, articulation, t.sampleRate),
  }));

  return onsets.sort(
    (a, b) => a.frameOffset - b.frameOffset || a.articulation.localeCompare(b.articulation),
  );
}

/**
 * One bar of backing, for the given arrangement slot.
 *
 * **This is also bar-preview mode** (§2.6). Preview plays the chord that owns the previewed slot,
 * not the first chord and not none, so previewing bar 7 sounds like bar 7 does in the loop — what
 * you hear is what you get, in preview as everywhere else.
 *
 * **A muted track contributes no onsets**, rather than onsets that are then silenced. There is
 * nothing to gain from scheduling a voice in order to turn it off, and a caller that reads this
 * schedule cannot then disagree with the mixdown about what was audible.
 */
export function backingBar(backing: BackingTracks, t: Timing, slot: number): BackingBar {
  const chord = chordForSlot(backing.chords, slot);
  return {
    slot,
    frameOffset: frameOffsetInLoop(t, slot),
    drums: backing.drums.muted ? [] : drumBarOnsets(t, backing.drums.patternId, backing.drums.kitId),
    chord,
    frequencies: chordFrequencies(chord, backing.chords.octave),
    chords: backing.chords.muted
      ? []
      : chordBarOnsets(t, backing.chords.chordPatternId, backing.chords.tone),
  };
}

/**
 * One full traversal of the loop, bar by bar.
 *
 * The drum pattern is one bar and repeats unchanged, so every bar's `drums` are identical; the
 * chord walks the four slots. Returned per bar anyway, because the caller schedules bar by bar and
 * a shape that made the drums a special case would have to be unpacked at every use.
 */
export function backingSchedule(backing: BackingTracks, t: Timing): readonly BackingBar[] {
  return Array.from({ length: t.barCount }, (_, i) => backingBar(backing, t, i + 1));
}
