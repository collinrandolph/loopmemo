import {
  canSwipeSlot,
  isSlotMuted,
  stepBarAt,
  stepPassAt,
  toggleSlotMute,
} from '../../src/domain/arrangement.ts';
import { toAbsolute } from '../../src/domain/bar-ref.ts';
import { availablePasses, totalPasses } from '../../src/domain/pass-index.ts';
import {
  type Layer,
  type Project,
  clearLayer,
  compressedLayer,
  layerCompressionPlan,
  layerCompressionSaving,
  layerPassIndex,
  projectTiming,
} from '../../src/domain/project.ts';
import {
  IDLE,
  type Playhead,
  type Transport,
  escalate,
  isPlayed,
  passedAt,
  playBar,
  playheadAt,
  stop,
} from '../../src/domain/transport.ts';
import { SWIPE_THRESHOLD } from './controls.ts';
import { trackDrag } from './gesture.ts';
import { helpControl } from './help.ts';
import type { BackingEngine } from './audio.ts';
import { type Rgb, type WaveNode, LR, clamp01, el, motion, ramp, sizing } from './kit.ts';
import { amp } from './demo.ts';
import { compressedTake } from './compress.ts';
import { type TakeStore, newTakeId } from './takes.ts';
import { barAmplitude } from './peaks.ts';
import { confirmPanel, formatBytes, renderLoop } from './screen.ts';

const BARS_PER_ROW = 4;
const LINES_PER_BAR = 16;

const TILE_TALL = 120; // the mockup's tile, and the height nothing grows past
/**
 * Below this a tile stops being readable and the grid scrolls instead of shrinking further.
 * Scrolling is the state with the gesture conflict, so this floor decides whether that conflict
 * is reachable at all — set it too high and it *causes* the fallback it exists to prevent.
 */
const TILE_SHORT = 50;

/**
 * What the tile spends on things that are **not** the waveform. Type does not shrink with the
 * tile, so this is subtracted rather than taken as a fraction. Two values because a short tile
 * drops the hint strip and folds the axis arrows into the label (`.is-compact-tiles`).
 */
const TILE_CHROME_TALL = 48; // label + hint strip
const TILE_CHROME_COMPACT = 28; // label alone, arrows folded in

/**
 * Where the hint strip stops fitting. Derived, not picked: label + waveform + hint fits while
 * `WAVE_RATIO * h + 40 ≤ h`, which is 100 and above.
 */
const TILE_HINT_MIN = 100;

/**
 * The waveform is the smaller of "what is left after the chrome" and this fraction of the tile.
 * Both halves are needed: subtracting alone lets the waveform **grow as the tile shrinks**, at the
 * step where the chrome goes compact; a fraction alone runs it under the label at the short end.
 */
const WAVE_RATIO = 0.6;
/** Peaks fill two thirds of the waveform box, which is the mockup's 48 in its 72. */
const PEAK_RATIO = 2 / 3;
const WAVE_MIN = 16;
const SEAM = 2;
const HOLD_MS = 500;
const HOLD_SLOP = 8;
const DOUBLE_TAP_MS = 300;

type Tile = {
  node: HTMLElement;
  label: HTMLElement;
  wave: WaveNode;
  swiping: boolean;
  /** Contraction while a swipe is active; 1 at rest (§3.4). */
  swipeA: number;
  /** Collapse toward the dot floor while muted. */
  muteA: number;
  /** Release: held at 1 when a bar or cycle ends, then decays over TAU.reset. */
  resetA: number;
};

/**
 * Edit Layer (§3.4, §3.6, §3.7).
 *
 * Gestures, the three animation accumulators and the render pass follow
 * `docs/mockups/edit-layer-mockup.html`. The *rules* come from `src/domain` instead —
 * `stepPassAt` / `stepBarAt` for the axes, `canSwipeSlot` for the mute lock, `playheadAt` /
 * `passedAt` for the transport — so the screen and the tests cannot disagree.
 *
 * The pass axis wraps through the passes that actually exist for that bar, so a gap in the
 * available set is skipped (§1.4), which the mockup's blind pass count cannot express.
 */
export function editLayerScreen(opts: {
  project: Project;
  layerIndex: number;
  // `BackingEngine`, not the bare `Engine`: the backing has to be told which traversal is
  // playing, or a one-bar preview walks the chord progression while the sweep holds one slot.
  engine: BackingEngine;
  /** Where captured audio lives; the engine needs it to play what this screen edits. */
  takes: TakeStore;
  onChange(layer: Layer): void;
  onDone(): void;
}): { node: HTMLElement; destroy(): void } {
  const project = opts.project;
  const t = projectTiming(project);
  const barCount = project.barCount;

  let layer = project.layers[opts.layerIndex]!;
  let transport: Transport = IDLE;
  let selected = -1;
  let lineWidth = 3;
  let lastPhase = 0;
  let tileHeight = TILE_TALL;
  let peakHeight = (TILE_TALL - TILE_CHROME_TALL) * PEAK_RATIO;

  const spent = ramp.tokenRGB('--lr-spent');
  const spentSel = ramp.tokenRGB('--lr-spent-sel');
  const tiles: Tile[] = [];

  // ------------------------------------------------------------------ chrome --
  const root = el('div', 'lr-screen');
  const header = el('div', 'lr-header');
  // Same shape as the Playback header. Tempo and bar count are project settings and belong to
  // the project's header, not to a screen that edits one layer inside it.
  const titleRow = el('div', 'lr-title-row');
  const statsRow = el('div', 'lr-meta lr-stats');
  const controls = el('div', 'header-controls');
  header.append(titleRow, statsRow);

  const grid = el('div', 'grid');
  const rowsEl = el('div');
  grid.append(rowsEl);

  // A live node, not markup: `refresh` repaints it and rebuilds its swatch. §4.7 calls reading
  // the gradient the manual's highest-value entry, which is why it lives in the help sheet.
  const legend = el('div', 'legend');
  const help = helpControl({
    title: 'Edit Layer',
    pages: [
      {
        label: 'Edit Layer',
        content: () => [
          'tap · repeat bar (tap again to stop) &nbsp; double tap · play loop from here' +
            ' &nbsp; hold · mute / unmute &nbsp; swipe · change pass / bar' +
            ' <span style="color:rgba(255,255,255,.4)">(locked while muted)</span>',
          legend,
        ],
      },
    ],
  });

  /**
   * Compress and Clear, deliberately awkward to reach (§4.3): open the drawer, choose, then
   * confirm a sentence stating the outcome in passes and megabytes (§4.1). Both are irreversible,
   * and on Playback discarding a take would be a mis-tap away from arming one.
   *
   * Clearing returns to Playback rather than sitting on an empty grid.
   */
  const drawer = el('div', 'layer-ops');
  const opsBtn = el('button', 'lr-btn', 'Layer…');
  opsBtn.addEventListener('click', () => {
    const open = root.classList.toggle('is-ops-open');
    if (!open) drawer.classList.remove('is-confirming');
    else paintOps();
  });

  // The drawer is both the host and the box: the two actions are replaced by the question, and
  // Cancel redraws them.
  const confirm = confirmPanel(drawer, drawer, paintOps);
  const askOps = (text: string, label: string, run: () => void) => confirm(text, label, true, run);

  function paintOps() {
    drawer.classList.remove('is-confirming');
    const saving = layerCompressionSaving(layer, project);
    const name = layer.name || `Layer ${layer.index + 1}`;
    drawer.innerHTML = '';

    const compressBtn = el('button', 'lr-btn', 'Compress layer') as HTMLButtonElement;
    compressBtn.disabled = saving.discarded === 0;
    compressBtn.addEventListener('click', () => {
      const bars = layerCompressionPlan(layer, t);
      if (!bars) {
        askOps(
          `<b>${name}</b> has a bar pointing at audio that is no longer there. Fix that bar ` +
            'before compressing, or the gap is baked into the only copy left.',
          'Close',
          paintOps,
        );
        return;
      }
      askOps(
        `Compress <b>${name}</b>? ${saving.discarded} unused pass${saving.discarded === 1 ? '' : 'es'} ` +
          `discarded, <b>${formatBytes(saving.bytes)}</b> freed. The edited loop becomes Pass 1 and stays ` +
          'editable; the other layers are untouched.',
        'Compress',
        () => {
          // Written before the layer is changed. Compress keeps only what it writes, so a layer
          // whose audio is not in this session must be refused rather than compressed to silence.
          const session = compressedTake(layer, bars, opts.takes, t.sampleRate, newTakeId(`${layer.id}-c`));
          if (!session) {
            askOps(
              `<b>${name}</b> cannot be compressed here: its audio is not in this session. The ` +
                'browser build keeps takes in memory only, so a reload loses them.',
              'Close',
              paintOps,
            );
            return;
          }
          layer = compressedLayer(layer, session, barCount);
          opts.onChange(layer);
          root.classList.remove('is-ops-open');
          redrawAll();
          refresh();
        },
      );
    });

    const clearBtn = el('button', 'lr-btn lr-btn--danger', 'Clear layer');
    clearBtn.addEventListener('click', () => {
      const passes = totalPasses(index());
      askOps(
        `Clear <b>${name}</b>? All ${passes} recorded pass${passes === 1 ? '' : 'es'} and this ` +
          'arrangement go with it. The layer is left empty and ready to record. This cannot be undone.',
        'Clear',
        () => {
          opts.onChange(clearLayer(layer));
          opts.onDone(); // nothing left to edit
        },
      );
    });

    drawer.append(
      compressBtn,
      clearBtn,
      el(
        'div',
        'hint',
        saving.discarded === 0
          ? 'Already one pass — nothing to compress. Both actions are permanent.'
          : 'Both actions are permanent and affect only this layer.',
      ),
    );
  }

  const footer = el('div', 'lr-footer');
  const doneBtn = el('button', 'lr-btn lr-btn--primary', 'Done');
  doneBtn.addEventListener('click', opts.onDone);
  opsBtn.style.marginLeft = 'auto';
  footer.append(help.node, opsBtn, doneBtn);
  root.append(header, grid, drawer, footer);

  const volume = LR.VolumeControl({
    large: true,
    level: () => layer.level * 100,
    muted: () => layer.muted,
    onToggle() {
      layer = { ...layer, muted: !layer.muted };
      opts.onChange(layer);
      syncLayers();
      volume.update();
    },
  });
  const slider = el('input') as HTMLInputElement;
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = String(Math.round(layer.level * 100));
  slider.addEventListener('input', () => {
    layer = { ...layer, level: Number(slider.value) / 100 };
    volume.update();
    opts.onChange(layer);
    syncLayers();
  });
  controls.append(volume, slider);

  /**
   * Push this screen's edit at the engine, which holds a snapshot and re-reads nothing on its
   * own. Without it a swipe redraws the tile while playback keeps scheduling the old arrangement
   * — the drawing and the audio disagreeing about one edit (§1.1) — and §2.4 calls applying an
   * edit to *playing* audio core functionality, so it has to land now.
   */
  function syncLayers() {
    opts.engine.setLayers(
      { ...project, layers: project.layers.map((l) => (l.index === layer.index ? layer : l)) },
      opts.takes,
    );
  }

  function index() {
    return layerPassIndex(layer, t);
  }
  function recordedBars() {
    return Math.max(barCount, totalPasses(index()) * barCount);
  }

  // ------------------------------------------------------------------- build --
  for (let row = 0; row * BARS_PER_ROW < barCount; row++) {
    const rowEl = el('div', 'bar-row');
    for (let c = 0; c < BARS_PER_ROW && row * BARS_PER_ROW + c < barCount; c++) {
      const slot = row * BARS_PER_ROW + c;
      const node = el('div', 'tile');
      const label = el('div', 'tile-label');
      const wave = LR.Waveform({});
      node.append(
        label,
        wave,
        el('div', 'swipe-hint', '<span class="hint-pass">↕ pass</span><span>↔ bar</span>'),
      );
      rowEl.appendChild(node);
      attachGestures(node, slot);
      tiles.push({ node, label, wave, swiping: false, swipeA: 1, muteA: 0, resetA: 0 });
    }
    rowsEl.appendChild(rowEl);
  }

  /** Rebuild a tile's lines. Called when its *source* changes, never during playback. */
  function redraw(slot: number) {
    const tile = tiles[slot]!;
    const ref = layer.barSources[slot];
    const muted = isSlotMuted(layer.mutedSlots, slot);
    tile.node.classList.toggle('is-muted', muted);

    if (!ref) {
      tile.label.innerHTML = '<span class="pass">—</span><span class="rel">·</span>';
      tile.wave.build(0, () => ({ height: 0, rgb: [0, 0, 0] }));
      return;
    }

    const passes = availablePasses(index(), ref.relativeBar);
    // Each axis arrow to the left of the label it steps: `↕` ahead of the pass, `↔` ahead of the
    // bar. CSS shows them only on a tile too short to carry the separate hint strip.
    tile.label.innerHTML =
      `<span class="pass"><i class="ax">↕</i>P${ref.pass}</span>` +
      `<span class="rel"><i class="ax">↔</i>${ref.relativeBar}</span>`;
    // **A tile with one available pass hides its vertical hint** — the axis works, it simply has
    // nowhere to go, and an affordance for a gesture that cannot change anything is a promise the
    // user has no way to cash. Per *bar*, not per layer: a partial pass leaves early bars with two
    // and late ones with one (§1.4), so neighbouring tiles legitimately differ.
    //
    // Deliberately not extended to a muted tile, whose swipe is also locked. That lock is one hold
    // away from being released and the help sheet says so, whereas a second pass can only come
    // from recording one.
    tile.node.classList.toggle('is-single-pass', passes.length <= 1);
    tile.node.title = `slot ${slot + 1} · pass ${ref.pass}, bar ${ref.relativeBar} · available: ${passes.join(', ') || 'none'}`;

    // Colour indexes per LINE across the whole recording: one continuous non-repeating ramp at
    // any length, so a slot pulled from elsewhere lands visibly off the run.
    const src = toAbsolute(ref, barCount) - 1;
    const totalLines = recordedBars() * LINES_PER_BAR;
    // Real peaks where the take exists, `amp` only where it does not. A tile must draw the audio
    // its `BarRef` points at — this is the screen the two indices are *for*.
    const passes_ = index(); // the screen's own resolver, so the peaks agree with the axis
    tile.wave.build(LINES_PER_BAR, (i) => ({
      height: motion.snapEven(
        (barAmplitude(layer, passes_, ref, i, LINES_PER_BAR) ??
          amp(layer.index, src, i, LINES_PER_BAR)) * peakHeight,
        lineWidth,
      ),
      rgb: ramp.rgb((src * LINES_PER_BAR + i) / (totalLines - 1)),
    }));
  }

  function redrawAll() {
    for (let slot = 0; slot < barCount; slot++) redraw(slot);
  }

  // ---------------------------------------------------------------- gestures --
  function step(slot: number, axis: 'pass' | 'bar', dir: number) {
    const next =
      axis === 'pass'
        ? stepPassAt(layer.barSources, slot, dir, index(), layer.mutedSlots)
        : stepBarAt(layer.barSources, slot, dir, barCount, layer.mutedSlots);
    if (next === layer.barSources) return;
    layer = { ...layer, barSources: next };
    redraw(slot);
    opts.onChange(layer);
    syncLayers();
  }

  /**
   * The two swipe axes, the hold, and the tap. Press state and the release edges belong to
   * `trackDrag`, including the reason it is not `hasPointerCapture`.
   */
  function attachGestures(node: HTMLElement, slot: number) {
    let axis: 'pass' | 'bar' | null = null;
    let holdTimer: number | null = null;

    function clearHold() {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
    }

    trackDrag(node, {
      onStart(_e, drag) {
        axis = null;
        holdTimer = window.setTimeout(() => {
          drag.consume(); // a hold that fired is not also a tap
          layer = { ...layer, mutedSlots: toggleSlotMute(layer.mutedSlots, slot) };
          redraw(slot);
          opts.onChange(layer);
          syncLayers();
        }, HOLD_MS);
      },

      onMove(_e, drag) {
        const { dx, dy } = drag;

        // A hold requires stillness, so hold and swipe can never both fire.
        if (holdTimer !== null && Math.max(Math.abs(dx), Math.abs(dy)) > HOLD_SLOP) clearHold();
        // The lock is domain code (§3.7) so the gesture cannot drift from any other route.
        if (!canSwipeSlot(layer.mutedSlots, slot)) return;

        if (!axis && Math.max(Math.abs(dx), Math.abs(dy)) > SWIPE_THRESHOLD) {
          axis = Math.abs(dx) > Math.abs(dy) ? 'bar' : 'pass';
          tiles[slot]!.swiping = true;
        }
        if (!axis) return;

        const travel = axis === 'bar' ? dx : dy;
        if (Math.abs(travel) <= SWIPE_THRESHOLD) return;
        // Both axes are inverted relative to travel, and it is the same rule on each: the
        // material moves under the finger, so the next one is pulled in from the side you are
        // dragging toward. Dragging LEFT pulls the next bar in from the right (§3.7, which
        // states this axis); dragging UP pulls the next pass in from below. §3.7 leaves the
        // vertical direction unspecified — this is the filmstrip applied to it.
        step(slot, axis, travel > 0 ? -1 : 1);
        drag.rebase(); // allow repeats within one drag
        drag.consume();
      },

      onTap: () => tap(slot),

      onEnd() {
        tiles[slot]!.swiping = false;
        clearHold();
        axis = null;
      },
    });
  }

  // --------------------------------------------------------------- transport --
  function frameNow() {
    return opts.engine.running() ? opts.engine.frame() : 0;
  }

  function select(slot: number) {
    for (const tile of tiles) tile.node.classList.remove('is-selected');
    if (slot >= 0) tiles[slot]!.node.classList.add('is-selected');
    selected = slot;
  }

  /**
   * Release only what played. Releasing everything makes untouched bars flash; releasing
   * nothing leaves played bars stuck spent.
   */
  function releasePlayed(head: Playhead | undefined) {
    for (let slot = 0; slot < barCount; slot++) {
      if (isPlayed(head, slot)) tiles[slot]!.resetA = 1;
    }
  }

  let lastTapSlot = -1;
  let lastTapTime = 0;

  function tap(slot: number) {
    const now = performance.now();
    const isDouble = slot === lastTapSlot && now - lastTapTime < DOUBLE_TAP_MS;
    const head = playheadAt(transport, frameNow(), t);

    if (isDouble) {
      // Escalate rather than restart: `escalate` rebases the anchor by the cycles already
      // completed, so bar mode becomes loop mode without playback pausing (§3.7). The rebase
      // lands on a bar boundary, so the engine's grid still holds and it only needs telling.
      transport = escalate(transport, frameNow(), t);
      opts.engine.setTransport(transport);
    } else if (transport.mode !== 'idle' && transport.origin === slot) {
      releasePlayed(head);
      transport = stop();
      opts.engine.stop();
      select(-1); // §3.6: selection is UI state and clears on stop
      lastTapSlot = -1;
      lastTapTime = 0;
      return;
    } else {
      releasePlayed(head);
      // **Re-anchored, even when already running.** The backing is generated on the engine's bar
      // grid and the sweep runs on the transport's, so the two have to be one grid — and they are
      // one grid only if the transport starts on a frame the engine calls a downbeat, and 0 says
      // so without arithmetic. It also absorbs the scheduling lead: frames before the anchor read
      // as negative and `playheadAt` floors them to phase 0, so the sweep waits for the audio.
      //
      // Transport first, then start: the engine schedules its first bars inside `start`, and
      // handing it the new traversal afterwards would only throw them away again.
      transport = playBar(slot, 0);
      opts.engine.setTransport(transport);
      opts.engine.start(0);
      lastPhase = 0;
      select(slot);
    }
    lastTapSlot = slot;
    lastTapTime = now;
  }

  // Arrow keys drive the same two axes, for keyboard and VoiceOver parity.
  let keyTimer: number | undefined;
  const onKey = (e: KeyboardEvent) => {
    const map: Record<string, ['pass' | 'bar', number]> = {
      // Up and Left are both forward, matching the swipe inversion on their axis.
      ArrowUp: ['pass', 1],
      ArrowDown: ['pass', -1],
      ArrowLeft: ['bar', 1],
      ArrowRight: ['bar', -1],
    };
    const move = map[e.key];
    if (!move || selected < 0 || !canSwipeSlot(layer.mutedSlots, selected)) return;
    e.preventDefault();
    tiles[selected]!.swiping = true;
    clearTimeout(keyTimer);
    keyTimer = window.setTimeout(() => {
      if (selected >= 0) tiles[selected]!.swiping = false;
    }, 140);
    step(selected, move[0], move[1]);
  };
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------ render --
  const frames = renderLoop((dt) => {
    const head = playheadAt(transport, frameNow(), t);

    // A bar ending snaps that slot to fully spent; a completed cycle releases the lot. The
    // edge is not redundant with the played set — it drives the 180 ms release, and no
    // played-set test can see it (§3.6).
    if (head) {
      const phase = Math.floor(head.phaseSlots);
      if (phase > lastPhase) {
        for (let k = lastPhase; k < phase; k++) {
          tiles[(head.origin + k) % barCount]!.resetA = 1;
        }
        if (phase >= head.cycleLength) {
          for (const tile of tiles) tile.resetA = 1;
          lastPhase = 0;
        } else {
          lastPhase = phase;
        }
      } else if (phase < lastPhase) {
        for (const tile of tiles) tile.resetA = 1;
        lastPhase = phase;
      }
    }

    for (let slot = 0; slot < barCount; slot++) {
      const tile = tiles[slot]!;
      const muted = isSlotMuted(layer.mutedSlots, slot);

      tile.swipeA = motion.approach(
        tile.swipeA,
        tile.swiping ? 0 : 1,
        tile.swiping ? motion.TAU.swipe! : motion.TAU.release!,
        dt,
      );
      tile.muteA = motion.approach(tile.muteA, muted ? 1 : 0, motion.TAU.mute!, dt);
      tile.resetA = tile.resetA > 0.001 ? motion.approach(tile.resetA, 0, motion.TAU.reset!, dt) : 0;

      const target: Rgb = tile.node.classList.contains('is-selected') ? spentSel : spent;
      const lines = tile.wave.lines();
      const scale = motion.swipeScale(tile.swipeA);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]! as HTMLElement & { _h: number; _rgb: Rgb };
        const passed = Math.max(passedAt(head, slot, i, LINES_PER_BAR), tile.resetA);

        if (tile.muteA > 0.002) {
          // Muting collapses to the dot floor via REAL HEIGHT. scaleY cannot get there: CSS
          // scales every border-radius corner by one shared factor, so squashing vertically
          // leaves square caps (§3.3). Colour still animates — the bar is silent on this
          // layer, but other layers sound through its slot.
          const live = line._h * motion.playScale(clamp01(passed)) * scale;
          const h = Math.max(lineWidth, Math.round(live + (lineWidth - live) * tile.muteA));
          line.style.height = `${h}px`;
          line.style.transform = 'scaleY(1)';
          const ct = clamp01(passed / motion.COLOR_FEATHER);
          line.style.color =
            ct === 0 ? `rgb(${line._rgb})` : ramp.toSpent(line._rgb, ct, target);
        } else {
          line.style.height = `${line._h}px`;
          tile.wave.paint(line, passed, scale, target, lineWidth);
        }
      }
    }
  });

  // ------------------------------------------------------------------ sizing --
  /**
   * **Fit the grid to the screen rather than scrolling it.**
   *
   * `.tile` sets `touch-action: none` so the browser cannot eat a vertical drag before it steps
   * the pass axis (§3.7) — which also means a grid taller than the viewport cannot be dragged to
   * scroll. Sizing the tile to the space available removes the conflict instead of arbitrating
   * it, and keeps the whole arrangement on screen, which is what the colour signature is for.
   *
   * Clamped to `TILE_TALL` so a desktop window does not produce enormous tiles, and floored at
   * `TILE_SHORT`, below which the page scrolls. **No phone reaches the floor**: swept at 375×812,
   * 375×667 and 320×568, every bar count fits.
   */
  function syncTileHeight() {
    const rows = Math.ceil(barCount / BARS_PER_ROW);
    const box = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    // Document-relative, so the measurement does not change with how far the page is scrolled.
    const top = box.top + window.scrollY;
    // `documentElement.clientHeight`, **not** `window.innerHeight`: the layout viewport is what
    // CSS lays out against, and the visual viewport differs whenever the browser is scaling or
    // the address bar is part-collapsed. Measured 1213 against 812 on the same screen.
    const available = viewportHeight() - top - footer.getBoundingClientRect().height - padding;
    const perRow = Math.floor((available - (rows - 1) * SEAM) / rows);

    apply(Math.min(TILE_TALL, Math.max(TILE_SHORT, perRow)));

    // Then correct against the result rather than trusting the model: predicting the height of
    // everything around the grid means knowing about the drawer, the footer's border and the
    // shell, and missing any of them overflows by a little. One reflow cannot be wrong.
    for (let pass = 0; pass < 3; pass++) {
      // How far past the fold the footer has been pushed — **not** `scrollHeight`, which is
      // stretched to the visual viewport regardless of content. The footer is the last thing in
      // the screen, so where it ends is where the content ends.
      const over = Math.round(footer.getBoundingClientRect().bottom + window.scrollY) - viewportHeight();
      if (over <= 0 || tileHeight <= TILE_SHORT) break;
      apply(Math.max(TILE_SHORT, tileHeight - Math.ceil(over / rows)));
    }
  }

  function apply(height: number) {
    if (height === tileHeight) return;
    tileHeight = height;
    const compact = height < TILE_HINT_MIN;
    root.classList.toggle('is-compact-tiles', compact);
    // Even, so the waveform's centreline still lands on a whole pixel (§3.3).
    const chrome = compact ? TILE_CHROME_COMPACT : TILE_CHROME_TALL;
    const wave = motion.snapEven(
      Math.max(WAVE_MIN, Math.min(height - chrome, height * WAVE_RATIO)),
      2,
    );
    peakHeight = wave * PEAK_RATIO;
    root.style.setProperty('--tile-h', `${height}px`);
    root.style.setProperty('--tile-wave-h', `${wave}px`);
    redrawAll();
  }

  function syncSizing() {
    const first = tiles[0]?.node;
    if (!first?.clientWidth) return;
    const fit = sizing.fitToCount(first.clientWidth, LINES_PER_BAR);
    if (fit.width === lineWidth) return;
    lineWidth = fit.width;
    sizing.apply(fit.width);
    redrawAll();
  }

  function refresh() {
    const passes = totalPasses(index());
    // Rebuilt, not patched, so `controls` is re-appended: it lives in this row and `innerHTML`
    // would drop it.
    titleRow.innerHTML = `<div class="lr-title">${layer.name || `Layer ${layer.index + 1}`}</div>`;
    titleRow.appendChild(controls);
    statsRow.textContent = `${passes} Pass${passes === 1 ? '' : 'es'}`;

    legend.innerHTML =
      '<strong>Colour encodes where in the recording each bar came from.</strong> ' +
      "The gradient's stop count is derived from the line count, so any song length gets one " +
      'continuous, non-repeating ramp.<div class="swatch"></div>' +
      'Pass and bar numbers give the bar’s position in the original recording, not its slot in ' +
      'the song. Smooth colour flow means bars are still in recorded order; a jump — and a ' +
      'number out of sequence — means that bar came from elsewhere.';
    const swatch = legend.querySelector('.swatch')!;
    for (let s = 0; s < 60; s++) {
      const i = el('i');
      i.style.background = ramp.css(s / 59);
      swatch.appendChild(i);
    }
    redrawAll();
  }

  // Height first: it changes the tile's width-independent geometry, and `syncSizing` measures
  // the tile to pick a line width. The other order fits lines to a box that is about to move.
  const onResize = () => {
    syncTileHeight();
    syncSizing();
  };
  window.addEventListener('resize', onResize);

  let observer: ResizeObserver | undefined;
  // Measuring needs the nodes on the page; the guard is for a screen destroyed before that.
  let mounted = true;
  requestAnimationFrame(() => {
    if (!mounted) return;
    // `refresh` first: it fills the header, and measuring against an empty one hands the grid 44
    // phantom pixels — a whole row of tile at 32 bars, so the grid overflows.
    refresh();
    syncTileHeight();
    syncSizing();
    volume.update();
    if (tiles[0]) {
      observer = new ResizeObserver(syncSizing);
      observer.observe(tiles[0].node);
    }
  });

  return {
    node: root,
    destroy() {
      mounted = false;
      frames.stop();
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      document.removeEventListener('keydown', onKey);
      help.destroy();
      opts.engine.stop();
    },
  };
}

/** The layout viewport — what CSS sizes against. See `syncTileHeight`. */
function viewportHeight(): number {
  return document.documentElement.clientHeight;
}
