import {
  canSwipeSlot,
  isSlotMuted,
  stepBarAt,
  stepPassAt,
  toggleSlotMute,
} from '../../src/domain/arrangement.ts';
import { formatBarRef, toAbsolute } from '../../src/domain/bar-ref.ts';
import { availablePasses, totalPasses } from '../../src/domain/pass-index.ts';
import { type Layer, type Project, layerPassIndex, projectTiming } from '../../src/domain/project.ts';
import {
  IDLE,
  type Transport,
  completedCycleBetween,
  isPlayed,
  passedAt,
  playBar,
  playLoopFrom,
  playheadAt,
  stop,
} from '../../src/domain/transport.ts';
import { type Rgb, type WaveNode, LR, el, motion, ramp, sizing } from './kit.ts';
import { type Engine, barPeaks } from './sim.ts';

const HOLD_MS = 500;
const DOUBLE_MS = 260;
const SWIPE_PX = 24;

type Tile = {
  node: HTMLElement;
  label: HTMLElement;
  wave: WaveNode;
  /** Release accumulator: holds a played tile spent, then decays (§3.6). */
  reset: number;
};

/**
 * Edit Layer (§3.7, §3.4, §3.6).
 *
 * Every rule here comes from `src/domain` — `stepPassAt` / `stepBarAt` for the two axes,
 * `canSwipeSlot` for the mute lock, `playheadAt` / `isPlayed` / `passedAt` for the transport.
 * The only thing this file decides is how a pointer becomes one of those calls.
 */
export function editLayerScreen(opts: {
  project: Project;
  layerIndex: number;
  engine: Engine;
  onChange(layer: Layer): void;
}): HTMLElement {
  const t = projectTiming(opts.project);
  const barCount = opts.project.barCount;

  let layer = opts.project.layers[opts.layerIndex]!;
  let transport: Transport = IDLE;
  let selected: number | undefined;
  let previousFrame = 0;

  const root = el('div', 'lr-screen');
  const header = el('div', 'lr-header');
  const grid = el('div', 'grid');
  root.append(header, grid);

  const rowsEl = el('div');
  grid.append(el('div', 'grid-title'), rowsEl);

  const spent = ramp.tokenRGB('--lr-spent');
  const spentSel = ramp.tokenRGB('--lr-spent-sel');
  const tiles: Tile[] = [];
  let linesPerBar = 12;

  function index() {
    return layerPassIndex(layer, t);
  }

  /** Where this source sits in the whole recording — the colour axis of §1.1. */
  function sourceT(slot: number): number {
    const ref = layer.barSources[slot];
    if (!ref) return 0;
    const total = Math.max(1, totalPasses(index()) * barCount);
    return (toAbsolute(ref, barCount) - 1) / Math.max(1, total - 1);
  }

  function buildTiles() {
    rowsEl.innerHTML = '';
    tiles.length = 0;

    for (let row = 0; row * 4 < barCount; row++) {
      const rowEl = el('div', 'bar-row');
      for (let i = 0; i < 4 && row * 4 + i < barCount; i++) {
        const slot = row * 4 + i;
        const node = el('div', 'tile');
        const label = el('div', 'tile-label');
        const wave = LR.Waveform({});
        const hint = el('div', 'swipe-hint', '<span>bar</span><span>pass</span>');
        node.append(label, wave, hint);
        rowEl.appendChild(node);
        bindGestures(node, slot);
        tiles.push({ node, label, wave, reset: 0 });
      }
      rowsEl.appendChild(rowEl);
    }
  }

  function measure() {
    const first = tiles[0]?.node;
    if (!first) return;
    const width = first.clientWidth - 10;
    const fit = sizing.fitToWidth(width, 14, 8);
    sizing.apply(fit.width);
    linesPerBar = fit.count;
  }

  /** Rebuild a tile's lines — called whenever its *source* changes, never on playback. */
  function drawTile(slot: number) {
    const tile = tiles[slot]!;
    const ref = layer.barSources[slot];
    const muted = isSlotMuted(layer.mutedSlots, slot);

    tile.node.classList.toggle('is-muted', muted);
    tile.node.classList.toggle('is-selected', selected === slot);

    if (!ref) {
      tile.label.innerHTML = '<span>—</span>';
      tile.wave.build(0, () => ({ height: 0, rgb: [0, 0, 0] }));
      return;
    }

    const passes = availablePasses(index(), ref.relativeBar);
    tile.label.innerHTML =
      `<span>${ref.relativeBar}</span>` +
      `<span class="pass">P${ref.pass}${passes.length > 1 ? '' : ' ·'}</span>`;
    tile.node.title = `slot ${slot + 1} · ${formatBarRef(ref)} · passes ${passes.join(',') || '—'}`;

    const peaks = barPeaks(layer.index, toAbsolute(ref, barCount), linesPerBar);
    const base = sourceT(slot);
    const span = 1 / Math.max(1, totalPasses(index()) * barCount);

    tile.wave.build(linesPerBar, (i, u) => ({
      height: Math.round(8 + peaks[i]! * 56),
      rgb: ramp.rgb(base + span * u),
    }));
  }

  function drawAll() {
    for (let slot = 0; slot < barCount; slot++) drawTile(slot);
  }

  // ---------------------------------------------------------------- gestures --
  function bindGestures(node: HTMLElement, slot: number) {
    let startX = 0;
    let startY = 0;
    let held = false;
    let moved = false;
    let holdTimer: number | undefined;
    let lastTap = 0;
    let tapTimer: number | undefined;

    node.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      held = false;
      moved = false;
      node.setPointerCapture(e.pointerId);
      holdTimer = window.setTimeout(() => {
        held = true;
        layer = { ...layer, mutedSlots: toggleSlotMute(layer.mutedSlots, slot) };
        commit(slot);
      }, HOLD_MS);
    });

    node.addEventListener('pointermove', (e) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) {
        moved = true;
        clearTimeout(holdTimer);
      }
    });

    node.addEventListener('pointerup', (e) => {
      clearTimeout(holdTimer);
      if (held) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (Math.max(Math.abs(dx), Math.abs(dy)) >= SWIPE_PX) {
        // The gate lives in the domain so every route to the edit agrees about it (§3.7).
        if (!canSwipeSlot(layer.mutedSlots, slot)) return;
        const next =
          Math.abs(dy) > Math.abs(dx)
            ? // vertical steps the pass; wraps through the available set, gaps skipped
              stepPassAt(layer.barSources, slot, dy < 0 ? 1 : -1, index(), layer.mutedSlots)
            : // horizontal steps the bar; inverted, so the strip moves under the finger
              stepBarAt(layer.barSources, slot, dx < 0 ? 1 : -1, barCount, layer.mutedSlots);
        layer = { ...layer, barSources: next };
        commit(slot);
        return;
      }
      if (moved) return;

      const now = performance.now();
      if (now - lastTap < DOUBLE_MS) {
        clearTimeout(tapTimer);
        lastTap = 0;
        begin(slot, 'loop');
        return;
      }
      lastTap = now;
      tapTimer = window.setTimeout(() => begin(slot, 'bar'), DOUBLE_MS);
    });

    node.addEventListener('pointercancel', () => clearTimeout(holdTimer));
  }

  function commit(slot: number) {
    drawTile(slot);
    opts.onChange(layer);
  }

  function begin(slot: number, mode: 'bar' | 'loop') {
    const sameOrigin = transport.mode !== 'idle' && transport.origin === slot;
    if (sameOrigin && transport.mode === mode) {
      transport = stop();
      opts.engine.stop();
      selected = undefined; // §3.6 rule 6: selection is UI state and clears on stop
      drawAll();
      return;
    }
    opts.engine.start(0);
    previousFrame = 0;
    transport = mode === 'bar' ? playBar(slot, 0) : playLoopFrom(slot, 0);
    selected = slot;
    for (const tile of tiles) tile.reset = 0;
    drawAll();
  }

  // ------------------------------------------------------------------ render --
  let lastNow = performance.now();

  function frame() {
    const now = performance.now();
    const dt = Math.min(64, now - lastNow);
    lastNow = now;

    const position = opts.engine.running() ? opts.engine.frame() : previousFrame;
    const head = playheadAt(transport, position, t);

    // The cycle edge is not redundant with the played set: it drives the 180 ms release,
    // and no played-set test can see it (§3.6).
    if (transport.mode !== 'idle' && completedCycleBetween(transport, previousFrame, position, t)) {
      for (let slot = 0; slot < barCount; slot++) {
        if (isPlayed(head, slot)) continue;
        tiles[slot]!.reset = motion.COLOR_FEATHER;
      }
    }
    previousFrame = position;

    for (let slot = 0; slot < barCount; slot++) {
      const tile = tiles[slot]!;
      tile.reset = motion.approach(tile.reset, 0, motion.TAU.reset!, dt);
      const target: Rgb = selected === slot ? spentSel : spent;
      const lines = tile.wave.lines();
      for (let i = 0; i < lines.length; i++) {
        const live = passedAt(head, slot, i, lines.length);
        tile.wave.paint(lines[i]!, Math.max(live, tile.reset), 1, target, 2);
      }
    }
    requestAnimationFrame(frame);
  }

  function refresh(project: Project) {
    layer = project.layers[opts.layerIndex]!;
    const passes = totalPasses(index());
    header.innerHTML =
      `<div class="lr-title-row"><div class="lr-title">${layer.name || 'Untitled layer'}</div>` +
      `<div class="lr-meta">${project.bpm} BPM · ${barCount} bars · ${passes} pass${passes === 1 ? '' : 'es'}</div></div>`;
    (grid.firstElementChild as HTMLElement).textContent =
      'Tap a bar to repeat it · double tap to play from there · hold to mute · swipe to change pass or bar';
    drawAll();
  }

  buildTiles();
  requestAnimationFrame(() => {
    measure();
    refresh(opts.project);
    requestAnimationFrame(frame);
  });

  return root;
}
