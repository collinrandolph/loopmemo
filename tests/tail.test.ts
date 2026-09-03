import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type BackingTracks, defaultBacking } from '../src/domain/backing.ts';
import { haasDelayFrames } from '../src/domain/effects.ts';
import { createProject, emptyLayer, projectTiming, recordSession } from '../src/domain/project.ts';
import { loopTailFrames } from '../src/domain/tail.ts';
import { loopFrames, timing } from '../src/domain/timing.ts';

const T = (bpm: number) => timing(bpm, 4, 44100);
const ms = (frames: number, rate = 44100) => Math.round((frames / rate) * 1000);

function backing(patch: {
  drums?: Partial<BackingTracks['drums']>;
  chords?: Partial<BackingTracks['chords']>;
}): BackingTracks {
  const b = defaultBacking();
  return {
    drums: { ...b.drums, muted: true, ...patch.drums },
    chords: { ...b.chords, muted: true, ...patch.chords },
  };
}

describe('loopTailFrames', () => {
  it('is zero when nothing is audible', () => {
    assert.equal(loopTailFrames([], T(120), backing({})), 0);
  });

  describe('drums', () => {
    // `syncopated-pop` is the only pattern with an open hat, and its own comment says the accent
    // is meant to ring past the loop point. It is therefore the only drum tail in the library.
    const open = { drums: { muted: false, patternId: 'syncopated-pop', kitId: 'tight' } };

    it('is zero at a tempo whose bar outlasts the open hat', () => {
      assert.equal(loopTailFrames([], T(84), backing(open)), 0);
    });

    it('grows with tempo — envelopes are seconds, bars are musical', () => {
      const at120 = loopTailFrames([], T(120), backing(open));
      const at180 = loopTailFrames([], T(180), backing(open));
      assert.ok(at120 > 0 && at180 > at120, `${ms(at120)}ms then ${ms(at180)}ms`);
      assert.equal(ms(at180), 183);
    });

    it('is zero for a pattern with no open hat, at any tempo', () => {
      const closed = { drums: { muted: false, patternId: 'backbeat-pop', kitId: 'tight' } };
      for (const bpm of [84, 120, 180, 240]) {
        assert.equal(loopTailFrames([], T(bpm), backing(closed)), 0, `${bpm} BPM`);
      }
    });
  });

  describe('chords', () => {
    // The cap wraps to the next bar's first onset and releases 50 ms early, so a pattern whose
    // first onset is the downbeat lands *before* the bar line. Every pattern in the library
    // starts on beat 1 except Off-beat Skank, whose onsets are all short chunks.
    it('does not overhang across the usable tempo range', () => {
      for (const id of ['sustain', 'steady-quarters', 'off-beat-skank', 'syncopated-push']) {
        for (const bpm of [84, 120, 180]) {
          const tail = loopTailFrames([], T(bpm), backing({ chords: { muted: false, chordPatternId: id } }));
          assert.equal(tail, 0, `${id} at ${bpm} BPM gave ${ms(tail)}ms`);
        }
      }
    });
  });

  describe('layers', () => {
    const t = T(84);
    const recorded = recordSession(
      emptyLayer(0),
      { id: 's', audioFileURL: 'take://s', recordedFrames: loopFrames(t), recordedAt: '', waveformPeaks: [] },
      t,
    );

    it('counts a Surround layer, with or without backing — the bounce case', () => {
      assert.equal(loopTailFrames([{ ...recorded, pan: 'surround' }], t), haasDelayFrames(t));
    });

    it('ignores a centred one', () => {
      assert.equal(loopTailFrames([{ ...recorded, pan: 'center' }], t), 0);
    });

    it('ignores a muted or unrecorded layer, which cannot be sounding', () => {
      assert.equal(loopTailFrames([{ ...recorded, pan: 'surround', muted: true }], t), 0);
      assert.equal(loopTailFrames([{ ...emptyLayer(0), pan: 'surround' }], t), 0);
    });
  });

  it('reports the worst source, not their sum', () => {
    const t = T(180);
    const p = createProject({ id: 'x', name: 'x', bpm: 180, barCount: 4, quality: 'standard' });
    const layer = { ...p.layers[0]!, pan: 'surround' as const };
    const drums = backing({ drums: { muted: false, patternId: 'syncopated-pop', kitId: 'tight' } });
    const both = loopTailFrames([layer], projectTiming(p), drums);
    assert.equal(both, loopTailFrames([], t, drums), 'the hat outlasts the Haas delay');
  });
});
