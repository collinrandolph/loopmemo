import type { ReferenceSource } from '../../src/domain/bounce.ts';
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
import { helpControl } from './help.ts';
import { LR, el } from './kit.ts';
import type { Engine } from './sim.ts';

/**
 * Export (§4.5, extended).
 *
 * §4.5 gives format, quality, preview and share, and one deliverable — "it exports the project
 * exactly as it currently sounds". That is the Full Loop, and it stays on by default. Stems and
 * the raw recording are opt-in additions, and what each one contains is decided in
 * `src/domain/export.ts` rather than here, so the file list and the sizes cannot drift from it.
 *
 * **No mute controls** (§4.5). Muting happens on the Playback screen, where the result is
 * audible. What this screen decides is which *kinds* of file come out, not what is in them.
 *
 * The size of a selection is the fact that decides it — the same reasoning as Compress showing
 * its projection (§4.1) — so every toggle carries its own file count and total.
 */
export function exportScreen(opts: {
  project: Project;
  engine: Engine;
  references: readonly (ReferenceSource & { label: string })[];
  onDone(): void;
}): { node: HTMLElement; destroy(): void } {
  const project = opts.project;
  const seconds = loopSeconds(projectTiming(project));

  let selection: ExportSelection = { ...DEFAULT_SELECTION };
  let format: ExportFormat = 'wav';
  let bitrate: Mp3Bitrate = 192;

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
      detail: 'The mix exactly as you hear it — levels, effects, reference tracks and mutes.',
    },
    {
      key: 'stems',
      title: 'Stems',
      detail: 'One file per layer and reference track, dry: the edited loop with no effects.',
    },
    {
      key: 'raw',
      title: 'Raw recording',
      detail: 'Every pass on every layer, exactly as captured. Always WAV.',
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
      paint();
    });
    whatRows.appendChild(row);
    toggles.set(option.key, { row, count });
  }

  // ---------------------------------------------------------------- format --
  const formatRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Format</span>');
  const formatChips = el('div', 'lr-chips');
  for (const id of ['wav', 'mp3'] as const) {
    const chip = el('span', `lr-chip${id === format ? ' is-active' : ''}`, id.toUpperCase());
    chip.addEventListener('click', () => {
      format = id;
      paint();
    });
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

  // Only meaningful for MP3: WAV's quality is the project's capture setting, snapshotted at
  // creation and immutable (§2.7), so there is nothing to choose.
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
    bitrateRow,
    wavNote,
    el('div', 'lr-section-label', 'Preview'),
    preview,
    el('div', 'lr-section-label', 'Files'),
    manifest,
  );

  const help = helpControl({
    title: 'Export',
    content: () => [
      'the full loop is the mix as you hear it · stems are one dry file per layer · raw is every ' +
        'pass exactly as captured · muting happens on the playback screen, not here',
    ],
  });

  const shareBtn = el('button', 'lr-btn lr-btn--primary', 'Share') as HTMLButtonElement;
  shareBtn.addEventListener('click', opts.onDone);
  const footer = el('div', 'lr-footer');
  footer.append(help.node, shareBtn);

  root.append(header, body, footer);

  // ----------------------------------------------------------------- paint --
  function paint() {
    const references = opts.references;

    for (const option of options) {
      const t = toggles.get(option.key)!;
      const on = selection[option.key];
      t.row.classList.toggle('is-on', on);
      // Each toggle costs what it costs whether or not the others are on, so the count is
      // planned for that one alone. A total that only appears once everything is chosen is not
      // the number anyone is deciding with.
      const alone = exportPlan(
        project,
        { fullLoop: false, stems: false, raw: false, [option.key]: true },
        { format, mp3Bitrate: bitrate, references },
      );
      const n = alone.files.length;
      t.count.innerHTML =
        `<div class="export-files">${n} file${n === 1 ? '' : 's'}</div>` +
        `<div class="export-size">${mb(alone.totalBytes)}</div>`;
    }

    const plan = exportPlan(project, selection, { format, mp3Bitrate: bitrate, references });
    formatRow.classList.toggle('is-inert', !selection.fullLoop && !selection.stems);
    bitrateRow.style.display = format === 'mp3' ? '' : 'none';
    wavNote.style.display = format === 'wav' ? '' : 'none';

    manifest.innerHTML = plan.files.length
      ? plan.files
          .map(
            (f) =>
              `<div class="export-file"><span class="export-kind is-${f.kind}"></span>` +
              `<span class="export-name">${f.name}</span>` +
              `<span class="export-bytes">${mb(f.bytes)}</span></div>`,
          )
          .join('')
      : '<div class="lr-note">Nothing selected.</div>';

    const n = plan.files.length;
    shareBtn.disabled = !isExportable(selection);
    shareBtn.textContent = n ? `Share ${n} file${n === 1 ? '' : 's'} · ${mb(plan.totalBytes)}` : 'Share';
  }

  paint();

  // ---------------------------------------------------------------- render --
  let alive = true;
  const step = () => {
    if (!alive) return;
    requestAnimationFrame(step);
    const elapsed = playing ? (opts.engine.frame() / opts.engine.sampleRate) % seconds : 0;
    progress.set(elapsed / seconds);
    const bar = Math.min(project.barCount, Math.floor((elapsed / seconds) * project.barCount) + 1);
    position.textContent = `Bar ${bar} · ${LR.fmtTime(elapsed)} / ${LR.fmtTime(seconds)}`;
  };
  requestAnimationFrame(step);

  return {
    node: root,
    destroy() {
      alive = false;
      help.destroy();
      opts.engine.stop();
    },
  };
}

function mb(bytes: number): string {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}
