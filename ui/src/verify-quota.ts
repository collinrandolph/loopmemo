import { persistentStore } from './store.ts';

/**
 * What a full disk does to a take (§6.1).
 *
 * The failure this rules out is a *quiet* one. A quota error used to warn the console, mark the
 * whole store broken, and leave the recording looking exactly as saved as any other — so the take
 * was gone on the next reload with nothing having said so, and every later write was silently
 * dropped too.
 *
 * Three claims:
 *
 * 1. A refused write reports `full`, not `unavailable` — they are different states with different
 *    remedies, and only one of them is recoverable.
 * 2. The refused take is **remembered**, so freeing space can still make it durable.
 * 3. A store that is full still **reads and deletes**, which is what makes it recoverable at all.
 *
 * Run from the console:
 *
 *     const m = await import('/ui/dist/ui/src/verify-quota.js');
 *     await m.verifyQuota();
 */
const DB = 'loop-recorder-quota';

/** One `put` fails with a quota error, then the store behaves normally again. */
function failNextPut(times: number): () => void {
  const proto = IDBObjectStore.prototype;
  const real = proto.put;
  let left = times;
  proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
    const request = real.apply(this, args as Parameters<typeof real>);
    if (left > 0 && this.name === 'takes') {
      left--;
      // Let the real request settle, then override the outcome the caller sees.
      queueMicrotask(() => {
        Object.defineProperty(request, 'error', {
          value: new DOMException('quota', 'QuotaExceededError'),
          configurable: true,
        });
        request.onerror?.(new Event('error') as Event & { target: IDBRequest });
      });
    }
    return request;
  } as typeof proto.put;
  return () => {
    proto.put = real;
  };
}

function buffer(frames = 4410): AudioBuffer {
  const ctx = new OfflineAudioContext(1, frames, 44100);
  const b = ctx.createBuffer(1, frames, 44100);
  b.getChannelData(0).fill(0.25);
  return b;
}

export async function verifyQuota() {
  indexedDB.deleteDatabase(DB);
  const store = persistentStore(DB);
  const seen: string[] = [];
  store.onStatusChange(() => seen.push(`${store.status()}:${store.unsaved().length}`));

  const restore = failNextPut(1);
  store.saveTake('refused', buffer());
  await new Promise((r) => setTimeout(r, 400));
  const whenFull = { status: store.status(), unsaved: [...store.unsaved()] };

  // A full store must still read and delete — that is the whole recovery path. The mock lets the
  // real write land and only overrides the outcome the caller sees, so the row being readable is
  // what proves reads are not disabled by `full`.
  const stillReads = (await store.loadTake('refused')) !== undefined;
  restore();

  // Deleting is what frees room, and it retries what was refused.
  store.deleteProject('anything');
  await new Promise((r) => setTimeout(r, 600));
  const afterFree = { status: store.status(), unsaved: [...store.unsaved()] };
  const recovered = await store.loadTake('refused');

  indexedDB.deleteDatabase(DB);

  return {
    statusWhenRefused: whenFull.status,
    unsavedWhenRefused: whenFull.unsaved,
    fullStoreStillReads: stillReads,
    statusAfterFreeing: afterFree.status,
    unsavedAfterFreeing: afterFree.unsaved,
    takeRecoveredFrames: recovered?.samples.length ?? 0,
    transitions: seen,
    pass:
      stillReads &&
      whenFull.status === 'full' &&
      whenFull.unsaved.length === 1 &&
      afterFree.status === 'ok' &&
      afterFree.unsaved.length === 0 &&
      recovered?.samples.length === 4410,
  };
}
