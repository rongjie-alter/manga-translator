/**
 * Getting a project back out of the browser.
 *
 * Autosave writes the JSON next to the images, which is enough while a project *has*
 * a folder. A project imported from a single file or a PDF does not: its pages are in
 * memory and its JSON is in IndexedDB, so without an explicit way out the work is
 * trapped in one browser profile. These two exports are that way out.
 */

import { ensurePermission, swallowAbort, writeTextAtomically } from './handles'
import { serializeProject, stampProject } from './project-file'
import { FOLDER_JSON_NAME, sortPageNames, type ProjectSource } from './source'
import type { ProjectFile } from '../state/schema'

export interface CopyEntry {
  /** Page name in the source project. */
  from: string
  /** Name to write in the destination folder. */
  to: string
}

export interface CopyPlan {
  entries: CopyEntry[]
  jsonName: string
  /** The project as it should be written to the copy: `page.file` matches `to`. */
  project: ProjectFile
}

/**
 * Decide what the copy looks like on disk.
 *
 * A folder is reopened by listing it and sorting the names (`sortPageNames`), not by
 * trusting any recorded order -- so copying a reordered project verbatim silently
 * reverts the reordering. When the names already sort into reading order the copy
 * keeps them; when they do not, every page gets a zero-padded numeric prefix so the
 * sort and the reading order become the same thing.
 */
export function planCopy(project: ProjectFile): CopyPlan {
  const ordered = project.pages.slice().sort((a, b) => a.index - b.index)
  const names = ordered.map((p) => p.file)
  const alreadyInOrder =
    sortPageNames(names).every((name, i) => name === names[i]) && !names.includes(FOLDER_JSON_NAME)

  const width = Math.max(4, String(ordered.length).length)
  const entries = ordered.map((page, i) => ({
    from: page.file,
    to: alreadyInOrder ? page.file : String(i + 1).padStart(width, '0') + '-' + page.file,
  }))

  const renamed = new Map(entries.map((e) => [e.from, e.to]))
  return {
    entries,
    jsonName: FOLDER_JSON_NAME,
    project: {
      ...project,
      // Hashes are deliberately untouched: the copy holds the same bytes, so a page
      // that was `translated` must not open as `stale`.
      pages: project.pages.map((page) => ({ ...page, file: renamed.get(page.file) ?? page.file })),
    },
  }
}

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
 * Write every page and the project JSON into a folder the user picks.
 *
 * Pages are copied one at a time rather than in parallel: for a PDF-backed project
 * every `getFile()` is a page render, and a folder's worth of those at once is what
 * makes the tab unresponsive. Returns null if the user dismissed the picker.
 */
export async function saveCopyToFolder(
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

  const plan = planCopy(project)
  const byName = new Map((await source.listPages()).map((p) => [p.file, p]))

  let done = 0
  for (const entry of plan.entries) {
    if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError')
    onProgress?.({ done, total: plan.entries.length, name: entry.to })
    const page = byName.get(entry.from)
    // A page listed in the JSON but missing from the source is skipped rather than
    // failing the whole export -- a partial copy beats none.
    if (page) await writeBlob(dir, entry.to, await page.getFile())
    done++
  }

  await writeTextAtomically(dir, plan.jsonName, serializeProject(stampProject(plan.project)))
  onProgress?.({ done, total: plan.entries.length, name: plan.jsonName })
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
