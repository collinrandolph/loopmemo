import type { BackingMixSource, BackingTracks } from '../../src/domain/backing.ts';
import {
  DEFAULT_SELECTION,
  type ExportFormat,
  type ExportSelection,
  MP3_BITRATES,
  type Mp3Bitrate,
  exportPlan,
  isExportable,
} from '../../src/domain/export.ts';
import { type Project, projectTiming } from '../../src/domain/project.ts';
import { loopSeconds } from '../../src/domain/timing.ts';
import { bindChips } from './controls.ts';
import { LR, el } from './kit.ts';
import type { Engine } from './engine.ts';
import { renderExport } from './export-files.ts';
import { chooseDestination, zip } from './save.ts';
import { formatBytes, renderLoop } from './screen.ts';
import type { TakeStore } from './takes.ts';

/**
 * Export (§4.5, extended). §4.5's one deliverable — "exactly as it currently sounds" — is the
 * Full Loop and stays on by default; the two stem sets and the recorded passes are opt-in.
 *
 * What each file contains is decided in `src/domain/export.ts`, so the list and the sizes here
 * cannot drift from it — including which files are stereo, a per-file fact rather than per-kind.
 *
 * **No mute controls** (§4.5): muting happens on Playback, where the result is audible. This
 * screen decides which *kinds* of file come out, not what is in them. Every toggle carries its
 * own count and total, because size is the fact that decides a selection (§4.1).
 */
export function exportScreen(opts: {
  project: Project;
  engine: Engine;
  backing: readonly BackingMixSource[];
  /** The live backing, for rendering; `backing` above is the flattened list the plan reads. */
  tracks: BackingTracks;
  /** Captured audio, so a stem or a pass has something to render from. */
  takes: TakeStore;
  /** Leave without exporting. Distinct from `onShare` even where both land in the same place. */
  onCancel(): void;
  onShare(): void;
}): { node: HTMLElement; destroy(): void } {
  const project = opts.project;
  const seconds = loopSeconds(projectTiming(project));

  let selection: ExportSelection = { ...DEFAULT_SELECTION };
  let format: ExportFormat = 'wav';
  let bitrate: Mp3Bitrate = 192;

  /**
   * **The browser cannot encode MP3**: `AudioEncoder` reports it unsupported, and this repo has no
   * runtime dependencies for a LAME-class encoder. §2.7 keeps the format because a native platform
   * has it, so the refusal lives here.
   *
   * Greyed rather than removed — greyed says "not here", missing says "never", and only one is
   * true. What is unacceptable is writing a WAV with an `.mp3` name.
   */
  const MP3_AVAILABLE = false;

  const root = el('div', 'lr-screen export');

  // ------------------------------------------------------------------ header --
  const header = el('div', 'lr-header');
  header.append(
    el(
      'div',
      'lr-title-row',
      `<div class="lr-title">Export</div><div class="lr-settings">${project.name}</div>`,
    ),
    el('div', 'lr-meta lr-stats', `${project.bpm} BPM · ${project.barCount} bars · ${LR.fmtTime(seconds)}`),
  );

  const body = el('div', 'grid');

  // ------------------------------------------------------------------ what --
  const whatRows = el('div', 'export-list');
  const options: {
    key: keyof ExportSelection;
    title: string;
    detail: string;
  }[] = [
    {
      key: 'fullLoop',
      title: 'Full loop',
      detail: 'The mix exactly as you hear it — levels, effects, backing tracks and mutes.',
    },
    {
      key: 'stems',
      title: 'Stems',
      detail: 'One file per layer and backing track, dry: the edited loop with no effects.',
    },
    {
      key: 'stemsWithEffects',
      title: 'Stems + effects',
      detail: 'The same set with each layer’s level, EQ and pan applied. Panned layers come ' +
        'out stereo; centred ones stay mono.',
    },
    {
      key: 'allPasses',
      title: 'All recorded passes',
      detail: 'Every take on every layer, unedited — including passes the arrangement does not use.',
    },
  ];

  const toggles = new Map<keyof ExportSelection, { row: HTMLElement; count: HTMLElement }>();

  for (const option of options) {
    const row = el('div', 'export-item');
    const box = el('span', 'export-check');
    const count = el('div', 'export-count');
    row.append(
      box,
      el('div', 'export-text', `<div class="export-title">${option.title}</div>` +
        `<div class="export-detail">${option.detail}</div>`),
      count,
    );
    row.addEventListener('click', () => {
      selection = { ...selection, [option.key]: !selection[option.key] };
      // A message about the last selection is worse than none about this one.
      saveNote.style.display = 'none';
      paint();
    });
    whatRows.appendChild(row);
    toggles.set(option.key, { row, count });
  }

  // ---------------------------------------------------------------- format --
  const formatRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Format</span>');
  const formatChips = el('div', 'lr-chips');
  for (const id of ['wav', 'mp3'] as const) {
    const available = id === 'wav' || MP3_AVAILABLE;
    const chip = el(
      'span',
      `lr-chip${id === format ? ' is-active' : ''}${available ? '' : ' is-unavailable'}`,
      id.toUpperCase(),
    );
    if (available) {
      chip.addEventListener('click', () => {
        format = id;
        paint();
      });
    } else {
      chip.title = 'Not available in the browser build';
    }
    formatChips.appendChild(chip);
  }
  formatRow.appendChild(formatChips);
  bindChips(formatRow);

  const bitrateRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Quality</span>');
  const bitrateChips = el('div', 'lr-chips');
  for (const rate of MP3_BITRATES) {
    const chip = el('span', `lr-chip${rate === bitrate ? ' is-active' : ''}`, `${rate} kbps`);
    chip.addEventListener('click', () => {
      bitrate = rate;
      paint();
    });
    bitrateChips.appendChild(chip);
  }
  bitrateRow.appendChild(bitrateChips);
  bindChips(bitrateRow);

  const formatNote = el(
    'div',
    'export-note',
    'MP3 is not available in the browser build — it has no MP3 encoder. Native builds keep it.',
  );

  // The bitrate row above is only meaningful for MP3: WAV's quality is the project's capture
  // setting, snapshotted at creation and immutable (§2.7), so there is nothing to choose.
  const wavNote = el(
    'div',
    'export-note',
    `WAV is written at the project’s recording quality — ${project.audioQuality === 'high' ? '24-bit / 48 kHz' : '16-bit / 44.1 kHz'}, fixed when the project was created.`,
  );

  // --------------------------------------------------------------- preview --
  let playing = false;
  const playBtn = LR.PlayButton(() => {
    playing = !playing;
    playBtn.setPlaying(playing);
    if (playing) opts.engine.start(0);
    else opts.engine.stop();
  });
  const progress = LR.ProgressBar({ ticks: project.barCount });
  const position = el('div', 'lr-position');
  const preview = el('div', 'lr-transport');
  preview.append(playBtn, progress, position);

  // ----------------------------------------------------------------- files --
  const manifest = el('div', 'export-manifest');

  body.append(
    el('div', 'lr-section-label', 'What to export'),
    whatRows,
    // No section label above these: the rows carry their own, and "Format" over a row already
    // labelled FORMAT reads as a mistake.
    el('div', 'export-gap'),
    formatRow,
    formatNote,
    bitrateRow,
    wavNote,
    el('div', 'lr-section-label', 'Preview'),
    preview,
    el('div', 'lr-section-label', 'Files'),
    manifest,
  );

  // No help control here. Every option states what it produces on its own row, and a question
  // mark holding a paraphrase of what is already on screen is worse than nothing.
  const cancelBtn = el('button', 'lr-btn', 'Cancel');
  cancelBtn.addEventListener('click', opts.onCancel);

  const shareBtn = el('button', 'lr-btn lr-btn--primary', 'Share') as HTMLButtonElement;

  /**
   * Only ever visible when an export failed. Silence was half of the original bug.
   */
  const saveNote = el('div', 'export-note export-error');
  saveNote.style.display = 'none';
  // Last in the body, so it sits directly above the button that produced it.
  body.appendChild(saveNote);

  function fail(message: string) {
    saveNote.textContent = message;
    saveNote.style.display = '';
  }

  /**
   * **Reserve somewhere to put it, then render, then write** — the order is load-bearing.
   * `showSaveFilePicker` needs transient user activation, which expires about five seconds after
   * the click, so asking after rendering throws `SecurityError` on any export slow enough to
   * matter. Asking first also means a cancel costs nothing, because nothing has been rendered.
   *
   * **The plan decides the container, not the outcome.** The name is chosen before anything is
   * rendered, so several planned files stay an archive even when fewer arrive — otherwise a lone
   * `.wav` is written into a file the user already named `.zip`. The shortfall is said out loud.
   *
   * One file saves as itself; several are zipped, because a loop of download clicks trips
   * Chrome's multiple-download prompt and arrives as an unordered pile. The button counts rather
   * than spins, since a project with every pass selected is a couple of dozen renders.
   *
   * `onShare` fires only when a file was written: cancelling is a decision, not a failure.
   */
  let exporting = false;
  shareBtn.addEventListener('click', async () => {
    if (exporting) return;
    exporting = true;
    shareBtn.disabled = true;
    saveNote.style.display = 'none';
    try {
      const plan = exportPlan(project, selection, {
        format,
        mp3Bitrate: bitrate,
        backing: opts.backing,
      });
      if (plan.files.length === 0) return;

      const archive = plan.files.length > 1;
      const name = archive ? `${project.name}.zip` : plan.files[0]!.name;
      // First, while the click that asked for it is still fresh.
      const destination = await chooseDestination(name, archive ? 'application/zip' : 'audio/wav');
      if (!destination) return; // cancelled, and nothing has been rendered to waste

      const files = await renderExport(
        plan,
        { project, backing: opts.tracks, takes: opts.takes },
        (done, total) => {
          shareBtn.textContent = `Rendering ${done} / ${total}…`;
        },
      );
      if (files.length === 0) {
        fail('Nothing could be rendered — the audio for this selection is not in this session.');
        return;
      }
      const short = plan.files.length - files.length;
      if (short > 0) {
        fail(
          `${short} of ${plan.files.length} files had no audio behind them and were left out. ` +
            'Recorded passes only exist in the session they were recorded in.',
        );
      }

      shareBtn.textContent = archive ? 'Packing…' : 'Saving…';
      const blob = archive ? await zip(files) : files[0]!.blob;
      const problem = await destination.write(blob);
      if (problem) fail(`Could not save ${destination.filename} — ${problem}`);
      // **Stay on the screen when something was left out**, even though the file was written.
      // `onShare` means "you are finished here", and it tears this screen down — which took the
      // shortfall message with it before it could be read. A short export is exactly the one the
      // user needs to be told about.
      else if (short === 0) opts.onShare();
    } catch (e) {
      // Never swallowed: a render that throws and resets the button silently is
      // indistinguishable from an export that worked and went somewhere unexpected.
      fail(`Export failed — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    } finally {
      exporting = false;
      shareBtn.disabled = false;
      paint();
    }
  });

  const footer = el('div', 'lr-footer');
  footer.append(cancelBtn, shareBtn);

  // Escape leaves too. Nothing here is destructive and nothing is half-finished, so it needs no
  // confirmation — the screen is a set of choices that have not been acted on yet.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') opts.onCancel();
  };
  document.addEventListener('keydown', onKey);

  root.append(header, body, footer);

  // ----------------------------------------------------------------- paint --
  function paint() {
    const backing = opts.backing;

    for (const option of options) {
      const t = toggles.get(option.key)!;
      const on = selection[option.key];
      t.row.classList.toggle('is-on', on);
      // Each toggle costs what it costs whether or not the others are on, so the count is
      // planned for that one alone. A total that only appears once everything is chosen is not
      // the number anyone is deciding with.
      const alone = exportPlan(
        project,
        { fullLoop: false, stems: false, stemsWithEffects: false, allPasses: false, [option.key]: true },
        { format, mp3Bitrate: bitrate, backing },
      );
      const n = alone.files.length;
      t.count.innerHTML =
        `<div class="export-files">${n} file${n === 1 ? '' : 's'}</div>` +
        `<div class="export-size">${formatBytes(alone.totalBytes)}</div>`;
    }

    const plan = exportPlan(project, selection, { format, mp3Bitrate: bitrate, backing });
    bitrateRow.style.display = format === 'mp3' ? '' : 'none';
    wavNote.style.display = format === 'wav' ? '' : 'none';

    manifest.innerHTML = plan.files.length
      ? plan.files
          .map(
            (f) =>
              `<div class="export-file"><span class="export-kind is-${f.kind}"></span>` +
              `<span class="export-name">${f.name}</span>` +
              // Shown because it is not uniform any more: a stem with effects is stereo or mono
              // depending on how its layer is panned, and that is also why two of them can
              // differ in size.
              `<span class="export-ch">${f.channels === 2 ? 'stereo' : 'mono'}</span>` +
              `<span class="export-bytes">${formatBytes(f.bytes)}</span></div>`,
          )
          .join('')
      : '<div class="lr-note">Nothing selected.</div>';

    const n = plan.files.length;
    shareBtn.disabled = !isExportable(selection);
    shareBtn.textContent = n ? `Share ${n} file${n === 1 ? '' : 's'} · ${formatBytes(plan.totalBytes)}` : 'Share';
  }

  paint();

  // ---------------------------------------------------------------- render --
  const loop = renderLoop(() => {
    const elapsed = playing ? (opts.engine.frame() / opts.engine.sampleRate) % seconds : 0;
    progress.set(elapsed / seconds);
    const bar = Math.min(project.barCount, Math.floor((elapsed / seconds) * project.barCount) + 1);
    position.textContent = `Bar ${bar} · ${LR.fmtTime(elapsed)} / ${LR.fmtTime(seconds)}`;
  });

  return {
    node: root,
    destroy() {
      loop.stop();
      document.removeEventListener('keydown', onKey);
      opts.engine.stop();
    },
  };
}
