/**
 * Pointer-drag tracking, and the one thing this app has to get right about it.
 *
 * **Press state is owned here, never asked of the platform.** `pointermove` fires on plain
 * hover, so a move handler that does not know whether a button is down will act on hover. The
 * obvious guard, `hasPointerCapture`, does not work: capture is a *routing* hint and it survives
 * a `pointerup` the page never receives — released outside the window, focus lost, the browser
 * taking the gesture over. Hover then re-enters the element still holding orphaned capture, the
 * guard passes, and the move is measured against an origin from minutes ago. An enormous delta,
 * and the control steps with nothing pressed.
 *
 * That bug shipped once, from the mockup, which guards this way — so copying the mockup
 * reintroduces it (CLAUDE.md). It was then written a second time in a second control. This
 * module exists so there is exactly one copy of the answer:
 *
 * - an own `down` flag, set on `pointerdown` and cleared on every route out;
 * - a bail on `e.buttons === 0`, which catches the missed release itself, since mouse and touch
 *   both report no buttons once up;
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
}
