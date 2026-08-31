import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PAN_PRESETS, isStereoPreset } from '../src/domain/effects.ts';
import {
  DEFAULT_SELECTION,
  type ExportOptions,
  type ExportSelection,
  exportPlan,
  isExportable,
} from '../src/domain/export.ts';
import {
  type Project,
  bytesPerSecond,
  createProject,
  projectTiming,
  recordSession,
} from '../src/domain/project.ts';
import { loopFrames, loopSeconds } from '../src/domain/timing.ts';
import { LOOP, session } from './fixtures.ts';

function project(quality: 'standard' | 'high' = 'standard'): Project {
  return createProject({
    id: 'p1',
    name: 'Rooftop',
    bpm: 96,
    barCount: 16,
    quality,
    now: '2026-08-29T00:00:00.000Z',
  });
}

/**
 * `count` layers, each with `takes` sessions of one pass.
 *
 * One pass **at this project's rate**, not the fixture's frame count: a 48k project holding
 * 44.1k's worth of frames is 8% short, which is a difference in the recording rather than in
 * the export and would show up as a size gap nothing in the plan caused.
 */
function recorded(base: Project, count: number, takes = 1): Project {
  const t = projectTiming(base);
  const oneLoop = loopFrames(t);
  const layers = base.layers.map((layer, i) => {
    if (i >= count) return layer;
    let next = layer;
    for (let k = 0; k < takes; k++) next = recordSession(next, session(oneLoop, `s${i}-${k}`), t);
    return { ...next, name: `L${i + 1}` };
  });
  return { ...base, layers };
}

const wav: ExportOptions = { format: 'wav', mp3Bitrate: 192 };
const mp3: ExportOptions = { format: 'mp3', mp3Bitrate: 192 };
const all: ExportSelection = { fullLoop: true, stems: true, stemsWithEffects: true, allPasses: true };
const only = (key: keyof ExportSelection): ExportSelection => ({
  fullLoop: false,
  stems: false,
  stemsWithEffects: false,
  allPasses: false,
  [key]: true,
});

const BACKING = [
  { id: 'drums', muted: false, level: 1, label: 'Drums' },
  { id: 'chords', muted: false, level: 1, label: 'Chords' },
  // Muted, so it is not part of the sketch and produces no stem — unlike a muted *layer*.
  { id: 'shaker', muted: true, level: 1, label: 'Shaker' },
];

describe('export selection', () => {
  it('defaults to the loop alone', () => {
    // §4.5's one deliverable. The other three are opt-in.
    assert.deepEqual(DEFAULT_SELECTION, {
      fullLoop: true,
      stems: false,
      stemsWithEffects: false,
      allPasses: false,
    });
  });

  it('is not an export with nothing selected', () => {
    assert.equal(isExportable({ fullLoop: false, stems: false, stemsWithEffects: false, allPasses: false }), false);
    assert.equal(isExportable(DEFAULT_SELECTION), true);
  });
});

describe('full loop', () => {
  it('is exactly one file, one loop long', () => {
    const p = recorded(project(), 3);
    const plan = exportPlan(p, DEFAULT_SELECTION, wav);
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0]!.name, 'Rooftop.wav');
    assert.equal(plan.files[0]!.seconds, loopSeconds(projectTiming(p)));
  });

  it('is stereo, because the mixdown pans', () => {
    assert.equal(exportPlan(recorded(project(), 2), DEFAULT_SELECTION, wav).files[0]!.channels, 2);
  });

  it('sizes the stereo loop at twice the mono rate', () => {
    const p = recorded(project(), 1);
    const seconds = loopSeconds(projectTiming(p));
    const plan = exportPlan(p, DEFAULT_SELECTION, wav);
    assert.equal(plan.files[0]!.bytes, Math.round(bytesPerSecond('standard') * 2 * seconds));
  });
});

describe('stems', () => {
  it('gives one file per recorded layer, each one loop long', () => {
    const p = recorded(project(), 3, 4);
    const plan = exportPlan(p, only('stems'), wav);
    assert.deepEqual(
      plan.files.map((f) => f.name),
      ['Rooftop - L1 - stem.wav', 'Rooftop - L2 - stem.wav', 'Rooftop - L3 - stem.wav'],
    );
    // Four passes recorded, one loop exported: a stem is the edited loop, not the take.
    for (const f of plan.files) assert.equal(f.seconds, loopSeconds(projectTiming(p)));
  });

  it('is mono however the layer is panned, because it carries no pan', () => {
    const p = recorded(project(), 2);
    const panned = { ...p, layers: p.layers.map((l) => ({ ...l, pan: 'surround' as const })) };
    const plan = exportPlan(panned, only('stems'), wav);
    assert.ok(plan.files.every((f) => f.channels === 1));
  });

  it('still exports a muted layer', () => {
    // The Full Loop honours the mute; the stem set does not. A layer is usually muted to hear
    // something else, and a set with a track missing is a broken delivery.
    const p = recorded(project(), 2);
    const muted = { ...p, layers: p.layers.map((l) => (l.index === 0 ? { ...l, muted: true } : l)) };
    const plan = exportPlan(muted, only('stems'), wav);
    assert.equal(plan.files.length, 2);
    assert.ok(plan.files.some((f) => f.name === 'Rooftop - L1 - stem.wav'));
  });

  it('skips layers that were never recorded', () => {
    assert.equal(exportPlan(recorded(project(), 2), only('stems'), wav).files.length, 2); // not seven
  });

  it('adds a stem per audible backing track, and skips the muted one', () => {
    // §2.6: the drum loop and chord bed are what every layer was played against, so a stem set
    // without them is missing the thing the layers answer to. Muting one takes it out, which is
    // the opposite of what muting a *layer* does two tests above — see the next test.
    const plan = exportPlan(recorded(project(), 1), only('stems'), { ...wav, backing: BACKING });
    assert.deepEqual(
      plan.files.map((f) => f.name),
      ['Rooftop - L1 - stem.wav', 'Rooftop - Drums - stem.wav', 'Rooftop - Chords - stem.wav'],
    );
  });

  it('parts company with layers on what a mute means', () => {
    // The whole reason the two rules differ, asserted side by side so neither can drift into
    // the other: a muted layer is a performance you are not using right now and still ships as
    // a stem; a muted backing track is a decision the sketch does not have one, and does not.
    const p = recorded(project(), 1);
    const mutedLayer = { ...p, layers: p.layers.map((l) => (l.index === 0 ? { ...l, muted: true } : l)) };
    const names = (o: Parameters<typeof exportPlan>[2]) =>
      exportPlan(mutedLayer, only('stems'), o).files.map((f) => f.name);

    assert.deepEqual(names({ ...wav, backing: [{ id: 'd', muted: false, level: 1, label: 'Drums' }] }), [
      'Rooftop - L1 - stem.wav',
      'Rooftop - Drums - stem.wav',
    ]);
    assert.deepEqual(names({ ...wav, backing: [{ id: 'd', muted: true, level: 1, label: 'Drums' }] }), [
      'Rooftop - L1 - stem.wav',
    ]);
  });

  it('names an unnamed layer by its position', () => {
    const base = project();
    const t = projectTiming(base);
    const p = { ...base, layers: base.layers.map((l) => (l.index === 2 ? recordSession(l, session(LOOP), t) : l)) };
    assert.equal(exportPlan(p, only('stems'), wav).files[0]!.name, 'Rooftop - Layer 3 - stem.wav');
  });
});

describe('stems with effects', () => {
  it('is mono for a centred layer and stereo for a panned one', () => {
    // Centre is the mono capture in both channels; writing it twice doubles the file for
    // nothing. Every other preset is a real stereo image.
    const p = recorded(project(), 3);
    const mixed = {
      ...p,
      layers: p.layers.map((l) =>
        l.index === 0
          ? { ...l, pan: 'center' as const }
          : l.index === 1
            ? { ...l, pan: 'wideL' as const }
            : { ...l, pan: 'surround' as const },
      ),
    };
    const plan = exportPlan(mixed, only('stemsWithEffects'), wav);
    assert.deepEqual(plan.files.map((f) => f.channels), [1, 2, 2]);
  });

  it('agrees with the pan law about which presets spread', () => {
    // One derivation, not two: the file's channel count and the picker's idea of a preset must
    // come from the same place.
    for (const preset of PAN_PRESETS) {
      assert.equal(isStereoPreset(preset), preset.id !== 'center', preset.id);
    }
  });

  it('costs twice a dry stem when panned, and the same when centred', () => {
    const p = recorded(project(), 1);
    const centred = { ...p, layers: p.layers.map((l) => ({ ...l, pan: 'center' as const })) };
    const panned = { ...p, layers: p.layers.map((l) => ({ ...l, pan: 'wideR' as const })) };
    const dry = exportPlan(p, only('stems'), wav).totalBytes;
    assert.equal(exportPlan(centred, only('stemsWithEffects'), wav).totalBytes, dry);
    assert.equal(exportPlan(panned, only('stemsWithEffects'), wav).totalBytes, dry * 2);
  });

  it('covers the same sources as the dry set', () => {
    const p = recorded(project(), 3);
    const dry = exportPlan(p, only('stems'), { ...wav, backing: BACKING });
    const wet = exportPlan(p, only('stemsWithEffects'), { ...wav, backing: BACKING });
    assert.equal(dry.files.length, wet.files.length);
  });
});

describe('all recorded passes', () => {
  it('gives one file per session, not per layer', () => {
    // Sessions are never concatenated (§1.4), so "every pass" on disk is the session set.
    const plan = exportPlan(recorded(project(), 2, 3), only('allPasses'), wav);
    assert.equal(plan.files.length, 6);
    assert.deepEqual(plan.files.slice(0, 3).map((f) => f.name), [
      'Rooftop - L1 - take 1.wav',
      'Rooftop - L1 - take 2.wav',
      'Rooftop - L1 - take 3.wav',
    ]);
  });

  it('numbers the take even when there is only one', () => {
    assert.equal(
      exportPlan(recorded(project(), 1), only('allPasses'), wav).files[0]!.name,
      'Rooftop - L1 - take 1.wav',
    );
  });

  it('is the captured length, not the loop', () => {
    const p = recorded(project(), 1);
    const t = projectTiming(p);
    const long = {
      ...p,
      layers: p.layers.map((l) => (l.index === 0 ? { ...l, sessions: [session(3 * LOOP)] } : l)),
    };
    assert.equal(exportPlan(long, only('allPasses'), wav).files[0]!.seconds, (3 * LOOP) / t.sampleRate);
  });

  it('follows the chosen format like everything else', () => {
    // §2.7 keeps *capture* PCM and says in the same breath that lossy encoding belongs at
    // "compression and export". Forcing these to WAV read that rule as covering a boundary it
    // explicitly does not.
    const plan = exportPlan(recorded(project(), 1), all, mp3);
    assert.ok(plan.files.every((f) => f.format === 'mp3' && f.name.endsWith('.mp3')));
  });

  it('is mono, because capture is', () => {
    const plan = exportPlan(recorded(project(), 2), only('allPasses'), wav);
    assert.ok(plan.files.every((f) => f.channels === 1));
  });
});

describe('sizing', () => {
  it('totals every selected file', () => {
    const plan = exportPlan(recorded(project(), 3, 2), all, wav);
    assert.equal(plan.totalBytes, plan.files.reduce((n, f) => n + f.bytes, 0));
    assert.equal(plan.files.length, 1 + 3 + 3 + 6);
  });

  it('makes MP3 a bitrate multiplication rather than a guess', () => {
    const p = recorded(project(), 1);
    const seconds = loopSeconds(projectTiming(p));
    const plan = exportPlan(p, DEFAULT_SELECTION, { format: 'mp3', mp3Bitrate: 320 });
    assert.equal(plan.files[0]!.bytes, Math.round((320 * 1000 * seconds) / 8));
  });

  it('does not move an MP3 with the channel count, since CBR covers both', () => {
    const p = recorded(project(), 1);
    const centred = { ...p, layers: p.layers.map((l) => ({ ...l, pan: 'center' as const })) };
    const panned = { ...p, layers: p.layers.map((l) => ({ ...l, pan: 'wideR' as const })) };
    assert.equal(
      exportPlan(centred, only('stemsWithEffects'), mp3).totalBytes,
      exportPlan(panned, only('stemsWithEffects'), mp3).totalBytes,
    );
  });

  it('costs more at high quality for WAV, and the same for MP3', () => {
    assert.ok(
      exportPlan(recorded(project('high'), 2), all, wav).totalBytes >
        exportPlan(recorded(project('standard'), 2), all, wav).totalBytes,
    );
    assert.equal(
      exportPlan(recorded(project('standard'), 2), all, mp3).totalBytes,
      exportPlan(recorded(project('high'), 2), all, mp3).totalBytes,
    );
  });

  it('never names two files the same thing, in any combination', () => {
    // These land in one folder. The general form of a collision that was real once: two stem
    // sets, or a stem and a single-take pass, sharing a name. Sweep rather than trust.
    const p = recorded(project(), 3, 2);
    for (const fullLoop of [false, true]) {
      for (const stems of [false, true]) {
        for (const stemsWithEffects of [false, true]) {
          for (const allPasses of [false, true]) {
            const pick = { fullLoop, stems, stemsWithEffects, allPasses };
            const names = exportPlan(p, pick, { ...wav, backing: BACKING }).files.map((f) => f.name);
            assert.equal(new Set(names).size, names.length, JSON.stringify(pick));
          }
        }
      }
    }
  });

  it('reports nothing at all when nothing is selected', () => {
    const plan = exportPlan(recorded(project(), 3), {
      fullLoop: false,
      stems: false,
      stemsWithEffects: false,
      allPasses: false,
    }, wav);
    assert.deepEqual(plan.files, []);
    assert.equal(plan.totalBytes, 0);
  });
});
