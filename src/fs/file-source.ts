/**
 * A project built from one picked file: a single image, or a PDF.
 *
 * This is the awkward case. `showOpenFilePicker()` hands back a handle to the file
 * and no way to reach its parent directory, so there is nowhere to put `<base>.json`
 * -- the sibling-file layout the rest of the app assumes is simply unavailable. The
 * project JSON therefore lives in IndexedDB, and the export buttons on the scan view
 * are how it gets onto disk. That makes this the one path where clearing site data
 * loses work, which is why the UI says so.
 *
 * The upside is that this path needs no File System Access at all, so opening an
 * image or a PDF works in browsers that cannot open a folder.
 */

import { getPageBlob, listPageBlobNames, putPageBlob } from './blob-store'
import { idbGet, idbSet } from './idb'
import { hashFile } from './images'
import {
  jsonNameForFile,
  sortPageNames,
  type AddedImage,
  type PageSource,
  type ProjectSource,
} from './source'
import { toStorableImage, uniqueName } from './add-images'
import { loadSettings } from '../state/settings'

/**
 * Project identity, and the one decision here worth arguing about.
 *
 * Keyed on the file *name*, not its contents. Hashing the bytes would look more
 * correct, but re-saving a PDF in any tool would then produce a different key, the
 * stored JSON would not be found, a blank project would be created, and the
 * translation would be orphaned in IndexedDB with nothing pointing at it. Keying on
 * the name means a re-saved file finds its project again; the content change shows
 * up where it should, as pages going `stale`. Two different files with the same name
 * collide, which is visible (every page stale) and recoverable, rather than silent.
 */
export function fileProjectId(fileName: string): string {
  return 'file:' + fileName.toLowerCase()
}

function projectKey(projectId: string): string {
  return 'project:' + projectId
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

class MemoryProjectSource implements ProjectSource {
  readonly writable = true
  readonly jsonName: string

  constructor(
    readonly name: string,
    private readonly projectId: string,
    /** Pages that come from the picked file itself. */
    private readonly basePages: PageSource[],
  ) {
    this.jsonName = jsonNameForFile(name)
  }

  async readJson(): Promise<string | null> {
    return (await idbGet<string>(projectKey(this.projectId))) ?? null
  }

  async writeJson(text: string): Promise<void> {
    await idbSet(projectKey(this.projectId), text)
  }

  async listPages(): Promise<PageSource[]> {
    // Added pages come after the file's own, matching where they were appended.
    const added = sortPageNames(await listPageBlobNames(this.projectId)).map((file) => ({
      file,
      getFile: () => this.readAdded(file),
    }))
    return [...this.basePages, ...added]
  }

  /**
   * Added pages are persisted, not just held in memory.
   *
   * A rescan re-lists the source and reconciles against it, so a page that only
   * existed in the store would come back missing and have its translation dropped.
   */
  async addImage(name: string, blob: Blob): Promise<AddedImage> {
    const taken = new Set([
      ...this.basePages.map((page) => page.file),
      ...(await listPageBlobNames(this.projectId)),
    ])
    const finalName = uniqueName(name, taken)
    await putPageBlob(this.projectId, finalName, blob)
    return {
      name: finalName,
      page: { file: finalName, getFile: () => this.readAdded(finalName) },
    }
  }

  private async readAdded(file: string): Promise<File> {
    const blob = await getPageBlob(this.projectId, file)
    if (!blob) throw new Error('could not load added page ' + file)
    return new File([blob], file, { type: blob.type })
  }
}

/** Turn a picked file into a project. Rasterises a PDF; wraps an image as one page. */
export async function openFileProject(file: File): Promise<ProjectSource> {
  const projectId = fileProjectId(file.name)
  requestDurableStorage()
  const pages = isPdfFile(file) ? await pdfPages(file) : await imagePage(file)
  return new MemoryProjectSource(file.name, projectId, pages)
}

/**
 * Ask the browser not to evict this origin's storage under pressure.
 *
 * For a folder project IndexedDB holds only a cache, but for this one it holds the
 * translation itself, so eviction is data loss. Best-effort and deliberately not
 * awaited: it may prompt, it may be refused, and either way opening the file should
 * not wait on the answer.
 */
function requestDurableStorage(): void {
  void navigator.storage?.persist?.().catch(() => undefined)
}

/** A single image is one page, under a name a directory listing would recognise. */
async function imagePage(file: File): Promise<PageSource[]> {
  const storable = await toStorableImage(file)
  const name = storable.converted ? baseName(file.name) + storable.extension : file.name
  return [{ file: name, getFile: async () => new File([storable.blob], name, { type: storable.blob.type }) }]
}

async function pdfPages(file: File): Promise<PageSource[]> {
  // Dynamic import so `pdfjs-dist` is not in the bundle for folder-only users.
  const { openPdf, pageHashSeed } = await import('./pdf')
  const documentHash = await hashFile(file)
  const pdf = await openPdf(file, loadSettings().maxEdge)

  // Names are a pure function of the *page number*, never of position. Reordering
  // pages in the scan view must not rename them: reconcile matches pages by name, so
  // a renumbered page reads as one page removed and a different one added, which
  // would delete the translation.
  const width = Math.max(3, String(pdf.pageCount).length)
  const pages: PageSource[] = []
  for (let pageNo = 1; pageNo <= pdf.pageCount; pageNo++) {
    const file = 'page-' + String(pageNo).padStart(width, '0') + '.jpg'
    pages.push({
      file,
      getFile: async () => new File([await pdf.renderPage(pageNo)], file, { type: 'image/jpeg' }),
      // Derived, not measured -- so opening the project does not render the book.
      hash: () => hashFile(new Blob([pageHashSeed(documentHash, pageNo)])),
    })
  }
  return pages
}

function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}
