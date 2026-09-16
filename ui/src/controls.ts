import { trackDrag } from './gesture.ts';
import { SWIPE_Y_ICON } from './icons.ts';
import { LEVEL_MAX, LEVEL_UNITY } from '../../src/domain/project.ts';
import { el } from './kit.ts';

/** The two controls this app adds on top of `docs/kit/`, both used by more than one screen. */

export const SWIPE_THRESHOLD = 22; // shared with the Edit Layer tiles: one gesture, one travel

/**
 * One vertically-swipeable field.
 *
 * **Up steps forward**, matching the pass axis: the material moves under the finger, so the next
 * value is pulled in from the side you drag toward (§3.7's filmstrip, on the vertical axis). A
 * tap steps too — upper half forward, lower half back — because a mouse drag is awkward and a
 * control with no tap affordance reads as inert.
 *
 * **Every wheel is the value with a right-aligned `↕`**; the layouts differ only in whether the
 * caption is drawn. `row` puts it outside as a `.lr-panel-label`, so a panel of wheels reads as
 * labelled rows alongside Volume, EQ and Pan. `inline` — the chord editor's Note / Sign / Type —
 * draws none, because C / ♮ / Maj under a chord button say what they are. The caption goes on as
 * `aria-label` either way.
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
      // **A disabled chip moves nothing, including the highlight.** This moves the active class
      // independently of whatever the chip's own handler does, which is the whole point — one
      // mechanism, so the highlight cannot drift from the value. But it made the settings lock
      // lie in the other direction: the per-chip handler returned early on `locked` while this
      // still repainted, so a locked project showed 4 bars and held 16, and Standard quality
      // looked like High. Same failure as the EQ picker's, seen from the other side — there the
      // value moved and the highlight did not.
      if (chip.getAttribute('aria-disabled') === 'true') return;
      for (const c of group.querySelectorAll('.lr-chip')) c.classList.remove('is-active');
      chip.classList.add('is-active');
    });
  }
}

/**
 * A level fader that can be pushed past unity, marks where unity is, and snaps back on a
 * double tap.
 *
 * **Past unity because a take arrives at whatever the system input gave it** (§6.1). The app
 * cannot set that gain — no browser or iOS API offers it — so the only remedy for a quiet
 * recording is to raise it afterwards, and a fader that stops at 1 has none. `LEVEL_MAX` is
 * +6 dB.
 *
 * **Unity is the midpoint**, which is what makes it markable: half the travel attenuates and
 * half boosts, so the tick sits dead centre and the neutral position is findable by eye.
 * The double tap is the same thing for the hand, and it is what stops "back to normal" being a
 * hunt for a value you cannot see.
 *
 * The volume icon stays coarse above unity — §3.5 already says the arcs are the readout and
 * precision belongs on the slider, so the thumb's position past the tick is the fine reading.
 */
/**
 * A level as the percentage the volume icon fills to.
 *
 * **Over the whole range, not just the attenuating half.** The icon divides by 100 internally and
 * clamps, so passing `level * 100` filled it completely at unity and every decibel of the +6 dB
 * above that moved nothing — the control looked identical at 1.0 and at 2.0. Dividing by
 * `LEVEL_MAX` puts unity at half fill, which is also where the fader's tick is, so the coarse
 * readout and the fine one agree about where neutral is.
 */
export function levelPercent(level: number): number {
  return (level / LEVEL_MAX) * 100;
}

export function levelSlider(level: () => number, onInput: (next: number) => void): HTMLElement {
  const wrap = el('div', 'lr-level');
  const input = el('input', 'lr-level__range') as HTMLInputElement;
  input.type = 'range';
  input.min = '0';
  input.max = String(Math.round(LEVEL_MAX * 100));
  input.value = String(Math.round(level() * 100));
  input.addEventListener('input', () => onInput(Number(input.value) / 100));
  // `dblclick` rather than a hand-rolled double tap: this is a native control, not one of the
  // gesture surfaces `trackDrag` exists for, and `touch-action: manipulation` in the CSS is what
  // stops a phone treating the second tap as a zoom.
  input.addEventListener('dblclick', () => {
    input.value = String(Math.round(LEVEL_UNITY * 100));
    onInput(LEVEL_UNITY);
  });
  wrap.appendChild(input);
  return wrap;
}

/**
 * The Perfect loop setting (§2.6), as a row of two chips.
 *
 * **One control, mounted twice.** It is the primary setting on the project settings screen and
 * appears again on Export, where the choice is usually made — both read and write the same
 * `project.perfectLoop`, so they are two views of one value rather than the second editor §1.5
 * warns about. `refresh` lets a mount re-read after the other one has changed it.
 */
export function perfectLoopRow(
  value: () => boolean,
  onPick: (next: boolean) => void,
): { node: HTMLElement; refresh(): void } {
  const row = el('div', 'lr-panel-row', '<span class="lr-panel-label">Perfect loop</span>');
  const chips = el('div', 'lr-chips');
  const on = el('span', 'lr-chip', 'On');
  const off = el('span', 'lr-chip', 'Off');
  chips.append(on, off);
  row.appendChild(chips);

  const refresh = () => {
    on.classList.toggle('is-active', value());
    off.classList.toggle('is-active', !value());
  };
  on.addEventListener('click', () => onPick(true));
  off.addEventListener('click', () => onPick(false));
  bindChips(row);
  refresh();
  return { node: row, refresh };
}
