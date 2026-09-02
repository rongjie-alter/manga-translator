/**
 * A minimal promise wrapper over one IndexedDB object store.
 *
 * Used only for things that can be regenerated: directory handles (so a project can be
 * reopened without re-picking the folder) and the recent-projects list. Nothing here is
 * authoritative -- the project JSON on disk is.
 */

const DB_NAME = 'comic-translator'
const DB_VERSION = 1
const STORE = 'kv'

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('failed to open IndexedDB'))
  })
  return dbPromise
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = fn(tx.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
      }),
  )
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
}

export function idbSet(key: string, value: unknown): Promise<void> {
  return run('readwrite', (s) => s.put(value, key)).then(() => undefined)
}

export function idbDelete(key: string): Promise<void> {
  return run('readwrite', (s) => s.delete(key)).then(() => undefined)
}

export function idbKeys(): Promise<string[]> {
  return run<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.filter((k): k is string => typeof k === 'string'),
  )
}
