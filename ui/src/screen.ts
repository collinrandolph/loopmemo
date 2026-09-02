import { el } from './kit.ts';

/**
 * The pieces every screen needs and none of them owns.
 *
 * Each of these was written out once per screen and drifted: four render loops, four byte
 * formatters that disagreed about small sizes, and two confirmations with the same markup.
 */

/**
 * An animation loop that can be stopped.
 *
 * A screen is rebuilt on every navigation, so a loop with no stop leaves a render pass running
 * forever over detached nodes. `dt` is milliseconds since the last frame, clamped so a
 * backgrounded tab does not resume with one enormous step.
 */
export function renderLoop(frame: (dt: number) => void): { stop(): void } {
  let alive = true;
  let last = performance.now();
  const step = (now: number) => {
    if (!alive) return;
    const dt = Math.min(now - last, 50);
    last = now;
    frame(dt);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return {
    stop() {
      alive = false;
    },
  };
}

/**
 * A size, in the unit that reads best at that magnitude.
 *
 * Nothing is ever "0.0 MB": a project with no recordings has no size, and a rounded zero looks
 * like a measurement that failed.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB';
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * Confirmation in place, stating the outcome (§4.1) — never a generic prompt.
 *
 * The host keeps `is-confirming` while a question is open, so the screen can hide the buttons the
 * question is about. `reset` is what Cancel restores, which differs: the layer drawer redraws its
 * two actions, the settings screen simply closes the box.
 */
export function confirmPanel(
  host: HTMLElement,
  box: HTMLElement,
  reset: () => void,
): (text: string, label: string, danger: boolean, run: () => void) => void {
  return (text, label, danger, run) => {
    box.innerHTML =
      `<div class="confirm-text">${text}</div>` +
      `<button class="lr-btn ${danger ? 'lr-btn--danger' : 'lr-btn--primary'}" data-yes>${label}</button>` +
      '<button class="lr-btn" data-no>Cancel</button>';
    host.classList.add('is-confirming');
    box.querySelector('[data-yes]')!.addEventListener('click', () => {
      host.classList.remove('is-confirming');
      run();
    });
    box.querySelector('[data-no]')!.addEventListener('click', () => {
      host.classList.remove('is-confirming');
      reset();
    });
  };
}

/**
 * Size a `max-height` collapse to what the panel actually holds. Call after toggling the class.
 *
 * The kit collapses with `max-height`, and a CSS value has to clear the tallest content the panel
 * will ever hold — which costs time on the way back, because `max-height` has to fall past the
 * content before the box starts shrinking, and needs a per-case override the moment one panel is
 * shorter than the guess. Measuring is the whole of the movement.
 */
export function syncCollapse(host: HTMLElement, panel: HTMLElement, openClass = 'is-open'): void {
  panel.style.maxHeight = host.classList.contains(openClass) ? `${panel.scrollHeight}px` : '0px';
}

/** A row whose content lines up under the control column, with an empty label as the spacer. */
export function annotationRow(node: HTMLElement): HTMLElement {
  const row = el('div', 'lr-panel-row setting-annotation', '<span class="lr-panel-label"></span>');
  row.appendChild(node);
  return row;
}
