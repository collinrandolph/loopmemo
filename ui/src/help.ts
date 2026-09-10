import { HELP_ICON } from './icons.ts';
import { el } from './kit.ts';

/**
 * The help affordance §4.7 asks for: the gestures a screen supports, on request.
 *
 * **This is a placeholder for the manual, not the manual.** §4.7 describes a real one: sections
 * on editing, recording setup and everything else, each readable in isolation, reached by deep
 * link from the control it explains, with "reading the gradient" named as the highest-value
 * entry — which is why the Edit Layer screen's legend lives in here now rather than under the
 * grid. What this holds is the text that was already on screen, moved rather than written.
 * Building it out properly is a later job (§4.7, and build order step 8).
 *
 * What it does buy now is the thing §4.7 is really about: the Edit Layer screen's interactions
 * are "powerful but undiscoverable", and a footer running the length of the screen is where
 * instructions go to be ignored. Behind a question mark they are at least somewhere a user
 * would think to look.
 */
export function helpControl(opts: { title: string; content(): (HTMLElement | string)[] }): {
  node: HTMLElement;
  destroy(): void;
} {
  const node = el('button', 'lr-help', HELP_ICON);
  node.setAttribute('aria-label', 'Help');
  node.setAttribute('type', 'button');

  let overlay: HTMLElement | undefined;

  function close() {
    overlay?.remove();
    overlay = undefined;
  }

  // Capture phase, so Escape closes the sheet instead of reaching the screen behind it — both
  // listeners sit on `document`, and a bubble-phase one there cannot be stopped from a sibling.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !overlay) return;
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);

  function open() {
    close();
    const sheet = el('div', 'lr-help-sheet');
    const head = el('div', 'lr-help-head', `<span>${opts.title}</span>`);
    const closeBtn = el('button', 'lr-help-close', '×');
    closeBtn.setAttribute('aria-label', 'Close');
    head.appendChild(closeBtn);

    const body = el('div', 'lr-help-body');
    for (const part of opts.content()) {
      // Callers hand over live nodes as well as strings — the Edit Layer legend is one element
      // that `refresh` keeps painted, so it is moved in rather than copied and left to go stale.
      body.append(typeof part === 'string' ? el('p', 'lr-help-text', part) : part);
    }

    sheet.append(head, body);
    overlay = el('div', 'lr-help-overlay');
    overlay.appendChild(sheet);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(); // the backdrop, not the sheet
    });
    closeBtn.addEventListener('click', close);
    document.body.appendChild(overlay);
  }

  node.addEventListener('click', () => (overlay ? close() : open()));

  return {
    node,
    destroy() {
      close();
      document.removeEventListener('keydown', onKey, true);
    },
  };
}
