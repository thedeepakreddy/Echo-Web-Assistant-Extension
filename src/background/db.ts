// Shared IndexedDB for everything ECHO remembers locally:
//   cache      — past API answers, so an identical question costs nothing
//   kb         — text of pages you've visited, for offline recall
//   highlights — text you saved, re-injected when you revisit the page
//
// Service workers get killed and restarted constantly, so the connection is
// lazily (re)opened and every helper resolves rather than throws — a storage
// failure must degrade ECHO to "no memory", never break the request.

const DB_NAME = 'echo_db';
const DB_VERSION = 1;

export const STORE_CACHE = 'cache';
export const STORE_KB = 'kb';
export const STORE_HIGHLIGHTS = 'highlights';

let dbPromise: Promise<IDBDatabase> | null = null;

export function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        const s = db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
        s.createIndex('expires', 'expires');
      }
      if (!db.objectStoreNames.contains(STORE_KB)) {
        const s = db.createObjectStore(STORE_KB, { keyPath: 'url' });
        s.createIndex('ts', 'ts');
        s.createIndex('domain', 'domain');
      }
      if (!db.objectStoreNames.contains(STORE_HIGHLIGHTS)) {
        const s = db.createObjectStore(STORE_HIGHLIGHTS, { keyPath: 'id' });
        s.createIndex('url', 'url');
        s.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // If another tab holds an old version open, don't hang forever.
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  });
  // A failed open must not poison every later call.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode) {
  return db.transaction(store, mode).objectStore(store);
}

export async function idbPut(store: string, value: any): Promise<void> {
  try {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const r = tx(db, store, 'readwrite').put(value);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  } catch { /* storage unavailable — feature degrades silently */ }
}

export async function idbGet<T = any>(store: string, key: IDBValidKey): Promise<T | null> {
  try {
    const db = await getDB();
    return await new Promise<T | null>((resolve, reject) => {
      const r = tx(db, store, 'readonly').get(key);
      r.onsuccess = () => resolve((r.result as T) ?? null);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const r = tx(db, store, 'readwrite').delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function idbGetAll<T = any>(store: string, limit = 1000): Promise<T[]> {
  try {
    const db = await getDB();
    return await new Promise<T[]>((resolve, reject) => {
      const r = tx(db, store, 'readonly').getAll(undefined, limit);
      r.onsuccess = () => resolve((r.result as T[]) || []);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return [];
  }
}

export async function idbGetAllByIndex<T = any>(store: string, index: string, key: IDBValidKey, limit = 500): Promise<T[]> {
  try {
    const db = await getDB();
    return await new Promise<T[]>((resolve, reject) => {
      const r = tx(db, store, 'readonly').index(index).getAll(key, limit);
      r.onsuccess = () => resolve((r.result as T[]) || []);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return [];
  }
}

export async function idbClear(store: string): Promise<void> {
  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const r = tx(db, store, 'readwrite').clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function idbCount(store: string): Promise<number> {
  try {
    const db = await getDB();
    return await new Promise<number>((resolve, reject) => {
      const r = tx(db, store, 'readonly').count();
      r.onsuccess = () => resolve(r.result || 0);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return 0;
  }
}

/**
 * Keep a store under `max` records by evicting the oldest by `tsField`.
 * Called opportunistically after writes so the DB can't grow unbounded.
 */
export async function idbTrim(store: string, tsField: string, max: number): Promise<void> {
  try {
    const count = await idbCount(store);
    if (count <= max) return;
    const all = await idbGetAll<any>(store, count);
    all.sort((a, b) => (a[tsField] || 0) - (b[tsField] || 0));
    const db = await getDB();
    const victims = all.slice(0, count - max);
    const objStore = tx(db, store, 'readwrite');
    const keyPath = String((objStore as any).keyPath || 'id');
    for (const v of victims) objStore.delete(v[keyPath]);
  } catch { /* ignore */ }
}
