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
import { type Rgb, type WaveNode, LR, clamp01, el, motion, ramp, sizing } from './kit.ts';
import { type Engine, amp } from './sim.ts';

const BARS_PER_ROW = 4;
const LINES_PER_BAR = 16;
const MAX_WAVE = 48; // 40% of the 120px tile
const SWIPE_THRESHOLD = 22;
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

  const spent = ramp.tokenRGB('--lr-spent');
  const spentSel = ramp.tokenRGB('--lr-spent-sel');
  const tiles: Tile[] = [];

  // ------------------------------------------------------------------ chrome --
  const root = el('div', 'lr-screen');
  const header = el('div', 'lr-header');
  const titleRow = el('div', 'lr-title-row');
  const controls = el('div', 'header-controls');
  header.append(titleRow, controls);

  const grid = el('div', 'grid');
  const gridTitle = el('div', 'grid-title');
  const rowsEl = el('div');
  const legend = el('div', 'legend');
  grid.append(gridTitle, rowsEl, legend);

  const footer = el('div', 'lr-footer');
  const doneBtn = el('button', 'lr-btn lr-btn--primary', 'Done');
  doneBtn.addEventListener('click', opts.onDone);
  footer.append(
    el(
      'span',
      '',
      'tap · repeat bar (tap again to stop) &nbsp; double tap · play loop from here' +
        ' &nbsp; hold · mute / unmute &nbsp; swipe · change pass / bar' +
        ' <span style="color:rgba(255,255,255,.4)">(locked while muted)</span>',
    ),
    doneBtn,
  );
  root.append(header, grid, footer);

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
      height: motion.snapEven(amp(layer.index, src, i, LINES_PER_BAR) * MAX_WAVE, lineWidth),
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

  function attachGestures(node: HTMLElement, slot: number) {
    let x0 = 0;
    let y0 = 0;
    let axis: 'pass' | 'bar' | null = null;
    let fired = false;
    let held = false;
    let holdTimer: number | null = null;
    /**
     * Whether a press is actually in progress.
     *
     * **Not `hasPointerCapture`.** `pointermove` fires on plain hover, and capture is only a
     * routing hint — it survives a `pointerup` the page never receives, which happens whenever
     * the button is released outside the window or the browser takes the gesture over. Hover
     * then re-enters a tile still holding orphaned capture, the guard passes, and the move is
     * measured against a `x0`/`y0` from minutes ago: an enormous delta that steps the slot
     * without anyone pressing anything. Own the state instead of asking the platform for it.
     */
    let down = false;

    function endGesture() {
      down = false;
      tiles[slot]!.swiping = false;
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
      axis = null;
    }

    node.addEventListener('pointerdown', (e) => {
      x0 = e.clientX;
      y0 = e.clientY;
      axis = null;
      fired = false;
      held = false;
      down = true;
      node.setPointerCapture(e.pointerId);
      holdTimer = window.setTimeout(() => {
        held = true;
        layer = { ...layer, mutedSlots: toggleSlotMute(layer.mutedSlots, slot) };
        redraw(slot);
        opts.onChange(layer);
      }, HOLD_MS);
    });

    // Capture can be lost without a pointerup — treat that as the gesture ending.
    node.addEventListener('lostpointercapture', endGesture);

    node.addEventListener('pointermove', (e) => {
      if (!down) return;
      // A move with no button held is a release we never saw. Mouse and touch both report
      // `buttons === 0` once up, so this catches the case that leaves capture stranded.
      if (e.buttons === 0) {
        endGesture();
        return;
      }
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;

      // A hold requires stillness, so hold and swipe can never both fire.
      if (holdTimer !== null && Math.max(Math.abs(dx), Math.abs(dy)) > HOLD_SLOP) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      // The lock is domain code (§3.7) so the gesture cannot drift from any other route.
      if (!canSwipeSlot(layer.mutedSlots, slot)) return;

      if (!axis && Math.max(Math.abs(dx), Math.abs(dy)) > SWIPE_THRESHOLD) {
        axis = Math.abs(dx) > Math.abs(dy) ? 'bar' : 'pass';
        tiles[slot]!.swiping = true;
      }
      if (!axis) return;

      const travel = axis === 'bar' ? dx : dy;
      if (Math.abs(travel) > SWIPE_THRESHOLD) {
        // Both axes are inverted relative to travel, and it is the same rule on each: the
        // material moves under the finger, so the next one is pulled in from the side you are
        // dragging toward. Dragging LEFT pulls the next bar in from the right (§3.7, which
        // states this axis); dragging UP pulls the next pass in from below. §3.7 leaves the
        // vertical direction unspecified — this is the filmstrip applied to it.
        const dir = travel > 0 ? -1 : 1;
        step(slot, axis, dir);
        x0 = e.clientX;
        y0 = e.clientY; // allow repeats within one drag
        fired = true;
      }
    });

    node.addEventListener('pointerup', (e) => {
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      // Only a press that this tile actually saw begin can become a tap.
      const wasDown = down;
      endGesture();
      if (wasDown && !fired && !held) tap(slot);
    });

    node.addEventListener('pointercancel', endGesture);
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
    titleRow.innerHTML =
      `<div class="lr-title">${layer.name || `Layer ${layer.index + 1}`}</div>` +
      `<div class="lr-meta">${project.bpm} BPM · ${barCount} bars · ${passes} pass${passes === 1 ? '' : 'es'}</div>`;
    gridTitle.textContent =
      `Select the pass and bar for each slot — ${barCount}-bar song, ${LINES_PER_BAR} lines per bar, ` +
      `${recordedBars() * LINES_PER_BAR} gradient stops across the recording`;

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

  let observer: ResizeObserver | undefined;
  requestAnimationFrame(() => {
    if (!alive) return;
    syncSizing();
    refresh();
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
      observer?.disconnect();
      document.removeEventListener('keydown', onKey);
      opts.engine.stop();
    },
  };
}
