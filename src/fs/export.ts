/**
 * Getting a project back out of the browser.
 *
 * Autosave writes the JSON next to the images, which is enough while a project *has*
 * a folder. A project imported from a single file or a PDF does not: its pages are in
 * memory and its JSON is in IndexedDB, so without an explicit way out the work is
 * trapped in one browser profile. These two exports are that way out: one for the
 * images, one for the JSON, kept deliberately separate so neither silently renames
 * files the other still refers to by their original name.
 */

import { ensurePermission, swallowAbort } from './handles'
import { serializeProject, stampProject } from './project-file'
import type { ProjectSource } from './source'
import type { ProjectFile } from '../state/schema'

/**
 * Hand the project JSON to the browser's downloader.
 *
 * `jsonName` should be `source.jsonName` -- the same name the scan/projects views
 * already show the user (`foo.pdf` -> `foo.json`, or `translation.json` for a
 * folder). Re-deriving a name from `project.project.name` here previously mangled
 * any title with non-ASCII characters (e.g. Japanese), since it was scrubbed by a
 * `\w`-only sanitizer.
 */
export function downloadProjectJson(project: ProjectFile, jsonName: string): void {
  const stamped = stampProject(project)
  const blob = new Blob([serializeProject(stamped)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = jsonName
  document.body.append(link)
  link.click()
  link.remove()
  // Revoking synchronously can cancel the download in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export interface CopyProgress {
  done: number
  total: number
  name: string
}

/**
 * Write every page's current image into a folder the user picks, under its existing
 * name -- deliberately not renumbered for reading order, since a separately
 * downloaded `translation.json` still refers to pages by their original name, and
 * renaming here would break that match (reconcile matches pages by name).
 *
 * Pages are copied one at a time rather than in parallel: for a PDF-backed project
 * every `getFile()` is a page render, and a folder's worth of those at once is what
 * makes the tab unresponsive. Returns null if the user dismissed the picker.
 */
export async function saveImagesToFolder(
  source: ProjectSource,
  project: ProjectFile,
  onProgress?: (p: CopyProgress) => void,
  signal?: AbortSignal,
): Promise<{ folder: string; pages: number } | null> {
  const picker = (window as unknown as { showDirectoryPicker?: PickDirectory }).showDirectoryPicker
  if (!picker) throw new Error('This browser cannot pick a folder to save into')

  const dir = await picker({ mode: 'readwrite', id: 'comic-translator-export' }).catch(swallowAbort)
  if (!dir) return null
  if (!(await ensurePermission(dir))) throw new Error('Write permission for the folder was denied')

  const pages = project.pages.slice().sort((a, b) => a.index - b.index)
  const byName = new Map((await source.listPages()).map((p) => [p.file, p]))

  let done = 0
  for (const page of pages) {
    if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError')
    onProgress?.({ done, total: pages.length, name: page.file })
    const src = byName.get(page.file)
    // A page listed in the JSON but missing from the source is skipped rather than
    // failing the whole export -- a partial copy beats none.
    if (src) await writeBlob(dir, page.file, await src.getFile())
    done++
  }

  return { folder: dir.name, pages: done }
}

type PickDirectory = (opts?: {
  mode?: 'read' | 'readwrite'
  id?: string
}) => Promise<FileSystemDirectoryHandle>

async function writeBlob(
  dir: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  const stream = await handle.createWritable()
  try {
    await stream.write(blob)
    await stream.close()
  } catch (err) {
    await stream.abort().catch(() => undefined)
    throw err
  }
}
