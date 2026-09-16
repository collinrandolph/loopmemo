/**
 * The audio session category (spec §2.2, "The session category is a product decision").
 *
 * **Why it exists.** With the default category, the iOS Ring/Silent switch mutes Web Audio through
 * the phone speaker — not through headphones, which is why every device test passed until one ran
 * on the speaker. Declaring a *playback* session is what a music app does, and the switch stops
 * applying.
 *
 * **Why it is behind a setting, and off by default** (decided 2026-09-16). §2.2 lists five things
 * only a device can confirm, the worst being that the record-time speaker flip of platform-decision
 * §6 gets worse. A toggle lets one phone session compare both behaviours on every output route
 * instead of needing a build per answer. Once the device pass is done, the setting is expected to
 * go: the spec's decision is that the app *is* a playback app, not that the user chooses.
 *
 * **Two categories, switched at the edges of a take** — `playback` while only playing,
 * `play-and-record` from the moment an input is opened or a capture starts until the capture stops.
 * Holding `play-and-record` permanently is refused in §2.2: it is the category in which output
 * follows the input route, and sitting in it while merely listening widens that risk for nothing.
 *
 * **Set inside a gesture, never at load.** Every call below comes from `audio.ts` entry points that
 * a tap reaches — `start`, `openInput`, `startCapture`, `stopCapture` — and never from `setLayers`
 * or anything a screen mount runs.
 *
 * **Feature-detected, and silent where absent.** `navigator.audioSession` is WebKit's and not in
 * the DOM typings. Where it is missing, every call is a no-op and the settings row says so; §2.2's
 * one-time "check the side switch" note for those browsers is not built yet.
 */

export type SessionKind = 'playback' | 'play-and-record';
type SessionType = SessionKind | 'auto';

type AudioSessionApi = { type: string };

function api(): AudioSessionApi | undefined {
  const candidate = (globalThis.navigator as { audioSession?: AudioSessionApi } | undefined)?.audioSession;
  return candidate && typeof candidate === 'object' && 'type' in candidate ? candidate : undefined;
}

export function audioSessionSupported(): boolean {
  return api() !== undefined;
}

let enabled = false;
/** What this module last asked for. `auto` is the browser's own default. */
let requested: SessionType = 'auto';

function request(type: SessionType) {
  const session = api();
  if (!session || session.type === type) {
    requested = type;
    return;
  }
  try {
    session.type = type;
    requested = type;
  } catch (e) {
    // A refusal is reported, not thrown: sound still plays in the default category, which is the
    // behaviour the setting exists to compare against.
    console.warn(`Loop Recorder: audio session type '${type}' refused.`, e);
  }
}

/**
 * Turn the declaration on or off. **Off hands the session back to `auto`** rather than leaving the
 * last category in place, so toggling it during the device pass compares like with like.
 */
export function setAudioSessionEnabled(on: boolean) {
  enabled = on;
  if (!on) request('auto');
}

export function audioSessionEnabled(): boolean {
  return enabled;
}

/** Declare what the engine is about to do. A no-op while the setting is off. */
export function claimAudioSession(kind: SessionKind) {
  if (enabled) request(kind);
}

/** For the settings row and for a device report: what was last asked for, and what is in force. */
export function audioSessionState(): { requested: SessionType; actual: string | undefined } {
  return { requested, actual: api()?.type };
}
