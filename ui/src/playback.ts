import { isSilentAt } from '../../src/domain/arrangement.ts';
import { toAbsolute } from '../../src/domain/bar-ref.ts';
import { PAN_PRESETS, type PanPresetId } from '../../src/domain/effects.ts';
import { EQ_PRESETS, type EqPresetId } from '../../src/domain/eq.ts';
import { totalPasses } from '../../src/domain/pass-index.ts';
import {
  type Layer,
  type Project,
  layerHasRecording,
  layerPassIndex,
  nextPassNumber,
  projectTiming,
  projectTotalPasses,
  sizeProjection,
} from '../../src/domain/project.ts';
import { loopSeconds } from '../../src/domain/timing.ts';
import { LR, el, ramp } from './kit.ts';
import { eqIconSvg, panIconSvg } from './preset-icons.ts';
import { barPeaks } from './sim.ts';

/**
 * Playback screen (§4.4) — the layer stack as an overview.
 *
 * Thin on purpose: rows, levels, mute, the preset strips and the pass badge. Editing lives on
 * the Edit Layer screen.
 */
export function playbackScreen(opts: {
  project: Project;
  onChange(layer: Layer): void;
  onEdit(layerIndex: number): void;
}): HTMLElement {
  const project = opts.project;
  const t = projectTiming(project);
  const root = el('div', 'lr-screen');

  const passes = projectTotalPasses(project);
  const size = sizeProjection(project);
  root.appendChild(
    el(
      'div',
      'lr-header',
      `<div class="lr-title-row"><div class="lr-title">${project.name}</div>` +
        `<div class="lr-meta">${project.bpm} BPM · ${project.barCount} bars · ` +
        `${LR.fmtTime(loopSeconds(t))} · ${passes} pass${passes === 1 ? '' : 'es'} · ` +
        `${(size.uncompressedBytes / 1e6).toFixed(1)} MB</div></div>`,
    ),
  );

  const rows = el('div', 'lr-rows');
  root.appendChild(rows);

  for (const layer of project.layers) rows.appendChild(layerRow(layer));

  function layerRow(initial: Layer): HTMLElement {
    let layer = initial;
    const recorded = layerHasRecording(layer);

    const row = el('div', 'lr-row' + (recorded ? '' : ' is-empty'));
    const head = el('div', 'lr-row-head');

    const dot = el('button', 'lr-rec');
    const label = el('div');
    label.style.cssText = 'min-width:116px;display:flex;align-items:baseline;gap:6px';

    const lane = LR.Waveform({ variant: 'lane' });
    const laneWrap = el('div');
    laneWrap.style.cssText = 'flex:1;min-width:0';
    laneWrap.appendChild(lane);

    const volume = LR.VolumeControl({
      level: () => layer.level * 100,
      muted: () => layer.muted,
      onToggle() {
        layer = { ...layer, muted: !layer.muted };
        row.classList.toggle('is-muted', layer.muted);
        paintLane();
        opts.onChange(layer);
      },
    });

    head.append(dot, label, laneWrap, volume);
    row.appendChild(head);

    const panel = el('div', 'lr-panel');
    const inner = el('div', 'lr-panel-inner');
    panel.appendChild(inner);
    row.appendChild(panel);

    // Volume + Edit bars share a row, as in the playback mockup.
    const volumeRow = el('div', 'lr-panel-row');
    volumeRow.innerHTML =
      '<span class="lr-panel-label">Volume</span>' +
      `<input class="level" type="range" min="0" max="100" value="${Math.round(layer.level * 100)}" style="flex:1">`;
    const editBtn = el('button', 'lr-btn', 'Edit bars') as HTMLButtonElement;
    editBtn.disabled = !recorded;
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onEdit(layer.index);
    });
    volumeRow.appendChild(editBtn);
    inner.appendChild(volumeRow);

    if (recorded) {
      inner.appendChild(
        presetRow('EQ', EQ_PRESETS, layer.eq, (id) => {
          layer = { ...layer, eq: id };
          opts.onChange(layer);
        }, (p) => eqIconSvg(p.id)),
      );
      inner.appendChild(
        presetRow('Pan', PAN_PRESETS, layer.pan, (id) => {
          layer = { ...layer, pan: id };
          opts.onChange(layer);
        }, (p) => panIconSvg(p)),
      );
    } else {
      inner.appendChild(
        el(
          'div',
          'lr-panel-row',
          '<span class="lr-panel-label"></span><span class="lr-note">Record a pass to start editing</span>',
        ),
      );
    }

    head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.lr-volume, .lr-rec, .lr-btn')) return;
      row.classList.toggle('is-open');
    });
    volumeRow.querySelector('.level')!.addEventListener('input', (e) => {
      layer = { ...layer, level: Number((e.target as HTMLInputElement).value) / 100 };
      volume.update();
      opts.onChange(layer);
    });

    function paintLabel() {
      const count = totalPasses(layerPassIndex(layer, t));
      label.innerHTML =
        `<span style="color:var(--lr-ink-faint);font-size:11px">${layer.index + 1}</span>` +
        (layer.name
          ? `<span style="color:var(--lr-ink);font-size:13px">${layer.name}</span>`
          : `<span style="color:var(--lr-ink-faint);font-size:13px">Layer ${layer.index + 1}</span>`) +
        `<span class="lr-pass-badge" style="margin-left:auto">P${count || nextPassNumber(layer, t)}</span>`;
    }

    function paintLane() {
      const width = laneWrap.clientWidth || 240;
      const perBar = Math.max(2, Math.floor(width / (project.barCount * 6)));
      const total = Math.max(1, totalPasses(layerPassIndex(layer, t)) * project.barCount);
      const [from, to] = ramp.slice(layer.index, project.layers.length);

      lane.build(project.barCount * perBar, (i) => {
        const slot = Math.floor(i / perBar);
        const ref = layer.barSources[slot];
        const silent = !ref || isSilentAt(layer.mutedSlots, slot, layer.muted);
        const peak = ref ? barPeaks(layer.index, toAbsolute(ref, project.barCount), perBar)[i % perBar]! : 0;
        const u = ref ? (toAbsolute(ref, project.barCount) - 1) / total : 0;
        return {
          height: silent ? 2 : Math.round(3 + peak * 21),
          rgb: ramp.rgb(from + (to - from) * u),
        };
      });
    }

    paintLabel();
    requestAnimationFrame(() => {
      if (recorded) paintLane();
      volume.update();
    });
    return row;
  }

  return root;
}

function presetRow<P extends { id: string; name: string }>(
  label: string,
  presets: readonly P[],
  current: string,
  onPick: (id: never) => void,
  icon: (p: P) => string,
): HTMLElement {
  const row = el('div', 'lr-panel-row');
  row.innerHTML = `<span class="lr-panel-label">${label}</span>`;

  const chips = el('div', 'lr-chips');
  chips.style.flex = '1';
  const name = el('span');
  name.style.cssText = 'font-size:11px;color:var(--lr-ink);min-width:54px;text-align:right';

  for (const preset of presets) {
    const chip = el('span', 'lr-chip' + (preset.id === current ? ' is-active' : ''), icon(preset));
    chip.style.cssText += 'display:flex;padding:4px 6px;flex:1;justify-content:center';
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      for (const other of chips.children) other.classList.remove('is-active');
      chip.classList.add('is-active');
      name.textContent = preset.name;
      onPick(preset.id as never);
    });
    chips.appendChild(chip);
  }
  name.textContent = presets.find((p) => p.id === current)?.name ?? '';

  row.append(chips, name);
  return row;
}

export type { EqPresetId, PanPresetId };
