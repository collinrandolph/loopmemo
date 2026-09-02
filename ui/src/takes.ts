import type { Layer } from '../../src/domain/project.ts';
import type { RecordingSession } from '../../src/domain/pass-index.ts';
import type { SessionBuffers } from './layer-audio.ts';

/**
 * Where captured audio lives, since in a browser there is no file to point at.
 *
 * The domain never opens `RecordingSession.audioFileURL` — `regionFor` returns a session index
 * and a frame range and stops — so the URL can be whatever the platform resolves: a path on iOS,
 * a key into this map here.
 *
 * **Keyed by session id, not array position.** `sessions` is appended to and, after a compress,
 * replaced wholesale, so position is not stable identity.
 *
 * **Nothing persists**: a reload loses every take. §4.1's storage question is a real one and is
 * not answered by putting hundreds of megabytes in IndexedDB on a whim.
 */
export type TakeStore = {
  put(session: RecordingSession, buffer: AudioBuffer): void;
  get(sessionId: string): AudioBuffer | undefined;
  /** One entry per session, positionally, which is what `SourceRegion.sessionIndex` indexes. */
  buffersFor(layer: Layer): SessionBuffers;
  size(): number;
};

/** The scheme is a marker, not a protocol — nothing dereferences it. */
export const TAKE_URL_SCHEME = 'take:';

export function takeUrl(sessionId: string): string {
  return `${TAKE_URL_SCHEME}//${sessionId}`;
}

export function takeStore(): TakeStore {
  const held = new Map<string, AudioBuffer>();
  return {
    put: (session, buffer) => void held.set(session.id, buffer),
    get: (sessionId) => held.get(sessionId),
    // Undefined where a session has no audio in this store — a demo project's simulated takes,
    // or a project reloaded after the buffers were lost. `scheduleSegments` skips those rather
    // than failing, so a partly-loaded layer plays the bars it can.
    buffersFor: (layer) => layer.sessions.map((s) => held.get(s.id)),
    size: () => held.size,
  };
}
