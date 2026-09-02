/**
 * Reading, reconciling and writing the project JSON.
 *
 * Everything that decides *what* changes is a pure function over plain data
 * (`reconcile`), so the interesting behaviour -- new pages appearing, images being
 * edited underneath a finished translation -- is testable without a filesystem.
 */

import { hashFile } from './images'
import type { ProjectSource } from './source'
import {
  migrate,
  newPage,
  newProjectFile,
  type Page,
  type ProjectFile,
  type ProjectMeta,
  type ProjectSettings,
} from '../state/schema'

export interface DiskPage {
  file: string
  hash: string
}

export interface ReconcileReport {
  /** Files on disk that the project had never seen. Appended as pending pages. */
  added: string[]
  /** Pages whose image is no longer on disk. Dropped from the project. */
  removed: string[]
  /** Translated pages whose image changed on disk. Marked `stale`. */
  changed: string[]
}

export interface ReconcileResult {
  project: ProjectFile
  report: ReconcileReport
  /** Whether anything actually moved. Lets callers skip a pointless write. */
  dirty: boolean
}

/**
 * Fold the current directory listing into an existing project.
 *
 * Order is preserved for pages that already existed -- a user who reordered pages in the
 * scan view does not want that undone because they added one file. New files land at the
 * end, in the order the listing gave them, for the user to move.
 */
export function reconcile(project: ProjectFile, disk: DiskPage[]): ReconcileResult {
  const onDisk = new Map(disk.map((d) => [d.file, d.hash]))
  const report: ReconcileReport = { added: [], removed: [], changed: [] }

  const kept: Page[] = []
  for (const page of project.pages) {
    const hash = onDisk.get(page.file)
    if (hash === undefined) {
      report.removed.push(page.file)
      continue
    }
    onDisk.delete(page.file)
    // An empty stored hash means the page predates hashing; adopt the disk hash
    // rather than declaring every page stale on first open.
    if (page.hash === '') {
      kept.push({ ...page, hash })
    } else if (page.hash !== hash) {
      report.changed.push(page.file)
      kept.push({ ...page, hash, status: page.status === 'pending' ? 'pending' : 'stale' })
    } else {
      kept.push(page)
    }
  }

  const known = new Set(project.pages.map((p) => p.file))
  for (const d of disk) {
    if (known.has(d.file)) continue
    report.added.push(d.file)
    kept.push(newPage(d.file, 0, d.hash))
  }

  const renumbered = kept.map((page, i) => (page.index === i ? page : { ...page, index: i }))
  const dirty =
    report.added.length > 0 ||
    report.removed.length > 0 ||
    report.changed.length > 0 ||
    renumbered.some((page, i) => page !== kept[i])

  return { project: { ...project, pages: renumbered }, report, dirty }
}

export async function readDiskPages(source: ProjectSource): Promise<DiskPage[]> {
  const pages = await source.listPages()
  const out: DiskPage[] = []
  for (const page of pages) {
    out.push({ file: page.file, hash: await hashFile(await page.getFile()) })
  }
  return out
}

export interface LoadResult {
  project: ProjectFile
  report: ReconcileReport
  /** True when no project JSON existed and one was created in memory. */
  created: boolean
}

/**
 * Open a project, creating it if the folder has no JSON yet.
 *
 * Nothing is written here. The caller saves once the user has confirmed the import,
 * so pointing the app at a folder is never destructive.
 */
export async function loadProject(
  source: ProjectSource,
  defaults: Partial<ProjectMeta & ProjectSettings> = {},
): Promise<LoadResult> {
  const disk = await readDiskPages(source)
  const text = await source.readJson()

  if (text === null) {
    return {
      project: newProjectFile(source.name, disk, defaults),
      report: { added: disk.map((d) => d.file), removed: [], changed: [] },
      created: true,
    }
  }

  const { project, report } = reconcile(migrate(JSON.parse(text)), disk)
  return { project, report, created: false }
}

/** Stamp `updatedAt` at the moment of writing, so the file reflects the save, not the edit. */
export function stampProject(project: ProjectFile): ProjectFile {
  return { ...project, project: { ...project.project, updatedAt: new Date().toISOString() } }
}

export function serializeProject(project: ProjectFile): string {
  return JSON.stringify(project, null, 2) + '\n'
}

export async function saveProject(
  source: ProjectSource,
  project: ProjectFile,
): Promise<ProjectFile> {
  if (!source.writable) throw new Error('this project source is read-only')
  const stamped = stampProject(project)
  await source.writeJson(serializeProject(stamped))
  return stamped
}
