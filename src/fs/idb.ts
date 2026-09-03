/**
 * A minimal promise wrapper over one IndexedDB object store.
 *
 * Mostly used for things that can be regenerated: directory and file handles (so a
 * project can be reopened without re-picking it) and the recent-projects list.
 *
 * With one exception, which is worth knowing about. A project imported from a single
 * image or a PDF has nowhere on disk to keep its JSON -- `showOpenFilePicker` gives no
 * access to the file's parent folder -- so for that kind of project the JSON and any
 * pasted pages live here and are authoritative. See `file-source.ts`; the scan view's
 * export buttons are how that work gets onto disk.
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
