import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bounceSeed, bouncedName } from '../src/domain/bounce.ts';
import { DEFAULT_SELECTION, exportPlan } from '../src/domain/export.ts';
import {
  type Layer,
  type Project,
  compressedProject,
  createProject,
  projectTiming,
  projectTotalPasses,
  recordSession,
  sizeProjection,
} from '../src/domain/project.ts';
import { availablePasses, regionFor, totalPasses } from '../src/domain/pass-index.ts';
import type { RecordingSession } from '../src/domain/pass-index.ts';
import { layerPassIndex } from '../src/domain/project.ts';
import { framesPerBar, loopFrames } from '../src/domain/timing.ts';

/**
 * Two individually-correct features, in sequence.
 *
 * **This is the category that produced the worst findings and had no coverage at all.** 359 tests
 * and eight browser instruments were green while a screen previewed another project's audio and a
 * bounced project could not be overdubbed in time, because every one of them checks an operation
 * on its own. Bounce is correct. Recording is correct. Recording onto the seed a bounce produced
 * is a third thing, and nothing asked about it.
 *
 * Pure domain, so these run under `npm test` with no Web Audio and nothing to be flaky about. The
 * compositions that need an engine live in `ui/src/verify-lifecycle.ts`.
 */

const SEQ = { n: 0 };
function session(frames: number, id = `take-${++SEQ.n}`): RecordingSession {
  return {
    id,
    audioFileURL: `blob:${id}`,
    recordedFrames: frames,
    recordedAt: '2026-09-16T00:00:00.000Z',
    waveformPeaks: [],
  };
}

/** Record `passes` whole passes onto one layer of a fresh project. */
function recorded(passes: number, opts: { bpm?: number; barCount?: number } = {}) {
  const project = createProject({
    id: 'src',
    name: 'Source',
    bpm: opts.bpm ?? 96,
    barCount: opts.barCount ?? 8,
    quality: 'standard',
  });
  const t = projectTiming(project);
  const layer = recordSession(project.layers[0]!, session(loopFrames(t) * passes), t);
  return {
    project: { ...project, layers: project.layers.map((l) => (l.index === 0 ? layer : l)) },
    t,
  };
}

function withLayer(project: Project, layer: Layer): Project {
  return { ...project, layers: project.layers.map((l) => (l.index === layer.index ? layer : l)) };
}

describe('record -> bounce -> overdub', () => {
  const { project: source, t } = recorded(3);

  it('the seed holds exactly one pass, because a mixdown is one loop', () => {
    const mixdown = session(loopFrames(t), 'mixdown');
    const seed = bounceSeed(source, mixdown, { id: 'b1', name: bouncedName(source.name) });

    assert.equal(totalPasses(layerPassIndex(seed.layers[0]!, projectTiming(seed))), 1);
    assert.equal(projectTotalPasses(seed), 1, 'and nothing else carries passes into it');
  });

  it('layer 1 of a seed can be recorded onto, and both sessions resolve', () => {
    const mixdown = session(loopFrames(t), 'mixdown');
    const seed = bounceSeed(source, mixdown, { id: 'b1', name: bouncedName(source.name) });
    const seedT = projectTiming(seed);

    // The case that makes a *per-layer* answer wrong for anything about bounce provenance: one
    // layer now holds a rendered session and a captured one.
    const overdubbed = recordSession(seed.layers[0]!, session(loopFrames(seedT) * 2, 'live'), seedT);
    const index = layerPassIndex(overdubbed, seedT);

    assert.equal(totalPasses(index), 3, 'the mixdown pass plus two recorded ones');
    assert.equal(overdubbed.sessions.length, 2, 'and they are two sessions, never concatenated');
    for (let bar = 1; bar <= seed.barCount; bar++) {
      for (const pass of availablePasses(index, bar)) {
        assert.ok(regionFor(index, { pass, relativeBar: bar }), `P${pass}/bar ${bar} resolves`);
      }
    }
  });

  it('a seed carries the source backing verbatim, mute flags included', () => {
    const muted: Project = {
      ...source,
      backing: { ...source.backing, drums: { ...source.backing.drums, muted: true } },
    };
    const seed = bounceSeed(muted, session(loopFrames(t), 'm2'), { id: 'b2', name: 'B' });
    assert.equal(seed.backing.drums.muted, true, 'the groove carries as settings, muted or not');
    assert.deepEqual(seed.backing, muted.backing);
  });

  /**
   * **"All recorded passes" is one file per *session*, not per pass** — and this test asserted
   * per pass first, which was the test being wrong rather than the code. §1.4 says sessions are
   * never concatenated, so a layer recorded twice holds two files; a three-pass layer built from
   * a rendered mixdown and one two-pass take is two files, not three. `exportPlan` says so in a
   * comment and the checkbox label is the loose part.
   */
  it('exporting the overdubbed seed plans one file per session', () => {
    const seed = bounceSeed(source, session(loopFrames(t), 'm3'), { id: 'b3', name: 'B' });
    const seedT = projectTiming(seed);
    const overdubbed = withLayer(
      seed,
      recordSession(seed.layers[0]!, session(loopFrames(seedT) * 2, 'live2'), seedT),
    );

    const plan = exportPlan(overdubbed, { ...DEFAULT_SELECTION, allPasses: true }, {
      format: 'wav',
      mp3Bitrate: 192,
      backing: [],
    });
    const passFiles = plan.files.filter((f) => f.kind === 'pass');
    assert.equal(passFiles.length, 2, 'the rendered mixdown, and the take recorded over it');
    assert.equal(
      totalPasses(layerPassIndex(overdubbed.layers[0]!, seedT)),
      3,
      'while the layer holds three passes — the two counts answer different questions',
    );
  });
});

describe('record -> compress -> record again', () => {
  it('the pass axis re-enables, because availability is derived from audio', () => {
    const { project, t } = recorded(4);
    assert.equal(projectTotalPasses(project), 4);

    // Compress keeps one loop per layer and replaces its sessions wholesale.
    const compressed = compressedProject(project, (i) => session(loopFrames(t), `c${i}`));
    assert.equal(projectTotalPasses(compressed), 1, 'four passes became one');
    assert.equal(compressed.isCompressed, true);

    const index = layerPassIndex(compressed.layers[0]!, t);
    assert.deepEqual(availablePasses(index, 1), [1], 'one pass, so the axis has nowhere to go');

    // Recording onto it again. Nothing special happens: §1.4 derives availability from audio, so a
    // compressed layer needs no special case and the axis comes back on its own.
    const again = withLayer(
      compressed,
      recordSession(compressed.layers[0]!, session(loopFrames(t) * 2, 'after'), t),
    );
    const back = layerPassIndex(again.layers[0]!, t);
    assert.deepEqual(availablePasses(back, 1), [1, 2, 3], 'the axis is live again');
    assert.equal(again.layers[0]!.sessions.length, 2, 'appended, not concatenated');
  });

  it('compressing twice is idempotent in pass count and keeps the loop whole', () => {
    const { project, t } = recorded(3);
    const once = compressedProject(project, (i) => session(loopFrames(t), `c1-${i}`));
    const twice = compressedProject(once, (i) => session(loopFrames(t), `c2-${i}`));

    assert.equal(projectTotalPasses(twice), 1);
    const index = layerPassIndex(twice.layers[0]!, t);
    for (let bar = 1; bar <= project.barCount; bar++) {
      const region = regionFor(index, { pass: 1, relativeBar: bar });
      assert.ok(region, `bar ${bar} still resolves after two compressions`);
      assert.equal(region.frameCount, framesPerBar(t), 'and is a full slot wide');
    }
  });

  it('the size projection follows the audio through both steps', () => {
    const { project, t } = recorded(4);
    const before = sizeProjection(project).uncompressedBytes;
    const compressed = compressedProject(project, (i) => session(loopFrames(t), `c${i}`));
    const after = sizeProjection(compressed).uncompressedBytes;
    assert.ok(after < before, `compress should shrink the projection (${before} -> ${after})`);

    const again = withLayer(
      compressed,
      recordSession(compressed.layers[0]!, session(loopFrames(t) * 2, 'more'), t),
    );
    assert.ok(
      sizeProjection(again).uncompressedBytes > after,
      'and recording onto it should grow it again',
    );
  });
});

describe('a bounce of a bounce', () => {
  it('does not stack the suffix', () => {
    assert.equal(bouncedName('Rooftop'), 'Rooftop (Bounce)');
    assert.equal(bouncedName('Rooftop (Bounce)'), 'Rooftop (Bounce)', 'said once is enough');
  });

  it('keeps quality from the source through two generations', () => {
    const hq = createProject({ id: 'h', name: 'H', bpm: 120, barCount: 4, quality: 'high' });
    const t = projectTiming(hq);
    const first = bounceSeed(hq, session(loopFrames(t), 'g1'), { id: 'g1', name: 'G1' });
    const second = bounceSeed(first, session(loopFrames(projectTiming(first)), 'g2'), {
      id: 'g2',
      name: 'G2',
    });
    // A mixdown is a sum of the source's layers and sits at its rate; seeding at another would
    // need a resample at every splice, which snapshotting quality exists to prevent.
    assert.equal(second.audioQuality, 'high');
    assert.equal(second.bpm, hq.bpm);
    assert.equal(second.barCount, hq.barCount);
  });
});
