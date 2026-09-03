import type { Project } from '../../src/domain/project.ts';

/**
 * Keeping projects and takes across a reload (§4.1's storage question).
 *
 * **Two very different sizes, so two stores.** A `Project` is a few kilobytes of JSON — including
 * `waveformPeaks`, which matters more than it looks: peaks travel with the project, so every
 * waveform on every screen is correct the instant the app boots, long before any audio has
 * loaded. A take is megabytes of samples and is only needed to *hear* something.
 *
 * That split is what keeps `render()` synchronous. Projects load once at boot; take buffers
 * stream in behind and re-push themselves at the engine when they arrive. A screen opened before
 * its audio has landed draws correctly and is briefly silent, which `scheduleSegments` already
 * handles — it skips a segment whose session has no buffer rather than failing.
 *
 * **Storage failing is never fatal.** Private windows, blocked storage and quota errors all leave
 * the app exactly as it was before this file existed: everything in memory, lost on reload. The
 * failure is reported once and then the app carries on.
 */

const DB_NAME = 'loop-recorder';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const TAKES = 'takes';
const META = 'meta';

/** Samples as captured, plus what they were captured at. */
export type TakeAudio = { readonly samples: Float32Array; readonly sampleRate: number };

export type Store = {
  /** Projects as last saved, or undefined when this browser has never been seeded. */
  loadProjects(): Promise<readonly Project[] | undefined>;
  /** Fire and forget, debounced per project — an edit is a value, and they arrive per pixel. */
  saveProject(project: Project): void;
  deleteProject(id: string): void;
  loadTake(id: string): Promise<TakeAudio | undefined>;
  /** Takes are immutable, so this runs once per take and is not debounced. */
  saveTake(id: string, buffer: AudioBuffer): void;
  /** Drop every take no live project refers to — compress and delete both orphan them. */
  sweep(keep: ReadonlySet<string>): void;
  /** Whether anything is actually being written. False once storage has failed. */
  available(): boolean;
};

/** Debounce for project writes. Long enough to swallow a slider drag, short enough to survive. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * `Float32Array` because that is what the worklet captured, so nothing is converted and nothing
 * is lost. It is twice the size of the 16-bit PCM §2.7 costs a project at, which is the honest
 * trade for a take that reads back exactly as it was recorded.
 */
function samplesOf(buffer: AudioBuffer): Float32Array {
  return buffer.getChannelData(0).slice();
}

/** `dbName` is only for `verify-store.ts`, so a check never writes into the real database. */
export function persistentStore(dbName = DB_NAME): Store {
  let db: IDBDatabase | undefined;
  let broken = false;
  const pending = new Map<string, number>();

  function fail(what: string, e: unknown) {
    if (broken) return;
    broken = true;
    console.warn(`Loop Recorder: storage unavailable (${what}), continuing in memory only.`, e);
  }

  const opening = new Promise<IDBDatabase | undefined>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(dbName, DB_VERSION);
    } catch (e) {
      fail('open', e);
      resolve(undefined);
      return;
    }
    request.onupgradeneeded = () => {
      const next = request.result;
      if (!next.objectStoreNames.contains(PROJECTS)) next.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!next.objectStoreNames.contains(TAKES)) next.createObjectStore(TAKES, { keyPath: 'id' });
      if (!next.objectStoreNames.contains(META)) next.createObjectStore(META, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    request.onerror = () => {
      fail('open', request.error);
      resolve(undefined);
    };
  });

  // Asks the browser not to evict this origin under storage pressure. Advisory — a refusal is not
  // an error, it just means the data is evictable like any other site's.
  void navigator.storage?.persist?.().catch(() => {});

  async function tx(store: string, mode: IDBTransactionMode): Promise<IDBObjectStore | undefined> {
    const open = await opening;
    if (!open || broken) return undefined;
    try {
      return open.transaction(store, mode).objectStore(store);
    } catch (e) {
      fail(store, e);
      return undefined;
    }
  }

  function run<T>(request: IDBRequest<T> | undefined, what: string): Promise<T | undefined> {
    if (!request) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        fail(what, request.error);
        resolve(undefined);
      };
    });
  }

  return {
    available: () => !broken,

    async loadProjects() {
      const meta = await tx(META, 'readonly');
      const seeded = await run(meta?.get('seeded'), 'meta');
      if (!seeded) return undefined;
      const store = await tx(PROJECTS, 'readonly');
      const all = await run<Project[]>(store?.getAll() as IDBRequest<Project[]>, 'projects');
      return all ?? undefined;
    },

    saveProject(project) {
      window.clearTimeout(pending.get(project.id));
      pending.set(
        project.id,
        window.setTimeout(() => {
          pending.delete(project.id);
          void (async () => {
            const store = await tx(PROJECTS, 'readwrite');
            if (!store) return;
            await run(store.put(project), 'save project');
            const meta = await tx(META, 'readwrite');
            await run(meta?.put({ key: 'seeded', value: true }), 'meta');
          })();
        }, SAVE_DEBOUNCE_MS),
      );
    },

    deleteProject(id) {
      window.clearTimeout(pending.get(id));
      pending.delete(id);
      void (async () => {
        const store = await tx(PROJECTS, 'readwrite');
        await run(store?.delete(id), 'delete project');
      })();
    },

    async loadTake(id) {
      const store = await tx(TAKES, 'readonly');
      const row = await run<TakeAudio | undefined>(
        store?.get(id) as IDBRequest<TakeAudio | undefined>,
        'load take',
      );
      return row?.samples ? row : undefined;
    },

    saveTake(id, buffer) {
      void (async () => {
        const store = await tx(TAKES, 'readwrite');
        if (!store) return;
        await run(
          store.put({ id, samples: samplesOf(buffer), sampleRate: buffer.sampleRate }),
          'save take',
        );
      })();
    },

    sweep(keep) {
      void (async () => {
        const store = await tx(TAKES, 'readonly');
        const ids = await run<IDBValidKey[]>(store?.getAllKeys(), 'sweep');
        const orphans = (ids ?? []).filter((id) => !keep.has(String(id)));
        if (orphans.length === 0) return;
        const writable = await tx(TAKES, 'readwrite');
        if (!writable) return;
        for (const id of orphans) writable.delete(id);
      })();
    },
  };
}
