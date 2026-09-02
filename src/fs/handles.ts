/**
 * File System Access implementation of `ProjectSource`, plus handle persistence.
 *
 * A directory handle survives a reload if it is stashed in IndexedDB, but the
 * permission grant does not: reopening a project needs a fresh `requestPermission()`
 * inside a user gesture. `reviveProject()` handles that, and reports the difference
 * between "permission denied" and "folder is gone".
 */

import { idbDelete, idbGet, idbSet, idbKeys } from './idb'
import {
  FOLDER_JSON_NAME,
  isImageName,
  jsonNameForFile,
  sortPageNames,
  type PageSource,
  type ProjectSource,
} from './source'

interface PickerWindow {
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<
    FileSystemDirectoryHandle
  >
  showOpenFilePicker?: (opts?: {
    multiple?: boolean
    types?: { description: string; accept: Record<string, string[]> }[]
  }) => Promise<FileSystemFileHandle[]>
}

export function isFsaSupported(): boolean {
  if (typeof window === 'undefined') return false
  return typeof (window as unknown as PickerWindow).showDirectoryPicker === 'function'
}

/** Ask for permission, but only prompt when we do not already have it. */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
  if (typeof handle.queryPermission !== 'function') return true // older engines: optimistic
  if ((await handle.queryPermission({ mode })) === 'granted') return true
  return (await handle.requestPermission({ mode })) === 'granted'
}

class DirectoryProjectSource implements ProjectSource {
  readonly writable = true
  readonly jsonName = FOLDER_JSON_NAME

  constructor(
    readonly name: string,
    private readonly dir: FileSystemDirectoryHandle,
  ) {}

  async readJson(): Promise<string | null> {
    return readTextIfPresent(this.dir, this.jsonName)
  }

  async writeJson(text: string): Promise<void> {
    await writeTextAtomically(this.dir, this.jsonName, text)
  }

  async listPages(): Promise<PageSource[]> {
    const byName = new Map<string, FileSystemFileHandle>()
    for await (const [name, handle] of iterateDirectory(this.dir)) {
      if (handle.kind === 'file' && isImageName(name)) {
        byName.set(name, handle as FileSystemFileHandle)
      }
    }
    return sortPageNames([...byName.keys()]).map((name) => ({
      file: name,
      getFile: () => byName.get(name)!.getFile(),
    }))
  }
}

/**
 * A single image or PDF, whose JSON sibling is `<base>.json`.
 *
 * The image itself is one page; a PDF is rasterised by the caller, which is why
 * `listPages()` here returns the source file and lets the importer expand it.
 */
class SingleFileProjectSource implements ProjectSource {
  readonly writable = true
  readonly jsonName: string

  constructor(
    readonly name: string,
    private readonly dir: FileSystemDirectoryHandle,
    private readonly file: FileSystemFileHandle,
  ) {
    this.jsonName = jsonNameForFile(file.name)
  }

  async readJson(): Promise<string | null> {
    return readTextIfPresent(this.dir, this.jsonName)
  }

  async writeJson(text: string): Promise<void> {
    await writeTextAtomically(this.dir, this.jsonName, text)
  }

  async listPages(): Promise<PageSource[]> {
    return [{ file: this.file.name, getFile: () => this.file.getFile() }]
  }
}

export async function pickDirectoryProject(): Promise<ProjectSource | null> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker
  if (!picker) throw new Error('This browser does not support the File System Access API')
  const dir = await picker({ mode: 'readwrite', id: 'comic-translator-project' }).catch(
    swallowAbort,
  )
  if (!dir) return null
  if (!(await ensurePermission(dir))) throw new Error('Write permission for the folder was denied')
  await rememberHandle(dir.name, dir)
  return new DirectoryProjectSource(dir.name, dir)
}

/**
 * Reopen a previously picked folder.
 *
 * Must be called from a user gesture: the permission prompt is suppressed otherwise
 * and this returns null as though the user had declined.
 */
export async function reviveProject(key: string): Promise<ProjectSource | null> {
  const dir = await idbGet<FileSystemDirectoryHandle>(handleKey(key))
  if (!dir) return null
  if (!(await ensurePermission(dir))) return null
  return new DirectoryProjectSource(dir.name, dir)
}

export function forgetProject(key: string): Promise<void> {
  return idbDelete(handleKey(key))
}

export async function listRememberedProjects(): Promise<string[]> {
  const keys = await idbKeys().catch(() => [] as string[])
  return keys.filter((k) => k.startsWith(HANDLE_PREFIX)).map((k) => k.slice(HANDLE_PREFIX.length))
}

const HANDLE_PREFIX = 'handle:'

function handleKey(key: string): string {
  return HANDLE_PREFIX + key
}

function rememberHandle(key: string, handle: FileSystemHandle): Promise<void> {
  // Structured-cloneable, so the handle itself round-trips through IndexedDB.
  return idbSet(handleKey(key), handle).catch(() => undefined)
}

function swallowAbort(err: unknown): null {
  if (err instanceof DOMException && err.name === 'AbortError') return null
  throw err
}

async function readTextIfPresent(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<string | null> {
  try {
    const handle = await dir.getFileHandle(name)
    return await (await handle.getFile()).text()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null
    throw err
  }
}

/**
 * Write via a temp file, then swap.
 *
 * `createWritable()` truncates on open, so a crash midway through a direct write
 * leaves a zero-length project file and loses every translation in it. Writing the
 * temp file first means the real file is only touched once the full payload is on
 * disk, narrowing the window to a single small copy.
 */
async function writeTextAtomically(
  dir: FileSystemDirectoryHandle,
  name: string,
  text: string,
): Promise<void> {
  const tmpName = name + '.tmp'
  const bytes = new TextEncoder().encode(text)

  const tmp = await dir.getFileHandle(tmpName, { create: true })
  const tmpStream = await tmp.createWritable()
  try {
    await tmpStream.write(bytes)
    await tmpStream.close()
  } catch (err) {
    await tmpStream.abort().catch(() => undefined)
    throw err
  }

  const written = await tmp.getFile()
  if (written.size !== bytes.byteLength) {
    throw new Error(
      'short write to ' + tmpName + ' (' + written.size + ' of ' + bytes.byteLength + ' bytes)',
    )
  }

  const target = await dir.getFileHandle(name, { create: true })
  const stream = await target.createWritable()
  try {
    await stream.write(await written.arrayBuffer())
    await stream.close()
  } catch (err) {
    await stream.abort().catch(() => undefined)
    throw err
  }
  await dir.removeEntry(tmpName).catch(() => undefined)
}

interface AsyncEntries {
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>
}

function iterateDirectory(
  dir: FileSystemDirectoryHandle,
): AsyncIterableIterator<[string, FileSystemHandle]> {
  const entries = (dir as unknown as AsyncEntries).entries
  if (!entries) throw new Error('Directory iteration is not supported in this browser')
  return entries.call(dir)
}

export { DirectoryProjectSource, SingleFileProjectSource }
