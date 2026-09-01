import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHORD_SLOT_COUNT,
  CHORD_TONES,
  DRUM_KITS,
  DRUM_PATTERNS,
  DRUM_VOICES,
  type DrumVoice,
  QUALITIES,
  CHORD_PATTERNS,
  chordForSlot,
  chordFrequencies,
  chordLabel,
  chordMidiNotes,
  chordSlotFor,
  chordTone,
  defaultBacking,
  drumKit,
  drumPattern,
  kitVoiceFrames,
  backingMixSources,
  randomChord,
  chordPattern,
  toneFrames,
} from '../src/domain/backing.ts';
import {
  type Project,
  createProject,
  isConfigurationLocked,
  projectTiming,
  recordSession,
} from '../src/domain/project.ts';
import { loopFrames } from '../src/domain/timing.ts';
import { session } from './fixtures.ts';

const SR = 44_100;

describe('chord vocabulary', () => {
  it('spells a chord the way it is written, not as three fields', () => {
    assert.equal(chordLabel({ letter: 'C', accidental: 'natural', quality: 'major' }), 'C');
    assert.equal(chordLabel({ letter: 'B', accidental: 'flat', quality: 'maj7' }), 'B♭maj7');
    assert.equal(chordLabel({ letter: 'F', accidental: 'sharp', quality: 'min7' }), 'F♯m7');
    assert.equal(chordLabel({ letter: 'G', accidental: 'natural', quality: 'dom7' }), 'G7');
  });

  it('has no scale field anywhere, so a slot can never be out of one (§4.4)', () => {
    const bed = defaultBacking().chords;
    assert.ok(!('scale' in bed), 'chord bed grew a scale back');
    for (const slot of bed.slots) {
      assert.ok(!('quality' in slot) === false, 'quality is stored, not derived');
    }
  });

  it('offers exactly the five qualities, and every one resolves to notes', () => {
    assert.equal(QUALITIES.length, 5);
    for (const q of QUALITIES) {
      const notes = chordMidiNotes({ letter: 'C', accidental: 'natural', quality: q.id });
      assert.ok(notes.length === 3 || notes.length === 4, `${q.id} produced ${notes.length} notes`);
    }
  });
});

describe('chord pitch', () => {
  it('puts A natural on concert A, which anchors everything else', () => {
    const [root] = chordFrequencies({ letter: 'A', accidental: 'natural', quality: 'major' });
    assert.ok(Math.abs(root! - 440) < 1e-9, `root was ${root}`);
  });

  it('C major is C4 E4 G4 — the mid-register default §4.4 asks for', () => {
    assert.deepEqual(
      chordMidiNotes({ letter: 'C', accidental: 'natural', quality: 'major' }),
      [60, 64, 67],
    );
  });

  it('quality changes the third, not the root', () => {
    const major = chordMidiNotes({ letter: 'D', accidental: 'natural', quality: 'major' });
    const minor = chordMidiNotes({ letter: 'D', accidental: 'natural', quality: 'minor' });
    assert.equal(major[0], minor[0]);
    assert.equal(major[1]! - minor[1]!, 1, 'the minor third is one semitone below the major');
  });

  it('an accidental moves the whole chord by one semitone', () => {
    const natural = chordMidiNotes({ letter: 'E', accidental: 'natural', quality: 'min7' });
    const flat = chordMidiNotes({ letter: 'E', accidental: 'flat', quality: 'min7' });
    assert.deepEqual(flat, natural.map((n) => n - 1));
  });

  it('the octave setting is exactly twelve semitones, and doubles the frequency', () => {
    const chord = { letter: 'C', accidental: 'natural', quality: 'major' } as const;
    assert.deepEqual(chordMidiNotes(chord, 1), chordMidiNotes(chord, 0).map((n) => n + 12));

    const low = chordFrequencies(chord, -1)[0]!;
    const mid = chordFrequencies(chord, 0)[0]!;
    assert.ok(Math.abs(mid / low - 2) < 1e-9, `ratio was ${mid / low}`);
  });

  it('rejects a letter that is not a note', () => {
    assert.throws(
      () => chordMidiNotes({ letter: 'H', accidental: 'natural', quality: 'major' }),
      /unknown note letter/,
    );
  });
});

describe('the chord tiling rule (§2.6)', () => {
  it('chord 2 owns slots 2, 6, 10, 14, 18, 22 — the worked example', () => {
    for (const slot of [2, 6, 10, 14, 18, 22]) {
      assert.equal(chordSlotFor(slot), 2, `slot ${slot}`);
    }
  });

  it('slot 1 is chord 1 and the cycle is four long', () => {
    assert.equal(chordSlotFor(1), 1);
    assert.equal(chordSlotFor(CHORD_SLOT_COUNT), CHORD_SLOT_COUNT);
    assert.equal(chordSlotFor(CHORD_SLOT_COUNT + 1), 1);
  });

  it('tiles evenly into every valid bar count, so no partial progression exists', () => {
    for (const barCount of [4, 8, 12, 16, 20, 24, 28, 32]) {
      assert.equal(barCount % CHORD_SLOT_COUNT, 0, `${barCount} bars`);
      const used = new Set(
        Array.from({ length: barCount }, (_, i) => chordSlotFor(i + 1)),
      );
      assert.equal(used.size, CHORD_SLOT_COUNT, `${barCount} bars did not use every chord`);
    }
  });

  it('is 1-based like every other bar index, and says so rather than silently wrapping', () => {
    assert.throws(() => chordSlotFor(0), /1-based/);
    assert.throws(() => chordSlotFor(-1), /1-based/);
  });

  it('chordForSlot reads through the tiling, not off the raw slot', () => {
    const bed = {
      ...defaultBacking().chords,
      slots: [
        { letter: 'C', accidental: 'natural', quality: 'major' },
        { letter: 'A', accidental: 'natural', quality: 'minor' },
        { letter: 'F', accidental: 'natural', quality: 'major' },
        { letter: 'G', accidental: 'natural', quality: 'dom7' },
      ],
    } as const;
    assert.equal(chordLabel(chordForSlot(bed, 6)), 'Am');
    assert.equal(chordLabel(chordForSlot(bed, 20)), 'G7');
  });
});

describe('the libraries', () => {
  it('holds the settled counts — six drum patterns, four kits, seven chord patterns, four tones', () => {
    assert.equal(DRUM_PATTERNS.length, 6);
    assert.equal(DRUM_KITS.length, 4);
    assert.equal(CHORD_PATTERNS.length, 7);
    assert.equal(CHORD_TONES.length, 4);
  });

  it('has unique ids in every library, so a lookup cannot be ambiguous', () => {
    const unique = (ids: readonly string[]) => assert.equal(new Set(ids).size, ids.length);
    unique(DRUM_PATTERNS.map((p) => p.id));
    unique(DRUM_KITS.map((k) => k.id));
    unique(CHORD_PATTERNS.map((p) => p.id));
    unique(CHORD_TONES.map((t) => t.id));
  });

  it('puts every onset on a straight beat or eighth — no swing, no triplets (§2.6)', () => {
    const straight = (beat: number) => (beat * 2) % 1 === 0;
    for (const pattern of DRUM_PATTERNS) {
      for (const voice of DRUM_VOICES) {
        for (const beat of pattern.voices[voice] ?? []) {
          assert.ok(straight(beat), `${pattern.id} ${voice} on ${beat}`);
        }
      }
    }
    for (const pattern of CHORD_PATTERNS) {
      for (const beat of [...pattern.strikes, ...pattern.chunks]) {
        assert.ok(straight(beat), `${pattern.id} on ${beat}`);
      }
    }
  });

  it('keeps every onset inside its bar', () => {
    for (const pattern of DRUM_PATTERNS) {
      for (const voice of DRUM_VOICES) {
        for (const beat of pattern.voices[voice] ?? []) {
          assert.ok(beat >= 1 && beat < 5, `${pattern.id} ${voice} on ${beat}`);
        }
      }
    }
    for (const pattern of CHORD_PATTERNS) {
      for (const beat of [...pattern.strikes, ...pattern.chunks]) {
        assert.ok(beat >= 1 && beat < 5, `${pattern.id} on ${beat}`);
      }
    }
  });

  it('never puts a strike and a chunk on the same beat', () => {
    for (const pattern of CHORD_PATTERNS) {
      for (const beat of pattern.strikes) {
        assert.ok(!pattern.chunks.includes(beat), `${pattern.id} doubles up on ${beat}`);
      }
    }
  });

  it('gives every drum pattern something to play', () => {
    for (const pattern of DRUM_PATTERNS) {
      const total = DRUM_VOICES.reduce((n, v) => n + (pattern.voices[v]?.length ?? 0), 0);
      assert.ok(total > 0, `${pattern.id} is silent`);
    }
  });

  it('names an unknown id rather than returning undefined', () => {
    assert.throws(() => drumPattern('nope'), /unknown drum pattern/);
    assert.throws(() => drumKit('nope'), /unknown drum kit/);
    assert.throws(() => chordPattern('nope'), /unknown chord pattern/);
  });
});

describe('kits are a real axis, not a relabelling', () => {
  it('opens the hat longer than it closes it, in every kit', () => {
    for (const kit of DRUM_KITS) {
      assert.ok(
        kit.hat.openSeconds > kit.hat.closedSeconds,
        `${kit.id} open ${kit.hat.openSeconds} vs closed ${kit.hat.closedSeconds}`,
      );
    }
  });

  it('sweeps every kick downward, which is what makes it read as a hit', () => {
    for (const kit of DRUM_KITS) {
      assert.ok(kit.kick.startFreq > kit.kick.endFreq, `${kit.id} sweeps upward`);
    }
  });

  /**
   * The lesson that cost a fifth kit: one that only nudged another's numbers by 10–15% was
   * indistinguishable by ear and was cut. This is that rule as a test — not a proof of audible
   * difference, but it does catch a kit added by copying another and tweaking it.
   */
  it('separates every pair of kits by more than a nudge on some parameter', () => {
    const signature = (k: (typeof DRUM_KITS)[number]) => [
      k.kick.seconds,
      k.kick.startFreq,
      k.snare.seconds,
      k.hat.closedSeconds,
      k.hat.highpass,
    ];
    for (let i = 0; i < DRUM_KITS.length; i++) {
      for (let j = i + 1; j < DRUM_KITS.length; j++) {
        const a = signature(DRUM_KITS[i]!);
        const b = signature(DRUM_KITS[j]!);
        const biggest = Math.max(...a.map((x, n) => Math.abs(x - b[n]!) / Math.max(x, b[n]!)));
        assert.ok(
          biggest > 0.2,
          `${DRUM_KITS[i]!.id} and ${DRUM_KITS[j]!.id} differ by at most ${(biggest * 100).toFixed(0)}%`,
        );
      }
    }
  });

  it('makes Punchy the shortest kit, since that is the region it was added to occupy', () => {
    const punchy = drumKit('punchy');
    for (const kit of DRUM_KITS) {
      if (kit.id === 'punchy') continue;
      assert.ok(punchy.kick.seconds < kit.kick.seconds, `kick vs ${kit.id}`);
      assert.ok(punchy.snare.seconds < kit.snare.seconds, `snare vs ${kit.id}`);
      assert.ok(punchy.hat.closedSeconds < kit.hat.closedSeconds, `hat vs ${kit.id}`);
    }
  });
});

describe('envelope lengths convert at the boundary, and are not stored in frames', () => {
  it('gives the same duration in seconds at either sample rate', () => {
    const kit = drumKit('tight');
    for (const voice of DRUM_VOICES) {
      const at441 = kitVoiceFrames(kit, voice, 44_100) / 44_100;
      const at48 = kitVoiceFrames(kit, voice, 48_000) / 48_000;
      assert.ok(Math.abs(at441 - at48) < 1e-4, `${voice}: ${at441} vs ${at48}`);
    }
  });

  it('distinguishes the open hat from the closed one, sharing the rest of the recipe', () => {
    const kit = drumKit('tight');
    assert.ok(kitVoiceFrames(kit, 'hatOpen', SR) > kitVoiceFrames(kit, 'hat', SR));
  });

  it('makes a chunk far shorter than a strike, for every tone', () => {
    for (const tone of CHORD_TONES) {
      assert.ok(
        toneFrames(tone, 'chunk', SR) < toneFrames(tone, 'strike', SR) / 2,
        `${tone.id} chunk is not decisively shorter`,
      );
    }
  });

  /**
   * The number behind §2.6's unresolved tail problem. A bar is `240 / bpm` seconds, so it gets
   * *shorter* as the tempo rises — Pad's 2.2 s strike outlives a whole bar above ~109 BPM, which
   * is most of the app's 60–240 range. A strike late in the last bar is then still sounding when
   * a fixed-length bounce stops.
   */
  it('lets a Pad strike outlive a bar across most of the tempo range — the tail problem', () => {
    const pad = chordTone('pad');
    const barFrames = (bpm: number) => Math.round((SR * 60 * 4) / bpm);

    assert.ok(
      toneFrames(pad, 'strike', SR) > barFrames(120),
      'Pad no longer outruns a bar at 120 BPM — recheck the §2.6 tail note',
    );
    assert.ok(
      toneFrames(pad, 'strike', SR) < barFrames(60),
      'a 60 BPM bar is 4 s, so nothing in the library should outrun it',
    );
  });
});

describe('the default project backing', () => {
  it('starts with a groove and without chords', () => {
    const backing = defaultBacking();
    assert.equal(backing.drums.muted, false, 'drums carry §5.1 #8, which removed the metronome');
    assert.equal(backing.chords.muted, true, 'four unasked-for C major bars are a harmonic decision');
  });

  it('names patterns and kits that exist', () => {
    const backing = defaultBacking();
    assert.doesNotThrow(() => drumPattern(backing.drums.patternId));
    assert.doesNotThrow(() => drumKit(backing.drums.kitId));
    assert.doesNotThrow(() => chordPattern(backing.chords.chordPatternId));
    assert.doesNotThrow(() => chordTone(backing.chords.tone));
  });

  it('fills every chord slot, so no slot can be missing at playback', () => {
    assert.equal(defaultBacking().chords.slots.length, CHORD_SLOT_COUNT);
  });

  it('has no enabled flag on either track — mute is the whole of it (§5.2)', () => {
    const backing = defaultBacking();
    assert.ok(!('enabled' in backing.drums), 'drums grew an enabled flag back');
    assert.ok(!('enabled' in backing.chords), 'chords grew an enabled flag back');
  });
});

describe('backingMixSources — the seam bounce and export share', () => {
  it('flattens both tracks, keeping the drums first', () => {
    const sources = backingMixSources(defaultBacking());
    assert.deepEqual(sources.map((s) => s.id), ['drums', 'chords']);
    assert.deepEqual(sources.map((s) => s.label), ['Drums', 'Chords']);
  });

  /**
   * The gap this closes: the export screen used to be handed a hardcoded pair of tracks, so a
   * backing track muted on the Playback screen still exported a stem. Mute now travels.
   */
  it('carries mute through from the project, so export cannot disagree with playback', () => {
    const backing = defaultBacking();
    const muted = { ...backing, drums: { ...backing.drums, muted: true } };
    assert.equal(backingMixSources(muted)[0]!.muted, true);
    assert.equal(backingMixSources(backing)[0]!.muted, false);
  });

  it('carries level through as well, so the mixdown balances as the user set it', () => {
    const backing = defaultBacking();
    const quiet = { ...backing, chords: { ...backing.chords, level: 0.2 } };
    assert.equal(backingMixSources(quiet)[1]!.level, 0.2);
  });
});

describe('a project carries its backing', () => {
  it('seeds a new project with the defaults', () => {
    const p = createProject({ id: 'p', name: 'P', bpm: 120, barCount: 16, quality: 'standard' });
    assert.deepEqual(p.backing, defaultBacking());
  });

  it('accepts a groove chosen at setup (§4.5)', () => {
    const chosen = {
      ...defaultBacking(),
      drums: { patternId: 'boom-bap', kitId: 'lofi', level: 0.8, muted: false },
    };
    const p = createProject({
      id: 'p',
      name: 'P',
      bpm: 96,
      barCount: 8,
      quality: 'standard',
      backing: chosen,
    });
    assert.equal(p.backing.drums.patternId, 'boom-bap');
  });

  /**
   * §1.2: BPM and bar count lock after the first recording because every derived value depends on
   * them. Backing feeds nothing derived, so it stays editable for the life of the project — the
   * user swaps the kit after four layers, or drops the chords once the guitar carries the harmony.
   */
  it('stays editable after the configuration locks', () => {
    const p = createProject({ id: 'p', name: 'P', bpm: 120, barCount: 4, quality: 'standard' });
    const t = projectTiming(p);
    const first = recordSession(p.layers[0]!, session(loopFrames(t)), t);
    const recorded: Project = { ...p, layers: [first, ...p.layers.slice(1)] };
    assert.equal(isConfigurationLocked(recorded), true, 'the fixture did not lock the project');

    const swapped: Project = {
      ...recorded,
      backing: {
        ...recorded.backing,
        drums: { ...recorded.backing.drums, kitId: 'punchy' },
      },
    };
    assert.equal(swapped.backing.drums.kitId, 'punchy');
    assert.equal(isConfigurationLocked(swapped), true, 'changing the kit must not unlock anything');
  });
});

describe('randomChord', () => {
  it('never spells a root nobody writes — no B♯, no F♭, no E♯, no C♭', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const chord = randomChord();
      seen.add(`${chord.letter}${chord.accidental}`);
    }
    for (const bad of ['Bsharp', 'Fflat', 'Esharp', 'Cflat']) {
      assert.ok(!seen.has(bad), `drew ${bad}`);
    }
  });

  it('reaches all twelve pitches and no more', () => {
    const pitches = new Set<number>();
    for (let i = 0; i < 4000; i++) pitches.add(chordMidiNotes(randomChord())[0]! % 12);
    assert.equal(pitches.size, 12);
  });

  it('leans on triads, so four sevenths is not the common progression', () => {
    let triads = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const { quality } = randomChord();
      if (quality === 'major' || quality === 'minor') triads++;
    }
    assert.ok(triads / n > 0.55, `only ${((triads / n) * 100).toFixed(0)}% were triads`);
  });

  it('takes its randomness as an argument, so the distribution is checkable at all', () => {
    assert.deepEqual(randomChord(() => 0), { letter: 'C', accidental: 'natural', quality: 'major' });
  });
});

describe('drum voices', () => {
  it('lists every voice any pattern uses, so nothing is silently unscheduled', () => {
    const used = new Set<DrumVoice>();
    for (const pattern of DRUM_PATTERNS) {
      for (const voice of Object.keys(pattern.voices) as DrumVoice[]) used.add(voice);
    }
    for (const voice of used) {
      assert.ok(DRUM_VOICES.includes(voice), `${voice} is used but not in DRUM_VOICES`);
    }
  });
});
