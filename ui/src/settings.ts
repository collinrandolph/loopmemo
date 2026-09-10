import { defaultBacking } from '../../src/domain/backing.ts';
import { bouncePlan, bounceSeed } from '../../src/domain/bounce.ts';
import {
  type AudioQuality,
  BPM_MAX,
  BPM_MIN,
  NAME_CHARACTER_LIMIT,
  type Project,
  QUALITY_SPEC,
  VALID_BAR_COUNTS,
  bytesPerSecond,
  compressedProject,
  createProject,
  LATENCY_OFFSET_MAX_SECONDS,
  isConfigurationLocked,
  projectCompressionPlan,
  projectTiming,
  projectTotalPasses,
  sizeProjection,
} from '../../src/domain/project.ts';
import { loopSeconds, timing } from '../../src/domain/timing.ts';
import { bindChips, perfectLoopRow } from './controls.ts';
import { helpControl } from './help.ts';
import { LR, el } from './kit.ts';
import type { BackingEngine } from './audio.ts';
import type { RecordingSession } from '../../src/domain/pass-index.ts';
import { compressedTake, hasAudioFor } from './compress.ts';
import { renderOffline, silentBacking, wrapTail } from './render.ts';
import { newTakeId, takeUrl } from './takes.ts';
import { computePeaks } from './peaks.ts';
import { annotationRow, confirmPanel, formatBytes } from './screen.ts';
import type { TakeStore } from './takes.ts';

/**
 * Project setup and project settings (§4.5) — **one screen**, because they are one screen.
 *
 * The fields are identical and which of them are editable is *derived*, not moded:
 * `isConfigurationLocked` says whether BPM and bar count have set (§5.1 #4), and a project being
 * created is one with no recordings, so it answers false and everything is open.
 *
 * **One genuine mode bit**: recording quality, snapshotted at creation and immutable after
 * (§2.7). A `Project` cannot say whether it is being created, so `mode` decides that one field
 * and the commit verb.
 *
 * **No backing pickers here.** The Playback rows own those, and a second editor for one piece of
 * state is the drift this codebase keeps undoing.
 */
export function projectSettingsScreen(opts: {
  /** The project being edited. For `new`, a throwaway used only for its defaults. */
  project: Project;
  mode: 'new' | 'edit';
  engine: BackingEngine;
  /** Captured audio, so the recording-offset preview has layers to sound against the backing. */
  takes: TakeStore;
  onCommit(project: Project): void;
  onCancel(): void;
  /** The project actions, moved here from the Library's per-row panel. Edit mode only. */
  onExport(project: Project): void;
  onCompress(next: Project): void;
  onBounce(source: Project, seed: Project): void;
  onDelete(id: string): void;
}): { node: HTMLElement; destroy(): void } {
  const creating = opts.mode === 'new';
  const locked = !creating && isConfigurationLocked(opts.project);

  let name = creating ? '' : opts.project.name;
  let bpm = opts.project.bpm;
  let barCount = opts.project.barCount;
  let quality: AudioQuality = opts.project.audioQuality;

  const root = el('div', 'lr-screen settings');

  // ------------------------------------------------------------------ header --
  const header = el('div', 'lr-header');
  const summary = el('div', 'lr-meta lr-stats');
  header.append(
    el(
      'div',
      'lr-title-row',
      `<div class="lr-title">${creating ? 'New project' : 'Project settings'}</div>`,
    ),
    summary,
  );

  const body = el('div', 'grid');

  // -------------------------------------------------------------------- name --
  const nameInput = el('input', 'setting-name') as HTMLInputElement;
  nameInput.type = 'text';
  nameInput.maxLength = NAME_CHARACTER_LIMIT * 2; // a project name is not a layer name (§3.9)
  nameInput.placeholder = creating ? 'Untitled' : opts.project.name;
  nameInput.value = name;
  nameInput.addEventListener('input', () => {
    name = nameInput.value;
    paint();
  });
  const nameRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Name</span>');
  nameRow.appendChild(nameInput);

  // --------------------------------------------------------------------- bpm --
  // §4.5's "preview at the project tempo", **on the tempo row** because that is all it is for: a
  // tempo cannot be judged by looking at it. It is not a transport for the project.
  //
  // **It dims with the row once the tempo locks, deliberately** — the preview exists to help
  // choose a tempo and there is nothing left to choose. Do not exempt it from `is-inert`.
  let playing = false;
  const playBtn = LR.PlayButton(() => {
    playing = !playing;
    playBtn.setPlaying(playing);
    if (playing) {
      retempo();
      opts.engine.start(0);
    } else {
      opts.engine.stop();
    }
  });

  const bpmValue = el('div', 'setting-figure');
  const bpmSlider = el('input', 'setting-slider') as HTMLInputElement;
  bpmSlider.type = 'range';
  bpmSlider.min = String(BPM_MIN);
  bpmSlider.max = String(BPM_MAX);
  bpmSlider.value = String(bpm);
  // The number follows the drag, the audio the release: re-anchoring is a stop and a restart, and
  // doing that on every `input` would never let a whole bar of the chosen tempo through.
  bpmSlider.addEventListener('input', () => {
    bpm = Number(bpmSlider.value);
    paint();
  });
  bpmSlider.addEventListener('change', () => retempo());

  const bpmRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Tempo</span>');
  bpmRow.append(bpmSlider, bpmValue, playBtn);

  // --------------------------------------------------------------- bar count --
  // Four across, two down. Wrapped as a flex row the eight values give a ragged second line and
  // chips too small to tap.
  const barsChips = el('div', 'lr-chips setting-bars');
  for (const count of VALID_BAR_COUNTS) {
    const chip = el('span', `lr-chip${count === barCount ? ' is-active' : ''}`, String(count));
    chip.addEventListener('click', () => {
      if (locked) return;
      barCount = count;
      paint();
    });
    barsChips.appendChild(chip);
  }
  const barsRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Bars</span>');
  barsRow.appendChild(barsChips);
  bindChips(barsRow);

  // ----------------------------------------------------------------- quality --
  // Two words, not two specifications. The format and its cost go below, for the chosen setting
  // only — on the chips they wrap, and put the numbers where they must be compared to be read.
  const qualityChips = el('div', 'lr-chips');
  for (const id of ['standard', 'high'] as const) {
    const chip = el('span', `lr-chip${id === quality ? ' is-active' : ''}`, id === 'high' ? 'High' : 'Standard');
    chip.addEventListener('click', () => {
      if (!creating) return;
      quality = id;
      paint();
    });
    qualityChips.appendChild(chip);
  }
  const qualityRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Quality</span>');
  qualityRow.appendChild(qualityChips);
  bindChips(qualityRow);
  const qualityFigure = el('div', 'setting-figures');

  /**
   * **One bar of drums, looping** — not the arrangement. The pattern is one bar and repeats
   * identically, so a sixteen-bar loop sounds the same and takes sixteen times as long to come
   * round; bar count is therefore not part of the preview and cannot disturb it. Chords are muted
   * for the same reason: the question here is "how fast is that".
   */
  function retempo() {
    const backing = creating ? defaultBacking() : opts.project.backing;
    opts.engine.setBacking(
      { drums: backing.drums, chords: { ...backing.chords, muted: true } },
      timing(bpm, 1, QUALITY_SPEC[quality].sampleRate, opts.project.beatsPerBar),
    );
  }

  // ------------------------------------------------------------------- notes --
  /**
   * One note for everything that stops being editable. **The two rules differ and it says so**:
   * tempo and bars are open until the first recording, quality from the moment the project
   * exists. Always shown — before there is audio it says what is about to become permanent,
   * afterwards it explains the dimmed controls.
   */
  const lockNote = el(
    'div',
    'export-note',
    '<strong>What settles, and when.</strong> <strong>Tempo</strong> and <strong>bars</strong> ' +
      'can be changed until this project has recorded audio. Every bar boundary and pass number ' +
      'is computed from them, so once there is audio measured against them they cannot move. ' +
      '<strong>Quality</strong> is fixed from the moment the project is created — a project’s ' +
      'layers must share a sample rate, or every splice between them would need a resample. ' +
      'The <strong>name</strong> and the <strong>backing tracks</strong> never lock; change the ' +
      'drum pattern, kit, chords, tone or octave from their rows on the Playback screen whenever ' +
      'you like.',
  );

  // ------------------------------------------------------- recording offset --
  /**
   * The recording offset (§2.3): how far earlier a take plays than it arrived.
   *
   * **A control, not a measurement** — a microphone cannot hear headphones, and §2.2 makes
   * headphones the correct setup, so a loopback calibration measures a route nobody records
   * against. It can be *judged*, which is what this row is for, and its preview plays the **loop**
   * rather than a bar of drums: an offset is only audible as a recorded layer landing late.
   *
   * **Never locked.** Nothing recorded is laid out against it, and it is exactly the setting a
   * user needs *after* the first take.
   */
  let latencyMs = Math.round(opts.project.latencyOffsetSeconds * 1000);

  function previewProject(): Project {
    return { ...opts.project, latencyOffsetSeconds: latencyMs / 1000 };
  }

  let latencyPlaying = false;
  const latencyPlayBtn = LR.PlayButton(() => {
    latencyPlaying = !latencyPlaying;
    latencyPlayBtn.setPlaying(latencyPlaying);
    if (latencyPlaying) {
      playing = false;
      playBtn.setPlaying(false);
      opts.engine.setBacking(opts.project.backing, projectTiming(opts.project));
      opts.engine.setLayers(previewProject(), opts.takes);
      opts.engine.start(0);
    } else {
      opts.engine.stop();
    }
  });

  const latencyValue = el('div', 'setting-figure');
  const latencySlider = el('input', 'setting-slider') as HTMLInputElement;
  latencySlider.type = 'range';
  latencySlider.min = '0';
  latencySlider.max = String(Math.round(LATENCY_OFFSET_MAX_SECONDS * 1000));
  latencySlider.value = String(latencyMs);

  /**
   * Applied a beat after the drag stops. The offset is baked into each scheduled buffer's read
   * position, so changing it re-plans the lookahead — and re-creating a segment about to start is
   * a way to make a click out of a control that exists to remove one.
   */
  let applyLatencyTimer: number | undefined;
  latencySlider.addEventListener('input', () => {
    latencyMs = Number(latencySlider.value);
    paint();
    window.clearTimeout(applyLatencyTimer);
    applyLatencyTimer = window.setTimeout(() => {
      if (latencyPlaying) opts.engine.setLayers(previewProject(), opts.takes);
    }, 90);
  });

  const latencyRow = el(
    'div',
    'lr-panel-row',
    '<span class="lr-panel-label">Rec offset</span>',
  );
  latencyRow.append(latencySlider, latencyValue, latencyPlayBtn);

  const latencyNote = el(
    'div',
    'setting-note',
    'How far earlier your recording plays than it arrived, to cancel the delay through your ' +
      'headphones and microphone. Play the loop and slide until your playing sits on the beat.',
  );

  // ----------------------------------------------------------- perfect loop --
  /**
   * A render setting rather than a mix one, so it sits with the recording offset rather than with
   * tempo and bars — nothing recorded depends on it and it never locks. Pending until Save, like
   * every other field on this screen; the Export screen's copy applies at once, because that
   * screen has no commit step.
   */
  let perfectLoop = opts.project.perfectLoop;
  const loopRow = perfectLoopRow(
    () => perfectLoop,
    (next) => {
      perfectLoop = next;
      loopRow.refresh();
    },
  );
  const loopNote = el('div', 'setting-note', "Wraps whatever is still ringing at the end of the loop — an open hat, a Surround layer’s delay — onto the start, so a file that repeats has no seam at the join. Turn it off for a one-shot, which keeps a clean start and lets the tail be cut.");

  // ---------------------------------------------------------------- actions --
  /**
   * Export, bounce, compress and delete. **They belong to a project, so they live on the
   * project's own screen** rather than in a browsing list.
   *
   * **Only in edit mode** — a project that does not exist yet has nothing to act on, so
   * `creating` gets no actions rather than four disabled buttons.
   *
   * **Every one acts on `commit()`, not `opts.project`**, so a rename typed just above reaches
   * the exported filenames.
   */
  const acts = el('div', 'acts');
  const confirmBox = el('div', 'confirm');
  const actionsBlock = el('div', 'setting-actions');
  actionsBlock.append(acts, confirmBox);

  function actionBtn(label: string, cls: string, run: () => void, disabled = false) {
    const b = el('button', cls, label) as HTMLButtonElement;
    b.disabled = disabled;
    b.addEventListener('click', run);
    return b;
  }

  // The question replaces the four buttons; Cancel just puts them back, which the class does.
  const ask = confirmPanel(actionsBlock, confirmBox, () => {});

  function askCompress() {
    const p = commit();
    const plan = projectCompressionPlan(p);
    if (!plan) {
      // The remedy is no longer "open it" — you are already inside it. Closing and fixing the bar
      // is the same repair, one screen away.
      ask(
        `<b>${p.name}</b> has a bar pointing at audio that is no longer there, so compressing it ` +
          'would bake a hole into the only copy. Close these settings and repair that bar first.',
        'Close',
        false,
        leave,
      );
      return;
    }
    const { uncompressedBytes, compressedBytes } = plan.projection;
    ask(
      `Compress <b>${p.name}</b>? Unused passes are discarded — <b>${formatBytes(uncompressedBytes)} → ` +
        `${formatBytes(compressedBytes)}</b>. The kept loop becomes Pass 1; bars stay editable and you can ` +
        'record new passes at any time.',
      'Compress',
      false,
      () => {
        opts.engine.stop();
        // Every layer is written before any of it is committed. `compressedProject` refuses a
        // project whole rather than partly (§2.7), and so does this: a project half of whose
        // layers were compressed to silence is a state nothing else knows how to describe.
        const written = new Map<number, RecordingSession>();
        const rate = projectTiming(p).sampleRate;
        for (const { layerIndex, bars } of plan.layers) {
          const layer = p.layers[layerIndex]!;
          const session = compressedTake(layer, bars, opts.takes, rate, newTakeId(`${p.id}-c${layerIndex}`));
          if (!session) {
            ask(
              `<b>${p.name}</b> cannot be compressed here: the audio for ` +
                `<b>${layer.name || `Layer ${layerIndex + 1}`}</b> is not in this session. The ` +
                'browser build keeps takes in memory only, so a reload loses them.',
              'Close',
              false,
              () => {},
            );
            return;
          }
          written.set(layerIndex, session);
        }
        opts.onCompress(compressedProject(p, (i) => written.get(i)!));
      },
    );
  }

  /**
   * Render the mixdown, file it, and seed the new project with it (§2.7).
   *
   * **Layers only, backing silenced.** The backing is not in a bounce; its *settings* carry
   * instead, which `bounceSeed` does — so the new sketch opens on the same groove, live and still
   * editable, rather than with the drums baked into layer 1.
   *
   * Rendered through the engine that plays the project, so the mixdown is what was heard. The
   * tail is folded back onto the head: a Surround layer's delayed last bar has nowhere to go in a
   * fixed-length render, and truncating it leaves a seam the live loop never had.
   */
  async function runBounce(p: Project, frames: number, tailFrames: number) {
    // Off means the seeded project carries the seam — permanently, since a bounce cannot be
    // re-rendered with the other setting later. On is the default for that reason.
    const tail = p.perfectLoop ? tailFrames : 0;
    const rendered = await renderOffline(p, silentBacking(), opts.takes, frames + tail);
    const buffer = wrapTail(rendered, frames, tail);
    const id = newTakeId(`${p.id}-mix`);
    const session: RecordingSession = {
      id,
      audioFileURL: takeUrl(id),
      recordedFrames: buffer.length,
      recordedAt: new Date().toISOString(),
      waveformPeaks: computePeaks(buffer),
    };
    opts.takes.put(session, buffer);
    // `bounceSeed`, not `compressedProject`. Both leave one loop on the layer, but the seed is a
    // *new* project and §2.7 is explicit that `isCompressed` must be false on it: the flag means
    // recorded passes were discarded, and a project that never had any would wear a label that lies.
    opts.onBounce(
      p,
      bounceSeed(p, session, {
        id,
        name: `${p.name} mix`,
        now: new Date().toISOString(),
      }),
    );
  }

  function askBounce() {
    const p = commit();
    const plan = bouncePlan(p);
    if (!plan) {
      // `bouncePlan` refuses on a slot pointing at audio that is gone, and on a mixdown with
      // nothing audible in it — a seed made of silence is worse than declining.
      ask(
        `<b>${p.name}</b> has nothing audible to mix down, or a bar pointing at audio that is no ` +
          'longer there. Close these settings and check before bouncing.',
        'Close',
        false,
        leave,
      );
      return;
    }
    ask(
      `Bounce <b>${p.name}</b> to a new project? Every layer is mixed down to one loop on layer 1 ` +
        `of a new sketch, at ${p.bpm} BPM. <b>${p.name} is left untouched.</b>`,
      'Bounce',
      false,
      () => {
        opts.engine.stop();
        // Same reason compress refuses: a mixdown of audio that is not in this session is a loop
        // of silence, and seeding a new project with one is worse than declining.
        const missing = plan.layers.find(
          (m) => !hasAudioFor(m.bars, opts.takes.buffersFor(p.layers[m.layerIndex]!)),
        );
        if (missing) {
          const layer = p.layers[missing.layerIndex]!;
          ask(
            `<b>${p.name}</b> cannot be bounced here: the audio for ` +
              `<b>${layer.name || `Layer ${missing.layerIndex + 1}`}</b> is not in this session. ` +
              'The browser build keeps takes in memory only, so a reload loses them.',
            'Close',
            false,
            () => {},
          );
          return;
        }
        void runBounce(p, plan.frameCount, plan.tailFrames);
      },
    );
  }

  function askDelete() {
    const p = commit();
    const passes = projectTotalPasses(p);
    ask(
      `Delete <b>${p.name}</b>? ${passes} recorded pass${passes === 1 ? '' : 'es'} and ` +
        `${formatBytes(sizeProjection(p).uncompressedBytes)} go with it. This cannot be undone.`,
      'Delete',
      true,
      () => {
        opts.engine.stop();
        opts.onDelete(opts.project.id);
      },
    );
  }

  if (!creating) {
    const projection = sizeProjection(opts.project);
    acts.append(
      actionBtn('Export', 'lr-btn', () => {
        opts.engine.stop();
        opts.onExport(commit());
      }),
      actionBtn('Bounce to new project', 'lr-btn', askBounce),
      actionBtn('Compress', 'lr-btn', askCompress, !projection.isWorthCompressing),
      actionBtn('Delete', 'lr-btn lr-btn--danger', askDelete),
    );
    acts.appendChild(
      el(
        'div',
        'hint',
        opts.project.isCompressed
          ? 'Compressed — one pass per layer. Recording a new pass clears this.'
          : projection.isWorthCompressing
            ? 'Compress discards unused passes and keeps each layer’s edited loop.'
            : 'Already one pass per layer — compressing would save nothing.',
      ),
    );
  }

  // **No section labels**: "Project" over a Name field names what the row already says. The
  // grouping is kept as a gap before the recording block instead. The lock note goes last of the
  // settings because it describes all of them, then the actions, which do rather than set.
  body.append(
    nameRow,
    bpmRow,
    barsRow,
    el('div', 'setting-gap'),
    qualityRow,
    annotationRow(qualityFigure),
    el('div', 'setting-gap'),
    latencyRow,
    annotationRow(latencyNote),
    loopRow.node,
    annotationRow(loopNote),
    el('div', 'setting-gap'),
    annotationRow(lockNote),
    ...(creating ? [] : [el('div', 'setting-gap'), actionsBlock]),
  );

  // ------------------------------------------------------------------ footer --
  const cancelBtn = el('button', 'lr-btn', 'Cancel');
  cancelBtn.addEventListener('click', leave);

  const commitBtn = el(
    'button',
    'lr-btn lr-btn--primary',
    creating ? 'Create project' : 'Save',
  ) as HTMLButtonElement;
  commitBtn.addEventListener('click', () => {
    opts.engine.stop();
    opts.onCommit(commit());
  });

  const help = helpControl({
    title: creating ? 'New project' : 'Project settings',
    content: () => [
      'Tempo and bar count lock after the first recording. Everything the app derives — bar ' +
        'boundaries, pass numbers, where each slot reads from — is computed from them, so they ' +
        'cannot move once there is audio measured against them.',
      'Recording quality is chosen once. A project’s layers have to share a sample rate, or every ' +
        'splice between them would need a resample.',
      'The backing tracks are never locked, and they are not on this screen. Change the drum ' +
        'pattern, kit, chords, tone or octave from their rows on the Playback screen, whenever ' +
        'you like.',
    ],
  });

  const footer = el('div', 'lr-footer');
  footer.append(help.node, cancelBtn, commitBtn);

  function commit(): Project {
    const finalName = name.trim() || 'Untitled';
    if (creating) {
      return {
        ...createProject({
          id: `p${Date.now().toString(36)}`,
          name: finalName,
          bpm,
          barCount,
          quality,
          beatsPerBar: opts.project.beatsPerBar,
        }),
        backing: defaultBacking(),
      };
    }
    // Quality is never re-chosen here, so it is copied rather than read from the form.
    return {
      ...opts.project,
      name: finalName,
      bpm,
      barCount,
      latencyOffsetSeconds: latencyMs / 1000,
      perfectLoop,
      lastModified: new Date().toISOString(),
    };
  }

  function leave() {
    opts.engine.stop();
    opts.onCancel();
  }

  // Escape leaves without committing. Nothing here has been applied yet, so there is nothing to
  // confirm — the same reasoning as the Export screen.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !document.querySelector('.lr-sheet')) leave();
  };
  document.addEventListener('keydown', onKey);

  root.append(header, body, footer);

  // ------------------------------------------------------------------- paint --
  function paint() {
    const t = timing(bpm, barCount, QUALITY_SPEC[quality].sampleRate, opts.project.beatsPerBar);
    const seconds = loopSeconds(t);
    bpmValue.textContent = `${bpm} BPM`;
    // "Off" rather than "0 ms": zero is a real state — uncompensated — and naming it says so.
    latencyValue.textContent = latencyMs === 0 ? 'Off' : `${latencyMs} ms`;
    summary.textContent = `${bpm} BPM · ${barCount} bars · ${LR.fmtTime(seconds)} per pass`;

    for (const [i, chip] of [...barsChips.children].entries()) {
      chip.classList.toggle('is-active', VALID_BAR_COUNTS[i] === barCount);
    }
    for (const [i, chip] of [...qualityChips.children].entries()) {
      chip.classList.toggle('is-active', (['standard', 'high'] as const)[i] === quality);
    }

    // A pass is the unit the Library counts and storage is spent in, so the cost of a quality
    // choice is stated in passes of *this* project rather than in minutes of audio.
    const spec = QUALITY_SPEC[quality];
    const perPass = seconds * bytesPerSecond(quality);
    qualityFigure.textContent =
      `${spec.bitDepth}-bit / ${spec.sampleRate / 1000} kHz · ${(perPass / 1e6).toFixed(1)} MB per pass, per layer`;

    bpmRow.classList.toggle('is-inert', locked);
    barsRow.classList.toggle('is-inert', locked);
    qualityRow.classList.toggle('is-inert', !creating);
    commitBtn.disabled = false;
  }

  paint();
  retempo();

  return {
    node: root,
    destroy() {
      document.removeEventListener('keydown', onKey);
      help.destroy();
      opts.engine.stop();
    },
  };
}
