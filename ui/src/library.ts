import {
  LAYER_COUNT,
  type Project,
  layerHasRecording,
  projectTiming,
  projectTotalPasses,
  recordedLayerCount,
  sizeProjection,
} from '../../src/domain/project.ts';
import { loopSeconds } from '../../src/domain/timing.ts';
import type { BackingEngine } from './audio.ts';
import { helpControl } from './help.ts';
import { type WaveNode, LR, el, motion, ramp } from './kit.ts';
import { amp } from './demo.ts';
import { formatBytes, renderLoop } from './screen.ts';
import { THEMES, type ThemeId, applyTheme, swatch } from './theme.ts';

const THUMB_LINES = 26; // enough to read a shape at 84px, few enough to stay legible
/**
 * Lane height, in px. Six, and built heights are snapped **even**: `paint` runs every line through
 * `snapEven`, so an odd height would round up the moment a preview started and pop every lane
 * taller. Six also leaves three levels where five leaves two.
 */
const THUMB_HEIGHT = 6;

/**
 * Project Library (§4.1) — the app's entry point, and a list you open a project from. The project
 * actions live on `settings.ts`, so a row here carries no second control.
 *
 * **The thumbnail is the progress display.** One `thumb` lane per recorded layer in that layer's
 * `ramp.slice`, so a project is recognisable by its colour signature and stripe count before the
 * name is read, and playing a row recedes its lines rather than covering the artwork. The size
 * readout swaps to a position readout while playing, so the row does not change width.
 *
 * **One preview at a time**, on one engine — §4.1 rules out standing up players per row.
 */
export function libraryScreen(opts: {
  projects: readonly Project[];
  /**
   * An engine already loaded with `project` and matched to its capture rate.
   *
   * **This is the only screen that plays a project other than the open one**, so it asks per
   * preview rather than taking the shell's — which is loaded with whatever is open, and would
   * make seven sketches preview as one. A callback rather than a constructor because a context
   * cannot change sample rate and the list holds both qualities, and the shell owns engine
   * lifetime.
   */
  engineFor(project: Project): BackingEngine;
  onOpen(id: string): void;
  /** Setup for a project that does not exist yet (§4.5). */
  onNew(): void;
  /** Remember a colourway. Applying it is immediate and does not wait on this. */
  onTheme(id: ThemeId): void;
}): { node: HTMLElement; destroy(): void } {
  const root = el('div', 'lr-screen library');

  // §4.1: most recently modified first. Sorted here rather than assumed of the input.
  const projects = [...opts.projects].sort((a, b) => b.lastModified.localeCompare(a.lastModified));

  let playingId: string | null = null;
  /** The engine the current preview is running on; whichever project it was built for. */
  let engine: BackingEngine | undefined;
  /**
   * Seconds, not frames: the list holds projects at both capture rates and the previewed row
   * decides which, so the clock converts once through the engine's own rate.
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
  // No sort note. §4.1 fixes the order at most-recently-modified and offers no other, so the line
  // announced a rule that cannot change rather than telling anyone something they could act on —
  // and the dates down the right of every card already say it. The sort itself is unchanged.
  header.append(titleRow, newBtn);

  const listEl = el('div', 'lr-rows');

  /**
   * From the rows, not the `projects` snapshot the screen was built with. §2.7 makes storage
   * "visible and user-managed", so the total has to answer the action just taken.
   */
  function paintStorage() {
    const total = rows.reduce((n, r) => n + sizeProjection(r.project).uncompressedBytes, 0);
    storage.textContent = `${rows.length} project${rows.length === 1 ? '' : 's'} · ${formatBytes(total)}`;
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
    /**
     * The position readout: its own column at the end of the row, vertically centred, shown only
     * while this row is previewing.
     *
     * **It used to replace the size**, which was a habit from the layout where both shared one
     * right-hand box. They are different facts — how big it is, and where the preview has got to
     * — and hiding one to show the other meant the size vanished from the row you were listening
     * to. Outside `main` so `rebuild` cannot throw it away, which also means the render loop's
     * handle is set once here rather than re-found on every repaint.
     */
    const time = el('div', 'p-time', '0:00');
    head.append(play, thumb, main, time);
    rowEl.appendChild(head);

    const row: Row = {
      project: initial,
      el: rowEl,
      lanes: [] as WaveNode[],
      play,
      time,
      rebuild,
    };

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
        // Real pixel heights, not the mockup's percentages: `paint` scales against the height a
        // line was built with, and a lane built at 0 emits `scaleY(Infinity)`.
        lane.build(THUMB_LINES, (i, u) => ({
          height: motion.snapEven(amp(layer.index, seed, i, THUMB_LINES) * THUMB_HEIGHT, 2),
          rgb: ramp.rgb(from + (to - from) * u),
        }));
        thumb.appendChild(lane);
        row.lanes.push(lane);
      }

      /**
       * **HQ and Compressed are gone**, and only Bounced remains (§4.1's design study). The two
       * removed were *settings* wearing the costume of provenance: every project has a quality,
       * and compression is a state the same project moves in and out of, so as badges they sat
       * beside the name claiming to say what a sketch *is*. Both are still in project settings,
       * which is where they can be acted on. Bounced stays because it says where a project came
       * from, which nothing else on the row does and no setting reports.
       */
      const tags = p.bouncedFromProjectId
        ? '<span class="lr-tag lr-tag--bounced">Bounced</span>'
        : '';

      /**
       * Three stacked lines, not two lines and a right-hand column. The size used to sit in its
       * own right-aligned box, which took width from the meta and wrapped it mid-phrase —
       * "3 layers / · 7 passes · Today". It belongs with the date: both answer "how big and how
       * recent", where the line above answers "what is it".
       */
      main.innerHTML =
        `<div class="p-name">${p.name}${tags}</div>` +
        // §2.7: pass count drives size, not layer count, which is why the row shows it.
        `<div class="p-meta">${p.bpm} BPM · ${p.barCount} bars · ${layers} layer${layers === 1 ? '' : 's'}` +
        ` · ${passes} pass${passes === 1 ? '' : 'es'}</div>` +
        `<div class="p-meta p-meta--b">${modified(p.lastModified)} · ` +
        `<span class="p-size"></span></div>`;
      main.querySelector('.p-size')!.textContent = formatBytes(
        sizeProjection(p).uncompressedBytes,
      );
    }

    // The whole row opens the project; there is no second action on it.
    head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.lr-play')) return;
      opts.onOpen(row.project.id);
    });

    listEl.appendChild(rowEl);
    rebuild();
    return row;
  }

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
      engine?.stop();
      return;
    }
    // **Loaded with this row's project, not whatever was queued last.** The engine holds a
    // snapshot and re-reads nothing on its own, so a preview that only calls `start` plays the
    // project the shell happens to have open rather than the row that was tapped.
    const project = rows.find((r) => r.project.id === id)!.project;
    loopSecondsNow = loopSeconds(projectTiming(project));
    engine = opts.engineFor(project);
    engine.start(0);
  }

  const spent = ramp.tokenRGB('--lr-spent');
  const loop = renderLoop(() => {
    if (playingId === null || !engine) return;
    const row = rows.find((r) => r.project.id === playingId);
    if (!row) return;

    const elapsed = engine.frame() / engine.sampleRate;
    const position = elapsed % loopSecondsNow;
    const head = (position / loopSecondsNow) * THUMB_LINES;
    // The thumbnail *is* the progress display (§4.1): played lines recede, the same convention
    // as every other screen, so no separate bar has to sit over the artwork.
    for (const lane of row.lanes) {
      const lines = lane.lines();
      for (let i = 0; i < lines.length; i++) lane.paint(lines[i]!, head - i, 1, spent, 2);
    }
    row.time.textContent = LR.fmtTime(position);
  });

  const help = helpControl({
    title: 'Projects',
    pages: [
      {
        label: 'Projects',
        content: () => [
          'play a project without opening it · tap a row to open it · export, bounce, compress and delete live in that project’s settings',
        ],
      },
    ],
  });

  /**
   * The colourway picker (§ not in the spec — flagged as an addition).
   *
   * **App chrome, not project state**, so it lives in the Library footer rather than project
   * settings and is stored beside the theme itself instead of inside a `Project`. Four dots and
   * no label: the swatch is the control, the same argument as the backing kit names.
   *
   * `applyTheme` is called directly rather than through a re-render — the tokens are on
   * `documentElement`, so every open screen restyles without being rebuilt, and rebuilding the
   * Library here would stop a running preview to change a colour.
   */
  const themes = el('div', 'theme-pick');
  for (const v of THEMES) {
    const dot = el('button', 'theme-dot');
    dot.style.background = swatch(v);
    dot.title = `${v.name} — ${v.note}`;
    dot.setAttribute('aria-label', v.name);
    dot.addEventListener('click', () => {
      applyTheme(v.id);
      opts.onTheme(v.id);
      paintThemes(v.id);
    });
    themes.append(dot);
  }
  function paintThemes(active: string) {
    for (let i = 0; i < themes.children.length; i++) {
      themes.children[i]!.classList.toggle('is-active', THEMES[i]!.id === active);
    }
  }
  paintThemes(document.documentElement.dataset['theme'] ?? '');

  const footer = el('div', 'lr-footer');
  footer.append(help.node, themes);
  root.append(header, listEl, footer);

  return {
    node: root,
    destroy() {
      loop.stop();
      help.destroy();
      // Stop, not destroy: the shell owns the engine's lifetime and closes it on the way out.
      engine?.stop();
    },
  };
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
