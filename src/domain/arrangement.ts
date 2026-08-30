import { type BarRef, barRef, barRefEquals, steppingBar } from './bar-ref.ts';
import { type PassIndex, type SourceRegion, regionFor, steppingPass } from './pass-index.ts';

/**
 * The arrangement: one BarRef per slot.
 *
 * There is deliberately no separate per-bar selection map alongside it — two structures
 * describing the same thing is exactly how they drift apart (§1.5).
 *
 * Every operation here returns a new array. Editing happens while audio is playing (§2.5),
 * so a mutation visible to a scheduler mid-pass is a race waiting to happen.
 */
export type Arrangement = readonly BarRef[];

/** Recorded order: slot n plays pass 1's bar n. */
export function recordedOrder(barCount: number): Arrangement {
  return Array.from({ length: barCount }, (_, i) => barRef(1, i + 1));
}

function requireSlot(arrangement: Arrangement, slot: number): BarRef {
  const ref = arrangement[slot];
  if (!ref) throw new RangeError(`slot ${slot} outside 0..${arrangement.length - 1}`);
  return ref;
}

export function setSlot(arrangement: Arrangement, slot: number, ref: BarRef): Arrangement {
  requireSlot(arrangement, slot);
  const next = arrangement.slice();
  next[slot] = ref;
  return next;
}

/**
 * Vertical swipe: step which pass fills this slot.
 *
 * Wraps through the passes that exist for **this bar position**, skipping gaps (§1.4).
 * Returns the arrangement unchanged when there is nowhere to go — a bar with one available
 * pass is the state that disables the axis on the Edit Layer screen (§4.3), and it is
 * derived from audio, not from a flag.
 */
export function stepPassAt(
  arrangement: Arrangement,
  slot: number,
  delta: number,
  index: PassIndex,
): Arrangement {
  const current = requireSlot(arrangement, slot);
  const stepped = steppingPass(index, current, delta);
  if (!stepped || barRefEquals(stepped, current)) return arrangement;
  return setSlot(arrangement, slot, stepped);
}

/**
 * Horizontal swipe: step which bar of the source fills this slot.
 *
 * Wraps within the same pass — a horizontal swipe never changes the pass (§1.3).
 *
 * Note the axis is inverted relative to travel in the UI: swiping LEFT steps forward, the
 * way a filmstrip moves under the finger (§3.7). That inversion belongs at the gesture
 * layer; this function takes a plain signed delta.
 */
export function stepBarAt(
  arrangement: Arrangement,
  slot: number,
  delta: number,
  barCount: number,
): Arrangement {
  const current = requireSlot(arrangement, slot);
  const stepped = steppingBar(current, delta, barCount);
  if (barRefEquals(stepped, current)) return arrangement;
  return setSlot(arrangement, slot, stepped);
}

/**
 * Slots pointing at audio that does not exist.
 *
 * Should always be empty in a healthy project — the swipe axes only ever land on available
 * passes. It is worth being able to ask, because a compress or a clear that went wrong
 * shows up here rather than as silence at playback time.
 */
export function unresolvedSlots(arrangement: Arrangement, index: PassIndex): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < arrangement.length; slot++) {
    if (!regionFor(index, arrangement[slot]!)) out.push(slot);
  }
  return out;
}

/**
 * Whether the arrangement is still in recorded order from this slot onward.
 *
 * This is what the colour gradient shows (§1.1): smooth colour flow across tiles means the
 * bars are still in recorded order, and a colour jump means that bar was pulled from
 * elsewhere. Exposed as a predicate so the same question has one answer.
 */
export function isRecordedOrderAt(arrangement: Arrangement, slot: number): boolean {
  const ref = arrangement[slot];
  return ref !== undefined && ref.pass === 1 && ref.relativeBar === slot + 1;
}

/**
 * What compressing this layer keeps, and what its arrangement becomes (§2.7).
 *
 * Compress discards every recorded pass and keeps each layer's final edited loop. The
 * retained loop is **standardised to Pass 1** and bars are **renumbered to the arranged
 * order**, because the original numbering referenced audio that no longer exists.
 *
 * `regions` is what to render, in slot order — the mixdown is the concatenation of them.
 * `arrangement` is what the layer holds afterwards: plain recorded order over the single
 * retained pass.
 *
 * Returns undefined if any slot is unresolved. Compressing an arrangement that points at
 * missing audio would bake a silent bar into the one copy that survives.
 */
export function compressionPlan(
  arrangement: Arrangement,
  index: PassIndex,
): { regions: SourceRegion[]; arrangement: Arrangement } | undefined {
  const regions: SourceRegion[] = [];
  for (const ref of arrangement) {
    const region = regionFor(index, ref);
    if (!region) return undefined;
    regions.push(region);
  }
  return { regions, arrangement: recordedOrder(arrangement.length) };
}
