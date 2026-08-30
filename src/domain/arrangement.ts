import { type BarRef, barRef, barRefEquals, steppingBar } from './bar-ref.ts';
import {
  type PassIndex,
  type SourceRegion,
  hasAudio,
  regionFor,
  steppingPass,
} from './pass-index.ts';
import { framesPerBar } from './timing.ts';

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

/**
 * Slots silenced on this layer — a rest in the pattern (§3.7, tap and hold).
 *
 * Stored as sparse slot indices rather than a boolean per slot. A parallel array would have
 * to stay exactly `barCount` long forever, and two arrays with a shared length invariant is
 * how they drift apart; a sparse list has no invariant to break. Every slot being muted at
 * once is a legitimate state and costs 32 numbers at the very worst.
 *
 * Deliberately **not** folded into `BarRef`. A BarRef says where audio came from and is used
 * to look up regions; muting is an arrangement decision about a slot. Different questions.
 *
 * **Scope is the slot, not the source.** Since swiping is locked while a bar is muted, no
 * gesture can ever move a mute onto different audio, so the two readings are not even
 * distinguishable in use — slot is the one that matches the grid the user is looking at.
 *
 * **Layer mute is separate and composes at read time** (see `isSilentAt`). Writing a layer
 * mute through into these would destroy the record of which bars the user muted on purpose,
 * so unmuting the layer could not restore them.
 */
export type MutedSlots = readonly number[];

export const NONE_MUTED: MutedSlots = [];

/** Recorded order: slot n plays pass 1's bar n. */
export function recordedOrder(barCount: number): Arrangement {
  return Array.from({ length: barCount }, (_, i) => barRef(1, i + 1));
}

/** What a layer's arrangement and mutes are the moment it first holds audio. */
export type InitialArrangement = {
  readonly barSources: Arrangement;
  readonly mutedSlots: MutedSlots;
};

/**
 * The arrangement a layer starts with, once its first pass exists.
 *
 * Recorded order, except where pass 1 never reached: a first pass that stopped after 9 bars
 * of a 16-bar loop leaves slots 9..15 with nothing behind them. Those slots **point at
 * `P1/1` and start muted**.
 *
 * Both halves of that matter, and neither works alone:
 *
 * - **Pointing somewhere real** keeps the slot swipeable. Left pointing at `P1/13`, which
 *   does not exist, the tile would draw blank and the vertical axis would have no available
 *   set to wrap through — the user could not select their way out of the hole. `P1/1` is
 *   audio that is guaranteed to exist the instant any of the pass does.
 * - **Starting muted** is what stops that placeholder from lying. An unmuted slot silently
 *   playing bar 1 in slot 13 would be the app inventing an arrangement the user never
 *   performed. Muted, the slot reads honestly as "nothing here yet".
 *
 * Together they hand the decision back: unmute, then swipe, using nothing but the gestures
 * that already exist. The app never resolves the gap on the user's behalf — including later.
 * Recording a second, complete pass does **not** reach back and unmute these; by then they
 * are ordinary muted slots and the user's own choices are indistinguishable from ours.
 *
 * The swipe lock (§3.7) composes rather than conflicts: unmuting is simply the first step,
 * and it is the step that means the user has decided the slot should sound.
 *
 * When pass 1 is complete this is exactly `recordedOrder(barCount)` with nothing muted.
 *
 * Bar count comes from the index's own timing rather than a parameter: the two must agree,
 * and taking it separately is just an opportunity for them not to.
 */
export function initialArrangement(index: PassIndex): InitialArrangement {
  const barCount = index.timing.barCount;
  const barSources: BarRef[] = [];
  const mutedSlots: number[] = [];

  for (let slot = 0; slot < barCount; slot++) {
    const natural = barRef(1, slot + 1);
    if (hasAudio(index, natural)) {
      barSources.push(natural);
    } else {
      barSources.push(barRef(1, 1));
      mutedSlots.push(slot);
    }
  }
  return { barSources, mutedSlots };
}

export function isSlotMuted(muted: MutedSlots, slot: number): boolean {
  return muted.includes(slot);
}

export function setSlotMuted(muted: MutedSlots, slot: number, value: boolean): MutedSlots {
  if (isSlotMuted(muted, slot) === value) return muted;
  return value
    ? [...muted, slot].sort((a, b) => a - b)
    : muted.filter((s) => s !== slot);
}

/** Tap and hold (§3.7). Hold fires at 500 ms and suppresses the pending tap. */
export function toggleSlotMute(muted: MutedSlots, slot: number): MutedSlots {
  return setSlotMuted(muted, slot, !isSlotMuted(muted, slot));
}

/**
 * Whether this slot is silent on this layer, given both mutes.
 *
 * Layer mute and bar mute are independent and either silences: there is no per-bar override
 * that plays through a muted layer, because that would be solo, and §5.1 #9 rules solo out.
 */
export function isSilentAt(muted: MutedSlots, slot: number, layerMuted: boolean): boolean {
  return layerMuted || isSlotMuted(muted, slot);
}

/**
 * Whether a swipe may act on this slot (§3.7).
 *
 * **Swiping is locked while a bar is muted.** A muted tile shows no contraction and no
 * redraw, so a swipe would change the pass with no feedback at all — silent state mutation
 * the user discovers much later.
 *
 * This is domain code rather than a check in the gesture handler so that the gesture and any
 * other route to the same edit cannot drift apart about when it is allowed.
 */
export function canSwipeSlot(muted: MutedSlots, slot: number): boolean {
  return !isSlotMuted(muted, slot);
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
  muted: MutedSlots,
): Arrangement {
  const current = requireSlot(arrangement, slot);
  if (!canSwipeSlot(muted, slot)) return arrangement;
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
  muted: MutedSlots,
): Arrangement {
  const current = requireSlot(arrangement, slot);
  if (!canSwipeSlot(muted, slot)) return arrangement;
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
 * One bar of the retained loop: audio to copy, or a rest to write as silence.
 *
 * **`frameCount` is what the bar occupies, and it is always `framesPerBar`** — on both
 * variants. For an audio bar, `region.frameCount` is a different quantity: how much audio
 * there is to copy, which may be *less*. A partial bar keeps its full width and the shortfall
 * is written as silence at its end, exactly as playback treats it.
 *
 * The two were the same number until partial bars became selectable (§1.4), and collapsing
 * them again is a quiet, destructive failure: compress writes the retained bars back to back,
 * so a bar narrower than `framesPerBar` pulls every later bar early and leaves the compressed
 * loop physically shorter than `barCount × framesPerBar` — permanently, in the only surviving
 * copy. Hence a field the writer cannot overlook rather than a rule it has to remember.
 */
export type RetainedBar =
  | {
      readonly kind: 'audio';
      readonly region: SourceRegion;
      readonly frameCount: number;
    }
  | { readonly kind: 'silence'; readonly frameCount: number };

/**
 * What compressing this layer keeps, and what it holds afterwards (§2.7).
 *
 * Compress discards every recorded pass and keeps each layer's final edited loop. The
 * retained loop is **standardised to Pass 1** and bars are **renumbered to the arranged
 * order**, because the original numbering referenced audio that no longer exists.
 *
 * **Mute bakes in.** Compress and bounce are both deliberately destructive in order to
 * reclaim space, so a muted slot is written as an actual silent bar rather than kept as a
 * flag over audio nobody can hear. Same rule as export: what you hear is what you get (§2.6).
 *
 * **A rest is still a bar.** The silence occupies its slot and the arrangement stays
 * `barCount` long — muting bar 3 does not shorten the loop or renumber what follows it.
 *
 * **The flags clear.** They are spent: the silence lives in the audio now, and keeping them
 * would silence it twice over. Worse, unmuting afterwards would reveal silence rather than
 * the take that used to be there, which is not something the user could undo.
 *
 * A muted slot needs no source, so an unresolved one is not an error there — it is about to
 * be silence either way. Returns undefined only when an **audible** slot points at audio
 * that does not exist, because baking that into the one surviving copy is unrecoverable.
 */
export function compressionPlan(
  arrangement: Arrangement,
  index: PassIndex,
  muted: MutedSlots,
): { bars: RetainedBar[]; arrangement: Arrangement; mutedSlots: MutedSlots } | undefined {
  const perBar = framesPerBar(index.timing);
  const bars: RetainedBar[] = [];

  for (let slot = 0; slot < arrangement.length; slot++) {
    if (isSlotMuted(muted, slot)) {
      bars.push({ kind: 'silence', frameCount: perBar });
      continue;
    }
    const region = regionFor(index, arrangement[slot]!);
    if (!region) return undefined;
    // Full width regardless of how much audio is behind it: a partial bar keeps its slot and
    // the shortfall becomes a rest, the same way playback already treats it.
    bars.push({ kind: 'audio', region, frameCount: perBar });
  }

  return {
    bars,
    arrangement: recordedOrder(arrangement.length),
    mutedSlots: NONE_MUTED,
  };
}
