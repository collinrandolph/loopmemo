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
import { takeStore } from './takes.ts';

/**
 * Shell for the UI pass: the screens, over the real domain and a sounding engine.
 *
 * Project state lives here as immutable values, replaced on every edit — the same shape the domain
 * functions take and return, so nothing needs an adapter. The Library is the entry point (§4.1);
 * everything else is reached from a project.
 */
let projects: readonly Project[] = demoLibrary();
// The most recently modified, which is what the Library puts at the top and what a user
// returning to the app last had open.
let openId = [...projects].sort((a, b) => b.lastModified.localeCompare(a.lastModified))[0]!.id;

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

/**
 * Captured audio, held here rather than on a screen or an engine — both are rebuilt on every
 * navigation, and record-then-edit is the app's central loop. Not in the `Project` either: that is
 * copied on every edit, and copying it should not mean copying tens of megabytes of samples.
 */
const takes = takeStore();

/**
 * The recording offset a new project starts on (§2.3). Latency belongs to the audio route, not to
 * the music, so last project's number is right for the next one on the same hardware. A default,
 * not a global setting — a setting would be a second editor for one piece of state.
 */
let lastLatencyOffsetSeconds = 0;

function open(): Project {
  return projects.find((p) => p.id === openId) ?? projects[0]!;
}

function replaceProject(next: Project) {
  projects = projects.map((p) => (p.id === next.id ? next : p));
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
            return next;
          },
          onOpen(id) {
            openId = id;
            navigate({ screen: 'playback' });
          },
          onNew: () => navigate({ screen: 'settings', mode: 'new' }),
        })
      : route.screen === 'playback'
        ? playbackScreen({
            project,
            engine,
            takes,
            onChange: replaceLayer,
            onBackingChange(backing) {
              replaceProject({ ...open(), backing });
              // Straight to the engine as well as into state: a kit swap or a mute has to be
              // audible on the next bar, not on the next navigation.
              engine.setBacking(backing, projectTiming(open()));
            },
            onEdit: (layerIndex) => navigate({ screen: 'edit', layerIndex }),
            onSettings: () => navigate({ screen: 'settings', mode: 'edit' }),
            onBack: () => navigate({ screen: 'library' }),
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
                onCommit(next) {
                  lastLatencyOffsetSeconds = next.latencyOffsetSeconds;
                  if (route.screen === 'settings' && route.mode === 'new') {
                    projects = [...projects, next];
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
                  openId = seed.id;
                  navigate({ screen: 'playback' });
                },
                onDelete(id) {
                  projects = projects.filter((p) => p.id !== id);
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
              onCancel: () => navigate(back),
              onShare: () => navigate(back),
            });

  current = screen;
  host.appendChild(screen.node);
}

render();
