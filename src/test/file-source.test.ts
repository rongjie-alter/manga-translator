import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteMemoryProject,
  fileProjectId,
  isPdfFile,
  openClipboardProject,
  openFileProject,
  openImagesProject,
} from '../fs/file-source'
import { reconcile, readDiskPages } from '../fs/project-file'
import { FOLDER_JSON_NAME } from '../fs/source'
import { migrate, newProjectFile } from '../state/schema'

vi.mock('../fs/idb', () => ({
  idbGet: vi.fn(),
  idbSet: vi.fn(),
  idbDelete: vi.fn(),
  idbKeys: vi.fn(),
}))

vi.mock('../fs/blob-store', () => ({
  putPageBlob: vi.fn(),
  getPageBlob: vi.fn(),
  listPageBlobNames: vi.fn(),
  clearPageBlobs: vi.fn(),
}))

vi.mock('../fs/pdf', () => ({
  openPdf: vi.fn(),
  pageHashSeed: (documentHash: string, pageNo: number, renderEdge: number) =>
    'r2:' + documentHash + ':' + pageNo + ':' + renderEdge,
  RASTER_VERSION: 'r2',
}))

import { idbDelete, idbGet, idbSet } from '../fs/idb'
import { getPageBlob, listPageBlobNames, putPageBlob } from '../fs/blob-store'
import { openPdf } from '../fs/pdf'

const png = (name: string, body = 'bytes') =>
  new File([body], name, { type: 'image/png' })

const pdfFile = (name = 'book.pdf', body = '%PDF-1.4') =>
  new File([body], name, { type: 'application/pdf' })

/** A rasterizer that counts renders, so tests can prove none happened. */
function fakePdf(pageCount: number) {
  const renderPage = vi.fn(async (pageNo: number) => new Blob(['page ' + pageNo]))
  const destroy = vi.fn(async () => {})
  vi.mocked(openPdf).mockResolvedValue({ pageCount, renderPage, destroy })
  return { renderPage, destroy }
}

beforeEach(() => {
  vi.mocked(idbGet).mockReset().mockResolvedValue(undefined)
  vi.mocked(idbSet).mockReset().mockResolvedValue(undefined)
  vi.mocked(listPageBlobNames).mockReset().mockResolvedValue([])
  vi.mocked(getPageBlob).mockReset().mockResolvedValue(undefined)
  vi.mocked(putPageBlob).mockReset().mockResolvedValue(undefined)
  vi.mocked(openPdf).mockReset()
  vi.mocked(idbDelete).mockReset().mockResolvedValue(undefined)
})

describe('fileProjectId', () => {
  it('is derived from the name, so a re-saved file finds its project again', () => {
    expect(fileProjectId('Book.pdf')).toBe(fileProjectId('book.pdf'))
  })

  it('is different for differently named files', () => {
    expect(fileProjectId('ch1.pdf')).not.toBe(fileProjectId('ch2.pdf'))
  })
})

describe('isPdfFile', () => {
  it('recognises a PDF by type or by extension', () => {
    expect(isPdfFile(pdfFile())).toBe(true)
    expect(isPdfFile(new File([''], 'book.PDF', { type: '' }))).toBe(true)
  })

  it('does not mistake an image for one', () => {
    expect(isPdfFile(png('a.png'))).toBe(false)
  })
})

describe('openImagesProject', () => {
  it('defaults to a fresh random id on every call', async () => {
    const a = await openImagesProject([png('a.png')], 'Dropped pages')
    const b = await openImagesProject([png('a.png')], 'Dropped pages')

    await a.writeJson('{"a":1}')
    await b.writeJson('{"b":1}')

    const [keyA] = vi.mocked(idbSet).mock.calls[0]!
    const [keyB] = vi.mocked(idbSet).mock.calls[1]!
    expect(keyA).not.toBe(keyB)
  })

  it('reuses the same IndexedDB key when a caller passes an explicit project id', async () => {
    const a = await openImagesProject([png('p1.jpg')], 'Thread A', 'thread:twitter:1')
    const b = await openImagesProject([png('p1.jpg')], 'Thread A (refetched)', 'thread:twitter:1')

    await a.writeJson('{"schemaVersion":1}')
    await b.writeJson('{"schemaVersion":1}')

    const [keyA] = vi.mocked(idbSet).mock.calls[0]!
    const [keyB] = vi.mocked(idbSet).mock.calls[1]!
    expect(keyA).toBe(keyB)
    expect(keyA).toBe('project:thread:twitter:1')
  })
})

describe('openClipboardProject', () => {
  it('flags the project as started from clipboard', async () => {
    const source = await openClipboardProject([png('a.png')])
    expect(source.startedFromClipboard).toBe(true)
  })

  it('leaves other sources unflagged', async () => {
    expect((await openImagesProject([png('a.png')], 'Dropped pages')).startedFromClipboard).toBeFalsy()
    expect((await openFileProject(png('cover.png'))).startedFromClipboard).toBeFalsy()
  })

  it('defaults to a fresh random id on every call, like a drop', async () => {
    const a = await openClipboardProject([png('a.png')])
    const b = await openClipboardProject([png('a.png')])

    await a.writeJson('{"a":1}')
    await b.writeJson('{"b":1}')

    const [keyA] = vi.mocked(idbSet).mock.calls[0]!
    const [keyB] = vi.mocked(idbSet).mock.calls[1]!
    expect(keyA).not.toBe(keyB)
  })
})

describe('deleteMemoryProject', () => {
  it('deletes the saved translation under the project key', async () => {
    await deleteMemoryProject('thread:twitter:1')
    expect(idbDelete).toHaveBeenCalledWith('project:thread:twitter:1')
  })
})

describe('a single-image project', () => {
  it('stores its JSON beside nothing, under the file base name', async () => {
    const source = await openFileProject(png('cover.png'))
    expect(source.jsonName).toBe('cover.json')
    expect(source.name).toBe('cover.png')
  })

  it('has exactly one page, named after the file', async () => {
    const source = await openFileProject(png('cover.png'))
    const pages = await source.listPages()

    expect(pages.map((p) => p.file)).toEqual(['cover.png'])
    expect((await pages[0]!.getFile()).type).toBe('image/png')
  })

  it('round-trips its JSON through IndexedDB', async () => {
    const source = await openFileProject(png('cover.png'))

    await source.writeJson('{"schemaVersion":1}')
    const [key, value] = vi.mocked(idbSet).mock.calls[0]!
    expect(key).toBe('project:file:cover.png')
    expect(value).toBe('{"schemaVersion":1}')

    vi.mocked(idbGet).mockResolvedValue('{"schemaVersion":1}')
    expect(await source.readJson()).toBe('{"schemaVersion":1}')
  })

  it('reports no stored project the first time it is opened', async () => {
    const source = await openFileProject(png('cover.png'))
    expect(await source.readJson()).toBeNull()
  })

  it('is writable, so autosave keeps working unchanged', async () => {
    expect((await openFileProject(png('cover.png'))).writable).toBe(true)
  })
})

describe('a PDF project', () => {
  it('turns every page into a page source, zero-padded in page order', async () => {
    fakePdf(12)
    const source = await openFileProject(pdfFile())

    const pages = await source.listPages()

    expect(pages).toHaveLength(12)
    expect(pages[0]!.file).toBe('page-001.jpg')
    expect(pages[11]!.file).toBe('page-012.jpg')
  })

  it('widens the padding for a book that needs it', async () => {
    fakePdf(1200)
    const pages = await (await openFileProject(pdfFile())).listPages()

    expect(pages[0]!.file).toBe('page-0001.jpg')
    expect(pages.at(-1)!.file).toBe('page-1200.jpg')
  })

  it('names pages by page number, not by position', async () => {
    fakePdf(3)
    const source = await openFileProject(pdfFile())

    // Two listings must agree, whatever order anything else put things in --
    // reconcile matches pages by name, so a renamed page loses its translation.
    const first = (await source.listPages()).map((p) => p.file)
    const second = (await source.listPages()).map((p) => p.file)
    expect(second).toEqual(first)
  })

  it('hashes pages without rendering any of them', async () => {
    const { renderPage } = fakePdf(40)
    const source = await openFileProject(pdfFile())

    const { disk } = await readDiskPages(source)

    expect(disk).toHaveLength(40)
    expect(renderPage).not.toHaveBeenCalled()
    for (const entry of disk) expect(entry.hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('gives every page a distinct hash', async () => {
    fakePdf(20)
    const { disk } = await readDiskPages(await openFileProject(pdfFile()))

    expect(new Set(disk.map((d) => d.hash)).size).toBe(20)
  })

  it('gives the same page the same hash on a later open', async () => {
    fakePdf(3)
    const first = await readDiskPages(await openFileProject(pdfFile()))
    fakePdf(3)
    const second = await readDiskPages(await openFileProject(pdfFile()))

    expect(second.disk).toEqual(first.disk)
  })

  it('stales its pages when the PDF itself changed, rather than losing them', async () => {
    fakePdf(2)
    const original = await readDiskPages(await openFileProject(pdfFile('book.pdf', '%PDF-a')))
    const project = newProjectFile('book.pdf', original.disk)
    const translated = {
      ...project,
      pages: project.pages.map((p) => ({ ...p, status: 'translated' as const })),
    }

    fakePdf(2)
    const edited = await readDiskPages(await openFileProject(pdfFile('book.pdf', '%PDF-b')))
    const { project: next, report } = reconcile(translated, edited.disk)

    expect(report.removed).toEqual([])
    expect(report.added).toEqual([])
    expect(report.changed).toEqual(['page-001.jpg', 'page-002.jpg'])
    expect(next.pages.map((p) => p.status)).toEqual(['stale', 'stale'])
  })

  it('renders a page only when its image is actually asked for', async () => {
    const { renderPage } = fakePdf(5)
    const pages = await (await openFileProject(pdfFile())).listPages()

    expect(renderPage).not.toHaveBeenCalled()
    const image = await pages[2]!.getFile()

    expect(renderPage).toHaveBeenCalledExactlyOnceWith(3)
    expect(image.name).toBe('page-003.jpg')
    expect(image.type).toBe('image/jpeg')
  })

  it('reports its current render edge, matching what it was opened at', async () => {
    fakePdf(1)
    const source = await openFileProject(pdfFile())
    // No local override in this test environment, so the built-in default applies.
    expect(source.pdfRenderEdge).toBe(2400)
  })

  it('stales already-translated pages when reprocessed at a different resolution', async () => {
    fakePdf(2)
    const source = await openFileProject(pdfFile())
    const before = await readDiskPages(source)
    const project = newProjectFile('book.pdf', before.disk)
    const translated = {
      ...project,
      pages: project.pages.map((p) => ({ ...p, status: 'translated' as const })),
    }

    await source.reprocessPdf!(3200)
    const after = await readDiskPages(source)
    const { project: next, report } = reconcile(translated, after.disk)

    expect(source.pdfRenderEdge).toBe(3200)
    expect(report.changed).toEqual(['page-001.jpg', 'page-002.jpg'])
    expect(next.pages.map((p) => p.status)).toEqual(['stale', 'stale'])
  })

  it('reprocesses through a freshly opened renderer, keeping page identity', async () => {
    const first = fakePdf(2)
    const source = await openFileProject(pdfFile())

    const second = fakePdf(2)
    await source.reprocessPdf!(3200)

    const pages = await source.listPages()
    expect(pages.map((p) => p.file)).toEqual(['page-001.jpg', 'page-002.jpg'])

    await pages[0]!.getFile()
    expect(first.renderPage).not.toHaveBeenCalled()
    expect(second.renderPage).toHaveBeenCalledExactlyOnceWith(1)
    expect(first.destroy).toHaveBeenCalledOnce()
  })
})

describe('reopening a memory-backed project', () => {
  it('preserves a reordering and an exclusion the user saved', async () => {
    fakePdf(3)
    const { disk } = await readDiskPages(await openFileProject(pdfFile()))
    const fresh = newProjectFile('book.pdf', disk)

    // The user reverses the order and excludes one page, and it is saved. Array
    // order is what carries the ordering -- `reconcile` renumbers `index` from it,
    // which is exactly what the scan view's move buttons maintain.
    const reversed = fresh.pages.slice().reverse()
    const edited = {
      ...fresh,
      pages: reversed.map((p, i) => ({ ...p, index: i, excluded: p.file === 'page-001.jpg' })),
    }
    const stored = JSON.stringify(edited)

    fakePdf(3)
    const reopened = await openFileProject(pdfFile())
    vi.mocked(idbGet).mockResolvedValue(stored)
    const listing = await readDiskPages(reopened)
    const { project, report } = reconcile(migrate(JSON.parse((await reopened.readJson())!)), listing.disk)

    expect(report).toEqual({ added: [], removed: [], changed: [] })
    const byIndex = project.pages.slice().sort((a, b) => a.index - b.index)
    expect(byIndex.map((p) => p.file)).toEqual(['page-003.jpg', 'page-002.jpg', 'page-001.jpg'])
    expect(project.pages.find((p) => p.file === 'page-001.jpg')!.excluded).toBe(true)
  })
})

describe('adding pages to a memory-backed project', () => {
  it('persists the blob rather than only holding it in memory', async () => {
    fakePdf(2)
    const source = await openFileProject(pdfFile())

    const added = await source.addImage!('page-003.png', new Blob(['x']))

    expect(added.name).toBe('page-003.png')
    expect(putPageBlob).toHaveBeenCalledWith('file:book.pdf', 'page-003.png', expect.any(Blob))
  })

  it('lists added pages after the file own pages, so they stay at the end', async () => {
    fakePdf(2)
    const source = await openFileProject(pdfFile())
    vi.mocked(listPageBlobNames).mockResolvedValue(['extra-2.png', 'extra-1.png'])

    const pages = await source.listPages()

    expect(pages.map((p) => p.file)).toEqual([
      'page-001.jpg',
      'page-002.jpg',
      'extra-1.png',
      'extra-2.png',
    ])
  })

  it('survives a rescan instead of being reported as missing', async () => {
    fakePdf(2)
    const source = await openFileProject(pdfFile())
    const before = await readDiskPages(source)
    const project = newProjectFile('book.pdf', before.disk)

    // The added page is now part of what the source lists.
    vi.mocked(listPageBlobNames).mockResolvedValue(['page-003.png'])
    vi.mocked(getPageBlob).mockResolvedValue(new Blob(['added']))
    const after = await readDiskPages(source)
    const { report } = reconcile(project, after.disk)

    expect(report.removed).toEqual([])
    expect(report.added).toEqual(['page-003.png'])
  })

  it('does not collide with a page the file already provides', async () => {
    fakePdf(2)
    const source = await openFileProject(pdfFile())

    const added = await source.addImage!('page-001.jpg', new Blob(['x']))

    expect(added.name).toBe('page-001-2.jpg')
  })

  it('reads an added page back from storage', async () => {
    fakePdf(1)
    const source = await openFileProject(pdfFile())
    await source.addImage!('page-002.png', new Blob(['added bytes']))
    vi.mocked(getPageBlob).mockResolvedValue(new Blob(['added bytes'], { type: 'image/png' }))
    vi.mocked(listPageBlobNames).mockResolvedValue(['page-002.png'])

    const pages = await source.listPages()
    const image = await pages[1]!.getFile()

    expect(await image.text()).toBe('added bytes')
  })

  it('reports a page whose blob has gone rather than returning an empty image', async () => {
    fakePdf(1)
    const source = await openFileProject(pdfFile())
    vi.mocked(listPageBlobNames).mockResolvedValue(['page-002.png'])
    vi.mocked(getPageBlob).mockResolvedValue(undefined)

    const pages = await source.listPages()

    await expect(pages[1]!.getFile()).rejects.toThrow('could not load added page page-002.png')
  })
})

describe('the folder JSON name is not used here', () => {
  it('uses the file base name, so two files in one folder do not clash', async () => {
    fakePdf(1)
    expect((await openFileProject(pdfFile('vol1.pdf'))).jsonName).toBe('vol1.json')
    expect((await openFileProject(pdfFile('vol1.pdf'))).jsonName).not.toBe(FOLDER_JSON_NAME)
  })
})
