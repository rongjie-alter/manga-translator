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

/**
 * What a PDF-backed project needs to keep around after the initial open, so a later
 * `reprocessPdf` can swap in a fresh renderer without disturbing page identity: names
 * are a pure function of page number (see `openPdfState` below) and must never
 * change, but the renderer producing their bytes, and the edge it renders at, are
 * mutable.
 */
interface PdfState {
  file: File
  documentHash: string
  pdf: RasterizedPdfLike
  renderEdge: number
  /** `page-001.jpg` etc, index 0 is page 1. Fixed for the life of the project. */
  pageNames: string[]
  pageHashSeed: (documentHash: string, pageNo: number, renderEdge: number) => string
}

/** Just the bit of `RasterizedPdf` this module uses, so it need not import `./pdf` eagerly. */
interface RasterizedPdfLike {
  renderPage(pageNo: number): Promise<Blob>
  destroy(): Promise<void>
}

class MemoryProjectSource implements ProjectSource {
  readonly writable = true
  readonly jsonName: string
  private pdfState: PdfState | null

  constructor(
    readonly name: string,
    private readonly projectId: string,
    /** Pages that come from the picked file itself, when it is not a PDF. */
    private readonly basePages: PageSource[],
    pdfState: PdfState | null = null,
  ) {
    this.jsonName = jsonNameForFile(name)
    this.pdfState = pdfState
  }

  get pdfRenderEdge(): number | undefined {
    return this.pdfState?.renderEdge
  }

  async reprocessPdf(renderEdge: number): Promise<void> {
    const state = this.pdfState
    if (!state) throw new Error('this project is not backed by a PDF')
    const { openPdf } = await import('./pdf')
    const pdf = await openPdf(state.file, renderEdge)
    const old = state.pdf
    state.pdf = pdf
    state.renderEdge = renderEdge
    await old.destroy()
  }

  async readJson(): Promise<string | null> {
    return (await idbGet<string>(projectKey(this.projectId))) ?? null
  }

  async writeJson(text: string): Promise<void> {
    await idbSet(projectKey(this.projectId), text)
  }

  async listPages(): Promise<PageSource[]> {
    const base = this.pdfState ? pdfPageSources(this.pdfState) : this.basePages
    // Added pages come after the file's own, matching where they were appended.
    const added = sortPageNames(await listPageBlobNames(this.projectId)).map((file) => ({
      file,
      getFile: () => this.readAdded(file),
    }))
    return [...base, ...added]
  }

  /**
   * Added pages are persisted, not just held in memory.
   *
   * A rescan re-lists the source and reconciles against it, so a page that only
   * existed in the store would come back missing and have its translation dropped.
   */
  async addImage(name: string, blob: Blob): Promise<AddedImage> {
    const taken = new Set([
      ...(this.pdfState?.pageNames ?? this.basePages.map((page) => page.file)),
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
  if (isPdfFile(file)) {
    const pdfState = await openPdfState(file, loadSettings().pdfRenderEdge)
    return new MemoryProjectSource(file.name, projectId, [], pdfState)
  }
  return new MemoryProjectSource(file.name, projectId, await imagePages([file]))
}

/**
 * Turn a set of loose dropped images into a project, with no folder or file of
 * their own to be named or keyed after.
 *
 * Unlike `openFileProject`, there is nothing stable to key the project on -- these
 * files have no shared identity to reopen against -- so each drop is its own project,
 * same as a single image picked through the file-input fallback (also never
 * remembered under "Recent").
 */
export async function openImagesProject(files: File[], name: string): Promise<ProjectSource> {
  const projectId = 'drop:' + crypto.randomUUID()
  requestDurableStorage()
  return new MemoryProjectSource(name, projectId, await imagePages(files))
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

/**
 * Each file becomes one page, under a name a directory listing would recognise.
 *
 * Names are de-duplicated with `uniqueName`: a single picked file can never collide
 * with itself, but a batch of dropped files can (two `page.jpg` from different
 * folders), and silently overwriting one page's blob with another's would lose it.
 */
async function imagePages(files: File[]): Promise<PageSource[]> {
  const taken = new Set<string>()
  const pages: PageSource[] = []
  for (const file of files) {
    const storable = await toStorableImage(file)
    const base = storable.converted ? baseName(file.name) + storable.extension : file.name
    const name = uniqueName(base, taken)
    taken.add(name)
    pages.push({
      file: name,
      getFile: async () => new File([storable.blob], name, { type: storable.blob.type }),
    })
  }
  return pages
}

async function openPdfState(file: File, renderEdge: number): Promise<PdfState> {
  // Dynamic import so `pdfjs-dist` is not in the bundle for folder-only users.
  const { openPdf, pageHashSeed } = await import('./pdf')
  const documentHash = await hashFile(file)
  const pdf = await openPdf(file, renderEdge)

  // Names are a pure function of the *page number*, never of position. Reordering
  // pages in the scan view must not rename them: reconcile matches pages by name, so
  // a renumbered page reads as one page removed and a different one added, which
  // would delete the translation. Fixed at open time, unaffected by a later
  // `reprocessPdf` -- only the renderer producing their bytes changes.
  const width = Math.max(3, String(pdf.pageCount).length)
  const pageNames = Array.from(
    { length: pdf.pageCount },
    (_, i) => 'page-' + String(i + 1).padStart(width, '0') + '.jpg',
  )
  return { file, documentHash, pdf, renderEdge, pageNames, pageHashSeed }
}

function pdfPageSources(state: PdfState): PageSource[] {
  return state.pageNames.map((file, i) => {
    const pageNo = i + 1
    return {
      file,
      getFile: async () => new File([await state.pdf.renderPage(pageNo)], file, { type: 'image/jpeg' }),
      // Derived, not measured -- so opening the project does not render the book.
      hash: () => hashFile(new Blob([state.pageHashSeed(state.documentHash, pageNo, state.renderEdge)])),
    }
  })
}

function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}
