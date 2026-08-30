import { isSilentAt } from '../../src/domain/arrangement.ts';
import { type ReferenceSource, isAudibleInMixdown } from '../../src/domain/bounce.ts';
import { PAN_PRESETS, type PanPresetId, panPreset } from '../../src/domain/effects.ts';
import { EQ_PRESETS, type EqPresetId } from '../../src/domain/eq.ts';
import type { RecordingSession } from '../../src/domain/pass-index.ts';
import { totalPasses } from '../../src/domain/pass-index.ts';
import {
  LAYER_COUNT,
  type Layer,
  NAME_CHARACTER_LIMIT,
  type Project,
  layerHasRecording,
  layerPassIndex,
  nextPassNumber,
  projectTiming,
  projectTotalPasses,
  recordSession,
  recordingBadge,
  sizeProjection,
} from '../../src/domain/project.ts';
import { framesPerBar, loopFrames, loopSeconds } from '../../src/domain/timing.ts';
import { type RecordState, type WaveNode, LR, el, motion, ramp, sizing } from './kit.ts';
import { eqIconSvg, panIconSvg } from './preset-icons.ts';
import { type Engine, amp } from './sim.ts';

const TARGET_LINES = 40; // lanes are an overview: the count follows the container
const LANE_AMPLITUDE = 44; // peak line height; the lane box is 54, see `.lr-wave--lane`
const PRESET_ICON_PX = 28; // the chips span the panel now, so the icon can be worth tapping

type Row = {
  layer: Layer;
  rec: RecordState;
  el: HTMLElement;
  wave: WaveNode;
  rule: HTMLElement;
  note: HTMLElement;
  badge: HTMLElement;
  volume: { update(): void };
  live: HTMLElement[];
  resetA: number;
};

/**
 * Playback screen (§4.4) — the layer stack, the transport, and recording.
 *
 * Follows `docs/mockups/playback-screen-mockup.html`. Two things are done through the domain
 * rather than faked, because they are rules rather than presentation:
 *
 * - **A pass is not counted until it is recorded.** The mockup increments a number at each
 *   loop point. Here the badge is `recordingBadge`, which reads provisional until the
 *   traversal has earned a bar, and the session is committed by `recordSession` at the stop —
 *   which may decline it (§1.4). Stop inside the first bar and no pass appears.
 * - **Sessions are not split at the loop point.** One continuous recording is one session
 *   however many passes it spans (§1.4), so nothing is written until recording ends.
 */
export function playbackScreen(opts: {
  project: Project;
  engine: Engine;
  onChange(layer: Layer): void;
  onEdit(layerIndex: number): void;
}): { node: HTMLElement; destroy(): void } {
  const project = opts.project;
  const t = projectTiming(project);
  const loop = loopFrames(t);
  const seconds = loopSeconds(t);

  let playing = false;
  let heldFrame = 0;
  let lineCount = TARGET_LINES;
  let lineWidth = 3;
  let previousProgress = 0;
  let recordingFrom = 0;

  const spent = ramp.tokenRGB('--lr-spent');
  const rows: Row[] = [];

  const root = el('div', 'lr-screen');

  // ------------------------------------------------------------------ header --
  const header = el('div', 'lr-header');
  const titleRow = el('div', 'lr-title-row');
  const statsRow = el('div', 'lr-meta lr-stats');
  const transportEl = el('div', 'lr-transport');
  header.append(titleRow, statsRow, transportEl);

  /**
   * Two lines, because there are two kinds of number here. Tempo, bar count and time
   * signature are what the project *is* — chosen once, and locked as soon as a pass exists
   * (§1.2) — so they sit on the title's line. Passes and size are what it has *become*, and
   * they move every take, so they get their own line and can change without redrawing the
   * name.
   */
  function paintTitle() {
    const passes = projectTotalPasses(project);
    const size = sizeProjection(project);
    titleRow.innerHTML =
      `<div class="lr-title">${project.name}</div>` +
      `<div class="lr-meta">${project.bpm} BPM · ${project.barCount} bars · ${project.beatsPerBar}/4</div>`;
    statsRow.textContent =
      `${passes} pass${passes === 1 ? '' : 'es'} · ${(size.uncompressedBytes / 1e6).toFixed(1)} MB`;
  }

  function frameNow() {
    return opts.engine.running() ? opts.engine.frame() : heldFrame;
  }

  const playBtn = LR.PlayButton(() => setPlaying(!playing));
  const progressBar = LR.ProgressBar({
    ticks: project.barCount,
    onSeek(fraction) {
      // The engine is the clock (§2.4), so a seek moves the engine, not a private counter.
      const target = Math.round(fraction * loop);
      heldFrame = target;
      previousProgress = fraction;
      if (playing) opts.engine.start(target);
    },
  });
  const position = el('div', 'lr-position');

  let masterLevel = 0.85;
  let masterMuted = false;
  const masterVol = LR.VolumeControl({
    large: true,
    level: () => masterLevel * 100,
    muted: () => masterMuted,
    onToggle() {
      masterMuted = !masterMuted;
      masterVol.update();
    },
  });
  const masterSlider = el('input') as HTMLInputElement;
  masterSlider.type = 'range';
  masterSlider.min = '0';
  masterSlider.max = '100';
  masterSlider.value = String(Math.round(masterLevel * 100));
  masterSlider.style.width = '90px';
  masterSlider.addEventListener('input', () => {
    masterLevel = Number(masterSlider.value) / 100;
    masterVol.update();
  });
  transportEl.append(playBtn, progressBar, position, masterVol, masterSlider);

  function setPlaying(on: boolean) {
    playing = on;
    playBtn.setPlaying(on);
    if (on) {
      opts.engine.start(heldFrame);
    } else {
      opts.engine.stop();
      heldFrame = 0;
      previousProgress = 0;
      for (const row of rows) row.resetA = 1;
    }
  }

  // ---------------------------------------------------------- reference rows --
  // Editable working copy of the domain's shape — the fields are readonly there, as every
  // domain type is, so the screen owns a mutable mirror rather than reaching into one.
  type RefRow = { -readonly [K in keyof ReferenceSource]: ReferenceSource[K] } & {
    icon: string;
    body: string;
    panel: string;
  };

  const refs: RefRow[] = [
    {
      id: 'drums',
      enabled: true,
      muted: false,
      level: 0.7,
      // A drum in side view: head, shell, and two tension lugs. The circle-with-spokes it
      // replaces read as a wheel — the spokes are the only thing that made it a cymbal, and
      // at 22px they lost against the rim.
      icon:
        '<ellipse cx="12" cy="6.6" rx="9" ry="3.1"/>' +
        '<path d="M3 6.6 v10.4 c0 1.7 4 3.1 9 3.1 s9 -1.4 9 -3.1 V6.6"/>' +
        '<path d="M4.1 10.2 L8.1 14.4 M19.9 10.2 L15.9 14.4 M12 11.2 v4.4"/>',
      body: '<div class="ref-detail">Dusty Break 02</div>',
      panel: '',
    },
    {
      id: 'chords',
      enabled: true,
      muted: false,
      level: 0.55,
      // A real keyboard rather than a grid: five white keys with the black keys where a
      // piano actually puts them, so the gap at x=14 is the E–F pair. The rect-and-bars it
      // replaces was symmetrical, which is exactly what a keyboard is not.
      icon:
        '<rect x="2" y="5" width="20" height="14" rx="1.6"/>' +
        '<path d="M6 12.8 v6.2 M10 12.8 v6.2 M14 5 v14 M18 12.8 v6.2"/>' +
        '<path d="M6 6 v6.8 M10 6 v6.8 M18 6 v6.8" stroke-width="2.6"/>',
      body:
        '<div class="chord-slots">' +
        ['Dm', 'G', 'Am'].map((c) => `<span class="chord">${c}</span>`).join('') +
        '<span class="chord is-borrowed">B♭</span></div>',
      panel:
        '<div class="lr-panel-row"><span class="lr-panel-label">Scale</span><div class="lr-chips">' +
        ['Major', 'Minor', 'Dorian', 'Mixolydian', 'Phrygian', 'Lydian']
          .map((s, i) => `<span class="lr-chip${i === 2 ? ' is-active' : ''}">${s}</span>`)
          .join('') +
        '</div></div><div class="lr-panel-row"><span class="lr-panel-label">Tone</span><div class="lr-chips">' +
        ['Rhodes', 'Pad', 'Nylon', 'Organ']
          .map((s, i) => `<span class="lr-chip${i === 0 ? ' is-active' : ''}">${s}</span>`)
          .join('') +
        '</div></div>',
    },
  ];

  const refsEl = el('div', 'refs');
  for (const ref of refs) {
    const row = el('div', 'lr-row');
    const head = el('div', 'lr-row-head', `<svg class="ref-icon" viewBox="0 0 24 24">${ref.icon}</svg>${ref.body}`);
    const vol = LR.VolumeControl({
      level: () => ref.level * 100,
      muted: () => ref.muted,
      onToggle() {
        ref.muted = !ref.muted;
        // §2.6's export rule: any enabled track sounds and exports; mute is how you exclude
        // one. `isAudibleInMixdown` is shared with bounce so the two cannot disagree.
        row.style.opacity = isAudibleInMixdown(ref) ? '1' : '0.62';
        vol.update();
      },
    });
    head.appendChild(vol);
    row.appendChild(head);

    const panel = el(
      'div',
      'lr-panel',
      '<div class="lr-panel-inner"><div class="lr-panel-row"><span class="lr-panel-label">Volume</span>' +
        `<input class="level" type="range" min="0" max="100" value="${Math.round(ref.level * 100)}" style="flex:1"></div>` +
        `${ref.panel}</div>`,
    );
    row.appendChild(panel);

    head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.lr-volume, .chord')) return;
      row.classList.toggle('is-open');
    });
    panel.querySelector('.level')!.addEventListener('input', (e) => {
      ref.level = Number((e.target as HTMLInputElement).value) / 100;
      vol.update();
    });
    bindChips(panel);
    refsEl.appendChild(row);
  }

  // --------------------------------------------------------------- layer rows --
  const layersEl = el('div', 'lr-rows');

  for (const initial of project.layers) rows.push(layerRow(initial));

  function capturingIndex() {
    return rows.findIndex((r) => r.rec === 'recording');
  }

  function setRec(index: number, state: RecordState) {
    rows.forEach((row, i) => {
      const next = i === index ? state : 'unarmed'; // arming is exclusive
      const was = row.rec;
      row.rec = next;
      row.el.classList.toggle('is-armed', next === 'armed');
      row.el.classList.toggle('is-recording', next === 'recording');

      if (next === 'recording' && was !== 'recording') {
        // A pass always begins on the downbeat, so recording restarts the loop.
        heldFrame = 0;
        previousProgress = 0;
        recordingFrom = 0;
        opts.engine.start(0);
        playing = true;
        playBtn.setPlaying(true);
        clearLive(row);
      }

      if (next !== 'recording' && was === 'recording') {
        // The whole take is one session however many passes it spanned (§1.4), and the
        // domain decides whether it holds any at all — a take under one bar is not a pass.
        const captured = Math.max(0, frameNow() - recordingFrom);
        const updated = recordSession(row.layer, capturedSession(row.layer, captured), t);
        row.layer = updated;
        opts.onChange(updated);
        clearLive(row);
        paintRow(row);
        paintTitle();
        buildLanes();
      }
      row.note.style.display = next === 'unarmed' && !layerHasRecording(row.layer) ? '' : 'none';
      row.rule.style.width = '0';
      paintBadge(row);
    });
    layersEl.classList.toggle('is-capturing', capturingIndex() >= 0);
  }

  function capturedSession(layer: Layer, frames: number): RecordingSession {
    return {
      id: `${layer.id}-take-${layer.sessions.length + 1}`,
      audioFileURL: `sim://${layer.id}/${layer.sessions.length + 1}`,
      recordedFrames: frames,
      recordedAt: new Date().toISOString(),
      waveformPeaks: [],
    };
  }

  function layerRow(initial: Layer): Row {
    const rowEl = el('div', 'lr-row');
    const head = el('div', 'lr-row-head');

    const dot = LR.RecordDot({
      state: () => row.rec,
      blocked: () => {
        const c = capturingIndex();
        return c >= 0 && c !== row.layer.index;
      },
      set: (s) => setRec(row.layer.index, s),
    });

    const label = el(
      'div',
      'layer-label',
      `<span class="idx">${initial.index + 1}</span>` +
        `<span class="layer-name" contenteditable="true" spellcheck="false" ` +
        `data-placeholder="Layer ${initial.index + 1}" role="textbox">${initial.name}</span>` +
        '<span class="lr-pass-badge"></span>',
    );

    const wave = LR.Waveform({ variant: 'lane' });
    wave.style.flex = '1';
    const note = el('span', 'lr-note', '');
    const rule = el('div', 'rec-rule');
    wave.append(note, rule);

    // Declared before the volume control, which calls `update()` inside its constructor and
    // so reads `row.layer` immediately rather than on the next frame.
    const row: Row = {
      layer: initial,
      rec: 'unarmed',
      el: rowEl,
      wave,
      rule,
      note,
      badge: label.querySelector('.lr-pass-badge')!,
      volume: { update() {} },
      live: [],
      resetA: 0,
    };

    const volume = LR.VolumeControl({
      level: () => row.layer.level * 100,
      muted: () => row.layer.muted,
      onToggle() {
        row.layer = { ...row.layer, muted: !row.layer.muted };
        rowEl.classList.toggle('is-muted', row.layer.muted);
        volume.update();
        opts.onChange(row.layer);
        buildLanes();
      },
    });

    head.append(dot, label, wave, volume);
    rowEl.appendChild(head);

    const panel = el('div', 'lr-panel');
    const inner = el('div', 'lr-panel-inner');
    panel.appendChild(inner);
    rowEl.appendChild(panel);

    const volumeRow = el(
      'div',
      'lr-panel-row',
      '<span class="lr-panel-label">Volume</span>' +
        `<input class="level" type="range" min="0" max="100" value="${Math.round(initial.level * 100)}" style="flex:1">`,
    );
    inner.appendChild(volumeRow);

    inner.appendChild(
      presetGroup('EQ', EQ_PRESETS, () => row.layer.eq, (id) => {
        row.layer = { ...row.layer, eq: id as EqPresetId };
        opts.onChange(row.layer);
      }, (p) => eqIconSvg(p.id as EqPresetId, PRESET_ICON_PX)),
    );
    inner.appendChild(
      presetGroup('Pan', PAN_PRESETS, () => row.layer.pan, (id) => {
        row.layer = { ...row.layer, pan: id as PanPresetId };
        opts.onChange(row.layer);
      }, (p) => panIconSvg(panPreset(p.id as PanPresetId), PRESET_ICON_PX)),
    );

    // Below the presets and on its own row: it leaves this screen, which the mixer controls
    // above it do not.
    const editRow = el('div', 'lr-panel-row edit-row');
    editRow.setAttribute('data-needs-audio', '');
    const editBtn = el('button', 'lr-btn', 'Edit Layer');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onEdit(row.layer.index);
    });
    editRow.appendChild(editBtn);
    inner.appendChild(editRow);

    inner.appendChild(
      el(
        'div',
        'lr-panel-row empty-note',
        '<span class="lr-panel-label"></span><span class="lr-note">Record a pass to start editing</span>',
      ),
    );

    head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.lr-rec, .lr-volume, .layer-name')) return;
      rowEl.classList.toggle('is-open');
    });
    volumeRow.querySelector('.level')!.addEventListener('input', (e) => {
      row.layer = { ...row.layer, level: Number((e.target as HTMLInputElement).value) / 100 };
      volume.update();
      opts.onChange(row.layer);
    });
    bindChips(panel);

    row.volume = volume;
    bindName(label.querySelector('.layer-name')!, row);
    layersEl.appendChild(rowEl);
    paintRow(row);
    return row;
  }

  function paintRow(row: Row) {
    const recorded = layerHasRecording(row.layer);
    row.el.classList.toggle('has-audio', recorded);
    row.el.classList.toggle('is-empty', !recorded);
    row.el.classList.toggle('is-muted', row.layer.muted);
    const count = totalPasses(layerPassIndex(row.layer, t));
    row.note.textContent = recorded ? `${count} pass${count === 1 ? '' : 'es'} recorded` : 'empty';
    row.note.style.display = recorded ? 'none' : '';
    paintBadge(row);
  }

  /**
   * The pass badge (§3.9). While recording it shows the traversal in progress, marked
   * provisional until that traversal has earned a bar — the same `passExists` that decides
   * whether it survives the stop, so the badge is a preview of the gate rather than a second
   * rule. Otherwise it names the pass about to be captured.
   */
  function paintBadge(row: Row) {
    if (row.rec === 'recording') {
      const badge = recordingBadge(row.layer, t, Math.max(0, frameNow() - recordingFrom));
      row.badge.textContent = `Pass ${badge.pass}`;
      row.badge.classList.toggle('is-provisional', !badge.isCommitted);
      return;
    }
    row.badge.textContent = `Pass ${nextPassNumber(row.layer, t)}`;
    row.badge.classList.remove('is-provisional');
  }

  function bindChips(scope: HTMLElement) {
    for (const group of scope.querySelectorAll<HTMLElement>('.lr-chips')) {
      group.addEventListener('click', (e) => {
        const chip = (e.target as HTMLElement).closest('.lr-chip');
        if (!chip || !group.contains(chip)) return;
        for (const c of group.querySelectorAll('.lr-chip')) c.classList.remove('is-active');
        chip.classList.add('is-active');
      });
    }
  }

  // ------------------------------------------------------------------ naming --
  function bindName(node: HTMLElement, row: Row) {
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    node.addEventListener('focus', () => {
      node.dataset.prev = node.textContent ?? '';
    });
    // Cap while typing, not only on commit: a field that grows mid-edit shoves the lane
    // sideways on every keystroke.
    node.addEventListener('input', () => {
      if ((node.textContent ?? '').length <= NAME_CHARACTER_LIMIT) return;
      node.textContent = (node.textContent ?? '').slice(0, NAME_CHARACTER_LIMIT);
      const range = document.createRange();
      const sel = getSelection();
      range.selectNodeContents(node);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        node.blur();
      }
      if (e.key === 'Escape') {
        node.textContent = node.dataset.prev ?? '';
        node.blur();
      }
    });
    node.addEventListener('blur', () => {
      const clean = (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_CHARACTER_LIMIT);
      node.textContent = clean;
      row.layer = { ...row.layer, name: clean };
      opts.onChange(row.layer);
    });
    node.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text') ?? '';
      const room = NAME_CHARACTER_LIMIT - (node.textContent ?? '').length;
      document.execCommand('insertText', false, text.replace(/\s+/g, ' ').slice(0, Math.max(0, room)));
    });
  }

  // ------------------------------------------------------------------- lanes --
  function buildLanes() {
    for (const row of rows) {
      if (!layerHasRecording(row.layer)) continue;
      const [from, to] = ramp.slice(row.layer.index, LAYER_COUNT);
      row.wave.build(lineCount, (i, u) => {
        const slot = Math.min(project.barCount - 1, Math.floor(u * project.barCount));
        const silent = isSilentAt(row.layer.mutedSlots, slot, false) || !row.layer.barSources[slot];
        return {
          height: silent ? 2 : motion.snapEven(amp(row.layer.index, 0, i, lineCount) * LANE_AMPLITUDE, 2),
          rgb: ramp.rgb(from + (to - from) * u),
        };
      });
      row.wave.append(row.note, row.rule);
    }
  }

  function clearLive(row: Row) {
    for (const node of row.live) node.remove();
    row.live = [];
  }

  /**
   * Live capture. In the app these heights come from an input tap — one peak per buffer,
   * lock-free hand-off, drained on a display link. The draw path is identical: append one
   * line per elapsed slot.
   */
  function pushLive(row: Row, upto: number) {
    const [from, to] = ramp.slice(row.layer.index, LAYER_COUNT);
    while (row.live.length < upto && row.live.length < lineCount) {
      const i = row.live.length;
      const u = lineCount > 1 ? i / (lineCount - 1) : 0;
      const line = el('div', 'lr-wave__line');
      const level = amp(row.layer.index, row.layer.sessions.length, i, lineCount) * (0.55 + 0.45 * Math.random());
      line.style.height = `${motion.snapEven(level * LANE_AMPLITUDE, 2)}px`;
      line.style.color = `rgb(${ramp.rgb(from + (to - from) * u)})`;
      row.wave.insertBefore(line, row.note);
      row.live.push(line);
    }
  }

  function syncSizing() {
    const lane = root.querySelector<HTMLElement>('.lr-wave--lane');
    if (!lane?.clientWidth) return;
    const fit = sizing.fitToWidth(lane.clientWidth, TARGET_LINES);
    if (fit.count === lineCount && fit.width === lineWidth) return;
    lineCount = fit.count;
    lineWidth = fit.width;
    sizing.apply(fit.width);
    buildLanes();
  }

  // ------------------------------------------------------------------ render --
  let alive = true;
  function loopFrame(fn: (dt: number) => void) {
    let last = performance.now();
    const step = (now: number) => {
      if (!alive) return;
      const dt = Math.min(now - last, 50);
      last = now;
      fn(dt);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  loopFrame((dt) => {
    const frame = frameNow();
    const progress = ((frame % loop) + loop) % loop / loop;

    if (playing && progress < previousProgress) {
      for (const row of rows) {
        row.resetA = 1;
        if (row.rec === 'recording') clearLive(row); // a pass completed; the take continues
      }
    }
    previousProgress = progress;

    const head = progress * lineCount;

    for (const row of rows) {
      row.resetA = row.resetA > 0.001 ? motion.approach(row.resetA, 0, motion.TAU.reset!, dt) : 0;

      if (row.rec === 'recording') {
        pushLive(row, Math.floor(head) + 1);
        row.rule.style.width = `${(progress * 100).toFixed(1)}%`;
        paintBadge(row);
      }

      const lines = row.wave.lines();
      for (let i = 0; i < lines.length; i++) {
        const passed = Math.max(playing || row.resetA > 0 ? head - i : -1, row.resetA);
        row.wave.paint(lines[i]!, passed, 1, spent, lineWidth);
      }
    }

    progressBar.set(progress);
    const bar = Math.min(project.barCount, Math.floor(progress * project.barCount) + 1);
    position.textContent = `Bar ${bar} · ${LR.fmtTime(progress * seconds)} / ${LR.fmtTime(seconds)}`;
  });

  // Escape disarms; it cannot stop a pass in progress (§3.5).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const armed = rows.findIndex((r) => r.rec === 'armed');
    if (armed >= 0) setRec(armed, 'unarmed');
  };
  document.addEventListener('keydown', onKey);

  const footer = el('div', 'lr-footer');
  footer.append(
    el(
      'span',
      '',
      'tap the name to rename · row for its mixer · speaker to mute · dot to arm, again to record, hold to cancel',
    ),
    el('button', 'lr-btn lr-btn--primary', 'Export'),
  );

  root.append(
    header,
    el('div', 'lr-section-label', 'Reference tracks'),
    refsEl,
    el('div', 'lr-section-label', 'Layers'),
    layersEl,
    footer,
  );
  (root.children[3] as HTMLElement).style.marginTop = '10px';

  paintTitle();
  let observer: ResizeObserver | undefined;
  requestAnimationFrame(() => {
    if (!alive) return;
    syncSizing();
    buildLanes();
    for (const row of rows) row.volume.update();
    masterVol.update();
    const lane = root.querySelector<HTMLElement>('.lr-wave--lane');
    if (lane) {
      observer = new ResizeObserver(syncSizing);
      observer.observe(lane);
    }
  });

  return {
    node: root,
    destroy() {
      alive = false;
      observer?.disconnect();
      document.removeEventListener('keydown', onKey);
      opts.engine.stop();
    },
  };
}

/**
 * A preset picker: the label and the current preset's name on one line, the six icons on
 * their own below. Six icons will not share a line with both of those — they were being
 * squeezed to a couple of pixels of padding each and pushing the name off the right edge —
 * and giving the strip the full width is also what lets the icons reach a tappable size.
 *
 * The icons are all the user sees, so the name is the only place a preset is named at all.
 */
function presetGroup<P extends { id: string; name: string }>(
  label: string,
  presets: readonly P[],
  current: () => string,
  onPick: (id: string) => void,
  icon: (p: P) => string,
): HTMLElement {
  const group = el('div', 'preset-group');
  group.setAttribute('data-needs-audio', '');

  const head = el('div', 'preset-head', `<span class="lr-panel-label">${label}</span>`);
  const name = el('span', 'preset-name');
  head.appendChild(name);

  const chips = el('div', 'lr-chips preset-chips');
  for (const preset of presets) {
    const chip = el('span', `lr-chip${preset.id === current() ? ' is-active' : ''}`, icon(preset));
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      name.textContent = preset.name;
      onPick(preset.id);
    });
    chips.appendChild(chip);
  }
  name.textContent = presets.find((p) => p.id === current())?.name ?? '';

  group.append(head, chips);
  return group;
}
