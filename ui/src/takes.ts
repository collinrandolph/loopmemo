import type { Layer } from '../../src/domain/project.ts';
import type { RecordingSession } from '../../src/domain/pass-index.ts';
import type { SessionBuffers } from './layer-audio.ts';

/**
 * Where captured audio lives, since in a browser there is no file to point at.
 *
 * `RecordingSession.audioFileURL` is the domain's handle on a take, and the domain never opens
 * it — `regionFor` returns a session index and a frame range and stops there, which is exactly
 * what lets all of `src/domain` be tested in Node. So the URL is free to be whatever the
 * platform can resolve: a path on iOS, and here a key into this map.
 *
 * **Keyed by session id rather than by array position.** A layer's `sessions` array is appended
 * to and, after a compress, replaced wholesale — so position is not stable identity, and a store
 * indexed on it would hand back the wrong take the first time a project was compressed. The id
 * is what `recordSession` already treats as the take's name.
 *
 * Nothing here persists. A reload loses every take, which is honest for a browser build whose
 * purpose is to prove the architecture rather than to keep anyone's music; §4.1's storage
 * question is a real one and it is not answered by putting hundreds of megabytes in IndexedDB
 * on a whim.
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
