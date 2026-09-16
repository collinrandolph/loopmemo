import { isSilentAt } from '../../src/domain/arrangement.ts';
import { type BackingTracks, drumPattern } from '../../src/domain/backing.ts';
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
import { type CountIn, countInFrames, countInStartFrame } from '../../src/domain/count-in.ts';
import { framesPerBar, loopFrames, loopSeconds } from '../../src/domain/timing.ts';
import { bindChips, levelPercent, levelSlider } from './controls.ts';
import { helpControl, helpFigure, helpLede, helpSection } from './help.ts';
import { type RecordState, type WaveNode, LR, el, motion, ramp, sizing } from './kit.ts';
import { SETTINGS_ICON, SWIPE_Y_ICON } from './icons.ts';
import { eqIconSvg, panIconSvg } from './preset-icons.ts';
import { backingRows } from './backing-rows.ts';
import { amp } from './demo.ts';
import { renderLoop, syncCollapse } from './screen.ts';
import { barAmplitude, computePeaks, drawnHeight, levelScaledHeight } from './peaks.ts';
import type { BackingEngine } from './audio.ts';
import { type TakeStore, newTakeId, takeUrl } from './takes.ts';
import { trimToDownbeat } from './recorder.ts';

const TARGET_LINES = 40; // lanes are an overview: the count follows the container
const LANE_AMPLITUDE = 34; // peak line height; the lane box is 40, see `.lr-wave--lane`
const PRESET_ICON_PX = 28; // the chips span the panel now, so the icon can be worth tapping

/** The label column never shrinks below this, so a one-character name still holds a column. */
const LABEL_MIN_PX = 52;
/**
 * `.layer-name` paints 6px wider than it occupies — it pads itself and pulls the padding back
 * with a negative margin, so the focus highlight has room without the text shifting. Measure the
 * occupied box only and the highlight bleeds into the lane.
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
  /** Waiting on the microphone before this row may arm; see `arm`. */
  pending: boolean;
  /** Re-measure the collapse after something changes the panel's content. */
  syncPanel(): void;
  live: HTMLElement[];
  /** The count-in pips, rebuilt per take because the beat count depends on the setting. */
  countIn: HTMLElement;
  pips: HTMLElement[];
  resetA: number;
};

/**
 * Playback screen (§4.4) — the layer stack, the transport, and recording. Layout follows
 * `docs/mockups/playback-screen-mockup.html`; two rules come from the domain instead:
 *
 * - **A pass is not counted until it is recorded.** The badge is `recordingBadge`, provisional
 *   until the traversal has earned a bar, and `recordSession` may still decline it (§1.4).
 * - **Sessions are not split at the loop point.** One continuous recording is one session however
 *   many passes it spans (§1.4), so nothing is written until recording ends.
 */
export function playbackScreen(opts: {
  project: Project;
  engine: BackingEngine;
  /** Where captured audio is filed; the domain only ever sees a session id. */
  takes: TakeStore;
  onChange(layer: Layer): void;
  /** Backing edits, which are project state rather than layer state (§2.6). */
  onBackingChange(backing: BackingTracks): void;
  /**
   * The count-in (§4.6), owned by the shell like the monitoring level: a preference of the person
   * rather than of a project, so it is not on `Project` and does not travel with a bounce.
   * Read at the moment recording starts, never cached — the settings screen can change it between
   * takes without this screen being rebuilt.
   */
  countIn(): CountIn;
  /**
   * The monitoring level, owned by the shell. A preference of the person, not of a project — it
   * is not on `Project`, does not travel with a bounce, and is not in an exported file.
   */
  master(): { readonly level: number; readonly muted: boolean };
  onMaster(next: { readonly level: number; readonly muted: boolean }): void;
  onEdit(layerIndex: number): void;
  /** Project settings (§4.5), reached by the gear beside the project stats. */
  onSettings(): void;
  /** Up to the Library. Also what Escape does once nothing is armed or recording. */
  onBack(): void;
  onExport(): void;
  /**
   * Whether takes are reaching storage, and how many are not (§6.1).
   *
   * Read on mount and whenever `onStorageChange` says so — the store is the source of truth and
   * announces its own transitions, so polling it from the render loop was both wasteful and
   * dependent on that loop running.
   */
  storage?(): { readonly kind: 'ok' | 'full' | 'unavailable'; readonly unsaved: number };
  /** Subscribe to storage changes. Returns an unsubscribe, called on teardown. */
  onStorageChange?(listener: () => void): () => void;
  /**
   * A take started or ended, so the shell can dim the controls it owns. **Paint only** — what
   * refuses a navigation is `takeInProgress`, asked at the moment of teardown, so enforcement
   * never depends on this notification having arrived.
   */
  onBusyChange?(busy: boolean): void;
}): { node: HTMLElement; destroy(): void; takeInProgress(): boolean } {
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
  /**
   * The count-in window in engine frames, for the take in progress: the transport starts at
   * `countInFrom` and the take begins at `countInUntil`. Equal (and 0) when the count-in is off,
   * which is what makes every `frameNow() < countInUntil` test below false in that case.
   */
  let countInFrom = 0;
  let countInUntil = 0;
  /** Loudest input since the last live line was drawn; see `pushLive`. */
  /**
   * Loudest input sample seen since the last line was drawn.
   *
   * **Accumulated rather than sampled**: `inputPeak()` resets the recorder's running maximum on
   * read, and the render loop runs far more often than a line is added, so sampling it per frame
   * would throw away every peak that fell between two lines — which is most of them, and
   * transients are exactly what a peak is for. Cleared when a line consumes it, and again when a
   * take begins, so nothing carries from one performance into the first line of the next.
   */
  let livePeak = 0;

  const spent = ramp.tokenRGB('--lr-spent');
  const rows: Row[] = [];

  const root = el('div', 'lr-screen');

  /**
   * Every control that ends a take by leaving the screen — settings, Edit Layer, Projects,
   * Export. They lock together while one runs, and this list is why they cannot drift: a new way
   * off the screen is one `exits.push` from being covered.
   *
   * `disabled`, not `pointer-events: none` — a focused button still fires on Enter.
   */
  const exits: HTMLButtonElement[] = [];

  // ------------------------------------------------------------------ header --
  const header = el('div', 'lr-header');
  const titleRow = el('div', 'lr-title-row');

  /**
   * The way into project settings — a **visible control**, not a tappable header. Tapping a layer
   * name on this screen renames it in place, so tapping the project name to navigate away would
   * teach the opposite lesson two rows apart.
   *
   * It ends the **title** line, opposite the project name, and the two number lines sit under it:
   * passes and size to the left, tempo and bar count right-aligned beneath the gear. So the right
   * edge reads as one column — the control, then the settings it opens — and the left edge is the
   * name over what the project has become.
   *
   * Every piece of text here is its own element, and `paintTitle` writes `textContent` into them.
   * The row used to be redrawn with `innerHTML`, which is fine for text and destroys a button —
   * the old comment noted exactly that hazard about the stats row, and moving the gear up brought
   * it along.
   */
  const titleEl = el('div', 'lr-title');
  const titleMeta = el('div', 'lr-settings');
  const statsRow = el('div', 'lr-meta lr-stats');
  const statsText = el('span', 'stats-text');
  const gearBtn = el('button', 'header-gear', `<svg viewBox="0 0 24 24">${SETTINGS_ICON}</svg>`);
  gearBtn.setAttribute('type', 'button');
  gearBtn.setAttribute('aria-label', 'Project settings');
  gearBtn.addEventListener('click', () => opts.onSettings());
  exits.push(gearBtn as HTMLButtonElement);
  titleRow.append(titleEl, gearBtn);
  statsRow.append(statsText, titleMeta);
  const transportEl = el('div', 'lr-transport');
  /** Only ever visible when the input failed; see `paintInputState`. */
  const inputNote = el('div', 'input-note');
  inputNote.style.display = 'none';
  // The storage banner used to live here. It is on the shell now, so it shows on the Library
  // too — which is the entry point, and the screen a first-run user in a private window meets
  // before any of this exists. One copy, not two.
  header.append(titleRow, statsRow, inputNote, transportEl);

  /**
   * Two lines for two kinds of number. Tempo, bars and time signature are what the project *is*,
   * locked once a pass exists (§1.2), so they sit with the title. Passes and size are what it has
   * *become* and move every take, so they change without redrawing the name.
   */
  function paintTitle() {
    // From the rows, not `opts.project` — that is the snapshot the screen was built with, and
    // edits only come back on the next mount, so the numbers would freeze mid-session.
    const live: Project = { ...project, layers: rows.map((r) => r.layer) };
    const passes = projectTotalPasses(live);
    const size = sizeProjection(live);
    titleEl.textContent = project.name;
    // The time signature is deliberately absent. Nothing in the app can change it — §4.6 lists no
    // control and `beatsPerBar` is only ever the default — so printing it spent a third of the
    // line on a number that never varies and cannot be acted on. It is still in the `Project` and
    // still drives the arithmetic; put it back here when there is a way to set it.
    titleMeta.textContent = `${project.bpm} BPM · ${project.barCount} Bars`;
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
      // **A take in progress cannot be seeked.** The length committed is `frameNow() -
      // recordingFrom`, so moving the clock under a running take reports a traversal nobody
      // played: forward it claims passes with no audio, back it claims none and is declined.
      if (capturingIndex() >= 0) return;
      // The engine is the clock (§2.4), so a seek moves the engine, not a private counter.
      const target = Math.round(fraction * loop);
      heldFrame = target;
      previousProgress = fraction;
      if (playing) opts.engine.start(target);
    },
  });
  const position = el('div', 'lr-position');

  /**
   * The monitoring level (§4.2). **Not screen state** — it is read from and written back to the
   * shell, because this screen is rebuilt on every navigation and a listening level that reset
   * itself on a trip to Edit Layer would be worse than not having one.
   *
   * 0..1, so it only ever trims down: the mix lives on the layer rows, where `Layer.level` runs
   * past unity to +6 dB. Unity is the default and the right-hand end, which is what makes this a
   * monitor rather than a second fader — and it is why `levelSlider`'s midpoint unity tick and
   * double-tap are not reused here.
   */
  let masterLevel = opts.master().level;
  let masterMuted = opts.master().muted;
  const pushMaster = () => {
    masterVol.update();
    opts.onMaster({ level: masterLevel, muted: masterMuted });
  };
  const masterVol = LR.VolumeControl({
    large: true,
    // `* 100` is `level / max * 100` with a max of 1 — the same normalisation `levelPercent` does
    // for layer rows, where the max is 2. Passing a raw 0..2 there saturated the icon at unity.
    level: () => masterLevel * 100,
    muted: () => masterMuted,
    onToggle() {
      masterMuted = !masterMuted;
      pushMaster();
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
    pushMaster();
  });
  transportEl.append(playBtn, progressBar, position, masterVol, masterSlider);

  /**
   * **Pausing while a take is running commits it, exactly as the record control does.**
   *
   * It delegates to `setRec` rather than duplicating the commit, so the two paths cannot drift,
   * and the order is load-bearing: `setRec` reads the take's length from `frameNow()`, which
   * falls back to `heldFrame` once the engine stops — stopping first would commit a take of zero
   * frames and the domain would decline it (§1.4). `setRec`'s stop branch calls back here once
   * the row is no longer recording, and that call does the transport work.
   */
  function setPlaying(on: boolean) {
    if (!on) {
      const capturing = capturingIndex();
      if (capturing >= 0) {
        setRec(capturing, 'unarmed');
        return;
      }
    }
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

  /**
   * Arming is abandoned by touching anything else. Armed is a held intention, not a mode, and a
   * row left armed makes the next tap on any dot record a layer chosen minutes ago — arming is
   * exclusive, so it blocks every other dot in the meantime.
   *
   * **Everything inside the armed row is exempt**: setting its level or opening its panel is
   * preparation for the take. **Recording is not included** — a stray press must never end one.
   *
   * On `pointerdown`, so the decision is made before a click reaches what was pressed, which is
   * what lets a dot on another row disarm this one and arm itself in the same gesture.
   */
  const onPointerDownAnywhere = (e: PointerEvent) => {
    const armed = rows.findIndex((r) => r.rec === 'armed');
    if (armed < 0) return;
    if (rows[armed]!.el.contains(e.target as Node)) return;
    setRec(armed, 'unarmed');
  };
  document.addEventListener('pointerdown', onPointerDownAnywhere);

  function setRec(index: number, state: RecordState) {
    let stopped = false;
    rows.forEach((row, i) => {
      const next = i === index ? state : 'unarmed'; // arming is exclusive
      const was = row.rec;
      row.rec = next;
      row.el.classList.toggle('is-armed', next === 'armed');
      row.el.classList.toggle('is-recording', next === 'recording');


      if (next === 'recording' && was !== 'recording') {
        // **The peak does not carry between takes.** It is accumulated across frames and
        // cleared only when a line consumes it — so a take that ended between two lines left
        // its last peak sitting here, and the first line of the *next* take was drawn at the
        // height of the end of the one before. A waveform is the app's only picture of the
        // audio (§1.1), and its first line lying about the take it belongs to is the kind of
        // wrong that reads as a real transient.
        livePeak = 0;
        /**
         * A pass always begins on the downbeat, so recording restarts the loop — and the count-in
         * is the loop's own tail played into that restart (§4.6). `countInStartFrame` ends on the
         * loop point, so `loop` is the downbeat in engine frames whatever the count-in length,
         * and with it off the two collapse to the frame recording has always started on.
         *
         * `recordingFrom` is the downbeat, not the transport's start: the take's length is
         * `frameNow() - recordingFrom`, so counting from the start would credit the count-in as
         * recorded bars. Stopping *during* it gives a negative difference, which clamps to zero
         * and the domain declines the take — which is the behaviour we want anyway.
         */
        const countIn = opts.countIn();
        const lead = countInFrames(countIn.bars, t);
        countInFrom = lead > 0 ? countInStartFrame(countIn.bars, t) : 0;
        countInUntil = lead > 0 ? loop : 0;
        heldFrame = countInFrom;
        previousProgress = 0;
        recordingFrom = countInUntil;
        // Drums only silences the chords and every layer for those bars; the full-loop mode plays
        // them, which is what tells you what you are joining.
        opts.engine.setCountIn(countIn.mode === 'drums' ? countInUntil : 0);
        opts.engine.start(countInFrom);
        startCountIn(row, countIn.bars);
        // Told before the take rather than after: the layer being recorded onto is silent for
        // the duration (§2.2), and that has to be true from the first bar, not from the commit.
        opts.engine.setLayers(liveProject(), opts.takes, i);
        // The stream can still go between arming and the downbeat — a device unplugged, a
        // permission revoked in another tab. Backing out is the same rule as refusing to arm:
        // never run a take that cannot record.
        void opts.engine.startCapture().then((ok) => {
          paintInputState();
          if (!ok) setRec(i, 'unarmed');
        });
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
        endCountIn(row);
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
    lockExits();
    // There was an `is-arming` toggle here, the armed equivalent of `is-capturing`, whose only
    // job was letting CSS out-specify the kit's empty-open record hint. The hint is gone, so
    // `.is-armed` paints the armed row on its own and this described nothing.

    if (stopped) {
      // The take ends where it ends, and the downbeat is where the next pass will start.
      setPlaying(false);
      // A committed pass can widen the badge, which shares the label column with the name.
      syncLabelWidth();
    }
  }

  /**
   * Lock the ways off the screen for the length of a take. Armed is *not* locked: it holds no
   * audio, and `onPointerDownAnywhere` already abandons it when attention moves elsewhere.
   */
  function lockExits() {
    const busy = capturingIndex() >= 0;
    root.classList.toggle('is-capturing', busy);
    for (const button of exits) button.disabled = busy;
    opts.onBusyChange?.(busy);
  }

  /**
   * Arm a row, but **only if there is something to record with** (§3.5).
   *
   * The record dot means "this will record". Letting it light up when the microphone has been
   * refused produced a take of nothing that the domain committed as a real pass: the badge
   * advanced, the arrangement was built on it, and the pass count and size projection both grew
   * by audio that does not exist. Refusing to arm is the only place that can be prevented, because
   * everything after it is correct given a take.
   *
   * **Instant when the input is already open**, which it is for every arm after the first. Only a
   * cold start waits, so the pending state is the permission prompt and nothing else.
   */
  async function arm(row: Row) {
    if (opts.engine.hasInput()) {
      setRec(row.layer.index, 'armed');
      return;
    }
    row.pending = true;
    row.el.classList.add('is-pending');
    const ok = await opts.engine.openInput();
    row.pending = false;
    row.el.classList.remove('is-pending');
    paintInputState();
    if (ok) setRec(row.layer.index, 'armed');
  }

  function capturedSession(layer: Layer, frames: number): RecordingSession {
    const id = newTakeId(`${layer.id}-take`);
    return {
      id,
      audioFileURL: takeUrl(id),
      recordedFrames: frames,
      recordedAt: new Date().toISOString(),
      waveformPeaks: [],
    };
  }

  /**
   * Push the layer state at the engine. Level, mute, EQ and pan are live gestures (§2.8) and have
   * to reach the graph now. The capturing index goes with them, or a level nudge during a take
   * un-silences the layer being recorded onto (§2.2).
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
   * Async because the worklet flushes its last partial chunk first, which is what keeps the tail
   * of a take. Nothing on screen waits: the pass count, badge and lanes were decided by
   * `recordSession` against the engine's frame count.
   */
  async function commitCapture(row: Row, session: RecordingSession, keep: boolean) {
    const raw = await opts.engine.stopCapture();
    // The microphone is open across the count-in — arming opens it early so the downbeat is never
    // spent waiting on a prompt — so what it heard in those bars is trimmed off here rather than
    // being allowed into the session. §5.1 #3: the first frame has to be the downbeat.
    const captured = raw && countInUntil > 0 ? trimToDownbeat(raw, countInUntil) : raw;
    if (captured && keep) {
      opts.takes.put(session, captured.buffer);
      // Peaks go onto the session the domain already committed. Display only — nothing derives
      // from them — so filling them late is safe, and the buffer arrives after the flush anyway.
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
   * Say so when the microphone is unavailable, rather than recording silence in silence. The
   * error text is verbatim: the difference between a denied permission, an insecure origin and no
   * device is the whole of what a user needs.
   */
  /**
   * Say what happened and what to do about it. The three cases need three different things from
   * the user and only the first is fixable without leaving the app, so they are worded apart
   * rather than printed as an exception name.
   */
  const INPUT_MESSAGE: Record<string, string> = {
    denied:
      'Microphone access was refused, so there is nothing to record with. ' +
      'Allow it for this site in your browser settings, then arm the layer again.',
    missing: 'No microphone found. Connect one, then arm the layer again.',
    insecure: 'Recording needs a secure connection — open this over https, or on localhost.',
  };

  function paintInputState() {
    const failure = opts.engine.inputError();
    inputNote.textContent = failure
      ? (INPUT_MESSAGE[failure.kind] ?? `The microphone could not be opened — ${failure.detail}.`)
      : '';
    inputNote.style.display = failure ? '' : 'none';
  }

  function layerRow(initial: Layer): Row {
    const rowEl = el('div', 'lr-row');
    const head = el('div', 'lr-row-head');

    const dot = LR.RecordDot({
      state: () => row.rec,
      blocked: () => {
        // A pass in progress owns the input, and so does a prompt that is still open — a second
        // tap while the browser is asking would queue an arm against an answer nobody has yet.
        if (rows.some((r) => r.pending)) return true;
        const c = capturingIndex();
        return c >= 0 && c !== row.layer.index;
      },
      set: (s) => (s === 'armed' ? void arm(row) : setRec(row.layer.index, s)),
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
    /**
     * The count-in indicator, in the lane the waveform is about to fill. That space is empty for
     * the whole count-in and for the first lines of the take, so a countdown costs no layout and
     * lands exactly where attention already is.
     *
     * One pip per beat rather than a number per bar: coming in on time needs the beat, and the
     * pips read as a bar of the grid the drums are playing.
     */
    const countInEl = el('div', 'count-in');
    countInEl.style.display = 'none';
    wave.append(note, rule, countInEl);

    // Before the volume control, which calls `update()` in its constructor and reads `row.layer`.
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
      pending: false,
      syncPanel() {},
      live: [],
      countIn: countInEl,
      pips: [],
      resetA: 0,
    };

    const volume = LR.VolumeControl({
      level: () => levelPercent(row.layer.level),
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

    const volumeRow = el('div', 'lr-panel-row', '<span class="lr-panel-label">Volume</span>');
    volumeRow.appendChild(
      levelSlider(
        () => row.layer.level,
        (next) => {
          row.layer = { ...row.layer, level: next };
          volume.update();
          opts.onChange(row.layer);
          syncLayers();
          // The lane draws the level, so it follows the fader. One row, not every lane — this
          // fires per pixel of the drag, and peaks are looked up rather than recomputed. Not while
          // armed or recording: the lane is hidden then, and `build` would delete the live lines.
          if (row.rec === 'unarmed') buildLane(row);
        },
      ),
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
    exits.push(editBtn as HTMLButtonElement);
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
      syncCollapse(rowEl, panel);
    });
    // An empty row hides the presets and the Edit button, so gaining audio changes an open
    // panel's height. Measured rather than guessed, so that needs no second CSS case.
    row.syncPanel = () => syncCollapse(rowEl, panel);
    bindChips(panel);

    row.volume = volume;
    bindName(label.querySelector('.layer-name')!, row);
    layersEl.appendChild(rowEl);
    paintRow(row);
    return row;
  }

  function paintRow(row: Row) {
    const recorded = layerHasRecording(row.layer);
    row.syncPanel();
    row.el.classList.toggle('has-audio', recorded);
    row.el.classList.toggle('is-empty', !recorded);
    row.el.classList.toggle('is-muted', row.layer.muted);
    const count = totalPasses(layerPassIndex(row.layer, t));
    row.note.textContent = recorded ? `${count} pass${count === 1 ? '' : 'es'} recorded` : 'empty';
    row.note.style.display = recorded ? 'none' : '';
    paintBadge(row);
  }

  /**
   * The pass badge (§3.9). While recording it shows the traversal in progress, provisional until
   * it has earned a bar — the same `passExists` that decides survival at the stop, so the badge
   * previews the gate rather than restating it. Otherwise it names the pass about to be captured.
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
   * The lane is an overview of the **arrangement**, not of the last take, so a slot draws the
   * material its `BarRef` points at. Height indexes on the source, colour on the layer — on this
   * screen colour is layer identity (§4.4), and the source ramp is the Edit Layer grid's job.
   */
  function buildLanes() {
    for (const row of rows) buildLane(row);
  }

  function buildLane(row: Row) {
    const bars = project.barCount;
    const linesPerSlot = Math.max(1, Math.round(lineCount / bars));
    if (!layerHasRecording(row.layer)) return;
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
      // simulated; drawing a *recorded* bar from a generator would be a lie.
      // Scaled by the layer's level, so the lane shows what the mix does with the take.
      const level = levelScaledHeight(
        (ref && barAmplitude(row.layer, index, ref, lineInSlot, linesPerSlot)) ??
          amp(row.layer.index, src, lineInSlot, linesPerSlot),
        row.layer.level,
      );
      return {
        height: silent ? 2 : motion.snapEven(level * LANE_AMPLITUDE, 2),
        rgb: ramp.rgb(from + (to - from) * u),
      };
    });
    // `build` replaces the lane's children, so everything that lives *beside* the lines has to
    // be put back — the count-in included, or it survives only on layers that have never been
    // recorded, which is exactly the set you are least likely to be counting into.
    row.wave.append(row.note, row.rule, row.countIn);
  }

  function clearLive(row: Row) {
    for (const node of row.live) node.remove();
    row.live = [];
  }

  /**
   * Live capture, drawn from the input rather than invented.
   *
   * This runs every frame and draws a line about once a second, so the peak has to be
   * **accumulated** across frames and cleared only when a line consumes it: `inputPeak()` resets
   * on read, so sampling it only when a line is due would throw away fifty-nine readings in sixty
   * and the line would show the last 16 ms rather than the second it stands for. The committed
   * waveform takes a true maximum over the same span, and the two have to agree.
   *
   * Same display gain as the committed waveform, so a take does not change height at the stop.
   */
  /**
   * Build the pips for a take, one per beat of the count-in, and show them.
   *
   * Beats rather than bars: coming in on time is a beat-level question, and a bar of pips reads as
   * the grid the drums are playing. `beatsPerBar` is the project's, not a constant — §5.1 #1 is
   * explicit that 4 is never hardcoded even while 4/4 is the only signature.
   */
  function startCountIn(row: Row, bars: number) {
    row.countIn.innerHTML = '';
    row.pips = [];
    for (let i = 0; i < bars * project.beatsPerBar; i++) {
      const pip = el('i', i % project.beatsPerBar === 0 ? 'is-downbeat' : '');
      row.countIn.appendChild(pip);
      row.pips.push(pip);
    }
    row.countIn.style.display = bars > 0 ? '' : 'none';
  }

  /** Light the pips up to the beat the transport has reached. Called from the render loop. */
  function paintCountIn(row: Row, frame: number) {
    if (!row.pips.length) return;
    const beats = countInUntil - countInFrom;
    const per = beats / row.pips.length;
    // `floor(elapsed / per) + 1` — a pip lights as its beat *begins*, unlike the live waveform
    // below, which draws a line only once its span has been heard. A count-in is a cue, so it has
    // to be ahead of the sound rather than behind it.
    const lit = Math.floor((frame - countInFrom) / per) + 1;
    for (let i = 0; i < row.pips.length; i++) {
      row.pips[i]!.classList.toggle('is-lit', i < lit);
    }
  }

  function endCountIn(row: Row) {
    if (row.countIn.style.display === 'none' && !row.pips.length) return;
    row.countIn.style.display = 'none';
    row.pips = [];
  }

  function pushLive(row: Row, upto: number) {
    const [from, to] = ramp.slice(row.layer.index, LAYER_COUNT);
    livePeak = Math.max(livePeak, opts.engine.inputPeak());
    // At the layer's level too, or the take would change height at the stop.
    const peak = levelScaledHeight(drawnHeight(livePeak), row.layer.level);
    if (row.live.length < upto) livePeak = 0;
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
   * The label column is fixed width so every lane starts at the same x, but measured from the
   * names actually present rather than the longest one a layer could have. `LABEL_MAX_PX` stops
   * one long name spending every lane's width; past it names ellipsize.
   *
   * The badge takes the name's place while armed and recording, so the column holds whichever is
   * wider — otherwise the lane shifts sideways on the row being watched most closely.
   *
   * Changing this changes the lane width, and the lane's `ResizeObserver` re-runs `syncSizing`.
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
  const frames = renderLoop((dt) => {
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

      if (row.rec === 'recording' && frame < countInUntil) {
        // Counting in. Nothing is drawn of the input yet — the microphone is open and its audio
        // is about to be trimmed off (§5.1 #3), so a waveform here would show material that never
        // reaches the take. The progress rule stays at zero for the same reason: no pass has
        // started, and sweeping it through the count-in would say one had.
        paintCountIn(row, frame);
        paintBadge(row);
      } else if (row.rec === 'recording') {
        endCountIn(row);
        // `floor(head)`, not `floor(head) + 1`: a line is drawn once its span has been *heard*,
        // not when it is entered. Drawing on entry appended line 0 before a single sample had
        // arrived, so every take opened with a line of silence the committed waveform did not
        // have. The cost is that the drawing trails the progress rule by one line, which is
        // what it means to draw a waveform of something that has already happened.
        pushLive(row, Math.floor(head));
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
   * Escape unwinds one level at a time: disarm first (§3.5), then leave. A pass in progress owns
   * the screen, so Escape does neither while one is running.
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

  /**
   * The Playback sheet (§4.7), from the approved copy in the "Playback Help Sheet" study: three
   * tabbed pages, each sized to be read without scrolling on the smallest current phone.
   *
   * **The illustrations are built from the app's own renderers**, not redrawn. `eqIconSvg` and
   * `panIconSvg` take the real presets out of `src/domain`, and the swipe arrow and gear are the
   * icons the screen itself uses — so a preset added or an icon changed cannot leave the help
   * showing something the app no longer does.
   */
  const swipeArrow = (size = 11) =>
    `<svg class="hs-ax" viewBox="0 0 24 24" width="${size}" height="${size}">${SWIPE_Y_ICON}</svg>`;

  const helpPages = [
    {
      label: 'Backing Tracks',
      content: () => [
        helpLede(
          'You don’t have to start completely from scratch — backing tracks can help you lock ' +
            'into a groove.',
        ),
        helpSection('Drum Loops', ['Tap the drum track, then swipe to choose a pattern and kit.']),
        helpFigure(
          `<span class="hs-lbl">Pattern</span><span class="hs-name">${
            drumPattern(project.backing.drums.patternId).name
          }</span>${swipeArrow()}`,
        ),
        helpSection('Chord Progressions', [
          'Select a chord by tapping it, then change it by swiping the selection wheels.',
        ]),
        helpFigure(
          '<span class="hs-chips"><b class="on">C</b><b>C</b><b>C</b><b>C</b></span>' +
            '<span class="hs-div"></span>' +
            `<span class="hs-wheels"><i>C${swipeArrow(7)}</i><i>♮${swipeArrow(7)}</i>` +
            `<i>Maj${swipeArrow(7)}</i></span>`,
        ),
        helpSection('', [
          'Tap the chord track, then swipe to choose a pattern and instrument tone — experiment ' +
            'by shifting the pitch up or down an octave.',
        ]),
        helpFigure(
          '<span class="hs-lbl">Octave</span>' +
            '<span class="hs-chips"><b>Low</b><b class="on">Default</b><b>High</b></span>',
        ),
      ],
    },
    {
      label: 'Recording',
      content: () => [
        helpSection('Arming a track', [
          'Tap a track’s record dot to arm it. It turns red and pulses. If you’re not ready to ' +
            'record, tap anywhere else to cancel.',
        ]),
        helpFigure(
          '<span class="hs-dot"><i></i>Unarmed</span><span class="hs-dot"><i class="armed"></i>Armed</span>',
          'hs-figure--bare',
        ),
        helpSection('Recording a pass', [
          'Once your track is armed, tap the dot again to start recording.',
          'The label shows the current pass and turns solid once you’ve recorded a full bar; ' +
            'passes that don’t reach one are discarded.',
          'Don’t worry about recording over your old work — every time you record, it’s stored ' +
            'as a new pass to choose from.',
          'Tap the dot again to end the recording.',
        ]),
        helpFigure(
          '<span class="hs-badge"><b class="lr-pass-badge is-provisional">Pass 6</b>recording…</span>' +
            '<span class="hs-badge"><b class="lr-pass-badge">Pass 6</b>bar complete</span>',
          'hs-figure--bare',
        ),
        helpSection('Adjusting for microphone latency', [
          'If your recording sounds offbeat, adjust the timing with the latency slider in ' +
            `Project settings (tap <svg class="hs-ico" viewBox="0 0 24 24">${SETTINGS_ICON}</svg>).`,
        ]),
        helpFigure(
          '<span class="hs-lbl">Offset</span><span class="hs-slider" style="--v:44%"></span>' +
            '<span class="hs-val">110ms</span>',
        ),
      ],
    },
    {
      label: 'Mixing',
      content: () => [
        helpLede('Make each layer stand out with mixing presets.'),
        helpSection('Volume', ['Adjust the volume of each layer independently.']),
        helpFigure('<span class="hs-slider hs-slider--unity" style="--v:50%"></span>'),
        helpSection('EQ', [
          'Shape the sonic profile of each track to minimize frequency overlap between tracks.',
        ]),
        helpFigure(
          EQ_PRESETS.map(
            (p) =>
              `<span class="${p.id === 'presence' ? 'on' : ''}">${eqIconSvg(p.id, 18)}</span>`,
          ).join(''),
          'hs-figure--icons',
        ),
        helpSection('Panning', [
          'Balance your mix in the stereo field by panning different elements in different ' +
            'directions.',
        ]),
        helpFigure(
          PAN_PRESETS.map(
            (p) =>
              `<span class="${p.id === 'slightL' ? 'on' : ''}">${panIconSvg(p, 18)}</span>`,
          ).join(''),
          'hs-figure--icons',
        ),
      ],
    },
  ];

  const help = helpControl({ title: 'Playback', pages: helpPages });

  // Up to the Library (§4.1). Secondary, because leaving is not what the screen is for.
  const backBtn = el(
    'button',
    'lr-btn back-btn',
    // The Library's chevron, mirrored. A text "‹" is a different weight at every font size and
    // sits on the baseline rather than centred.
    '<svg class="chev" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>Projects',
  );
  backBtn.addEventListener('click', () => opts.onBack());

  const exportBtn = el('button', 'lr-btn lr-btn--primary', 'Export');
  exportBtn.addEventListener('click', () => opts.onExport());
  exits.push(backBtn as HTMLButtonElement, exportBtn as HTMLButtonElement);

  // Help at the left edge, the two actions kept together on the right by an auto margin.
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
  // Measuring needs the nodes on the page; the guard is for a screen destroyed before that.
  let mounted = true;
  requestAnimationFrame(() => {
    if (!mounted) return;
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
    /**
     * Whether tearing this screen down would throw away a performance.
     *
     * The shell asks before it navigates, and that call is the enforcement — the dimmed
     * buttons above only say so. It reports on *recording*, not on armed: arming holds no
     * audio, and refusing to leave over an intention would be a mode rather than a guard.
     */
    takeInProgress: () => capturingIndex() >= 0,
    destroy() {
      mounted = false;
      frames.stop();
      observer?.disconnect();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDownAnywhere);
      help.destroy();
      opts.engine.stop();
    },
  };
}

/**
 * A preset picker: the label and the current preset's name on one line, the six icons on their
 * own below. Six icons cannot share a line with both and still be tappable. The icons are all the
 * user sees, so the name beside the label is the only place a preset is named.
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
    // `.lr-chips`, so stopping the event at the chip leaves the preset changed and the highlight
    // where it was. There is nothing above to guard against: the row head is the panel's sibling.
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
