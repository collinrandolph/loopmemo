import { type RecordingSession, passIndex } from '../src/domain/pass-index.ts';
import { type Timing, framesPerBar, loopFrames, timing } from '../src/domain/timing.ts';

/**
 * The spec's own worked example (§1.4), 96 BPM / 16 bars / 44.1 kHz:
 *
 *   session 0 = 2 full passes + 8 bars  -> passes 1, 2, 3 (3 partial)
 *   session 1 = 2 full passes           -> passes 4, 5
 *
 *   bars  1-8  -> 1, 2, 3, 4, 5
 *   bars  9-16 -> 1, 2, -, 4, 5      the gap is real and must survive
 */
export const T: Timing = timing(96, 16, 44_100);
export const FPB = framesPerBar(T); // 110_250
export const LOOP = loopFrames(T); // 1_764_000

export function session(frames: number, id = `s${frames}`): RecordingSession {
  return {
    id,
    audioFileURL: `file:///${id}.caf`,
    recordedFrames: frames,
    recordedAt: '2026-08-29T00:00:00.000Z',
    waveformPeaks: [],
  };
}

/** The two-session layer from §1.4. */
export function specIndex() {
  return passIndex([session(2 * LOOP + 8 * FPB, 'a'), session(2 * LOOP, 'b')], T);
}

/** A layer holding exactly one full pass. */
export function singlePassIndex() {
  return passIndex([session(LOOP, 'one')], T);
}
