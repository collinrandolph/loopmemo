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
import { demoLibrary } from './sim.ts';
import { takeStore } from './takes.ts';

/**
 * Shell for the UI pass: the screens over the real domain and a simulated engine.
 *
 * Project state lives here as immutable values, replaced on every edit — the same shape the
 * domain functions already take and return, so nothing needs an adapter. The Library is the
 * entry point (§4.1); everything else is reached from a project.
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
 * Captured audio, held here rather than on a screen or an engine.
 *
 * Both of those are rebuilt on every navigation, and a take has to outlive them — recording on
 * Playback and then opening Edit Layer to hunt through the passes is the app's central loop, and
 * it would be pointless if the audio went with the screen. It is deliberately not in the
 * `Project` either: a project is a value that gets copied on every edit, and copying it should
 * not mean copying tens of megabytes of samples.
 */
const takes = takeStore();

/**
 * The recording offset a new project starts on (§2.3).
 *
 * Latency is a property of the audio route rather than of the music, so the number that was
 * right for the last project is right for the next one on the same hardware. It is remembered
 * rather than made a global *setting*: a setting would be a second editor for one piece of
 * state, and what this is is a default.
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
 * Navigating runs `current.destroy()` and then closes the `AudioContext`, which takes the
 * capture worklet with it — so leaving Playback mid-take does not pause the performance, it
 * deletes it. Every route out of a screen funnels through here (the tab bar included), so the
 * rule is stated once rather than repeated at each caller, where the next one added would
 * simply forget it.
 *
 * A screen refusing is not an error to report: the controls that could get here are already
 * disabled, so reaching this is either the keyboard or a race, and in both cases the right
 * answer is that nothing happens.
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

  // Screens own a render loop and document-level listeners, so the outgoing one is torn down
  // before the next is built. Without it every navigation leaves a pass running over nodes
  // that are no longer on the page.
  //
  // The engine goes with it, and now that matters: an `AudioContext` is a real resource and
  // browsers cap how many a page may hold, so leaking one per navigation used to be free and is
  // not any more. Screen first, then engine — a screen's `destroy` stops the transport.
  current?.destroy();
  current = undefined;
  currentEngine?.destroy();
  host.innerHTML = '';

  // One engine per mount, at the open project's capture rate, so frame arithmetic on the
  // Playback and Edit screens is in the same units the domain computes in.
  //
  // A **sounding** engine, and it is the same `Engine` the simulated one implements — that type
  // was written as the seam a real engine would replace, so this is the swap happening rather
  // than a second path beside it. It plays the backing tracks it synthesises and the layers it
  // has been given audio for; the demo projects have none, so those stay silent until recorded.
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
          engine,
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
                // The project actions, which used to live in the Library's per-row panel. Each
                // arrives with pending edits already applied, so the screen persists what it is
                // handed rather than re-deriving it.
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
              // Read off the project, so muting a backing track on the Playback screen reaches
              // the export. These used to be hardcoded here — which meant the export always wrote
              // both stems no matter what the user had muted.
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
