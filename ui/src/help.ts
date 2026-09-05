import { HELP_ICON } from './icons.ts';
import { el } from './kit.ts';

/**
 * The help affordance §4.7 asks for: what a screen does, on request.
 *
 * §4.7 describes a manual in sections, each readable in isolation and reached from the control it
 * explains. `docs/user-guide.md` is where that copy is written; a screen's sheet is the part of it
 * that belongs to that screen, condensed to what a phone-sized panel can hold. **The two are
 * separate on purpose and they move together** — the guide has room for illustrations and the
 * whole app, the sheet has room for a screenful, so this is a condensation rather than a copy.
 *
 * What it buys is the thing §4.7 is really about: several of these interactions are "powerful but
 * undiscoverable", and a footer running the length of the screen is where instructions go to be
 * ignored. Behind a question mark they are at least somewhere a user would think to look.
 */

/**
 * A titled group of points. Strings may carry inline `<b>` and `<em>`, which is the whole of the
 * markup the sheet needs — anything more is the guide's job, not a panel's.
 */
export function helpSection(title: string, points: string[]): HTMLElement {
  const section = el('section', 'lr-help-section');
  section.appendChild(el('h4', 'lr-help-h', title));
  const list = el('ul', 'lr-help-list');
  for (const point of points) list.appendChild(el('li', '', point));
  section.appendChild(list);
  return section;
}

/** A single emphasised line — the one thing on a screen worth reading before anything else. */
export function helpLede(text: string): HTMLElement {
  return el('p', 'lr-help-lede', text);
}
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
