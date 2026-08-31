import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
import { loopSeconds } from '../src/domain/timing.ts';
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

/** `count` layers, each with `takes` sessions of one pass. */
function recorded(base: Project, count: number, takes = 1): Project {
  const t = projectTiming(base);
  const layers = base.layers.map((layer, i) => {
    if (i >= count) return layer;
    let next = layer;
    for (let k = 0; k < takes; k++) next = recordSession(next, session(LOOP, `s${i}-${k}`), t);
    return { ...next, name: `L${i + 1}` };
  });
  return { ...base, layers };
}

const wav: ExportOptions = { format: 'wav', mp3Bitrate: 192 };
const mp3: ExportOptions = { format: 'mp3', mp3Bitrate: 192 };
const all: ExportSelection = { fullLoop: true, stems: true, raw: true };

describe('export selection', () => {
  it('defaults to the loop alone', () => {
    // §4.5's one deliverable. The other two are opt-in.
    assert.deepEqual(DEFAULT_SELECTION, { fullLoop: true, stems: false, raw: false });
  });

  it('is not an export with nothing selected', () => {
    assert.equal(isExportable({ fullLoop: false, stems: false, raw: false }), false);
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

  it('is the only stereo file', () => {
    // Pan is the one thing that makes two channels out of a mono capture, and it is applied
    // in the mixdown alone.
    const plan = exportPlan(recorded(project(), 2), all, wav);
    assert.deepEqual(
      [...new Set(plan.files.map((f) => `${f.kind}:${f.channels}`))].sort(),
      ['loop:2', 'raw:1', 'stem:1'],
    );
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
    const plan = exportPlan(p, { fullLoop: false, stems: true, raw: false }, wav);
    assert.deepEqual(
      plan.files.map((f) => f.name),
      ['Rooftop - L1.wav', 'Rooftop - L2.wav', 'Rooftop - L3.wav'],
    );
    // Four passes recorded, one loop exported: a stem is the edited loop, not the take.
    for (const f of plan.files) assert.equal(f.seconds, loopSeconds(projectTiming(p)));
  });

  it('still exports a muted layer', () => {
    // The Full Loop honours the mute; the stem set does not. A layer is usually muted to hear
    // something else, and a set with a track missing is a broken delivery.
    const p = recorded(project(), 2);
    const muted = { ...p, layers: p.layers.map((l) => (l.index === 0 ? { ...l, muted: true } : l)) };
    const plan = exportPlan(muted, { fullLoop: false, stems: true, raw: false }, wav);
    assert.equal(plan.files.length, 2);
    assert.ok(plan.files.some((f) => f.name === 'Rooftop - L1.wav'));
  });

  it('skips layers that were never recorded', () => {
    const plan = exportPlan(recorded(project(), 2), { fullLoop: false, stems: true, raw: false }, wav);
    assert.equal(plan.files.length, 2); // not seven
  });

  it('adds one stem per enabled reference track, muted or not', () => {
    // §2.6: the drum loop and chord bed are what every layer was played against. `enabled`,
    // not audible — mute belongs to the mixdown.
    const plan = exportPlan(recorded(project(), 1), { fullLoop: false, stems: true, raw: false }, {
      ...wav,
      references: [
        { id: 'drums', enabled: true, muted: false, level: 1, label: 'Drums' },
        { id: 'chords', enabled: true, muted: true, level: 1, label: 'Chords' },
        { id: 'other', enabled: false, muted: false, level: 1, label: 'Other' },
      ],
    });
    assert.deepEqual(
      plan.files.map((f) => f.name),
      ['Rooftop - L1.wav', 'Rooftop - Drums.wav', 'Rooftop - Chords.wav'],
    );
  });

  it('names an unnamed layer by its position', () => {
    const base = project();
    const t = projectTiming(base);
    const p = { ...base, layers: base.layers.map((l) => (l.index === 2 ? recordSession(l, session(LOOP), t) : l)) };
    const plan = exportPlan(p, { fullLoop: false, stems: true, raw: false }, wav);
    assert.equal(plan.files[0]!.name, 'Rooftop - Layer 3.wav');
  });
});

describe('raw', () => {
  it('gives one file per session, not per layer', () => {
    // Sessions are never concatenated (§1.4), so "every pass" on disk is the session set.
    const p = recorded(project(), 2, 3);
    const plan = exportPlan(p, { fullLoop: false, stems: false, raw: true }, wav);
    assert.equal(plan.files.length, 6);
    assert.deepEqual(plan.files.slice(0, 3).map((f) => f.name), [
      'Rooftop - L1 - take 1.wav',
      'Rooftop - L1 - take 2.wav',
      'Rooftop - L1 - take 3.wav',
    ]);
  });

  it('numbers the take even when there is only one', () => {
    // Not cosmetic: without the number a layer recorded once names its raw file exactly what
    // its stem is called, and selecting both writes two different files to one name.
    const plan = exportPlan(recorded(project(), 1), { fullLoop: false, stems: false, raw: true }, wav);
    assert.equal(plan.files[0]!.name, 'Rooftop - L1 - take 1.wav');
  });

  it('is the captured length, not the loop', () => {
    const p = recorded(project(), 1);
    const t = projectTiming(p);
    const long = {
      ...p,
      layers: p.layers.map((l) => (l.index === 0 ? { ...l, sessions: [session(3 * LOOP)] } : l)),
    };
    const plan = exportPlan(long, { fullLoop: false, stems: false, raw: true }, wav);
    assert.equal(plan.files[0]!.seconds, (3 * LOOP) / t.sampleRate);
  });

  it('stays WAV even when the export format is MP3', () => {
    // §2.7 keeps capture PCM so nothing compounds loss; a re-encoded "raw" file defeats the word.
    const plan = exportPlan(recorded(project(), 1), all, mp3);
    const raw = plan.files.filter((f) => f.kind === 'raw');
    const rendered = plan.files.filter((f) => f.kind !== 'raw');
    assert.ok(raw.every((f) => f.format === 'wav' && f.name.endsWith('.wav')));
    assert.ok(rendered.every((f) => f.format === 'mp3' && f.name.endsWith('.mp3')));
  });
});

describe('sizing', () => {
  it('totals every selected file', () => {
    const plan = exportPlan(recorded(project(), 3, 2), all, wav);
    assert.equal(plan.totalBytes, plan.files.reduce((n, f) => n + f.bytes, 0));
    assert.equal(plan.files.length, 1 + 3 + 6);
  });

  it('makes MP3 a bitrate multiplication rather than a guess', () => {
    const p = recorded(project(), 1);
    const seconds = loopSeconds(projectTiming(p));
    const plan = exportPlan(p, DEFAULT_SELECTION, { format: 'mp3', mp3Bitrate: 320 });
    assert.equal(plan.files[0]!.bytes, Math.round((320 * 1000 * seconds) / 8));
  });

  it('costs more at high quality, for WAV only', () => {
    const std = exportPlan(recorded(project('standard'), 2), all, wav).totalBytes;
    const hi = exportPlan(recorded(project('high'), 2), all, wav).totalBytes;
    assert.ok(hi > std);
    // MP3 is a bitrate, so the rendered files do not move with capture quality — but raw is
    // still PCM at the project's rate, so the total does.
    const stdMp3 = exportPlan(recorded(project('standard'), 2), DEFAULT_SELECTION, mp3).totalBytes;
    const hiMp3 = exportPlan(recorded(project('high'), 2), DEFAULT_SELECTION, mp3).totalBytes;
    assert.equal(stdMp3, hiMp3);
  });

  it('never names two files the same thing, in any combination', () => {
    // These land in one folder. The general form of the collision that `take 1` fixed: sweep
    // every selection rather than trusting the one case that was noticed.
    const p = recorded(project(), 3, 2);
    const references = [
      { id: 'drums', enabled: true, muted: false, level: 1, label: 'Drums' },
      { id: 'chords', enabled: true, muted: false, level: 1, label: 'Chords' },
    ];
    for (const fullLoop of [false, true]) {
      for (const stems of [false, true]) {
        for (const raw of [false, true]) {
          const plan = exportPlan(p, { fullLoop, stems, raw }, { ...wav, references });
          const names = plan.files.map((f) => f.name);
          assert.equal(new Set(names).size, names.length, `duplicate in ${JSON.stringify({ fullLoop, stems, raw })}`);
        }
      }
    }
  });

  it('reports nothing at all when nothing is selected', () => {
    const plan = exportPlan(recorded(project(), 3), { fullLoop: false, stems: false, raw: false }, wav);
    assert.deepEqual(plan.files, []);
    assert.equal(plan.totalBytes, 0);
  });
});
