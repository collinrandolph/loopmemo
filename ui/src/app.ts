import type { Layer, Project } from '../../src/domain/project.ts';
import { QUALITY_SPEC } from '../../src/domain/project.ts';
import { editLayerScreen } from './edit-layer.ts';
import { el } from './kit.ts';
import { playbackScreen } from './playback.ts';
import { demoProject, simulatedEngine } from './sim.ts';

/**
 * Shell for the UI pass: two screens over the real domain and a simulated engine.
 *
 * Project state lives here as one immutable value, replaced on every edit — the same shape the
 * domain functions already take and return, so nothing needs an adapter.
 */
let project: Project = demoProject();
const engine = simulatedEngine(QUALITY_SPEC[project.audioQuality].sampleRate);

type Route = { screen: 'playback' } | { screen: 'edit'; layerIndex: number };
let route: Route = { screen: 'playback' };

const nav = el('div', 'app-nav');
const host = el('div');
document.body.append(nav, host);

function replaceLayer(layer: Layer) {
  project = {
    ...project,
    layers: project.layers.map((l) => (l.index === layer.index ? layer : l)),
  };
}

function render() {
  nav.innerHTML = '';
  const tabs: { label: string; route: Route }[] = [
    { label: 'Playback', route: { screen: 'playback' } },
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
      (tab.route.screen !== 'edit' || tab.route.layerIndex === (route as { layerIndex: number }).layerIndex);
    const button = el('button', active ? 'is-active' : '', tab.label);
    button.addEventListener('click', () => {
      route = tab.route;
      render();
    });
    nav.appendChild(button);
  }

  host.innerHTML = '';
  host.appendChild(
    route.screen === 'playback'
      ? playbackScreen({
          project,
          onChange: replaceLayer,
          onEdit(layerIndex) {
            route = { screen: 'edit', layerIndex };
            render();
          },
        })
      : editLayerScreen({
          project,
          layerIndex: route.layerIndex,
          engine,
          onChange: replaceLayer,
        }),
  );
}

render();
