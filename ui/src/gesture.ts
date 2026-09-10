/**
 * Pointer-drag tracking. **Every pointer gesture in the app goes through this** — do not write a
 * second one.
 *
 * **Press state is owned here, never asked of the platform.** `pointermove` fires on plain hover,
 * and the obvious guard, `hasPointerCapture`, does not work: capture is a *routing* hint that
 * survives a `pointerup` the page never receives — released outside the window, focus lost, the
 * browser taking the gesture over. Hover re-enters the element holding orphaned capture, the
 * guard passes, and the move is measured against an ancient origin, so the control steps with
 * nothing pressed. **The mockup guards that way, so copying it reintroduces the bug.**
 *
 * The answer, in one place:
 *
 * - an own `down` flag, set on `pointerdown` and cleared on every route out;
 * - a bail on `e.buttons === 0`, which catches the missed release itself;
 * - `lostpointercapture` and `pointercancel` treated as ends, because capture can go without a
 *   `pointerup` ever arriving.
 */

/** Handed to the handlers: travel so far, and the two things a gesture needs to say back. */
export type Drag = {
  /** Travel since the press began, or since the last `rebase`. */
  readonly dx: number;
  readonly dy: number;
  /**
   * Move the origin to the current point. A drag that steps something calls this so one long
   * drag can step repeatedly instead of once.
   */
  rebase(): void;
  /**
   * Say the gesture did something. The release is then not a tap — this is what keeps a swipe,
   * or a hold that fired, from also counting as a press.
   */
  consume(): void;
};

export function trackDrag(
  node: HTMLElement,
  handlers: {
    onStart?(e: PointerEvent, drag: Drag): void;
    onMove?(e: PointerEvent, drag: Drag): void;
    /** Only when the press began on this element and nothing consumed it. */
    onTap?(e: PointerEvent): void;
    /** Every route out: release, cancel, lost capture, or a move with no button held. */
    onEnd?(): void;
  },
): void {
  let down = false;
  let consumed = false;
  let x0 = 0;
  let y0 = 0;
  let x = 0;
  let y = 0;

  const drag: Drag = {
    get dx() {
      return x - x0;
    },
    get dy() {
      return y - y0;
    },
    rebase() {
      x0 = x;
      y0 = y;
    },
    consume() {
      consumed = true;
    },
  };

  function end() {
    down = false;
    handlers.onEnd?.();
  }

  node.addEventListener('pointerdown', (e) => {
    down = true;
    consumed = false;
    x0 = x = e.clientX;
    y0 = y = e.clientY;
    node.setPointerCapture(e.pointerId);
    handlers.onStart?.(e, drag);
  });

  node.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (e.buttons === 0) {
      end();
      return;
    }
    x = e.clientX;
    y = e.clientY;
    handlers.onMove?.(e, drag);
  });

  node.addEventListener('pointerup', (e) => {
    // Read before releasing capture. `lostpointercapture` is queued rather than dispatched
    // synchronously, so today it lands after this handler — but that is a detail of the event
    // loop to depend on, and reading first costs nothing.
    const wasDown = down;
    const wasConsumed = consumed;
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    end();
    if (wasDown && !wasConsumed) handlers.onTap?.(e);
  });

  node.addEventListener('lostpointercapture', end);
  node.addEventListener('pointercancel', end);

  // **The fifth thing that suppresses zoom, and the only one iOS actually obeys on a tile.**
  //
  // `touch-action` was supposed to be the whole answer: `manipulation` on `html, body` means "auto
  // minus double-tap zoom", and a tile's stricter `none` should subsume it. It does not. WebKit
  // still ran its double-tap-to-zoom recogniser on the tiles and zoomed the viewport onto the slot
  // — reported from an iPhone twice, the second time *after* the CSS was in — and on a screen that
  // is nothing but swipe targets a stuck zoom makes the app unusable.
  //
  // Preventing the second `touchend` is what actually stops it, and it belongs here because
  // `trackDrag` is exactly the set of elements that have claimed the touch for themselves. That is
  // a property, not a list to keep in sync with the markup: anything that gains a drag gains this.
  //
  // Three constraints keep it from eating real input:
  //   - It fires only on the SECOND tap of a pair, so an ordinary tap is untouched.
  //   - The taps must land within `ZOOM_TAP_PX` of each other, which is what the zoom recogniser
  //     itself requires. Two quick taps on different controls are not a double tap and keep their
  //     clicks — `levelSlider`'s double-tap-to-unity is a `dblclick` on a native range input, which
  //     is not a `trackDrag` node and never reaches this.
  //   - `preventDefault` here kills the *compatibility mouse events*, not the pointer events above.
  //     Every gesture in this app is built on those, so they are unaffected.
  //
  // `passive: false` is required: touch-adjacent listeners default to passive, and a passive
  // listener may not call `preventDefault` — it fails silently, which is how this looks fixed and
  // is not.
  node.addEventListener(
    'touchend',
    (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      const now = performance.now();
      const near =
        Math.abs(t.clientX - lastTapX) < ZOOM_TAP_PX && Math.abs(t.clientY - lastTapY) < ZOOM_TAP_PX;
      if (e.cancelable && near && now - lastTapEnd < ZOOM_TAP_MS) e.preventDefault();
      lastTapEnd = now;
      lastTapX = t.clientX;
      lastTapY = t.clientY;
    },
    { passive: false },
  );
}

/**
 * Shared across every `trackDrag` node rather than held per node, because the zoom recogniser is
 * the browser's and does not care that the two taps landed on different tiles. Per-node state
 * would miss a double tap that straddles a tile boundary, which is most of them on a grid this
 * dense.
 */
let lastTapEnd = 0;
let lastTapX = 0;
let lastTapY = 0;
/** Wider than the app's own 300 ms double tap: this has to close over the browser's window too. */
const ZOOM_TAP_MS = 400;
const ZOOM_TAP_PX = 40;
