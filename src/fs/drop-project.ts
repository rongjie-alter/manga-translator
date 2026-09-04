/**
 * Turn a whole-page drop on the Projects screen into a new project.
 *
 * A sibling to `ui/incoming.ts`, which pulls pages out of a paste or drop *into an
 * open project* and explicitly rejects folders and PDFs there ("has to come in as
 * its own project" -- this module is that other project). The same
 * `DataTransferItem` liveness rule applies: everything synchronous
 * (`webkitGetAsEntry`, starting a `getAsFileSystemHandle()` call) must happen before
 * any `await`, because the items are only valid for the duration of the event that
 * carried them.
 */

import { openDirectoryHandle } from './handles'
import { isPdfFile, openFileProject, openImagesProject } from './file-source'
import { isImageName, type ProjectSource } from './source'

interface EntryItem {
  webkitGetAsEntry?: () => { isDirectory: boolean } | null
}

interface HandleItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle>
}

function isDirectoryItem(item: DataTransferItem): boolean {
  return Boolean((item as unknown as EntryItem).webkitGetAsEntry?.()?.isDirectory)
}

const UNSUPPORTED_FOLDER =
  'This browser can’t open a dropped folder — use "Open folder of images…" instead.'

// Same numeric-aware ordering as `sortPageNames` in `./source`, over `File` rather
// than a bare name -- a directory listing would put page 2 before page 10.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export async function projectSourceFromDrop(dataTransfer: DataTransfer): Promise<ProjectSource> {
  const items = Array.from(dataTransfer.items ?? [])
  const directoryItems = items.filter(isDirectoryItem)

  if (directoryItems.length > 1) {
    throw new Error('Drop one folder at a time.')
  }
  if (directoryItems.length === 1) {
    // Started synchronously, while the item is still live; the promise itself can
    // be awaited later.
    const getHandle = (directoryItems[0] as unknown as HandleItem).getAsFileSystemHandle
    if (!getHandle) throw new Error(UNSUPPORTED_FOLDER)
    const handle = await getHandle.call(directoryItems[0])
    if (handle.kind !== 'directory') throw new Error(UNSUPPORTED_FOLDER)
    return openDirectoryHandle(handle as FileSystemDirectoryHandle)
  }

  const files = Array.from(dataTransfer.files ?? [])
  const jsons = files.filter((file) => file.name.toLowerCase().endsWith('.json'))
  const pdfs = files.filter((file) => isPdfFile(file))
  const images = files.filter(
    (file) =>
      !isPdfFile(file) &&
      !file.name.toLowerCase().endsWith('.json') &&
      (file.type.startsWith('image/') || isImageName(file.name)),
  )

  if (jsons.length > 1) throw new Error('Drop only one translation.json.')
  if (pdfs.length > 1) throw new Error('Drop one PDF at a time.')
  if (pdfs.length === 1 && images.length > 0) {
    throw new Error('Drop a PDF by itself, not alongside image files.')
  }

  let source: ProjectSource
  if (pdfs.length === 1) {
    source = await openFileProject(pdfs[0]!)
  } else if (images.length > 0) {
    const ordered = images.slice().sort((a, b) => collator.compare(a.name, b.name))
    source = await openImagesProject(ordered, 'Dropped pages')
  } else {
    throw new Error('Nothing to open in that drop.')
  }

  // A dropped folder's translation.json, if any, is already inside it and picked up
  // by the source's own `readJson()` -- only a memory-backed source needs seeding.
  if (jsons.length === 1) {
    await source.writeJson(await jsons[0]!.text())
  }
  return source
}
