import { trackDrag } from './gesture.ts';
import { SWIPE_Y_ICON } from './icons.ts';
import { el } from './kit.ts';

/** The two controls this app adds on top of `docs/kit/`, both used by more than one screen. */

export const SWIPE_THRESHOLD = 22; // shared with the Edit Layer tiles: one gesture, one travel

/**
 * One vertically-swipeable field.
 *
 * **Up steps forward**, matching the pass axis on the Edit Layer screen. Both are the same rule:
 * the material moves under the finger, so the next value is pulled in from the side you drag
 * toward — the filmstrip §3.7 states for the horizontal axis, applied to the vertical one it
 * leaves open.
 *
 * A tap steps too, upper half forward and lower half back, on the same axis as the drag: with a
 * mouse the drag is available but awkward, and a control with no tap affordance reads as inert.
 *
 * The press guard lives in `trackDrag` — see that file for why it is not `hasPointerCapture`.
 *
 * **Every wheel looks the same: the value, and a right-aligned `↕`.** What differs is only whether
 * the caption is drawn.
 *
 * - `row` is a full-width setting in a panel — Pattern, Kit, Tone. Its caption sits *outside* the
 *   control as an ordinary `.lr-panel-label`, so it reads as a labelled row like Volume, EQ and
 *   Pan directly above it.
 * - `inline` is the chord editor's Note / Sign / Type, three abreast, and draws **no caption at
 *   all**. Three fields reading C / ♮ / Maj under a chord button are self-describing, and a
 *   `↕ NOTE` under each one spent a line naming what the value already says. The arrow stays,
 *   because that is the part a value cannot tell you.
 *
 * The caption still names the control for assistive tech in both layouts, drawn or not.
 */
export function swipeWheel(
  caption: string,
  options: readonly { id: string; label: string }[],
  current: () => string,
  onPick: (id: string) => void,
  opts: { extraClass?: string; layout?: 'inline' | 'row' } = {},
): HTMLElement {
  const row = opts.layout === 'row';
  const node = el('div', `lr-wheel ${row ? 'lr-wheel--row' : ''} ${opts.extraClass ?? ''}`);
  node.setAttribute('aria-label', caption);
  const value = el('div', 'lr-wheel__value');
  node.append(value, el('span', 'lr-wheel__ax', `<svg viewBox="0 0 24 24">${SWIPE_Y_ICON}</svg>`));

  function paint(dir = 0) {
    value.textContent = options.find((o) => o.id === current())?.label ?? '';
    value.classList.remove('is-from-below', 'is-from-above');
    if (!dir) return;
    void value.offsetWidth; // restart the animation rather than let a repeat within one drag skip it
    // Forward is an upward drag, so the incoming value follows the finger up from underneath.
    value.classList.add(dir > 0 ? 'is-from-below' : 'is-from-above');
  }

  function step(dir: number) {
    const at = options.findIndex((o) => o.id === current());
    onPick(options[(at + dir + options.length) % options.length]!.id);
    paint(dir);
  }

  trackDrag(node, {
    onMove(_e, drag) {
      if (Math.abs(drag.dy) <= SWIPE_THRESHOLD) return;
      step(drag.dy > 0 ? -1 : 1); // inverted relative to travel, as both Edit Layer axes are
      drag.rebase(); // allow repeats within one drag
      drag.consume();
    },
    onTap(e) {
      const box = node.getBoundingClientRect();
      step(e.clientY < box.top + box.height / 2 ? 1 : -1);
    },
  });

  paint();
  if (!row) return node;

  // The label goes outside the control, so what the caller mounts is the panel row. The drag stays
  // bound to the wheel alone — a drag that started on the caption would step a value the finger
  // was never on.
  const wrap = el('div', 'lr-panel-row lr-wheel-row', `<span class="lr-panel-label">${caption}</span>`);
  wrap.appendChild(node);
  return wrap;
}

/**
 * Single-choice behaviour for a `.lr-chips` group: the clicked chip becomes the active one.
 * Delegated per group rather than per chip, so a group whose chips are rebuilt keeps working.
 */
export function bindChips(scope: HTMLElement): void {
  for (const group of scope.querySelectorAll<HTMLElement>('.lr-chips')) {
    group.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest('.lr-chip');
      if (!chip || !group.contains(chip)) return;
      for (const c of group.querySelectorAll('.lr-chip')) c.classList.remove('is-active');
      chip.classList.add('is-active');
    });
  }
}
