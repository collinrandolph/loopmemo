import { backingMixSources } from '../../src/domain/backing.ts';
import type { Layer, Project } from '../../src/domain/project.ts';
import { QUALITY_SPEC, projectTiming } from '../../src/domain/project.ts';
import { type BackingEngine, audioEngine } from './audio.ts';
import { editLayerScreen } from './edit-layer.ts';
import { exportScreen } from './export.ts';
import { el } from './kit.ts';
import { libraryScreen } from './library.ts';
import { playbackScreen } from './playback.ts';
import { projectSettingsScreen } from './settings.ts';
import { demoLibrary } from './demo.ts';
import { persistentStore } from './store.ts';
import {
  COUNT_IN_BAR_OPTIONS,
  COUNT_IN_DEFAULT,
  COUNT_IN_MODES,
  type CountIn,
  type CountInBars,
  type CountInMode,
} from '../../src/domain/count-in.ts';
import { DEFAULT_THEME, type ThemeId, applyTheme } from './theme.ts';
import { takeStore } from './takes.ts';

/**
 * Shell for the UI pass: the screens, over the real domain and a sounding engine.
 *
 * Project state lives here as immutable values, replaced on every edit — the same shape the domain
 * functions take and return, so nothing needs an adapter. The Library is the entry point (§4.1);
 * everything else is reached from a project.
 */
let projects: readonly Project[] = [];
// The most recently modified, which is what the Library puts at the top and what a user
// returning to the app last had open.
let openId = '';

type Route =
  | { screen: 'library' }
  | { screen: 'playback' }
  | { screen: 'edit'; layerIndex: number }
  // Export is reachable from two places, and cancelling has to put you back where you were —
  // an escape that lands somewhere you did not come from is a second navigation, not an escape.
  | { screen: 'export'; from: 'library' | 'playback' | 'settings' }
  // Setup and settings are one screen (see `settings.ts`); the mode decides only the commit verb
  // and whether recording quality can still be chosen.
  | { screen: 'settings'; mode: 'new' | 'edit' };
let route: Route = { screen: 'library' };

const nav = el('div', 'app-nav');
const host = el('div', 'app-host');
document.body.append(nav, host);

/**
 * A screen, plus its right to refuse being torn down.
 *
 * Only Playback implements `takeInProgress`, because only Playback holds something a teardown
 * would destroy. It is optional rather than a required `() => false` so a screen that cannot
 * lose anything does not have to say so.
 */
type Screen = { node: HTMLElement; destroy(): void; takeInProgress?(): boolean };

let current: Screen | undefined;
let currentEngine: BackingEngine | undefined;

const store = persistentStore();

/**
 * Captured audio, held here rather than on a screen or an engine — both are rebuilt on every
 * navigation, and record-then-edit is the app's central loop. Not in the `Project` either: that is
 * copied on every edit, and copying it should not mean copying tens of megabytes of samples.
 *
 * **Every route that files a take persists it**, because the write-through is here rather than at
 * the call sites — recording and compress both go through `put` and neither has to remember.
 */
const takes = takeStore((id, buffer) => store.saveTake(id, buffer));

/**
 * The recording offset a new project starts on (§2.3). Latency belongs to the audio route, not to
 * the music, so last project's number is right for the next one on the same hardware. A default,
 * not a global setting — a setting would be a second editor for one piece of state.
 */
let lastLatencyOffsetSeconds = 0;

/**
 * How loud the app is monitored at (§4.2). Here rather than on the Playback screen because that
 * screen is rebuilt on every navigation, and here rather than on a `Project` because it is a
 * property of the room you are listening in, not of the sketch — it does not travel with a bounce
 * and is not in an exported file. Every engine built below is told it, so the Library's row
 * previews obey it too.
 *
 * **The level persists and the mute does not.** A trim is a preference; a mute is a momentary act
 * — you mute to take a call — and restoring one on launch is an app that opens silent and looks
 * broken. The distinction is worth the extra line.
 */
let master = { level: 1, muted: false };
let masterWrite: number | undefined;

/**
 * The count-in (§4.6). Here for the same reasons as `master`: §5.1 #3 says it never touches the
 * audio, so it needs no per-project snapshot, and it describes how a person likes to start playing
 * rather than anything about a sketch. Both screens that touch it read this one value.
 */
let countIn: CountIn = COUNT_IN_DEFAULT;

function setCountIn(next: CountIn) {
  countIn = next;
  // Two keys rather than one JSON blob: each is independently readable, and a stored value that
  // fails its guard falls back on its own instead of taking the other down with it.
  store.savePref('count-in-bars', String(next.bars));
  store.savePref('count-in-mode', next.mode);
}

function setMaster(next: { readonly level: number; readonly muted: boolean }) {
  master = { level: next.level, muted: next.muted };
  currentEngine?.setMaster(master.level, master.muted);
  // The slider emits an event per pixel; the audio follows every one and the database does not.
  window.clearTimeout(masterWrite);
  masterWrite = window.setTimeout(() => store.savePref('master', String(master.level)), 300);
}

function open(): Project {
  return projects.find((p) => p.id === openId) ?? projects[0]!;
}

function replaceProject(next: Project) {
  projects = projects.map((p) => (p.id === next.id ? next : p));
  store.saveProject(next);
}

function replaceLayer(layer: Layer) {
  const project = open();
  replaceProject({
    ...project,
    layers: project.layers.map((l) => (l.index === layer.index ? layer : l)),
  });
}

/**
 * The only way the route changes, and the only place a change can be refused.
 *
 * Navigating destroys the screen and closes the `AudioContext`, which takes the capture worklet
 * with it, so leaving Playback mid-take deletes the performance rather than pausing it. Every
 * route out funnels through here, the tab bar included, so the rule is stated once.
 *
 * A refusal is not an error to report: the controls that reach here are already disabled, so this
 * is a keyboard or a race, and nothing happening is the right answer.
 */
function navigate(next: Route) {
  if (current?.takeInProgress?.()) return;
  route = next;
  render();
}

/**
 * The same rule, for the way out `navigate` cannot see.
 *
 * Every route *inside* the app funnels through `navigate`, which refuses while a take is running.
 * Leaving the page does not: a reload, a tab close, an iOS swipe-back or a pull-to-refresh takes
 * the whole document, and the take goes with it — a session is held in memory and written only at
 * the stop (`commitCapture`), so nothing on disk survives.
 *
 * **This is a mitigation, not the fix.** Spec §5.1 #7 settles that sessions are written
 * continuously and gives the reason — the raw performance is the only asset that cannot be
 * recreated — and the app has never done it. §5.1 #7 now records the divergence honestly; this
 * warning is worth having under either answer, and it is four lines.
 *
 * The predicate is asked, never cached, for the same reason `navigate` asks it: deriving the
 * answer from a notification would make it depend on the notification having arrived.
 */
window.addEventListener('beforeunload', (e) => {
  if (!current?.takeInProgress?.()) return;
  // Both halves are required and neither is enough alone — browsers disagree about which they
  // honour, and the wording is the browser's either way.
  e.preventDefault();
  e.returnValue = '';
});

function render() {
  const project = open();

  nav.innerHTML = '';
  const tabs: { label: string; route: Route }[] = [
    { label: 'Projects', route: { screen: 'library' } },
    { label: project.name, route: { screen: 'playback' } },
    ...project.layers
      .filter((l) => l.sessions.length > 0)
      .map((l) => ({
        label: `Edit · ${l.name || `Layer ${l.index + 1}`}`,
        route: { screen: 'edit' as const, layerIndex: l.index },
      })),
  ];

  for (const tab of tabs) {
    const active =
      tab.route.screen === route.screen &&
      (tab.route.screen !== 'edit' ||
        tab.route.layerIndex === (route as { layerIndex: number }).layerIndex);
    const button = el('button', active ? 'is-active' : '', tab.label);
    // Through `navigate`, not straight to `render` — the tab bar is a way off Playback like any
    // other, and it was the one that skipped the guard by setting the route itself.
    button.addEventListener('click', () => navigate(tab.route));
    nav.appendChild(button);
  }

  // Screens own a render loop and document listeners, so the outgoing one is torn down first, or
  // every navigation leaves a pass running over detached nodes. The engine goes with it — an
  // `AudioContext` is a capped resource. Screen first: its `destroy` stops the transport.
  current?.destroy();
  current = undefined;
  currentEngine?.destroy();
  host.innerHTML = '';

  // One engine per mount, at the open project's capture rate, so frame arithmetic on the screens
  // is in the units the domain computes in. It plays the backing it synthesises and the layers it
  // has audio for; the demo projects have none, so those stay silent until recorded.
  const engine = audioEngine(QUALITY_SPEC[project.audioQuality].sampleRate);
  engine.setBacking(project.backing, projectTiming(project));
  // A fresh engine on every navigation, so it has to be told what the layers hold each time.
  engine.setLayers(project, takes);
  engine.setMaster(master.level, master.muted);
  currentEngine = engine;

  // Where an escape from Export lands: back where it was opened from, never somewhere else.
  const back: Route =
    route.screen !== 'export'
      ? { screen: 'library' }
      : route.from === 'settings'
        ? { screen: 'settings', mode: 'edit' }
        : { screen: route.from };

  const screen =
    route.screen === 'library'
      ? libraryScreen({
          projects,
          /**
           * An engine loaded with the project about to be previewed. Reconfiguring is enough while
           * the rate matches; a context cannot change its sample rate, so the other quality needs
           * a new one. Stopped first, because `setBacking` re-anchors a running engine on a tempo
           * change and would start the new project a beat before `start(0)` says so.
           */
          engineFor(previewed) {
            const rate = QUALITY_SPEC[previewed.audioQuality].sampleRate;
            let next = currentEngine;
            if (!next || next.sampleRate !== rate) {
              currentEngine?.destroy();
              next = audioEngine(rate);
              currentEngine = next;
            } else {
              next.stop();
            }
            next.setBacking(previewed.backing, projectTiming(previewed));
            next.setLayers(previewed, takes);
            // A row preview is monitoring too, so it obeys the same trim as the open project.
            next.setMaster(master.level, master.muted);
            return next;
          },
          onOpen(id) {
            openId = id;
            navigate({ screen: 'playback' });
          },
          onNew: () => navigate({ screen: 'settings', mode: 'new' }),
          onTheme: (id) => store.savePref('theme', id),
        })
      : route.screen === 'playback'
        ? playbackScreen({
            project,
            engine,
            takes,
            onChange: replaceLayer,
            countIn: () => countIn,
            master: () => master,
            onMaster: setMaster,
            onBackingChange(backing) {
              replaceProject({ ...open(), backing });
              // Straight to the engine as well as into state: a kit swap or a mute has to be
              // audible on the next bar, not on the next navigation.
              engine.setBacking(backing, projectTiming(open()));
            },
            onEdit: (layerIndex) => navigate({ screen: 'edit', layerIndex }),
            onSettings: () => navigate({ screen: 'settings', mode: 'edit' }),
            onBack: () => navigate({ screen: 'library' }),
            storage: () => ({ kind: store.status(), unsaved: store.unsaved().length }),
            onStorageChange: (listener) => store.onStatusChange(listener),
            onExport: () => navigate({ screen: 'export', from: 'playback' }),
            // The tab bar belongs to the shell, so the screen cannot dim it itself. Enforcement
            // is still `navigate`; this only stops the bar from advertising a way out that a
            // take in progress will refuse.
            onBusyChange(busy) {
              for (const button of nav.querySelectorAll('button')) button.disabled = busy;
            },
          })
        : route.screen === 'edit'
          ? editLayerScreen({
              project,
              layerIndex: route.layerIndex,
              engine,
              takes,
              onChange: replaceLayer,
              onDone: () => navigate({ screen: 'playback' }),
            })
          : route.screen === 'settings'
            ? projectSettingsScreen({
                // For `new` this is only a source of defaults — the tempo, length and beats per
                // bar a fresh project starts on. Nothing about the open project is written to.
                //
                // The recording offset is overridden with the last value the user set rather
                // than inherited from whichever project happened to be open, because it is a
                // property of the audio route and not of the music (§2.3).
                project:
                  route.mode === 'new'
                    ? { ...project, latencyOffsetSeconds: lastLatencyOffsetSeconds }
                    : project,
                mode: route.mode,
                engine,
                takes,
                countIn: () => countIn,
                onCountIn: setCountIn,
                onCommit(next) {
                  lastLatencyOffsetSeconds = next.latencyOffsetSeconds;
                  if (route.screen === 'settings' && route.mode === 'new') {
                    projects = [...projects, next];
                    store.saveProject(next);
                    openId = next.id;
                    navigate({ screen: 'playback' });
                    return;
                  }
                  replaceProject(next);
                  navigate({ screen: 'playback' });
                },
                onCancel: () =>
                  navigate({
                    screen: route.screen === 'settings' && route.mode === 'new' ? 'library' : 'playback',
                  }),
                // Each action arrives with pending edits already applied, so the shell persists
                // what it is handed rather than re-deriving it.
                onExport(next) {
                  replaceProject(next);
                  navigate({ screen: 'export', from: 'settings' });
                },
                onCompress(next) {
                  replaceProject(next);
                  navigate({ screen: 'playback' });
                },
                onBounce(source, seed) {
                  // The source is written back first: it carries any pending rename, and §2.7 is
                  // explicit that a bounce leaves it otherwise untouched.
                  replaceProject(source);
                  projects = [...projects, seed];
                  store.saveProject(seed);
                  openId = seed.id;
                  navigate({ screen: 'playback' });
                },
                onDelete(id) {
                  projects = projects.filter((p) => p.id !== id);
                  store.deleteProject(id);
                  // Its takes are nobody's now; `sweep` collects them on the next boot.
                  openId = projects[0]?.id ?? '';
                  navigate({ screen: 'library' });
                },
              })
          : exportScreen({
              project,
              engine,
              // Read off the project, so muting a backing track on Playback reaches the export.
              backing: backingMixSources(project.backing),
              tracks: project.backing,
              takes,
              // Back where you came from, not always the Library.
              // Straight through to the project: the settings screen edits the same value, and
              // this screen has no commit step to defer it to.
              onPerfectLoop: (next) => replaceProject({ ...open(), perfectLoop: next }),
              onCancel: () => navigate(back),
              onShare: () => navigate(back),
            });

  current = screen;
  host.appendChild(screen.node);
}

/**
 * Read take audio back, newest-looking first, and tell the engine as it lands.
 *
 * Nothing waits for this. Peaks travel with the project, so every waveform is already correct;
 * what arrives here is only the ability to *hear* a layer. The open project goes first so the
 * screen you are looking at is the one that starts working.
 *
 * A take in progress is left alone: `setLayers` without the capturing index would un-silence the
 * layer being recorded onto (§2.2), and navigation is blocked during a take anyway.
 */
async function hydrate(sweep: boolean) {
  const live = new Set<string>();
  for (const p of projects) for (const l of p.layers) for (const s of l.sessions) live.add(s.id);
  // Only when the saved list is what we are holding. Sweeping against a freshly seeded demo shelf
  // would delete every real take on disk.
  if (sweep) store.sweep(live);

  const openFirst = [...live].sort((a, b) => Number(b.startsWith(openId)) - Number(a.startsWith(openId)));
  for (const id of openFirst) {
    if (takes.has(id)) continue;
    const audio = await store.loadTake(id);
    if (!audio) continue;
    const buffer = new OfflineAudioContext(1, audio.samples.length, audio.sampleRate).createBuffer(
      1,
      audio.samples.length,
      audio.sampleRate,
    );
    buffer.getChannelData(0).set(audio.samples);
    takes.restore(id, buffer);
    // Per take rather than at the end: the horizon already scheduled stays silent either way, but
    // everything after it picks the buffer up, so a long project starts sounding as it loads.
    //
    // **Only where the open project is what is playing.** Two screens preview something else —
    // the Library plays the row you tapped, project settings previews the project you are about
    // to create — and both load the engine themselves. Pushing `open()` here regardless meant a
    // take finishing its load mid-preview swapped the audio underneath, so a Library row started
    // as the row and finished as the open project. The route already says which screens play the
    // open project; asking it needs no new contract with the screens.
    const playsOpenProject = route.screen === 'playback' || route.screen === 'edit';
    if (playsOpenProject && !current?.takeInProgress?.()) currentEngine?.setLayers(open(), takes);
  }
}

/**
 * Projects first, audio behind them.
 *
 * **The saved list is authoritative once it exists, including when it is empty** — a user who
 * deleted every project meant it, and re-seeding the demo shelf over that would be the app
 * arguing with them. The shelf is a first-run convenience, and every row of it is deletable.
 */
async function boot() {
  // Before anything renders, so no frame is painted in the wrong colourway.
  applyTheme(((await store.loadPref('theme')) as ThemeId | undefined) ?? DEFAULT_THEME);
  // Mute is deliberately not restored — see `master`. A stored value outside 0..1 is ignored
  // rather than clamped: it means something else wrote the key, and unity is the safe reading.
  const savedMaster = Number(await store.loadPref('master'));
  if (savedMaster >= 0 && savedMaster <= 1) master = { level: savedMaster, muted: false };
  // Each half is validated against its own option list rather than trusted, so a hand-edited or
  // stale key falls back to the default instead of reaching the engine as a bar count it cannot
  // schedule. `bars` is read as a number because that is what it is; the key holds its digits.
  const savedBars = Number(await store.loadPref('count-in-bars'));
  const savedMode = await store.loadPref('count-in-mode');
  countIn = {
    bars: (COUNT_IN_BAR_OPTIONS as readonly number[]).includes(savedBars)
      ? (savedBars as CountInBars)
      : COUNT_IN_DEFAULT.bars,
    mode: (COUNT_IN_MODES as readonly string[]).includes(savedMode ?? '')
      ? (savedMode as CountInMode)
      : COUNT_IN_DEFAULT.mode,
  };
  const saved = await store.loadProjects();
  projects = saved ?? demoLibrary();
  if (!saved) for (const p of projects) store.saveProject(p);
  openId = [...projects].sort((a, b) => b.lastModified.localeCompare(a.lastModified))[0]?.id ?? '';
  render();
  void hydrate(saved !== undefined);
}

/**
 * Pinch-zoom, which is the one route CSS cannot close.
 *
 * `touch-action: manipulation` removes double-tap zoom and `user-scalable=no` is ignored by iOS,
 * so pinch is what is left. Safari raises its own non-standard `gesture*` events for it; other
 * browsers raise nothing here and the listeners cost nothing.
 *
 * `passive: false` is required — a passive listener may not call `preventDefault`, and the
 * default for touch-adjacent events is passive, so omitting it looks correct and does nothing.
 */
for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(name, (e) => e.preventDefault(), { passive: false });
}

void boot();
