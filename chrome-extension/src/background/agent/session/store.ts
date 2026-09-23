import { createLogger } from '@src/background/log';
import { pruneRecords, type SessionRecord } from './serialize';

// ---------------------------------------------------------------------------
// Session persistence — IndexedDB shell (Wave 1)
// ---------------------------------------------------------------------------
// Deliberately dumb: opens the DB per call, no caching, no schema logic beyond
// v1. All exports catch internally — a persistence failure must NEVER throw
// into the agent loop. The retention policy itself is pure (serialize.ts);
// this file only applies it.

const logger = createLogger('SessionStore');

const DB_NAME = 'koni-agent';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await requestToPromise(run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
  } finally {
    db.close();
  }
}

/** Upsert one session snapshot. Fire-and-forget safe. */
export async function saveSessionRecord(record: SessionRecord): Promise<void> {
  try {
    await withStore('readwrite', store => store.put(record));
  } catch (error) {
    logger.error('saveSessionRecord failed', error);
  }
}

/** Load one session snapshot (Wave 2 reads; unused in Wave 1). */
export async function loadSessionRecord(sessionId: string): Promise<SessionRecord | null> {
  try {
    const result = await withStore<SessionRecord | undefined>('readonly', store => store.get(sessionId));
    return result ?? null;
  } catch (error) {
    logger.error('loadSessionRecord failed', error);
    return null;
  }
}

/** Delete one session snapshot. Fire-and-forget safe. */
export async function deleteSessionRecord(sessionId: string): Promise<void> {
  try {
    await withStore('readwrite', store => store.delete(sessionId));
  } catch (error) {
    logger.error('deleteSessionRecord failed', error);
  }
}

/** Apply the pure retention policy: strip old/overflow docs, drop stale records. */
export async function pruneSessions(): Promise<void> {
  try {
    const all = await withStore<SessionRecord[]>('readonly', store => store.getAll());
    const meta = all.map(record => ({
      sessionId: record.sessionId,
      savedAt: record.savedAt,
      hasDocs: (record.attachedDocs?.length ?? 0) > 0,
    }));
    const decision = pruneRecords(meta, Date.now());
    for (const sessionId of decision.deleteRecords) {
      await withStore('readwrite', store => store.delete(sessionId));
    }
    for (const sessionId of decision.stripDocs) {
      const record = all.find(r => r.sessionId === sessionId);
      if (record) {
        await withStore('readwrite', store => store.put({ ...record, attachedDocs: [] }));
      }
    }
  } catch (error) {
    logger.error('pruneSessions failed', error);
  }
}
