/**
 * File System Access implementation of `ProjectSource`, plus handle persistence.
 *
 * A directory handle survives a reload if it is stashed in IndexedDB, but the
 * permission grant does not: reopening a project needs a fresh `requestPermission()`
 * inside a user gesture. `reviveProject()` handles that, and reports the difference
 * between "permission denied" and "folder is gone".
 */

import { uniqueName } from './add-images'
import { openFileProject } from './file-source'
import { idbDelete, idbGet, idbSet, idbKeys } from './idb'
import {
  FOLDER_JSON_NAME,
  isImageName,
  sortPageNames,
  type AddedImage,
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

  /**
   * Write a new image into the folder.
   *
   * Collisions are resolved against the directory rather than the project, because
   * the folder can hold files the project has never seen -- and overwriting one of
   * those would destroy a page that a rescan is about to pick up.
   */
  async addImage(name: string, blob: Blob): Promise<AddedImage> {
    const taken = new Set<string>()
    for await (const [entryName] of iterateDirectory(this.dir)) taken.add(entryName)

    const finalName = uniqueName(name, taken)
    const handle = await this.dir.getFileHandle(finalName, { create: true })
    const stream = await handle.createWritable()
    try {
      await stream.write(blob)
      await stream.close()
    } catch (err) {
      await stream.abort().catch(() => undefined)
      // The name was unused, so the half-written file is ours to clean up.
      await this.dir.removeEntry(finalName).catch(() => undefined)
      throw err
    }
    return { name: finalName, page: { file: finalName, getFile: () => handle.getFile() } }
  }
}

export async function pickDirectoryProject(): Promise<ProjectSource | null> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker
  if (!picker) throw new Error('This browser does not support the File System Access API')
  const dir = await picker({ mode: 'readwrite', id: 'comic-translator-project' }).catch(
    swallowAbort,
  )
  return dir ? openDirectoryHandle(dir) : null
}

/**
 * Turn a directory handle -- from the picker above, or from a drop -- into a project.
 *
 * Shared so a dropped folder gets the same permission check and "Recent" entry as
 * one picked through the dialog.
 */
export async function openDirectoryHandle(dir: FileSystemDirectoryHandle): Promise<ProjectSource> {
  if (!(await ensurePermission(dir))) throw new Error('Write permission for the folder was denied')
  await rememberHandle(dir.name, dir)
  return new DirectoryProjectSource(dir.name, dir)
}

/**
 * Pick a single image or PDF.
 *
 * Falls back to a plain file input where `showOpenFilePicker` is missing, which is
 * what makes this path work in browsers that cannot open a folder at all. The
 * trade-off is that only a real handle can be remembered, so a file picked through
 * the fallback will not appear under "Recent".
 */
export async function pickFileProject(): Promise<ProjectSource | null> {
  const picker = (window as unknown as PickerWindow).showOpenFilePicker
  if (!picker) {
    const file = await pickFileWithInput()
    return file ? openFileProject(file) : null
  }

  const handles = await picker({
    multiple: false,
    types: [
      {
        description: 'Comic page or PDF',
        accept: {
          'application/pdf': ['.pdf'],
          'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp'],
        },
      },
    ],
  }).catch(swallowAbort)

  const handle = handles?.[0]
  if (!handle) return null
  // Read-only: nothing is ever written next to the file, so asking for write access
  // would prompt for a permission this path never uses.
  if (!(await ensurePermission(handle, 'read'))) {
    throw new Error('Permission to read the file was denied')
  }
  await rememberHandle(handle.name, handle)
  return openFileProject(await handle.getFile())
}

/**
 * A file input, for engines without `showOpenFilePicker`.
 *
 * Dismissal is the interesting case. `change` does not fire on cancel, and `cancel`
 * is not universally supported -- so without the focus fallback the caller waits on
 * a promise that never settles, and whatever it disabled while "busy" stays disabled
 * with no way back.
 */
function pickFileWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*,application/pdf,.pdf'
    input.style.display = 'none'
    // Attached to the document: some engines do not fire events on a detached input.
    document.body.append(input)

    let settled = false
    const done = (file: File | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onRefocus)
      input.remove()
      resolve(file)
    }
    function onRefocus() {
      // The dialog is modal, so focus coming back means it closed. Give the change
      // event a moment to arrive first; no file by then means dismissal.
      setTimeout(() => done(input.files?.[0] ?? null), 400)
    }

    input.addEventListener('change', () => done(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => done(null))
    window.addEventListener('focus', onRefocus)
    input.click()
  })
}

/**
 * Reopen a previously picked folder or file.
 *
 * Must be called from a user gesture: the permission prompt is suppressed otherwise
 * and this returns null as though the user had declined.
 *
 * The stored value is a bare handle, and `FileSystemHandle.kind` already says which
 * sort it is -- so files and folders share one store with no record format to
 * migrate, and handles written by older builds still revive correctly.
 */
export async function reviveProject(key: string): Promise<ProjectSource | null> {
  const handle = await idbGet<FileSystemHandle>(handleKey(key))
  if (!handle) return null

  if (handle.kind === 'file') {
    if (!(await ensurePermission(handle, 'read'))) return null
    return openFileProject(await (handle as FileSystemFileHandle).getFile())
  }

  const dir = handle as FileSystemDirectoryHandle
  if (!(await ensurePermission(dir))) return null
  return new DirectoryProjectSource(dir.name, dir)
}

export function forgetProject(key: string): Promise<void> {
  return idbDelete(handleKey(key))
}

export interface RememberedProject {
  /** The key to pass back to `reviveProject`, and the label shown to the user. */
  key: string
  kind: 'folder' | 'file'
}

/**
 * The projects that can be reopened.
 *
 * The kind comes from the stored handle itself, so the list can say whether a name is
 * a folder or a file -- otherwise a folder and a file of the same name are
 * indistinguishable, and they share one key space.
 */
export async function listRememberedProjects(): Promise<RememberedProject[]> {
  const keys = await idbKeys().catch(() => [] as string[])
  const names = keys
    .filter((k) => k.startsWith(HANDLE_PREFIX))
    .map((k) => k.slice(HANDLE_PREFIX.length))

  return Promise.all(
    names.map(async (key) => {
      const handle = await idbGet<FileSystemHandle>(handleKey(key)).catch(() => undefined)
      return { key, kind: handle?.kind === 'file' ? ('file' as const) : ('folder' as const) }
    }),
  )
}

const HANDLE_PREFIX = 'handle:'

function handleKey(key: string): string {
  return HANDLE_PREFIX + key
}

function rememberHandle(key: string, handle: FileSystemHandle): Promise<void> {
  // Structured-cloneable, so the handle itself round-trips through IndexedDB.
  return idbSet(handleKey(key), handle).catch(() => undefined)
}

export function swallowAbort(err: unknown): null {
  if (err instanceof DOMException && err.name === 'AbortError') return null
  throw err
}

export async function readTextIfPresent(
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
export async function writeTextAtomically(
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

export { DirectoryProjectSource }
