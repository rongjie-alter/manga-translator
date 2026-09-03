/**
 * Rasterising a PDF into page images, lazily.
 *
 * Pages are rendered on demand and cached under a byte budget rather than rendered
 * up front: a 200-page book is hundreds of megabytes of JPEG, and the reader only
 * ever looks at a few pages at a time. Nothing is written to disk -- a PDF project
 * re-renders on each open, which is why `MemoryProjectSource` derives page hashes
 * arithmetically instead of from the rendered bytes (see `pageHashSeed`).
 *
 * `pdfjs-dist` is used directly rather than through a wrapper so the worker can be
 * bundled with the app. Wrappers in this space tend to point `workerSrc` at a CDN,
 * which would make opening a local file depend on the network and contradict this
 * app's promise that nothing leaves the browser except the pages being translated.
 */

import * as pdfjs from 'pdfjs-dist'
// Vite resolves the specifier and emits the worker as a bundled asset. `new URL(...,
// import.meta.url)` would not work here: that form only resolves relative paths.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fitToEdge } from './images'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Bumped when a change to how pages are rendered means the pixels differ.
 *
 * It feeds the per-page hash, so raising it marks already-translated pages `stale`
 * rather than leaving a translation attached to an image it no longer describes.
 */
export const RASTER_VERSION = 'r2'

/** JPEG quality for rendered pages, matching what `prepareImage` uses for uploads. */
const QUALITY = 0.85

/**
 * How much rendered output to keep. Sized in bytes rather than pages because page
 * sizes vary by an order of magnitude -- a text page and a full-bleed spread are not
 * interchangeable units.
 */
const MAX_CACHE_BYTES = 48 * 1024 * 1024

/**
 * Give up on a page that will not draw.
 *
 * Renders are serialised, so a `render()` that never settles does not just lose one
 * page -- it wedges every page queued behind it, permanently. Environments where
 * rasterisation does not complete do exist (an embedded view that never composites,
 * for one), and a page that fails is recoverable in the UI where a document that
 * silently stops responding is not.
 */
const RENDER_TIMEOUT_MS = 30_000

export interface RasterizedPdf {
  pageCount: number
  /** Render one page, 1-based. Cached, and serialised against other renders. */
  renderPage(pageNo: number): Promise<Blob>
  destroy(): Promise<void>
}

export async function openPdf(file: Blob, renderEdge: number): Promise<RasterizedPdf> {
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjs.getDocument({ data }).promise

  const cache = new Map<number, Blob>()
  let cachedBytes = 0
  // Renders are serialised: each one holds a full-page bitmap plus a canvas, and
  // letting a scrolling grid start twenty at once is what makes the tab stall.
  let queue: Promise<unknown> = Promise.resolve()

  async function render(pageNo: number): Promise<Blob> {
    const hit = cache.get(pageNo)
    if (hit) {
      // Re-insert to mark as most recently used.
      cache.delete(pageNo)
      cache.set(pageNo, hit)
      return hit
    }

    const page = await doc.getPage(pageNo)
    try {
      const natural = page.getViewport({ scale: 1 })
      const fitted = fitToEdge({ width: natural.width, height: natural.height }, renderEdge)
      const viewport = page.getViewport({ scale: fitted.width / natural.width })

      const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('could not get a 2d context to render the PDF page')

      const task = page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          task.promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              // Cancel so pdf.js lets go of the page rather than drawing into a
              // canvas nobody is waiting for any more.
              task.cancel()
              reject(new Error('timed out rendering page ' + pageNo + ' of the PDF'))
            }, RENDER_TIMEOUT_MS)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }

      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY })
      cache.set(pageNo, blob)
      cachedBytes += blob.size
      evict()
      return blob
    } finally {
      page.cleanup()
    }
  }

  function evict(): void {
    // Keep at least one page, so a single page larger than the budget still works.
    while (cachedBytes > MAX_CACHE_BYTES && cache.size > 1) {
      const oldest = cache.keys().next()
      if (oldest.done) return
      const dropped = cache.get(oldest.value)
      cache.delete(oldest.value)
      cachedBytes -= dropped?.size ?? 0
    }
  }

  return {
    pageCount: doc.numPages,
    renderPage(pageNo: number): Promise<Blob> {
      const run = queue.then(
        () => render(pageNo),
        () => render(pageNo),
      )
      queue = run.catch(() => undefined)
      return run
    },
    async destroy(): Promise<void> {
      cache.clear()
      cachedBytes = 0
      await doc.destroy()
    },
  }
}

/**
 * What a rendered page's hash is derived from.
 *
 * Hashing the rendered bytes would mean rendering every page just to open the
 * project. This instead identifies a page by the document it came from, its page
 * number, the renderer version, and the edge it was rendered at -- all known without
 * doing any work. Re-saving the PDF changes `documentHash`, so every page goes
 * `stale` and keeps its translation, rather than the project being unable to
 * recognise itself. Including `renderEdge` means raising the render resolution
 * (globally in Settings, or per-project via a reprocess) marks pages `stale` for the
 * same reason, instead of silently leaving a translation attached to a lower-quality
 * image than what is now on screen.
 */
export function pageHashSeed(documentHash: string, pageNo: number, renderEdge: number): string {
  return RASTER_VERSION + ':' + documentHash + ':' + pageNo + ':' + renderEdge
}
