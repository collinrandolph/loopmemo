import { isSilentAt } from '../../src/domain/arrangement.ts';
import { toAbsolute } from '../../src/domain/bar-ref.ts';
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

/**
 * Reference-track icons from **Lucide** (`drum`, `keyboard-music`), ISC licensed — path data
 * inlined rather than depended on, since this repo carries no runtime dependencies. Lucide's
 * 24-unit box, 2px stroke and round caps are already what `.ref-icon` declares, so they drop
 * straight in; take any future icon from the same set so the weights stay consistent.
 *
 * `keyboard-music` rather than Lucide's `piano`: the latter is a grand piano in silhouette and
 * needs its outline to be read, which at 22px it does not get — side by side in the row it
 * reads as a bag. Compared at size rather than chosen from the icon sheet.
 */
const DRUM_ICON =
  '<path d="m2 2 8 8"/><path d="m22 2-8 8"/><ellipse cx="12" cy="9" rx="10" ry="5"/>' +
  '<path d="M7 13.4v7.9"/><path d="M12 14v8"/><path d="M17 13.4v7.9"/>' +
  '<path d="M2 9v8a10 5 0 0 0 20 0V9"/>';

/**
 * The chord vocabulary (§4.4, **with one deliberate reversal**).
 *
 * §4.4 says "do not add a chord-quality picker to the primary interface": a scale plus four
 * roots makes the harmony correct by construction, and choosing quality per chord doubles the
 * decisions. Scale is gone here and quality is picked directly, at the user's instruction —
 * flagged rather than absorbed, because the spec is the authority and this contradicts it.
 *
 * Two things follow from dropping scale, and both are load-bearing. There is no longer any such
 * thing as a **borrowed** chord — "outside the scale" needs a scale to be outside of — so the
 * dashed slot state goes with it. And a slot can no longer be wrong, so nothing has to default
 * an out-of-scale root to a major triad.
 */
type Chord = {
  letter: string;
  accidental: 'natural' | 'flat' | 'sharp';
  quality: 'major' | 'minor' | 'dom7' | 'min7' | 'maj7';
};

const NOTE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((l) => ({ id: l, label: l }));

// `label` is what the picker shows, `suffix` what the chord button spells.
const ACCIDENTALS = [
  { id: 'natural', label: '♮', suffix: '' },
  { id: 'flat', label: '♭', suffix: '♭' },
  { id: 'sharp', label: '♯', suffix: '♯' },
];

const QUALITIES = [
  { id: 'major', label: 'Maj', suffix: '' },
  { id: 'minor', label: 'Min', suffix: 'm' },
  { id: 'dom7', label: '7', suffix: '7' },
  { id: 'min7', label: 'm7', suffix: 'm7' },
  { id: 'maj7', label: 'Maj7', suffix: 'maj7' },
];

const TONES = ['Rhodes', 'Pad', 'Nylon', 'Organ'];

/**
 * Placeholder library — §6.2 lists "drum loop library and selection UI" as not yet designed, so
 * these are names to swipe through, not a decided set.
 */
const DRUM_LOOPS = [
  'Dusty Break 02',
  'Tight Room 01',
  'Boom Bap 04',
  'Half-Time Shuffle',
  'Brush Kit 03',
  'Four on the Floor',
].map((name) => ({ id: name, label: name }));

/** A slot with nothing chosen yet. */
function defaultChord(): Chord {
  return { letter: 'C', accidental: 'natural', quality: 'major' };
}

/**
 * Randomising draws the root from the twelve pitches as they are actually spelled, not from
 * letter × accidental, so it cannot hand back B♯ or F♭ — enharmonically valid, and not how
 * anyone writes a chord. Quality is weighted toward triads for the same reason: uniform over
 * five would make a progression of four sevenths the common case.
 */
const RANDOM_ROOTS: Pick<Chord, 'letter' | 'accidental'>[] = [
  { letter: 'C', accidental: 'natural' },
  { letter: 'C', accidental: 'sharp' },
  { letter: 'D', accidental: 'natural' },
  { letter: 'E', accidental: 'flat' },
  { letter: 'E', accidental: 'natural' },
  { letter: 'F', accidental: 'natural' },
  { letter: 'F', accidental: 'sharp' },
  { letter: 'G', accidental: 'natural' },
  { letter: 'A', accidental: 'flat' },
  { letter: 'A', accidental: 'natural' },
  { letter: 'B', accidental: 'flat' },
  { letter: 'B', accidental: 'natural' },
];

const RANDOM_QUALITIES: Chord['quality'][] =
  ['major', 'major', 'major', 'minor', 'minor', 'minor', 'dom7', 'min7', 'maj7'];

function randomChord(): Chord {
  const root = RANDOM_ROOTS[Math.floor(Math.random() * RANDOM_ROOTS.length)]!;
  return { ...root, quality: RANDOM_QUALITIES[Math.floor(Math.random() * RANDOM_QUALITIES.length)]! };
}

const SWIPE_THRESHOLD = 22; // as `edit-layer.ts`; the same gesture should want the same travel

/**
 * One vertically-swipeable field. Three inline are the chord editor; one on its own is the drum
 * loop picker.
 *
 * **Up steps forward**, matching the pass axis on the Edit Layer screen. Both are the same rule:
 * the material moves under the finger, so the next value is pulled in from the side you drag
 * toward — the filmstrip §3.7 states for the horizontal axis, applied to the vertical one it
 * leaves open.
 *
 * A tap steps too, upper half forward and lower half back, on the same axis as the drag: with a
 * mouse the drag is available but awkward, and a control with no tap affordance reads as inert.
 *
 * The gesture is gated on its own `down` flag and bails when `e.buttons === 0`. Pointer capture
 * is a routing hint, not press state — it survives a `pointerup` the page never receives, and
 * gating on it is the bug this project has already shipped once (see CLAUDE.md).
 */
function swipeWheel(
  caption: string,
  options: readonly { id: string; label: string }[],
  current: () => string,
  onPick: (id: string) => void,
  extraClass = '',
): HTMLElement {
  const node = el('div', `lr-wheel ${extraClass}`);
  const value = el('div', 'lr-wheel__value');
  node.append(value, el('div', 'lr-wheel__cap', `↕ ${caption}`));

  function paint(dir = 0) {
    value.textContent = options.find((o) => o.id === current())?.label ?? '';
    value.classList.remove('is-from-below', 'is-from-above');
    if (!dir) return;
    void value.offsetWidth; // restart the animation rather than let a repeat within one drag skip it
    // Forward is an upward drag, so the incoming value follows the finger up from underneath.
    value.classList.add(dir > 0 ? 'is-from-below' : 'is-from-above');
  }

  function step(dir: number) {
    const at = options.findIndex((o) => o.id === current());
    onPick(options[(at + dir + options.length) % options.length]!.id);
    paint(dir);
  }

  let down = false;
  let y0 = 0;
  let fired = false;

  node.addEventListener('pointerdown', (e) => {
    down = true;
    y0 = e.clientY;
    fired = false;
    node.setPointerCapture(e.pointerId);
  });
  const end = () => {
    down = false;
  };
  node.addEventListener('lostpointercapture', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('pointerup', (e) => {
    if (down && !fired) {
      const box = node.getBoundingClientRect();
      step(e.clientY < box.top + box.height / 2 ? 1 : -1);
    }
    end();
  });
  node.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (e.buttons === 0) {
      end();
      return;
    }
    const dy = e.clientY - y0;
    if (Math.abs(dy) <= SWIPE_THRESHOLD) return;
    step(dy > 0 ? -1 : 1); // inverted relative to travel, as both Edit Layer axes are
    y0 = e.clientY; // allow repeats within one drag
    fired = true;
  });

  paint();
  return node;
}

/** Standard spelling, so the slot reads as the chord and not as three settings. */
function chordLabel(chord: Chord): string {
  const accidental = ACCIDENTALS.find((a) => a.id === chord.accidental)?.suffix ?? '';
  const quality = QUALITIES.find((q) => q.id === chord.quality)?.suffix ?? '';
  return `${chord.letter}${accidental}${quality}`;
}

const PIANO_ICON =
  '<rect width="20" height="16" x="2" y="4" rx="2"/>' +
  '<path d="M6 8h4"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M2 12h20"/>' +
  '<path d="M6 12v4"/><path d="M10 12v4"/><path d="M14 12v4"/><path d="M18 12v4"/>';

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
    statsRow.textContent =
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

  // ---------------------------------------------------------- reference rows --
  // Editable working copy of the domain's shape — the fields are readonly there, as every
  // domain type is, so the screen owns a mutable mirror rather than reaching into one. The
  // chord progression is not in the domain at all yet (§2.6 is unmodelled), so it lives here
  // as plain screen state until it is.
  type RefRow = { -readonly [K in keyof ReferenceSource]: ReferenceSource[K] };

  const refsEl = el('div', 'refs');

  /**
   * The shared half of a reference row: icon, body, speaker, and a panel that opens on a tap
   * anywhere else in the head. The drum row is only this; the chord row adds to it.
   */
  function referenceRow(ref: RefRow, icon: string, body: HTMLElement) {
    const row = el('div', 'lr-row');
    const head = el('div', 'lr-row-head', `<svg class="ref-icon" viewBox="0 0 24 24">${icon}</svg>`);
    head.appendChild(body);

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

    const panel = el('div', 'lr-panel');
    const inner = el('div', 'lr-panel-inner');
    panel.appendChild(inner);
    row.appendChild(panel);

    const settings = el(
      'div',
      'lr-panel-row',
      '<span class="lr-panel-label">Volume</span>' +
        `<input class="level" type="range" min="0" max="100" value="${Math.round(ref.level * 100)}" style="flex:1">`,
    );
    settings.querySelector('.level')!.addEventListener('input', (e) => {
      ref.level = Number((e.target as HTMLInputElement).value) / 100;
      vol.update();
    });

    refsEl.appendChild(row);
    return { row, head, inner, settings };
  }

  // ---- drums
  const drums: RefRow = { id: 'drums', enabled: true, muted: false, level: 0.7 };
  let drumLoop = DRUM_LOOPS[0]!.id;
  {
    const detail = el('div', 'ref-detail', drumLoop);
    const parts = referenceRow(drums, DRUM_ICON, detail);

    // The same wheel as the chord fields, and **always in the panel**. There is nothing to pick
    // first: a drum row has one loop where a chord row has four chords, so the picker has no
    // subject to be chosen and no reason to appear and disappear. Which is also why this panel
    // needs no divider — everything in it is the track's.
    parts.inner.append(
      swipeWheel('Loop', DRUM_LOOPS, () => drumLoop, (v) => {
        drumLoop = v;
        detail.textContent = v; // the row head names the loop, so it follows the wheel
      }),
      parts.settings,
    );

    parts.head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.lr-volume')) return;
      parts.row.classList.toggle('is-open');
    });
  }

  // ---- chords
  const chordsRef: RefRow = { id: 'chords', enabled: true, muted: false, level: 0.55 };
  const progression: Chord[] = [defaultChord(), defaultChord(), defaultChord(), defaultChord()];
  let tone = 'Rhodes';

  {
    const slots = el('div', 'chord-slots');
    const buttons = progression.map((_, i) => {
      const b = el('span', 'chord');
      b.dataset.slot = String(i);
      slots.appendChild(b);
      return b;
    });
    const parts = referenceRow(chordsRef, PIANO_ICON, slots);

    /**
     * The panel has two shapes and one of them is per-chord, so which chord is being edited is
     * part of the open state rather than a mode the panel remembers. `null` is the track view.
     */
    let editing: number | null = null;

    const chordSection = el('div', 'chord-editor');
    const divider = el('div', 'lr-panel-divider');

    const toneRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Tone</span>');
    const toneChips = el('div', 'lr-chips');
    for (const name of TONES) {
      const chip = el('span', `lr-chip${name === tone ? ' is-active' : ''}`, name);
      chip.addEventListener('click', () => {
        tone = name;
      });
      toneChips.appendChild(chip);
    }
    toneRow.appendChild(toneChips);
    bindChips(toneRow);

    // A track setting rather than a per-chord one: it replaces the whole progression, and it is
    // reachable without first picking a chord — which is the point, since the blank slate is
    // four identical C majors (§6.1).
    const randomRow = el('div', 'lr-panel-row random-row');
    const randomBtn = el('button', 'lr-btn', 'Randomize chords');
    randomBtn.addEventListener('click', () => {
      for (let i = 0; i < progression.length; i++) progression[i] = randomChord();
      render(); // the open editor is showing one of the slots that just changed
    });
    randomRow.appendChild(randomBtn);

    parts.inner.append(chordSection, divider, parts.settings, toneRow, randomRow);

    function paintChords() {
      for (const [i, b] of buttons.entries()) {
        b.textContent = chordLabel(progression[i]!);
        b.classList.toggle('is-editing', editing === i);
      }
    }

    /** Three fields inline, each scoped to the one chord being edited. */
    function paintEditor() {
      chordSection.innerHTML = '';
      if (editing === null) return;
      const chord = progression[editing]!;
      const changed = () => paintChords();
      chordSection.append(
        swipeWheel('Note', NOTE_LETTERS, () => chord.letter, (v) => {
          chord.letter = v;
          changed();
        }),
        swipeWheel('Sign', ACCIDENTALS, () => chord.accidental, (v) => {
          chord.accidental = v as Chord['accidental'];
          changed();
        }, 'lr-wheel--sign'),
        swipeWheel('Type', QUALITIES, () => chord.quality, (v) => {
          chord.quality = v as Chord['quality'];
          changed();
        }),
      );
    }

    function render() {
      parts.row.classList.toggle('is-editing-chord', editing !== null);
      paintEditor();
      paintChords();
    }

    function close() {
      editing = null;
      parts.row.classList.remove('is-open');
      render();
    }

    function show(next: number | null) {
      // Tapping the chord already open closes the panel; tapping a different one swaps the
      // editor without closing, so moving along the progression is one tap rather than two.
      if (parts.row.classList.contains('is-open') && editing === next) {
        close();
        return;
      }
      editing = next;
      parts.row.classList.add('is-open');
      render();
    }

    parts.head.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.lr-volume')) return;
      const chip = target.closest<HTMLElement>('.chord');
      if (chip) {
        show(Number(chip.dataset.slot));
        return;
      }
      // Outside the chord buttons the row is a plain toggle for the whole panel. An open panel
      // closes rather than falling back to the track view: that fallback made one tap on the
      // row do two different things depending on what the panel happened to be showing.
      if (parts.row.classList.contains('is-open')) close();
      else show(null);
    });

    paintChords();
  }

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
      row.wave.build(lineCount, (i, u) => {
        const slot = Math.min(bars - 1, Math.floor((i * bars) / lineCount));
        const ref = row.layer.barSources[slot];
        const silent = isSilentAt(row.layer.mutedSlots, slot, false) || !ref;
        const src = ref ? toAbsolute(ref, bars) : 0;
        // `ceil`, not `floor`: this has to invert the `slot` above, and the first line of slot
        // s is the first i with `floor(i * bars / lineCount) === s`. Flooring picks a line one
        // slot earlier whenever the division is not exact, which offsets the material.
        const lineInSlot = i - Math.ceil((slot * lineCount) / bars);
        return {
          height: silent
            ? 2
            : motion.snapEven(amp(row.layer.index, src, lineInSlot, linesPerSlot) * LANE_AMPLITUDE, 2),
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
      // `is-live` is what keeps the layer's existing lane hidden underneath: while armed or
      // recording every line without it is display:none, so a layer with audio behaves like an
      // empty one for the length of the take.
      const line = el('div', 'lr-wave__line is-live');
      const level = amp(row.layer.index, row.layer.sessions.length, i, lineCount) * (0.55 + 0.45 * Math.random());
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
