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
 * **This is the in-memory half.** `store.ts` writes takes through to IndexedDB and reads them
 * back; `put` is a new take and persists, `restore` is one arriving from disk and does not.
 * Separating them is what stops a hydration pass rewriting everything it just read.
 */
export type TakeStore = {
  /** A newly captured or rendered take. Persisted. */
  put(session: RecordingSession, buffer: AudioBuffer): void;
  /** A take read back from storage. Not persisted — it came from there. */
  restore(sessionId: string, buffer: AudioBuffer): void;
  get(sessionId: string): AudioBuffer | undefined;
  has(sessionId: string): boolean;
  /** One entry per session, positionally, which is what `SourceRegion.sessionIndex` indexes. */
  buffersFor(layer: Layer): SessionBuffers;
  size(): number;
};

/** The scheme is a marker, not a protocol — nothing dereferences it. */
export const TAKE_URL_SCHEME = 'take:';

export function takeUrl(sessionId: string): string {
  return `${TAKE_URL_SCHEME}//${sessionId}`;
}

export function takeStore(onPut?: (sessionId: string, buffer: AudioBuffer) => void): TakeStore {
  const held = new Map<string, AudioBuffer>();
  return {
    put(session, buffer) {
      held.set(session.id, buffer);
      onPut?.(session.id, buffer);
    },
    restore: (sessionId, buffer) => void held.set(sessionId, buffer),
    get: (sessionId) => held.get(sessionId),
    has: (sessionId) => held.has(sessionId),
    // Undefined where a session has no audio in this store — a demo project's simulated takes,
    // or one whose buffer has not been read back yet. `scheduleSegments` skips those rather than
    // failing, so a layer plays the bars it can while the rest arrive.
    buffersFor: (layer) => layer.sessions.map((s) => held.get(s.id)),
    size: () => held.size,
  };
}
