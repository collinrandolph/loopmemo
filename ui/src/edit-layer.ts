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
import { loopFrames } from '../../src/domain/timing.ts';
import { type Rgb, type WaveNode, LR, clamp01, el, motion, ramp, sizing } from './kit.ts';
import { type Engine, amp, simSession } from './sim.ts';

const BARS_PER_ROW = 4;
const LINES_PER_BAR = 16;

const TILE_TALL = 120; // the mockup's tile, and the height nothing grows past
/**
 * Below this a tile stops being readable, so the grid scrolls instead of shrinking further.
 * Reached only on a short viewport — 32 bars at 375×812 lands around 81.
 */
const TILE_SHORT = 72;

/**
 * What the tile spends on things that are **not** the waveform: the `P# / #` label and the swipe
 * hint, both of which are type at a fixed size and do not shrink with the tile.
 *
 * The waveform gets what is left, rather than a fixed fraction of the tile. A ratio works at 120
 * — 60% is the mockup's 72 — and fails as soon as the tile shrinks, because 60% of 73 is 44 and
 * the two fixed 40-odd pixels of chrome then have nowhere to go: the hint lands on top of the
 * waveform. Subtracting is the same answer at 120 and the right one everywhere else.
 */
const TILE_CHROME = 48;
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
 * The gestures, the three animation accumulators and the render pass follow
 * `docs/mockups/edit-layer-mockup.html`, which is the reference. What differs is only where
 * the *rules* come from: `stepPassAt` / `stepBarAt` for the axes, `canSwipeSlot` for the mute
 * lock, and `playheadAt` / `passedAt` for the transport — all `src/domain`, so the screen and
 * the tests cannot disagree about them.
 *
 * The mockup wraps the pass axis blindly through a pass count. Ours wraps through the passes
 * that actually exist for that bar, so a gap in the available set is skipped (§1.4) — visible
 * on bars 9–16 of the demo layer, which have no pass 3.
 */
export function editLayerScreen(opts: {
  project: Project;
  layerIndex: number;
  engine: Engine;
  /** Size tiles to the viewport instead of letting the grid scroll. See `syncTileHeight`. */
  fitGrid: boolean;
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
  let peakHeight = (TILE_TALL - TILE_CHROME) * PEAK_RATIO;

  const spent = ramp.tokenRGB('--lr-spent');
  const spentSel = ramp.tokenRGB('--lr-spent-sel');
  const tiles: Tile[] = [];

  // ------------------------------------------------------------------ chrome --
  const root = el('div', 'lr-screen');
  const header = el('div', 'lr-header');
  // Same shape as the Playback header: name and the level control on one line, the running
  // count on its own beneath. Tempo and bar count are project settings and belong to the
  // project's header, not to a screen that edits one layer inside it.
  const titleRow = el('div', 'lr-title-row');
  const statsRow = el('div', 'lr-meta lr-stats');
  const controls = el('div', 'header-controls');
  header.append(titleRow, statsRow);

  const grid = el('div', 'grid');
  const rowsEl = el('div');
  grid.append(rowsEl);

  // Kept as a live node rather than markup: `refresh` repaints it and rebuilds its swatch, so it
  // stays current whether or not the sheet is open. §4.7 calls reading the gradient the manual's
  // highest-value entry, which is why it belongs here rather than under the grid.
  const legend = el('div', 'legend');
  const help = helpControl({
    title: 'Edit Layer',
    content: () => [
      'tap · repeat bar (tap again to stop) &nbsp; double tap · play loop from here' +
        ' &nbsp; hold · mute / unmute &nbsp; swipe · change pass / bar' +
        ' <span style="color:rgba(255,255,255,.4)">(locked while muted)</span>',
      legend,
    ],
  });

  /**
   * Compress and Clear, deliberately awkward to reach (§4.3).
   *
   * Both are irreversible and both live only here, on the screen for the one layer they act on —
   * putting them on Playback would make discarding a take a mis-tap away from arming one. The
   * friction is three deliberate steps: open the drawer, choose, then confirm a sentence that
   * states the outcome in passes and megabytes (§4.1's rule for destructive actions).
   *
   * They are also the only two actions in the app that can leave a screen with nothing to show,
   * so clearing returns to Playback rather than sitting on an empty grid.
   */
  const drawer = el('div', 'layer-ops');
  const opsBtn = el('button', 'lr-btn', 'Layer…');
  opsBtn.addEventListener('click', () => {
    const open = root.classList.toggle('is-ops-open');
    if (!open) drawer.classList.remove('is-confirming');
    else paintOps();
  });

  function askOps(text: string, label: string, run: () => void) {
    drawer.innerHTML =
      `<div class="confirm-text">${text}</div>` +
      `<button class="lr-btn lr-btn--danger" data-yes>${label}</button>` +
      '<button class="lr-btn" data-no>Cancel</button>';
    drawer.classList.add('is-confirming');
    drawer.querySelector('[data-yes]')!.addEventListener('click', run);
    drawer.querySelector('[data-no]')!.addEventListener('click', paintOps);
  }

  function paintOps() {
    drawer.classList.remove('is-confirming');
    const saving = layerCompressionSaving(layer, project);
    const name = layer.name || `Layer ${layer.index + 1}`;
    drawer.innerHTML = '';

    const compressBtn = el('button', 'lr-btn', 'Compress layer') as HTMLButtonElement;
    compressBtn.disabled = saving.discarded === 0;
    compressBtn.addEventListener('click', () => {
      if (!layerCompressionPlan(layer, t)) {
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
          `discarded, <b>${mb(saving.bytes)}</b> freed. The edited loop becomes Pass 1 and stays ` +
          'editable; the other layers are untouched.',
        'Compress',
        () => {
          layer = compressedLayer(layer, simSession(`${layer.id}-c`, loopFrames(t)), barCount);
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
  });
  controls.append(volume, slider);

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
      node.append(label, wave, el('div', 'swipe-hint', '<span>↕ pass</span><span>↔ bar</span>'));
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
    tile.label.innerHTML =
      `<span class="pass">P${ref.pass}</span><span class="rel">${ref.relativeBar}</span>`;
    tile.node.title = `slot ${slot + 1} · pass ${ref.pass}, bar ${ref.relativeBar} · available: ${passes.join(', ') || 'none'}`;

    // Colour indexes per LINE across the whole recording, so any length gets one continuous,
    // non-repeating ramp — and a slot pulled from elsewhere lands visibly off the run.
    const src = toAbsolute(ref, barCount) - 1;
    const totalLines = recordedBars() * LINES_PER_BAR;
    tile.wave.build(LINES_PER_BAR, (i) => ({
      height: motion.snapEven(amp(layer.index, src, i, LINES_PER_BAR) * peakHeight, lineWidth),
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
  }

  /**
   * The two swipe axes, the hold, and the tap. Press state and the release edges belong to
   * `trackDrag` — including the reason it is not `hasPointerCapture`, which is written up there
   * because this file and the chord wheel both used to answer it separately.
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
      // completed, so bar mode becomes loop mode without playback pausing (§3.7).
      transport = escalate(transport, frameNow(), t);
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
      if (!opts.engine.running()) opts.engine.start(0);
      transport = playBar(slot, frameNow());
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
  // `LR.loop` cannot be cancelled, and this screen is rebuilt on every navigation — without a
  // stop, each visit leaves a render pass running forever over detached nodes.
  let alive = true;
  function loop(fn: (dt: number) => void) {
    let last = performance.now();
    const step = (now: number) => {
      if (!alive) return;
      const dt = Math.min(now - last, 50); // clamp after a backgrounded tab
      last = now;
      fn(dt);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  loop((dt) => {
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
   * `.tile` sets `touch-action: none`, which it must — that is what stops the browser eating a
   * vertical drag before it can step the pass axis (§3.7). The consequence is that a grid taller
   * than the viewport cannot be scrolled by dragging it, because every drag is already a gesture.
   * At 375×812 five rows fit, so 4 through 20 bars are fine and 24, 28 and 32 are not.
   *
   * Sizing the tile to the space available removes the conflict instead of arbitrating it, and
   * keeps the whole arrangement on screen — which is what the colour signature is *for*: §4.7
   * calls reading the gradient the manual's highest-value entry, and a gradient you have to
   * scroll through is not one you can read.
   *
   * Below `TILE_SHORT` it gives up and lets the page scroll, which is the honest fallback on a
   * landscape phone. Above `TILE_TALL` it stops growing, so a desktop window does not produce a
   * grid of enormous tiles.
   */
  function syncTileHeight() {
    const rows = Math.ceil(barCount / BARS_PER_ROW);
    let height = TILE_TALL;

    if (opts.fitGrid) {
      const box = grid.getBoundingClientRect();
      const style = getComputedStyle(grid);
      const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      // Document-relative, so the measurement does not change with how far the page is scrolled.
      const top = box.top + window.scrollY;
      const available =
        window.innerHeight - top - footer.getBoundingClientRect().height - padding;
      const perRow = Math.floor((available - (rows - 1) * SEAM) / rows);
      height = Math.min(TILE_TALL, Math.max(TILE_SHORT, perRow));
    }

    apply(height);

    // Then correct against the result rather than trusting the model. Predicting the height of
    // everything around the grid means knowing about the drawer, the footer's border, the shell
    // above it and whatever comes next — miss any of them and the grid overflows by a little,
    // which is exactly the state this exists to prevent. Measuring what actually happened costs
    // one reflow and cannot be wrong about it.
    for (let pass = 0; pass < 3 && opts.fitGrid; pass++) {
      const over = document.documentElement.scrollHeight - window.innerHeight;
      if (over <= 0 || tileHeight <= TILE_SHORT) break;
      apply(Math.max(TILE_SHORT, tileHeight - Math.ceil(over / rows)));
    }
  }

  function apply(height: number) {
    if (height === tileHeight) return;
    tileHeight = height;
    // Even, so the waveform's centreline still lands on a whole pixel (§3.3).
    const wave = motion.snapEven(Math.max(WAVE_MIN, height - TILE_CHROME), 2);
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
    // Rebuilt rather than patched, so `controls` has to be re-appended each time — it lives in
    // this row now and `innerHTML` would drop it.
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
  requestAnimationFrame(() => {
    if (!alive) return;
    // `refresh` first: it fills the header, and until it does the header is 28px rather than 72.
    // Measuring the grid's available height against an empty header hands it 44 phantom pixels,
    // which is a whole row's worth of tile at 32 bars — the grid then overflows the screen the
    // fit is meant to prevent.
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
      alive = false;
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      document.removeEventListener('keydown', onKey);
      help.destroy();
      opts.engine.stop();
    },
  };
}

function mb(bytes: number): string {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}
