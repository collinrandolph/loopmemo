import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DRUM_VOICES,
  chordLabel,
  defaultBacking,
  drumPattern,
} from '../src/domain/backing.ts';
import {
  backingBar,
  backingSchedule,
  beatFrameOffset,
  chordBarOnsets,
  drumBarOnsets,
} from '../src/domain/backing-schedule.ts';
import { framesPerBar, timing } from '../src/domain/timing.ts';

const T = timing(120, 16, 44_100);

/** Every track audible, and a progression whose slots are distinguishable. */
function audible() {
  const base = defaultBacking();
  return {
    drums: { ...base.drums, muted: false },
    chords: {
      ...base.chords,
      muted: false,
      chordPatternId: 'backbeat-strum',
      slots: [
        { letter: 'C', accidental: 'natural', quality: 'major' },
        { letter: 'A', accidental: 'natural', quality: 'minor' },
        { letter: 'F', accidental: 'natural', quality: 'major' },
        { letter: 'G', accidental: 'natural', quality: 'dom7' },
      ],
    },
  } as const;
}

describe('beatFrameOffset', () => {
  it('puts beat 1 on the downbeat', () => {
    assert.equal(beatFrameOffset(T, 1), 0);
  });

  it('divides the bar the domain actually uses, not an idealised one', () => {
    // 120 BPM at 44.1 kHz is 88,200 frames a bar exactly, so the quarters are exact too.
    assert.equal(framesPerBar(T), 88_200);
    assert.equal(beatFrameOffset(T, 2), 22_050);
    assert.equal(beatFrameOffset(T, 3), 44_100);
    assert.equal(beatFrameOffset(T, 4), 66_150);
    assert.equal(beatFrameOffset(T, 2.5), 33_075);
  });

  it('never reaches the next bar, at any tempo in range', () => {
    for (const bpm of [60, 96, 120, 137, 200, 240]) {
      const t = timing(bpm, 8, 48_000);
      const last = beatFrameOffset(t, 4.5);
      assert.ok(last < framesPerBar(t), `${bpm} BPM: ${last} >= ${framesPerBar(t)}`);
    }
  });

  /**
   * The reason this derives from `framesPerBar` rather than from its own frames-per-beat. At a
   * tempo where the bar does not divide evenly, an independently-rounded beat length drifts
   * against the bar grid the rest of the domain uses.
   */
  it('stays inside its own bar even where the bar length does not divide evenly', () => {
    const t = timing(137, 8, 44_100); // 77,255.47… frames a bar
    assert.equal(framesPerBar(t), 77_255);
    for (const beat of [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]) {
      const offset = beatFrameOffset(t, beat);
      assert.ok(offset >= 0 && offset < framesPerBar(t), `beat ${beat} at ${offset}`);
    }
  });

  it('rejects a beat outside the bar rather than scheduling into the next one', () => {
    assert.throws(() => beatFrameOffset(T, 0), /outside/);
    assert.throws(() => beatFrameOffset(T, 5), /outside/);
  });
});

describe('drum onsets', () => {
  it('schedules every onset the pattern names, and no others', () => {
    const pattern = drumPattern('four-on-the-floor');
    const expected = DRUM_VOICES.reduce((n, v) => n + (pattern.voices[v]?.length ?? 0), 0);
    assert.equal(drumBarOnsets(T, 'four-on-the-floor', 'tight').length, expected);
  });

  it('comes back in ascending frame order', () => {
    const onsets = drumBarOnsets(T, 'syncopated-pop', 'deep');
    for (let i = 1; i < onsets.length; i++) {
      assert.ok(
        onsets[i]!.frameOffset >= onsets[i - 1]!.frameOffset,
        `onset ${i} went backwards`,
      );
    }
  });

  /**
   * Not tidiness — the hat choke depends on hats being reached in a defined sequence, so a kick
   * and a hat sharing beat 1 must not be able to swap between two runs of the same pattern.
   */
  it('breaks ties by voice order, deterministically', () => {
    const onsets = drumBarOnsets(T, 'four-on-the-floor', 'tight');
    const onDownbeat = onsets.filter((o) => o.frameOffset === 0).map((o) => o.voice);
    assert.deepEqual(onDownbeat, ['kick', 'hat']);
  });

  it('carries the kit through, so the same pattern rings differently on a different kit', () => {
    const tight = drumBarOnsets(T, 'backbeat-pop', 'tight');
    const deep = drumBarOnsets(T, 'backbeat-pop', 'deep');
    assert.deepEqual(
      tight.map((o) => o.frameOffset),
      deep.map((o) => o.frameOffset),
      'the kit changed when the voices fire, which is the pattern’s job',
    );
    const tightKick = tight.find((o) => o.voice === 'kick')!;
    const deepKick = deep.find((o) => o.voice === 'kick')!;
    assert.notEqual(tightKick.nominalFrames, deepKick.nominalFrames);
  });

  it('schedules the open hat as its own voice, ringing longer than the closed ones', () => {
    const onsets = drumBarOnsets(T, 'syncopated-pop', 'tight');
    const open = onsets.find((o) => o.voice === 'hatOpen');
    const closed = onsets.find((o) => o.voice === 'hat');
    assert.ok(open, 'syncopated-pop lost its open accent');
    assert.ok(open!.nominalFrames > closed!.nominalFrames);
  });
});

describe('chord onsets', () => {
  it('schedules strikes and chunks together, in time order', () => {
    const onsets = chordBarOnsets(T, 'backbeat-strum', 'rhodes');
    assert.deepEqual(
      onsets.map((o) => o.beat),
      [1, 2.5, 3, 4.5],
    );
    assert.deepEqual(
      onsets.map((o) => o.articulation),
      ['strike', 'chunk', 'strike', 'chunk'],
    );
  });

  it('makes a chunk ring shorter than a strike of the same tone', () => {
    const onsets = chordBarOnsets(T, 'backbeat-strum', 'pad');
    const strike = onsets.find((o) => o.articulation === 'strike')!;
    const chunk = onsets.find((o) => o.articulation === 'chunk')!;
    assert.ok(chunk.nominalFrames < strike.nominalFrames);
  });

  it('handles a pattern with nothing on the downbeat', () => {
    const onsets = chordBarOnsets(T, 'off-beat-skank', 'organ');
    assert.equal(onsets.length, 4);
    assert.ok(onsets.every((o) => o.articulation === 'chunk'));
    assert.ok(onsets[0]!.frameOffset > 0, 'skank landed on the downbeat');
  });

  it('handles Sustain, which is one onset for the whole bar', () => {
    const onsets = chordBarOnsets(T, 'sustain', 'pad');
    assert.equal(onsets.length, 1);
    assert.equal(onsets[0]!.frameOffset, 0);
  });
});

describe('backingBar', () => {
  it('places the bar in the loop and the onsets inside the bar', () => {
    const bar = backingBar(audible(), T, 3);
    assert.equal(bar.frameOffset, 2 * framesPerBar(T));
    for (const onset of [...bar.drums, ...bar.chords]) {
      assert.ok(onset.frameOffset >= 0 && onset.frameOffset < framesPerBar(T));
    }
  });

  it('reads the chord through the tiling rule — bar preview sounds like the loop (§2.6)', () => {
    const backing = audible();
    assert.equal(chordLabel(backingBar(backing, T, 1).chord), 'C');
    assert.equal(chordLabel(backingBar(backing, T, 6).chord), 'Am');
    assert.equal(chordLabel(backingBar(backing, T, 11).chord), 'F');
    assert.equal(chordLabel(backingBar(backing, T, 16).chord), 'G7');
  });

  it('hands over frequencies at the chosen octave, ready for the platform', () => {
    const backing = audible();
    const mid = backingBar(backing, T, 2).frequencies;
    const high = backingBar({ ...backing, chords: { ...backing.chords, octave: 1 } }, T, 2)
      .frequencies;
    assert.equal(mid.length, 3, 'A minor is a triad');
    high.forEach((f, i) => assert.ok(Math.abs(f / mid[i]! - 2) < 1e-9));
  });

  it('schedules nothing for a muted track, rather than scheduling it silent', () => {
    const backing = audible();
    const noDrums = backingBar({ ...backing, drums: { ...backing.drums, muted: true } }, T, 1);
    assert.equal(noDrums.drums.length, 0);
    assert.ok(noDrums.chords.length > 0, 'muting the drums silenced the chords too');

    const noChords = backingBar({ ...backing, chords: { ...backing.chords, muted: true } }, T, 1);
    assert.equal(noChords.chords.length, 0);
    assert.ok(noChords.drums.length > 0, 'muting the chords silenced the drums too');
  });

  it('still reports which chord owns the slot when the bed is muted', () => {
    const backing = audible();
    const muted = backingBar({ ...backing, chords: { ...backing.chords, muted: true } }, T, 6);
    assert.equal(chordLabel(muted.chord), 'Am', 'the grid still has to draw the progression');
  });
});

describe('backingSchedule', () => {
  it('covers the whole loop, one entry per bar, in order', () => {
    const bars = backingSchedule(audible(), T);
    assert.equal(bars.length, T.barCount);
    bars.forEach((bar, i) => {
      assert.equal(bar.slot, i + 1);
      assert.equal(bar.frameOffset, i * framesPerBar(T));
    });
  });

  it('repeats the drum pattern unchanged and walks the chords', () => {
    const bars = backingSchedule(audible(), T);
    const first = bars[0]!.drums.map((o) => `${o.voice}@${o.frameOffset}`);
    for (const bar of bars) {
      assert.deepEqual(bar.drums.map((o) => `${o.voice}@${o.frameOffset}`), first);
    }
    assert.deepEqual(
      bars.slice(0, 5).map((b) => chordLabel(b.chord)),
      ['C', 'Am', 'F', 'G7', 'C'],
    );
  });

  it('never schedules an onset past the end of the loop', () => {
    for (const bpm of [60, 120, 240]) {
      for (const barCount of [4, 16, 32]) {
        const t = timing(bpm, barCount, 48_000);
        const loop = framesPerBar(t) * barCount;
        for (const bar of backingSchedule(audible(), t)) {
          for (const onset of [...bar.drums, ...bar.chords]) {
            assert.ok(
              bar.frameOffset + onset.frameOffset < loop,
              `${bpm} BPM / ${barCount} bars: onset past the loop end`,
            );
          }
        }
      }
    }
  });

  it('is empty of onsets, but still the right length, with both tracks muted', () => {
    const base = audible();
    const silent = {
      drums: { ...base.drums, muted: true },
      chords: { ...base.chords, muted: true },
    };
    const bars = backingSchedule(silent, T);
    assert.equal(bars.length, T.barCount);
    assert.ok(bars.every((b) => b.drums.length === 0 && b.chords.length === 0));
  });
});
