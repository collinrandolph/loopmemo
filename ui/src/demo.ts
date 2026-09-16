/**
 * Synthetic waveform peaks, for projects whose takes have no samples.
 *
 * **This is the only invented data left in the UI**, and it is here for one reason. The app used to
 * seed a shelf of demo projects on first launch — sessions holding frame counts and nothing else —
 * and that stopped on 2026-09-16, but installs that already saved them keep them. Drawing their
 * lanes flat would make those projects look broken rather than simulated, so `amp` stays until they
 * are deleted. A recorded take draws its own peaks (`peaks.ts`); nothing new ever reaches this.
 *
 * The fixtures themselves are in history before that date, if a screen ever needs a shelf to be
 * built against again.
 */

/**
 * Sample amplitude, keyed to the **global** line index so the envelope flows across bar joins.
 *
 * Keyed on the *source* bar, never the slot — swiping a slot onto another pass has to redraw it
 * with that pass's material, which is the whole point of the two indices (§1.1).
 */
export function amp(layerIndex: number, sourceBarIndex: number, lineIndex: number, linesPerBar: number): number {
  const g = sourceBarIndex * linesPerBar + lineIndex + layerIndex * 613;
  const env = 0.55 + 0.3 * Math.sin(g * 0.055) + 0.12 * Math.sin(g * 0.017 + 1.3);
  const det =
    0.22 * Math.sin(g * 1.31) + 0.14 * Math.sin(g * 2.77 + 0.6) + 0.09 * Math.sin(g * 0.61 + 2.2);
  return Math.min(1, Math.max(0.06, env + det));
}
