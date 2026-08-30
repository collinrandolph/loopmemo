/**
 * Where a bar's audio came from: which traversal of the loop, and which bar within it.
 *
 * Both fields are 1-based. This pair exists rather than a flat absolute bar number
 * because the two swipe axes map directly onto it (spec §1.3) — vertical steps `pass`,
 * horizontal steps `relativeBar`.
 *
 * A BarRef is a *source*. Where it sits in the arrangement is its *slot*, which is just
 * its index in the arrangement array. The two are never the same thing (§1.1), and
 * collapsing them destroys the Edit Layer screen.
 */
export type BarRef = {
  readonly pass: number;
  readonly relativeBar: number;
};

export function barRef(pass: number, relativeBar: number): BarRef {
  if (!Number.isInteger(pass) || pass < 1) {
    throw new RangeError(`pass is 1-based, got ${pass}`);
  }
  if (!Number.isInteger(relativeBar) || relativeBar < 1) {
    throw new RangeError(`relativeBar is 1-based, got ${relativeBar}`);
  }
  return { pass, relativeBar };
}

export function barRefEquals(a: BarRef, b: BarRef): boolean {
  return a.pass === b.pass && a.relativeBar === b.relativeBar;
}

/**
 * Decompose a 0-based absolute bar number.
 *
 * §1.3 states this with 1-based absolute bars; this takes 0-based, which is what array
 * indices and frame arithmetic actually produce. The spec's verified examples still
 * hold — 1-based bar 17 in a 16-bar loop is 0-based 16, and gives P2 / 1.
 */
export function fromAbsolute(absoluteBar: number, barCount: number): BarRef {
  if (!Number.isInteger(absoluteBar) || absoluteBar < 0) {
    throw new RangeError(`absolute bar is 0-based, got ${absoluteBar}`);
  }
  requireBarCount(barCount);
  return barRef(Math.floor(absoluteBar / barCount) + 1, (absoluteBar % barCount) + 1);
}

/** Recompose to a 0-based absolute bar number. */
export function toAbsolute(ref: BarRef, barCount: number): number {
  requireBarCount(barCount);
  return (ref.pass - 1) * barCount + (ref.relativeBar - 1);
}

/**
 * Step the horizontal axis, wrapping within the same pass.
 *
 * Stepping `relativeBar` off the end does NOT roll into the next pass. That would change
 * both coordinates from a single horizontal swipe, which is exactly the conflation the
 * {pass, relativeBar} pair exists to prevent (§1.3).
 *
 * Availability is deliberately not consulted here. §1.4 requires the *vertical* axis to
 * wrap through the available set for the bar being swiped, which needs the recorded
 * audio — that lives on `PassIndex.steppingPass`.
 */
export function steppingBar(ref: BarRef, delta: number, barCount: number): BarRef {
  requireBarCount(barCount);
  const zeroBased = ref.relativeBar - 1 + delta;
  const wrapped = ((zeroBased % barCount) + barCount) % barCount;
  return barRef(ref.pass, wrapped + 1);
}

export function formatBarRef(ref: BarRef): string {
  return `P${ref.pass}/${ref.relativeBar}`;
}

function requireBarCount(barCount: number): void {
  if (!Number.isInteger(barCount) || barCount < 1) {
    throw new RangeError(`barCount must be a positive integer, got ${barCount}`);
  }
}
