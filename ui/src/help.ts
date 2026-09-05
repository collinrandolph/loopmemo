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
/**
 * One page of a sheet. A screen with a single page shows its title; a screen with several shows
 * them as tabs, which is what lets the Playback sheet cover backing, recording and mixing without
 * any of the three needing to scroll.
 */
export type HelpPage = { label: string; content(): (HTMLElement | string)[] };

export function helpControl(opts: { title: string; pages: HelpPage[] }): {
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
    const head = el('div', 'lr-help-head');
    const body = el('div', 'lr-help-body');

    /**
     * Each page is built on demand and the body replaced, rather than all of them being built and
     * hidden. They hold live nodes — the Edit Layer legend is one `refresh` keeps painted — and
     * three copies of those would be two that quietly go stale.
     */
    function show(index: number) {
      body.innerHTML = '';
      for (const part of opts.pages[index]!.content()) {
        body.append(typeof part === 'string' ? el('p', 'lr-help-text', part) : part);
      }
      for (const [i, tab] of tabs.entries()) tab.classList.toggle('is-active', i === index);
      body.scrollTop = 0;
    }

    const tabs: HTMLElement[] = [];
    if (opts.pages.length > 1) {
      const strip = el('div', 'lr-help-tabs');
      for (const [i, page] of opts.pages.entries()) {
        const tab = el('button', 'lr-help-tab', page.label);
        tab.setAttribute('type', 'button');
        tab.addEventListener('click', () => show(i));
        tabs.push(tab);
        strip.appendChild(tab);
      }
      head.appendChild(strip);
    } else {
      head.appendChild(el('span', '', opts.title));
    }

    const closeBtn = el('button', 'lr-help-close', '×');
    closeBtn.setAttribute('aria-label', 'Close');
    head.appendChild(closeBtn);
    show(0);

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

/**
 * A strip of real controls under a point, showing what it is talking about.
 *
 * They are built from the app's own icon renderers and class names rather than redrawn, so a
 * preset added or a badge restyled cannot leave the help illustrating something that no longer
 * exists. `hs-figure--bare` drops the card, for figures that are already shapes on their own.
 */
export function helpFigure(html: string, variant = ''): HTMLElement {
  return el('div', `hs-figure ${variant}`.trim(), html);
}
