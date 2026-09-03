/**
 * Page images kept in IndexedDB rather than in a folder.
 *
 * A source that has no directory to write into still has to *keep* the pages a user
 * pastes, and keep them across a reload -- otherwise the next rescan lists the source
 * afresh, does not see them, and `reconcile` reports them as gone and deletes their
 * translations. Blobs are structured-cloneable, so IndexedDB stores them directly.
 *
 * The key prefix is deliberately not `handle:`, which `listRememberedProjects`
 * treats as "a project the user can reopen".
 */

import { idbDelete, idbGet, idbKeys, idbSet } from './idb'

const PREFIX = 'pageblob:'

function key(scope: string, name: string): string {
  return PREFIX + scope + '/' + name
}

export function putPageBlob(scope: string, name: string, blob: Blob): Promise<void> {
  return idbSet(key(scope, name), blob)
}

export function getPageBlob(scope: string, name: string): Promise<Blob | undefined> {
  return idbGet<Blob>(key(scope, name))
}

/** Names of every stored blob for this scope, in no particular order. */
export async function listPageBlobNames(scope: string): Promise<string[]> {
  const prefix = key(scope, '')
  const keys = await idbKeys().catch(() => [] as string[])
  return keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
}

export async function clearPageBlobs(scope: string): Promise<void> {
  const prefix = key(scope, '')
  const keys = await idbKeys().catch(() => [] as string[])
  await Promise.all(keys.filter((k) => k.startsWith(prefix)).map((k) => idbDelete(k)))
}
