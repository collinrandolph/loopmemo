import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BEATS,
  HAAS_MAX_SECONDS,
  PAN_ICON_ARCS,
  PAN_PRESETS,
  SILENT,
  gainFromDb,
  haasDelayFrames,
  noteDelayFrames,
  panGains,
  panPlan,
  panPreset,
} from '../src/domain/effects.ts';
import { framesPerBar, timing } from '../src/domain/timing.ts';
import { T } from './fixtures.ts';

const close = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

describe('pan', () => {
  it('is equal-power at every angle', () => {
    // Linear panning would dip about 3 dB through the centre, audible as a layer going quiet
    // in the middle of the sweep. Sources are mono, so this is positioning, not balancing.
    for (let angle = -45; angle <= 45; angle += 1) {
      const { left, right } = panGains(angle);
      close(left * left + right * right, 1);
    }
  });

  it('treats ±45° as a hard pan', () => {
    assert.deepEqual(panGains(-45), { left: 1, right: 0 });
    const hardRight = panGains(45);
    close(hardRight.left, 0);
    close(hardRight.right, 1);
  });

  it('puts the centre at −3 dB on both sides, not unity', () => {
    const { left, right } = panGains(0);
    close(left, Math.SQRT1_2);
    close(right, Math.SQRT1_2);
  });

  it('rejects an angle outside the field', () => {
    assert.throws(() => panGains(46), RangeError);
    assert.throws(() => panGains(-90), RangeError);
  });

  it('offers the six presets from §2.8', () => {
    assert.deepEqual(
      PAN_PRESETS.map((p) => p.id),
      ['center', 'slightL', 'slightR', 'wideL', 'wideR', 'surround'],
    );
    assert.throws(() => panPreset('nope' as never), RangeError);
  });
});

describe('the Haas delay', () => {
  it('is one eighth of a beat, which is what 7500/BPM means', () => {
    // §2.8 gives 7500/BPM ms; 60000/BPM ÷ 8 is the same number, so the constant is really a
    // note division. Expressing it that way keeps it in frames and drops the magic number.
    const t = timing(120, 16, 44_100);
    const ms = (noteDelayFrames(t, BEATS.thirtySecond) / t.sampleRate) * 1000;
    close(ms, 7500 / 120, 0.01);
    close(ms, 62.5, 0.01);
  });

  it('shares its arithmetic with framesPerBar', () => {
    // noteDelayFrames takes beats; framesPerBar is a beat count. Same formula, one place.
    for (const bpm of [60, 96, 120, 173, 240]) {
      const t = timing(bpm, 16, 44_100);
      assert.equal(noteDelayFrames(t, t.beatsPerBar), framesPerBar(t));
    }
  });

  it('clamps to 35 ms so it stays fused at every tempo', () => {
    // Above roughly 35-40 ms the copy separates into a second attack instead of widening.
    for (const bpm of [60, 84, 96, 120, 180, 214, 240]) {
      const t = timing(bpm, 16, 44_100);
      const seconds = haasDelayFrames(t) / t.sampleRate;
      assert.ok(seconds <= HAAS_MAX_SECONDS + 1e-9, `${bpm} BPM gave ${seconds * 1000} ms`);
    }
  });

  it('still follows the tempo where that fits inside the window', () => {
    // 7500/BPM <= 35 ms above about 214 BPM, so the fast end keeps the sync.
    const fast = timing(240, 16, 44_100);
    assert.equal(haasDelayFrames(fast), noteDelayFrames(fast, BEATS.thirtySecond));

    const slow = timing(120, 16, 44_100);
    assert.ok(haasDelayFrames(slow) < noteDelayFrames(slow, BEATS.thirtySecond), 'clamped');
  });

  it('scales with the sample rate, being a duration', () => {
    const high = timing(120, 16, 48_000);
    const standard = timing(120, 16, 44_100);
    close(haasDelayFrames(high) / 48_000, haasDelayFrames(standard) / 44_100, 1e-4);
  });
});

describe('the picker icons', () => {
  // A static label per preset, not a readout. The only thing worth asserting is that the
  // six are tellable apart and that the renderer can draw them.
  it('gives each preset a shape no other preset has', () => {
    const shapes = PAN_PRESETS.map((p) => `${p.icon.left}/${p.icon.right}`);
    assert.deepEqual(shapes, ['2/2', '2/1', '1/2', '3/0', '0/3', '3/3']);
    assert.equal(new Set(shapes).size, PAN_PRESETS.length);
  });

  it('stays within the arcs the icon has', () => {
    for (const { id, icon } of PAN_PRESETS) {
      assert.ok(icon.left >= 0 && icon.left <= PAN_ICON_ARCS, id);
      assert.ok(icon.right >= 0 && icon.right <= PAN_ICON_ARCS, id);
    }
  });
});

describe('panPlan', () => {
  it('gives every preset the same delay time, silencing the path instead', () => {
    // The audio layer builds the delay path once per layer and changes only the wet gain.
    // Rebuilding the graph or moving the delay time on a preset change both click, and
    // preset changes are a live gesture.
    const delays = PAN_PRESETS.map((p) => panPlan(p, T).delay.delayFrames);
    assert.equal(new Set(delays).size, 1);
    assert.equal(delays[0], haasDelayFrames(T));
  });

  it('sends nothing to the delay on the five plain presets', () => {
    for (const preset of PAN_PRESETS.filter((p) => p.id !== 'surround')) {
      assert.deepEqual(panPlan(preset, T).delay.wet, SILENT, preset.id);
      assert.deepEqual(panPlan(preset, T).dry, panGains(preset.angle));
    }
  });

  it('puts Surround dry hard left and its copy hard right, below it', () => {
    const plan = panPlan(panPreset('surround'), T);
    assert.deepEqual(plan.dry, { left: 1, right: 0 });
    close(plan.delay.wet.left, 0);
    close(plan.delay.wet.right, gainFromDb(-1.5));
    assert.equal(plan.delay.feedback, 0, 'a single repeat; feedback is for the v2 delay');
  });

  it('leaves Surround about 2.3 dB hotter than the other presets', () => {
    // Not an assertion that this is right — it is the consequence of -1.5 dB, recorded so a
    // change to that number is deliberate. Surround is the only preset whose two paths both
    // carry signal, so switching to it reads as a level change as well as a width one.
    const power = (g: { left: number; right: number }) => g.left ** 2 + g.right ** 2;
    const plan = panPlan(panPreset('surround'), T);
    const total = power(plan.dry) + power(plan.delay.wet);

    close(power(panPlan(panPreset('center'), T).dry), 1, 1e-9);
    close(10 * Math.log10(total), 2.32, 0.01);
  });
});
