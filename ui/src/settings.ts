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
import { loopFrames, loopSeconds, timing } from '../../src/domain/timing.ts';
import { bindChips } from './controls.ts';
import { helpControl } from './help.ts';
import { LR, el } from './kit.ts';
import type { BackingEngine } from './audio.ts';
import { simSession } from './sim.ts';
import type { TakeStore } from './takes.ts';

/**
 * Project setup and project settings (§4.5) — **one screen**, because they are one screen.
 *
 * The fields are identical; what differs is which of them are still editable, and that is
 * *derived* rather than moded. `isConfigurationLocked` already says whether BPM and bar count
 * have set (§5.1 #4), and a project being created is simply one with no recordings yet, so it
 * answers `false` and everything is open. Backing tracks never lock at all (§1.2), and they are
 * not here — the Playback rows own them, and a second editor for one piece of state is the drift
 * this codebase keeps having to undo.
 *
 * **One genuine mode bit**: recording quality. It is snapshotted at creation and immutable after
 * (§2.7), and that is not derivable from a `Project` value — an existing project cannot tell you
 * whether it is being created. So `mode` exists, and it decides exactly that one field and the
 * commit verb.
 *
 * **The preview is part of the tempo control, not a transport.** §4.5 asks for a preview at the
 * project tempo; with the backing engine that is real now, so the play button sits on the tempo
 * row and loops a single bar of drums. Its only job is to turn a BPM into something you can judge
 * by ear, which is the one thing the number cannot do.
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
  // §4.5's "preview at the project tempo", and it lives **on the tempo row** because that is the
  // only thing it is for: a tempo is a number you cannot judge by looking at it, so this plays
  // one bar of drums until you can. It is not a transport for the project.
  //
  // **It dims with the row on a recorded project, and that is deliberate.** Being inside the
  // tempo control means it inherits `is-inert` when the tempo locks — which is right, because
  // the preview exists to help choose a tempo and there is nothing left to choose. Hearing a
  // finished project is what the Playback transport is for. A greyed-out play button looks like
  // a bug and is not one; do not exempt it.
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
  // The number follows the drag; the audio follows the release. Re-anchoring the engine is a
  // stop and a restart, and `input` fires many times a second — retempoing on it would machine-gun
  // the loop into silence and you would never hear a whole bar of the tempo you were choosing.
  bpmSlider.addEventListener('input', () => {
    bpm = Number(bpmSlider.value);
    paint();
  });
  bpmSlider.addEventListener('change', () => retempo());

  const bpmRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Tempo</span>');
  bpmRow.append(bpmSlider, bpmValue, playBtn);

  // --------------------------------------------------------------- bar count --
  // Four across, two down. Eight values wrapped as a flex row gave a ragged second line and
  // chips too small to be a comfortable target; a fixed four-column grid makes both rows the
  // same shape and lets each button be worth tapping.
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
  // Two words, not two specifications. The full format and what it costs go on one line below,
  // for the chosen setting only — spelling both out on the chips wrapped them onto two rows and
  // put the numbers where they had to be compared rather than read.
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
   * The preview is **one bar of drums, looping** — not the arrangement.
   *
   * Bar count is deliberately not passed through: the drum pattern is one bar and repeats
   * identically, so a sixteen-bar loop would sound exactly like a one-bar loop while taking
   * sixteen times as long to come round. Previewing one bar also means changing the bar count
   * cannot disturb the preview, because it is not part of it.
   *
   * Chords are muted for the same reason. The question this control answers is "how fast is
   * that", and a chord bed is not part of the answer.
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
   * One note for everything that stops being editable, rather than a caption under each control
   * saying so separately.
   *
   * **The two rules are genuinely different and the note says so.** Tempo and bar count are open
   * until the first recording, because it is recorded audio that they stop matching. Quality is
   * settled the moment the project exists, because layers have to agree on a sample rate from the
   * first one. Collapsing that into "these lock later" would be shorter and wrong.
   *
   * Always shown, in both modes. Before there is audio it says what is about to become permanent,
   * which is when it is most worth knowing; afterwards it explains the controls that are dimmed.
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

  /**
   * Prose that belongs to the row above it, indented into the same column as that row's control.
   *
   * The empty label is a **spacer, not a missing label** — it is how `playback.ts`'s empty-layer
   * note lines up too. Aligning by participating in the row layout costs nothing and cannot drift;
   * the `padding-left` this replaces was a hardcoded copy of the label column that was wrong at
   * both breakpoints, because the row gap is 8px on mobile and 10px above it.
   */
  function annotate(node: HTMLElement): HTMLElement {
    const row = el('div', 'lr-panel-row setting-annotation', '<span class="lr-panel-label"></span>');
    row.appendChild(node);
    return row;
  }

  // ------------------------------------------------------- recording offset --
  /**
   * The recording offset (§2.3): how far earlier a take plays than it arrived.
   *
   * **It is a control rather than a measurement**, because a microphone cannot hear headphones
   * and §2.2 makes headphones the correct setup — so a loopback calibration measures an output
   * route nobody records against. What it can be is *judged*, and that is what this row is for.
   *
   * **Its preview plays the loop, not a bar of drums**, unlike the tempo preview above it. A
   * tempo can be judged from one bar; an offset can only be judged by hearing a recorded layer
   * land against the backing. A control that cannot be judged where it is presented is worse
   * than one that is hard to find.
   *
   * **Never locked.** `isConfigurationLocked` covers tempo and bar count because recorded frames
   * are laid out against them. Nothing recorded depends on this, and changing it rewrites
   * nothing — it is exactly the setting a user needs *after* the first take, when they can
   * finally hear that it is wrong.
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
   * Applied a beat after the drag stops, not on every pixel.
   *
   * The offset is baked into each scheduled buffer's read position, so changing it re-plans the
   * lookahead — cheap once, wasteful sixty times a second, and re-creating a segment that was
   * about to start is a way to make a click out of a control that exists to remove one. The
   * number on screen still follows the drag; only the audio waits, and it waits less than the
   * 1.2 s horizon it is about to be heard through anyway.
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

  // ---------------------------------------------------------------- actions --
  /**
   * Export, bounce, compress and delete — the whole of what used to be a per-row panel on the
   * Projects screen.
   *
   * **They belong to a project, so they live on the project's own screen.** In the Library they
   * were behind a chevron on a row, which made a browsing list carry every operation the app can
   * perform on a project; here they sit under the settings for the thing they act on.
   *
   * **Only in edit mode.** A project that does not exist yet cannot be exported, bounced,
   * compressed or deleted, so `creating` gets no actions rather than four disabled buttons.
   *
   * **Every one of them acts on `commit()`, not on `opts.project`** — pending edits included. A
   * rename typed just above and then exported has to reach the filenames, and it would be a
   * strange screen where an action ignored the field directly above it.
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

  /** In place, and stating the outcome — never a generic prompt (§4.1). */
  function ask(text: string, label: string, danger: boolean, run: () => void) {
    confirmBox.innerHTML =
      `<div class="confirm-text">${text}</div>` +
      `<button class="lr-btn ${danger ? 'lr-btn--danger' : 'lr-btn--primary'}" data-yes>${label}</button>` +
      '<button class="lr-btn" data-no>Cancel</button>';
    actionsBlock.classList.add('is-confirming');
    confirmBox.querySelector('[data-yes]')!.addEventListener('click', () => {
      actionsBlock.classList.remove('is-confirming');
      run();
    });
    confirmBox.querySelector('[data-no]')!.addEventListener('click', () => {
      actionsBlock.classList.remove('is-confirming');
    });
  }

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
      `Compress <b>${p.name}</b>? Unused passes are discarded — <b>${mb(uncompressedBytes)} → ` +
        `${mb(compressedBytes)}</b>. The kept loop becomes Pass 1; bars stay editable and you can ` +
        'record new passes at any time.',
      'Compress',
      false,
      () => {
        opts.engine.stop();
        opts.onCompress(
          compressedProject(p, (i) => simSession(`${p.id}-c${i}`, loopFrames(projectTiming(p)))),
        );
      },
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
        // `bounceSeed`, not `compressedProject`. Both leave one loop on the layer, but the seed is
        // a *new* project and §2.7 is explicit that `isCompressed` must be false on it: the flag
        // means recorded passes were discarded, and a project that never had any would wear a
        // label that lies.
        opts.onBounce(
          p,
          bounceSeed(p, simSession(`${p.id}-mix`, plan.frameCount), {
            id: `${p.id}-mix-${Date.now().toString(36)}`,
            name: `${p.name} mix`,
            now: new Date().toISOString(),
          }),
        );
      },
    );
  }

  function askDelete() {
    const p = commit();
    const passes = projectTotalPasses(p);
    ask(
      `Delete <b>${p.name}</b>? ${passes} recorded pass${passes === 1 ? '' : 'es'} and ` +
        `${mb(sizeProjection(p).uncompressedBytes)} go with it. This cannot be undone.`,
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

  // **No section labels.** "Project" over a Name field and "Timing" over Tempo and Bars name what
  // the rows already say. The grouping they were carrying is real, so it is kept as a gap before
  // the recording block rather than as three words.
  //
  // The lock note goes last of the settings, below everything it describes, because it now
  // describes all of it. A note that covers four rows cannot caption any one of them. The actions
  // follow it, separated, because they do things rather than set things.
  body.append(
    nameRow,
    bpmRow,
    barsRow,
    el('div', 'setting-gap'),
    qualityRow,
    annotate(qualityFigure),
    el('div', 'setting-gap'),
    latencyRow,
    annotate(latencyNote),
    el('div', 'setting-gap'),
    annotate(lockNote),
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

    // A pass is the unit the Library counts and the unit storage is spent in, so the cost of a
    // quality choice is stated in passes of *this* project rather than in minutes of audio.
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

function mb(bytes: number): string {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}
