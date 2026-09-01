import { isSilentAt } from '../../src/domain/arrangement.ts';
import type { BackingTracks } from '../../src/domain/backing.ts';
import { toAbsolute } from '../../src/domain/bar-ref.ts';
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
import { bindChips } from './controls.ts';
import { helpControl } from './help.ts';
import { type RecordState, type WaveNode, LR, el, motion, ramp, sizing } from './kit.ts';
import { SETTINGS_ICON } from './icons.ts';
import { eqIconSvg, panIconSvg } from './preset-icons.ts';
import { backingRows } from './backing-rows.ts';
import { amp } from './sim.ts';
import { barAmplitude, computePeaks } from './peaks.ts';
import type { BackingEngine } from './audio.ts';
import { type TakeStore, takeUrl } from './takes.ts';

const TARGET_LINES = 40; // lanes are an overview: the count follows the container
const LANE_AMPLITUDE = 34; // peak line height; the lane box is 40, see `.lr-wave--lane`
const PRESET_ICON_PX = 28; // the chips span the panel now, so the icon can be worth tapping

/** The label column never shrinks below this, so a one-character name still holds a column. */
const LABEL_MIN_PX = 52;
/**
 * `.layer-name` pads itself and pulls the padding back with a negative margin, so its hover
 * and focus highlight has room without the text shifting. That makes the box it *paints* 6px
 * wider than the box it *occupies* — measure only the latter and the highlight bleeds into
 * the lane on the right. Added back here rather than by dropping the negative margins, which
 * would move every name 3px and reopen the shift they exist to prevent.
 */
const LABEL_PAINT_SLACK_PX = 6;
/** …and never past this, so one long name cannot take the width away from every lane. */
const LABEL_MAX_PX = 104;

type Row = {
  layer: Layer;
  rec: RecordState;
  el: HTMLElement;
  label: HTMLElement;
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
  engine: BackingEngine;
  /** Where captured audio is filed; the domain only ever sees a session id. */
  takes: TakeStore;
  onChange(layer: Layer): void;
  /** Backing edits, which are project state rather than layer state (§2.6). */
  onBackingChange(backing: BackingTracks): void;
  onEdit(layerIndex: number): void;
  /** Project settings (§4.5), reached by the gear beside the project stats. */
  onSettings(): void;
  /** Up to the Library. Also what Escape does once nothing is armed or recording. */
  onBack(): void;
  onExport(): void;
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

  /**
   * The way into project settings, and it is a **visible control** rather than a tappable header.
   *
   * Tapping the title row used to do this, which had the appeal of "the place a value is shown is
   * the place you change it" and the problem of being invisible. It was also quietly inconsistent:
   * tapping a *layer* name on this same screen renames it in place, so tapping the *project* name
   * to navigate away taught the opposite lesson two rows apart. A gear says what it does.
   *
   * `paintTitle` rewrites the stats text, so that lives in its own span — writing `textContent` on
   * the row would take the button with it.
   */
  const statsRow = el('div', 'lr-meta lr-stats');
  const statsText = el('span', 'stats-text');
  const gearBtn = el('button', 'header-gear', `<svg viewBox="0 0 24 24">${SETTINGS_ICON}</svg>`);
  gearBtn.setAttribute('type', 'button');
  gearBtn.setAttribute('aria-label', 'Project settings');
  gearBtn.addEventListener('click', () => opts.onSettings());
  statsRow.append(statsText, gearBtn);
  const transportEl = el('div', 'lr-transport');
  /** Only ever visible when the input failed; see `paintInputState`. */
  const inputNote = el('div', 'input-note');
  inputNote.style.display = 'none';
  header.append(titleRow, statsRow, inputNote, transportEl);

  /**
   * Two lines, because there are two kinds of number here. Tempo, bar count and time
   * signature are what the project *is* — chosen once, and locked as soon as a pass exists
   * (§1.2) — so they sit on the title's line. Passes and size are what it has *become*, and
   * they move every take, so they get their own line and can change without redrawing the
   * name.
   */
  function paintTitle() {
    // From the rows, not from `opts.project`. That is the snapshot the screen was built with;
    // edits go out through `onChange` and come back on the next mount, so reading it here left
    // the pass count and the size frozen at whatever they were when the screen opened — a
    // recording committed and the header did not move.
    const live: Project = { ...project, layers: rows.map((r) => r.layer) };
    const passes = projectTotalPasses(live);
    const size = sizeProjection(live);
    titleRow.innerHTML =
      `<div class="lr-title">${project.name}</div>` +
      `<div class="lr-settings">${project.bpm} BPM · ${project.barCount} Bars · ${project.beatsPerBar}/4</div>`;
    statsText.textContent =
      `${passes} Pass${passes === 1 ? '' : 'es'} · ${(size.uncompressedBytes / 1e6).toFixed(1)} MB`;
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

  // The drum track and the chord bed edit `project.backing` and report upward, exactly like a
  // layer row — which is what lets a mute here reach the export screen (§2.6).
  const backingEl = backingRows({
    backing: project.backing,
    onChange: opts.onBackingChange,
  });

  // --------------------------------------------------------------- layer rows --
  const layersEl = el('div', 'lr-rows');

  for (const initial of project.layers) rows.push(layerRow(initial));

  function capturingIndex() {
    return rows.findIndex((r) => r.rec === 'recording');
  }

  function setRec(index: number, state: RecordState) {
    let stopped = false;
    rows.forEach((row, i) => {
      const next = i === index ? state : 'unarmed'; // arming is exclusive
      const was = row.rec;
      row.rec = next;
      row.el.classList.toggle('is-armed', next === 'armed');
      row.el.classList.toggle('is-recording', next === 'recording');

      // Arming is where the permission prompt is paid for. Raised at the downbeat instead, it
      // is answered seconds into a take that is already running (see `openInput`).
      if (next === 'armed' && was !== 'armed') void opts.engine.openInput().then(paintInputState);

      if (next === 'recording' && was !== 'recording') {
        // A pass always begins on the downbeat, so recording restarts the loop.
        heldFrame = 0;
        previousProgress = 0;
        recordingFrom = 0;
        opts.engine.start(0);
        // Told before the take rather than after: the layer being recorded onto is silent for
        // the duration (§2.2), and that has to be true from the first bar, not from the commit.
        opts.engine.setLayers(liveProject(), opts.takes, i);
        void opts.engine.startCapture().then(paintInputState);
        playing = true;
        playBtn.setPlaying(true);
        clearLive(row);
      }

      if (next !== 'recording' && was === 'recording') {
        // The whole take is one session however many passes it spanned (§1.4), and the
        // domain decides whether it holds any at all — a take under one bar is not a pass.
        //
        // The frame count comes from the engine's own clock, not from the captured buffer's
        // length: the buffer holds what the input delivered, which after compensation is not
        // the same window as what the player performed. `recordSession` is deciding how many
        // bars were traversed, and that is a question about the transport.
        const frames = Math.max(0, frameNow() - recordingFrom);
        const session = capturedSession(row.layer, frames);
        const before = row.layer.sessions.length;
        const updated = recordSession(row.layer, session, t);
        row.layer = updated;
        // Only keep the audio if the domain kept the take. A traversal that never completed a
        // bar holds no passes and is discarded (§1.4), and storing its buffer would leak a
        // take nothing can ever refer to. Ordered after the layer is in place, because
        // committing re-reads the rows to tell the engine what to play.
        void commitCapture(row, session, updated.sessions.length > before);
        opts.onChange(updated);
        clearLive(row);
        paintRow(row);
        paintTitle();
        buildLanes();
        stopped = true;
      }
      row.note.style.display = next === 'unarmed' && !layerHasRecording(row.layer) ? '' : 'none';
      row.rule.style.width = '0';
      paintBadge(row);
    });
    layersEl.classList.toggle('is-capturing', capturingIndex() >= 0);

    if (stopped) {
      // The take ends where it ends; the loop does not carry on past it. Rewinding to the
      // downbeat also puts the transport where the next pass will start, since recording
      // restarts the loop anyway.
      setPlaying(false);
      // A committed pass can widen the badge — "Pass 9" to "Pass 10" — and the badge shares
      // the label column with the name.
      syncLabelWidth();
    }
  }

  function capturedSession(layer: Layer, frames: number): RecordingSession {
    const id = `${layer.id}-take-${layer.sessions.length + 1}`;
    return {
      id,
      audioFileURL: takeUrl(id),
      recordedFrames: frames,
      recordedAt: new Date().toISOString(),
      waveformPeaks: [],
    };
  }

  /**
   * Push the layer state at the engine.
   *
   * Level, mute, EQ and pan are all live gestures made while the loop is running (§2.8), so
   * they have to reach the audio graph now rather than on the next navigation. The capturing
   * index goes with them: without it, a level nudge during a take would un-silence the layer
   * being recorded onto, which is the one thing that must stay quiet (§2.2).
   */
  function syncLayers() {
    const capturing = capturingIndex();
    opts.engine.setLayers(liveProject(), opts.takes, capturing >= 0 ? capturing : undefined);
  }

  /** The project as the rows currently have it, which is ahead of `opts.project` mid-session. */
  function liveProject(): Project {
    return { ...project, layers: rows.map((r) => r.layer) };
  }

  /**
   * Stop the capture and, if the domain kept the take, file its audio under the session id.
   *
   * Async because the worklet flushes its last partial chunk before reporting done, and waiting
   * for that is what stops the tail of a take being dropped. Nothing on screen waits for it —
   * the pass count, the badge and the lanes are all decided by `recordSession`, which has
   * already run against the engine's frame count.
   */
  async function commitCapture(row: Row, session: RecordingSession, keep: boolean) {
    const captured = await opts.engine.stopCapture();
    if (captured && keep) {
      opts.takes.put(session, captured.buffer);
      // Peaks are written back onto the session the domain already committed. They are display
      // only — no pass, region or size derives from them — so filling them late is safe, and it
      // is the only order available, since the buffer arrives after the worklet flushes.
      const peaks = computePeaks(captured.buffer);
      row.layer = {
        ...row.layer,
        sessions: row.layer.sessions.map((s) =>
          s.id === session.id ? { ...s, waveformPeaks: peaks } : s,
        ),
      };
      opts.onChange(row.layer);
      paintRow(row);
      buildLanes();
    }
    paintInputState();
    opts.engine.setLayers(liveProject(), opts.takes);
  }

  /**
   * Say so when the microphone is unavailable, rather than recording silence in silence.
   *
   * The first version of capture returned a bare `false` that nothing read, so a browser which
   * refused the input produced a take with no audio and no explanation — which is exactly the
   * failure that got reported. The error text is shown verbatim, because the difference between
   * a denied permission, an insecure origin and no device is the whole of what a user needs.
   */
  function paintInputState() {
    const error = opts.engine.inputError();
    inputNote.textContent = error ? `No audio input — ${error}. Takes will be silent.` : '';
    inputNote.style.display = error ? '' : 'none';
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
      label,
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
        syncLayers();
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
        syncLayers();
      }, (p) => eqIconSvg(p.id as EqPresetId, PRESET_ICON_PX)),
    );
    inner.appendChild(
      presetGroup('Pan', PAN_PRESETS, () => row.layer.pan, (id) => {
        row.layer = { ...row.layer, pan: id as PanPresetId };
        opts.onChange(row.layer);
        syncLayers();
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
      syncLayers();
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
      syncLabelWidth(); // a shorter name is width the lanes can have back
    });
    node.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text') ?? '';
      const room = NAME_CHARACTER_LIMIT - (node.textContent ?? '').length;
      document.execCommand('insertText', false, text.replace(/\s+/g, ' ').slice(0, Math.max(0, room)));
    });
  }

  // ------------------------------------------------------------------- lanes --
  /**
   * The lane is an overview of the **arrangement**, not of the last take — so a slot draws the
   * material its `BarRef` points at. Height indexes on the source, colour on the layer: on this
   * screen colour is layer identity (§4.4), and the source ramp is the Edit Layer grid's job.
   *
   * In recorded order `src * linesPerSlot + lineInSlot` comes back to the global line index, so
   * an unedited layer draws what it drew when the lane keyed on nothing and a slot pulled from
   * another pass is the only thing that changes. Exactly, when the lines divide evenly into
   * bars; within a line at the far end when they do not, which a synthetic peak can absorb.
   */
  function buildLanes() {
    const bars = project.barCount;
    const linesPerSlot = Math.max(1, Math.round(lineCount / bars));
    for (const row of rows) {
      if (!layerHasRecording(row.layer)) continue;
      const [from, to] = ramp.slice(row.layer.index, LAYER_COUNT);
      // Resolved once per row, not once per line: `layerPassIndex` walks every session.
      const index = layerPassIndex(row.layer, t);
      row.wave.build(lineCount, (i, u) => {
        const slot = Math.min(bars - 1, Math.floor((i * bars) / lineCount));
        const ref = row.layer.barSources[slot];
        const silent = isSilentAt(row.layer.mutedSlots, slot, false) || !ref;
        const src = ref ? toAbsolute(ref, bars) : 0;
        // `ceil`, not `floor`: this has to invert the `slot` above, and the first line of slot
        // s is the first i with `floor(i * bars / lineCount) === s`. Flooring picks a line one
        // slot earlier whenever the division is not exact, which offsets the material.
        const lineInSlot = i - Math.ceil((slot * lineCount) / bars);
        // Real peaks when the take is behind this bar, and the synthetic generator only when
        // there is no audio at all — the demo projects, whose sessions hold frame counts and
        // nothing else. Drawing those flat would make the Library look broken rather than
        // simulated; drawing a *recorded* bar from a generator is the lie this replaced.
        const level =
          (ref && barAmplitude(row.layer, index, ref, lineInSlot, linesPerSlot)) ??
          amp(row.layer.index, src, lineInSlot, linesPerSlot);
        return {
          height: silent ? 2 : motion.snapEven(level * LANE_AMPLITUDE, 2),
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
    const peak = opts.engine.inputPeak();
    while (row.live.length < upto && row.live.length < lineCount) {
      const i = row.live.length;
      const u = lineCount > 1 ? i / (lineCount - 1) : 0;
      // `is-live` is what keeps the layer's existing lane hidden underneath: while armed or
      // recording every line without it is display:none, so a layer with audio behaves like an
      // empty one for the length of the take.
      const line = el('div', 'lr-wave__line is-live');
      const level = peak;
      line.style.height = `${motion.snapEven(level * LANE_AMPLITUDE, 2)}px`;
      line.style.color = `rgb(${ramp.rgb(from + (to - from) * u)})`;
      row.wave.insertBefore(line, row.note);
      row.live.push(line);
    }
  }

  /**
   * The label column is fixed width so every lane starts at the same x — a ragged left edge
   * across seven rows is worse than the space it costs. But it was fixed at a width chosen for
   * the longest name a layer *could* have, not the longest one present, so eight layers named
   * "Bass" left a column of nothing between the name and the lane.
   *
   * Measure what the names actually need, take the widest, and give the rest to the lanes. The
   * clamp at the top keeps one long name from spending every lane's width; past it, names
   * ellipsize as before. Changing this changes the lane width, so the lane's `ResizeObserver`
   * re-runs `syncSizing` on its own — nothing needs to call both.
   *
   * The pass badge takes the name's place while armed and recording, so the column has to hold
   * whichever of the two is wider. It used to go auto-width for those states, which moved the
   * lane sideways on the one row you were watching most closely.
   */
  function syncLabelWidth() {
    let widest = LABEL_MIN_PX;
    root.classList.add('is-measuring');
    for (const row of rows) {
      widest = Math.max(widest, row.label.getBoundingClientRect().width + LABEL_PAINT_SLACK_PX);
    }
    root.classList.add('is-measuring-badge');
    for (const row of rows) widest = Math.max(widest, row.label.getBoundingClientRect().width);
    root.classList.remove('is-measuring', 'is-measuring-badge');
    root.style.setProperty('--layer-label-w', `${Math.min(LABEL_MAX_PX, Math.ceil(widest))}px`);
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

  /**
   * Escape unwinds one level at a time, innermost first.
   *
   * Disarming keeps it (§3.5), and **a pass in progress owns the input** — Escape cannot stop a
   * recording and must not leave the screen out from under one. With neither in the way it is
   * the keyboard's version of the Projects button.
   */
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const armed = rows.findIndex((r) => r.rec === 'armed');
    if (armed >= 0) {
      setRec(armed, 'unarmed');
      return;
    }
    if (capturingIndex() >= 0) return;
    opts.onBack();
  };
  document.addEventListener('keydown', onKey);

  const help = helpControl({
    title: 'Playback',
    content: () => [
      'tap the name to rename · row for its mixer · speaker to mute · dot to arm, again to record, hold to cancel',
    ],
  });

  // Up to the Library, which is the app's entry point (§4.1) and the only place this screen was
  // reached from. Secondary, because leaving is not the thing the screen is for.
  const backBtn = el(
    'button',
    'lr-btn back-btn',
    // The Library's chevron, mirrored — same 24-unit box, same 2px stroke, same 14px. A text
    // "‹" is a different weight at every font size and sits on the baseline rather than centred.
    '<svg class="chev" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>Projects',
  );
  backBtn.addEventListener('click', () => opts.onBack());

  const exportBtn = el('button', 'lr-btn lr-btn--primary', 'Export');
  exportBtn.addEventListener('click', () => opts.onExport());

  // Three items in a `space-between` footer: help at the left edge, then the two actions, with
  // the pair kept together by an auto margin rather than spread across the width.
  backBtn.style.marginLeft = 'auto';
  const footer = el('div', 'lr-footer');
  footer.append(help.node, backBtn, exportBtn);

  root.append(
    header,
    el('div', 'lr-section-label', 'Backing Tracks'),
    backingEl,
    el('div', 'lr-section-label', 'Layers'),
    layersEl,
    footer,
  );
  (root.children[3] as HTMLElement).style.marginTop = '10px';

  paintTitle();
  let observer: ResizeObserver | undefined;
  requestAnimationFrame(() => {
    if (!alive) return;
    syncLabelWidth();
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
      help.destroy();
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
    // **No `stopPropagation` here.** `bindChips` moves `is-active` by delegating on the enclosing
    // `.lr-chips`, so stopping the event at the chip meant the selection never moved — the preset
    // changed and the highlight stayed where it was. It was guarding nothing either: the only
    // click listener above this is on the row *head*, and these chips are in the panel, which is
    // the head's sibling rather than its ancestor.
    chip.addEventListener('click', () => {
      name.textContent = preset.name;
      onPick(preset.id);
    });
    chips.appendChild(chip);
  }
  name.textContent = presets.find((p) => p.id === current())?.name ?? '';

  group.append(head, chips);
  return group;
}
