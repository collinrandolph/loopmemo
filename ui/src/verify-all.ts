import { verifyBounce } from './verify-bounce.ts';
import { verifyCapture } from './verify-capture.ts';
import { verifyCompress } from './verify-compress.ts';
import { verifyCaptureFrames, verifyCountIn } from './verify-count-in.ts';
import { verifyEq } from './verify-eq.ts';
import { verifyJoins } from './verify-joins.ts';
import { verifyLifecycle } from './verify-lifecycle.ts';
import { verifyMaster } from './verify-master.ts';
import { verifyQuota } from './verify-quota.ts';
import { verifyRamps } from './verify-ramps.ts';
import { verifyStore } from './verify-store.ts';
import { verifyAudioSession } from './verify-audio-session.ts';
import { verifyTakeIds } from './verify-take-ids.ts';

/**
 * Every browser instrument, run in turn, with one verdict each. Opened from `ui/verify.html`.
 *
 * **Why a page and not Playwright** (decided 2026-09-16): the instruments were run by hand from
 * the console, one at a time, which is how a row of green instruments sat beside twenty-three real
 * defects — each was run when its feature was written and rarely after. One click that runs all of
 * them removes the reason not to, without adding the repo's first dependency beyond TypeScript. It
 * still needs someone to open it; that is the trade that was chosen.
 *
 * **Sequential, with a gap.** Several hold a live `AudioContext`, and run back to back in one page
 * they contend: a spurious capture failure was measured that way, and all of them passed spaced
 * 400 ms apart. Running them in parallel would be faster and would be measuring the contention.
 *
 * **The verdict is read, not re-derived.** Every instrument already reports its own `pass`, most at
 * several levels (`verify-joins` has one per claim). A result passes when every `pass` it contains
 * is true — so a new claim added inside an instrument is covered here without touching this file.
 * `verify-eq` predates the convention and says `graphMatchesDomain`; it is named explicitly below
 * rather than guessed at by a looser rule that would also sweep up booleans that are not verdicts.
 */

export type Instrument = {
  readonly name: string;
  readonly run: () => unknown;
  /** Which boolean keys are verdicts. `pass` unless the instrument says otherwise. */
  readonly verdictKeys?: readonly string[];
};

export const INSTRUMENTS: readonly Instrument[] = [
  { name: 'joins', run: verifyJoins },
  { name: 'capture', run: verifyCapture },
  { name: 'eq', run: verifyEq, verdictKeys: ['graphMatchesDomain'] },
  { name: 'master', run: verifyMaster },
  { name: 'compress', run: verifyCompress },
  { name: 'bounce', run: verifyBounce },
  { name: 'count-in', run: verifyCountIn },
  { name: 'count-in: capture frames', run: verifyCaptureFrames },
  { name: 'take ids', run: verifyTakeIds },
  { name: 'store', run: verifyStore },
  { name: 'quota', run: verifyQuota },
  { name: 'ramps', run: verifyRamps },
  { name: 'lifecycle', run: verifyLifecycle },
  { name: 'audio session', run: verifyAudioSession },
];

/** Measured: 400 ms was enough for every live context to be released before the next opens. */
export const GAP_MS = 400;

export type Outcome = {
  readonly name: string;
  readonly pass: boolean;
  /** Paths to each verdict that was false, e.g. `C_click.pass`. Empty when it passed. */
  readonly failed: readonly string[];
  readonly ms: number;
  readonly result?: unknown;
  readonly error?: string;
};

/** Every verdict in a result, by path. */
function verdicts(value: unknown, keys: readonly string[], path = ''): [string, boolean][] {
  if (value === null || typeof value !== 'object') return [];
  const out: [string, boolean][] = [];
  for (const [key, child] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (keys.includes(key) && typeof child === 'boolean') out.push([at, child]);
    else out.push(...verdicts(child, keys, at));
  }
  return out;
}

/**
 * Judge one result. **No verdict at all is a failure**, not a pass: an instrument whose report
 * lost its `pass` key would otherwise go green by saying nothing.
 */
export function judge(result: unknown, keys: readonly string[] = ['pass']): { pass: boolean; failed: string[] } {
  const found = verdicts(result, keys);
  if (found.length === 0) return { pass: false, failed: ['(no verdict reported)'] };
  const failed = found.filter(([, ok]) => !ok).map(([at]) => at);
  return { pass: failed.length === 0, failed };
}

export async function runAll(onOutcome?: (o: Outcome, i: number) => void): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (let i = 0; i < INSTRUMENTS.length; i++) {
    const instrument = INSTRUMENTS[i]!;
    if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS));
    const started = performance.now();
    let outcome: Outcome;
    try {
      const result = await instrument.run();
      const { pass, failed } = judge(result, instrument.verdictKeys);
      outcome = { name: instrument.name, pass, failed, ms: Math.round(performance.now() - started), result };
    } catch (e) {
      outcome = {
        name: instrument.name,
        pass: false,
        failed: ['(threw)'],
        ms: Math.round(performance.now() - started),
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      };
    }
    outcomes.push(outcome);
    onOutcome?.(outcome, i);
  }
  return outcomes;
}
