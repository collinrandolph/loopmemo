import {
  LAYER_COUNT,
  type Project,
  compressedProject,
  layerHasRecording,
  projectCompressionPlan,
  projectTiming,
  projectTotalPasses,
  recordedLayerCount,
  sizeProjection,
} from '../../src/domain/project.ts';
import { bouncePlan, bounceSeed } from '../../src/domain/bounce.ts';
import { loopFrames, loopSeconds } from '../../src/domain/timing.ts';
import { helpControl } from './help.ts';
import { type WaveNode, LR, el, motion, ramp } from './kit.ts';
import { type Engine, amp, simSession } from './sim.ts';

const THUMB_LINES = 26; // enough to read a shape at 84px, few enough to stay legible
/**
 * Lane height, in px. Six rather than the kit's five, and built heights are snapped **even**,
 * because `paint` runs every line through `snapEven` — which rounds to even and would round a
 * 3px line up to 4 the moment a preview started, popping every lane taller. Even at rest, even
 * while playing, and `playScale(0)` is 1, so the first painted frame is identical to the
 * unplayed one. Six leaves three levels where five leaves two.
 */
const THUMB_HEIGHT = 6;

/**
 * Project Library (§4.1) — the app's entry point.
 *
 * **The thumbnail is the progress display.** One `thumb` lane per recorded layer, each in that
 * layer's `ramp.slice`, so a project is recognisable by its colour signature and stripe count
 * before the name is read — and playing a row recedes its lines rather than putting a separate
 * progress bar over the artwork. The size readout swaps to a position readout while playing, so
 * the row does not change width.
 *
 * **Preview is a rendered mix, not the scheduling engine.** §4.1 is explicit: the list may show
 * dozens of projects and standing up seven players per row to audition a sketch is wasteful. The
 * simulated engine here is one frame counter for the whole screen, which is the same shape.
 *
 * **Destructive actions confirm in place and state the outcome.** Compress shows the real
 * projection, because a projected saving is the entire reason to do it and a generic prompt
 * hides the only fact that would inform the decision.
 */
export function libraryScreen(opts: {
  projects: readonly Project[];
  engine: Engine;
  onOpen(id: string): void;
  /** Setup for a project that does not exist yet (§4.5). */
  onNew(): void;
}): { node: HTMLElement; destroy(): void } {
  const root = el('div', 'lr-screen library');

  // §4.1: most recently modified first. Sorted here rather than assumed of the input.
  const projects = [...opts.projects].sort((a, b) => b.lastModified.localeCompare(a.lastModified));

  let playingId: string | null = null;
  /**
   * Seconds, not frames. Every other screen works in the open project's frames because that is
   * what the domain computes in — but this list holds projects at both capture rates, and one
   * engine runs at one rate. A duration is the same number either way, so the preview clock
   * converts once through `engine.sampleRate` and cannot drift on a 48k project.
   */
  let loopSecondsNow = 1;

  // ------------------------------------------------------------------ header --
  const header = el('div', 'lr-header');
  const titleRow = el('div', 'lr-title-row');
  const storage = el('div', 'storage');
  titleRow.append(el('div', 'lr-title', 'Projects'), storage);
  const newBtn = el(
    'button',
    'lr-btn lr-btn--primary new-btn',
    '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg> New project',
  );
  newBtn.addEventListener('click', () => opts.onNew());
  header.append(titleRow, el('div', 'sort-note', 'Most recently modified first'), newBtn);

  const listEl = el('div', 'lr-rows');

  /**
   * From the rows, not from `projects` — that is the snapshot the screen was built with, and a
   * compress or a delete moves both numbers. §2.7 makes storage "visible and user-managed", so
   * a device total that does not answer the action just taken is the one thing it must not be.
   */
  function paintStorage() {
    const total = rows.reduce((n, r) => n + sizeProjection(r.project).uncompressedBytes, 0);
    storage.textContent = `${rows.length} project${rows.length === 1 ? '' : 's'} · ${mb(total)}`;
  }

  // -------------------------------------------------------------------- rows --
  type Row = {
    project: Project;
    el: HTMLElement;
    lanes: WaveNode[];
    play: ReturnType<typeof LR.PlayButton>;
    time: HTMLElement;
    rebuild(): void;
  };
  const rows: Row[] = [];

  for (const [i, project] of projects.entries()) rows.push(projectRow(project, i));
  paintStorage();

  function projectRow(initial: Project, seed: number): Row {
    const rowEl = el('div', 'lr-row');
    const head = el('div', 'lr-row-head');

    const play = LR.PlayButton(() => setPlaying(row.project.id === playingId ? null : row.project.id));
    play.classList.add('lr-play--sm');

    const thumb = el('div', 'thumb');
    const main = el('div', 'p-main');
    const right = el('div', 'p-right', '<span class="p-size"></span><span class="p-time">0:00</span>');
    head.append(play, thumb, main, right);
    rowEl.appendChild(head);

    const row: Row = { project: initial, el: rowEl, lanes: [] as WaveNode[], play, time: right.querySelector('.p-time')!, rebuild };

    function rebuild() {
      const p = row.project;
      const passes = projectTotalPasses(p);
      const layers = recordedLayerCount(p);

      // One lane per recorded layer, in that layer's slice of the ramp.
      thumb.innerHTML = '';
      row.lanes = [];
      for (const layer of p.layers) {
        if (!layerHasRecording(layer)) continue;
        const lane = LR.Waveform({ variant: 'thumb' });
        const [from, to] = ramp.slice(layer.index, LAYER_COUNT);
        // Real pixel heights, not the mockup's percentages. `paint` scales a line against the
        // height it was built with, so a lane built at 0 and restyled afterwards divides by
        // zero and emits `scaleY(Infinity)` — which the browser drops, leaving the preview
        // looking like a dead render loop. The mockup can use percentages because nothing
        // there animates these lanes.
        lane.build(THUMB_LINES, (i, u) => ({
          height: motion.snapEven(amp(layer.index, seed, i, THUMB_LINES) * THUMB_HEIGHT, 2),
          rgb: ramp.rgb(from + (to - from) * u),
        }));
        thumb.appendChild(lane);
        row.lanes.push(lane);
      }

      const tags =
        (p.audioQuality === 'high' ? '<span class="lr-tag lr-tag--hq">HQ</span>' : '') +
        (p.isCompressed ? '<span class="lr-tag">Compressed</span>' : '') +
        (p.bouncedFromProjectId ? '<span class="lr-tag lr-tag--bounced">Bounced</span>' : '');

      main.innerHTML =
        `<div class="p-name">${p.name} ${tags}</div>` +
        `<div class="p-meta">${p.bpm} BPM · ${p.barCount} bars · ${layers} layer${layers === 1 ? '' : 's'}` +
        // §2.7: pass count drives size, not layer count, which is why the row shows it.
        ` · ${passes} pass${passes === 1 ? '' : 'es'} · ${modified(p.lastModified)}</div>`;
      right.querySelector('.p-size')!.textContent = mb(sizeProjection(p).uncompressedBytes);

    }

    // The whole row opens the project. There is no second action on a row any more — export,
    // bounce, compress and delete moved to the project's own settings screen, so a Projects row
    // is a list entry rather than a control surface.
    head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.lr-play')) return;
      opts.onOpen(row.project.id);
    });

    listEl.appendChild(rowEl);
    rebuild();
    return row;
  }

  // **No edit helpers here any more.** Replacing, inserting and removing a project all moved
  // out with the actions that called them; this screen lists projects and opens one.

  // --------------------------------------------------------------- playback --
  /** Exclusive, matching the arming rule: starting one stops another (§4.1). */
  function setPlaying(id: string | null) {
    playingId = id;
    for (const row of rows) {
      const on = row.project.id === id;
      row.el.classList.toggle('is-playing', on);
      row.play.setPlaying(on);
      if (!on) for (const lane of row.lanes) for (const line of lane.lines()) line.style.transform = '';
    }
    if (id === null) {
      opts.engine.stop();
      return;
    }
    loopSecondsNow = loopSeconds(projectTiming(rows.find((r) => r.project.id === id)!.project));
    opts.engine.start(0);
  }

  const spent = ramp.tokenRGB('--lr-spent');
  let alive = true;
  const step = () => {
    if (!alive) return;
    requestAnimationFrame(step);
    if (playingId === null) return;
    const row = rows.find((r) => r.project.id === playingId);
    if (!row) return;

    const elapsed = opts.engine.frame() / opts.engine.sampleRate;
    const position = elapsed % loopSecondsNow;
    const head = (position / loopSecondsNow) * THUMB_LINES;
    // The thumbnail *is* the progress display (§4.1): played lines recede, the same convention
    // as every other screen, so no separate bar has to sit over the artwork.
    for (const lane of row.lanes) {
      const lines = lane.lines();
      for (let i = 0; i < lines.length; i++) lane.paint(lines[i]!, head - i, 1, spent, 2);
    }
    row.time.textContent = LR.fmtTime(position);
  };
  requestAnimationFrame(step);

  const help = helpControl({
    title: 'Projects',
    content: () => [
      'play a project without opening it · tap a row to open it · export, bounce, compress and delete live in that project’s settings',
    ],
  });

  const footer = el('div', 'lr-footer');
  footer.append(help.node, el('span', 'lr-note', ''));
  root.append(header, listEl, footer);

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
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * Relative, because §4.1 sorts on it and "3 days ago" is what the sort means.
 *
 * Counted in **calendar days, not elapsed hours**: something saved at 21:05 last night is
 * "Yesterday" to the person who saved it, and 15 hours of elapsed time floors to 0 and calls it
 * Today. The list is ordered by the real timestamp either way; only the wording rounds.
 */
function modified(iso: string): string {
  const midnight = (ms: number) => Math.floor(ms / 86_400_000);
  const days = midnight(NOW) - midnight(Date.parse(iso));
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  return `${Math.floor(days / 7)} weeks ago`;
}

/** The demo shelf is dated, so "today" has to be its today rather than the reader's. */
const NOW = Date.parse('2026-08-30T12:00:00.000Z');
