import type { Layer, Project } from '../../src/domain/project.ts';
import { QUALITY_SPEC } from '../../src/domain/project.ts';
import { editLayerScreen } from './edit-layer.ts';
import { el } from './kit.ts';
import { libraryScreen } from './library.ts';
import { playbackScreen } from './playback.ts';
import { demoLibrary, simulatedEngine } from './sim.ts';

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
  | { screen: 'export' };
let route: Route = { screen: 'library' };

const nav = el('div', 'app-nav');
const host = el('div', 'app-host');
document.body.append(nav, host);

let current: { destroy(): void } | undefined;

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

function render() {
  const project = open();
  // One engine per mount, at the open project’s capture rate, so frame arithmetic on the
  // Playback and Edit screens is in the same units the domain computes in.
  const engine = simulatedEngine(QUALITY_SPEC[project.audioQuality].sampleRate);

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
    button.addEventListener('click', () => {
      route = tab.route;
      render();
    });
    nav.appendChild(button);
  }

  // Screens own a render loop and document-level listeners, so the outgoing one is torn down
  // before the next is built. Without it every navigation leaves a pass running over nodes
  // that are no longer on the page.
  current?.destroy();
  current = undefined;
  host.innerHTML = '';

  const screen =
    route.screen === 'library'
      ? libraryScreen({
          projects,
          engine,
          onOpen(id) {
            openId = id;
            route = { screen: 'playback' };
            render();
          },
          onExport(id) {
            openId = id;
            route = { screen: 'export' };
            render();
          },
          onChange(next) {
            projects = next;
            if (!projects.some((p) => p.id === openId)) openId = projects[0]?.id ?? '';
          },
        })
      : route.screen === 'playback'
        ? playbackScreen({
            project,
            engine,
            onChange: replaceLayer,
            onEdit(layerIndex) {
              route = { screen: 'edit', layerIndex };
              render();
            },
          })
        : route.screen === 'edit'
          ? editLayerScreen({
              project,
              layerIndex: route.layerIndex,
              engine,
              onChange: replaceLayer,
              onDone() {
                route = { screen: 'playback' };
                render();
              },
            })
          : exportPlaceholder();

  current = screen;
  host.appendChild(screen.node);
}

/** The Export screen is next; this keeps the route reachable in the meantime. */
function exportPlaceholder(): { node: HTMLElement; destroy(): void } {
  const node = el('div', 'lr-screen');
  node.append(
    el('div', 'lr-header', '<div class="lr-title-row"><div class="lr-title">Export</div></div>'),
    el('div', 'grid', '<div class="lr-note">Not built yet.</div>'),
  );
  return { node, destroy() {} };
}

render();
