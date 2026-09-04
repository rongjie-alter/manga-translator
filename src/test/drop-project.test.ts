import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { projectSourceFromDrop } from '../fs/drop-project'
import { idbGet, idbSet } from '../fs/idb'
import { listPageBlobNames } from '../fs/blob-store'
import { openPdf } from '../fs/pdf'

interface FakeItem {
  kind: 'file' | 'string'
  type: string
  directory?: boolean
  handle?: FileSystemHandle | 'unsupported'
}

/** Stand-in for a dropped `DataTransfer`. Real ones cannot be built outside a browser event. */
function dropTransfer(items: FakeItem[], files: File[] = []): DataTransfer {
  return {
    files,
    items: items.map((item) => ({
      kind: item.kind,
      type: item.type,
      webkitGetAsEntry: () => (item.directory ? { isDirectory: true } : null),
      ...(item.handle === 'unsupported'
        ? {}
        : { getAsFileSystemHandle: async () => item.handle }),
    })),
    types: files.length > 0 || items.length > 0 ? ['Files'] : [],
  } as unknown as DataTransfer
}

function dirHandle(name: string): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => 'granted' as PermissionState,
    entries: () => (async function* () {})(),
  } as unknown as FileSystemDirectoryHandle
}

const png = (name: string, body = 'bytes') => new File([body], name, { type: 'image/png' })
const pdfFile = (name = 'book.pdf') => new File(['%PDF-1.4'], name, { type: 'application/pdf' })
const json = (text: string, name = 'translation.json') =>
  new File([text], name, { type: 'application/json' })

beforeEach(() => {
  vi.mocked(idbGet).mockReset().mockResolvedValue(undefined)
  vi.mocked(idbSet).mockReset().mockResolvedValue(undefined)
  vi.mocked(listPageBlobNames).mockReset().mockResolvedValue([])
  vi.mocked(openPdf).mockReset().mockResolvedValue({
    pageCount: 1,
    renderPage: async () => new Blob(['page']),
    destroy: async () => {},
  })
})

describe('a dropped folder', () => {
  it('opens a writable project remembered under "Recent"', async () => {
    const dir = dirHandle('manga-vol1')
    const source = await projectSourceFromDrop(
      dropTransfer([{ kind: 'file', type: '', directory: true, handle: dir }]),
    )

    expect(source.name).toBe('manga-vol1')
    expect(source.writable).toBe(true)
    expect(idbSet).toHaveBeenCalledWith('handle:manga-vol1', dir)
  })

  it('rejects a folder when the browser cannot hand back a real handle', async () => {
    await expect(
      projectSourceFromDrop(
        dropTransfer([{ kind: 'file', type: '', directory: true, handle: 'unsupported' }]),
      ),
    ).rejects.toThrow(/can.t open a dropped folder/)
  })

  it('refuses more than one folder at a time', async () => {
    const items: FakeItem[] = [
      { kind: 'file', type: '', directory: true, handle: dirHandle('a') },
      { kind: 'file', type: '', directory: true, handle: dirHandle('b') },
    ]
    await expect(projectSourceFromDrop(dropTransfer(items))).rejects.toThrow(/one folder/)
  })
})

describe('a dropped PDF', () => {
  it('opens as its own project', async () => {
    const source = await projectSourceFromDrop(dropTransfer([], [pdfFile()]))
    expect(source.name).toBe('book.pdf')
    expect((await source.listPages())).toHaveLength(1)
  })

  it('refuses more than one PDF', async () => {
    await expect(
      projectSourceFromDrop(dropTransfer([], [pdfFile('a.pdf'), pdfFile('b.pdf')])),
    ).rejects.toThrow(/one PDF/)
  })

  it('refuses a PDF mixed with loose images', async () => {
    await expect(
      projectSourceFromDrop(dropTransfer([], [pdfFile(), png('a.png')])),
    ).rejects.toThrow(/by itself/)
  })
})

describe('dropped loose images', () => {
  it('become one project, in reading order', async () => {
    const source = await projectSourceFromDrop(
      dropTransfer([], [png('page-10.png'), png('page-2.png'), png('page-1.png')]),
    )

    const pages = await source.listPages()
    expect(pages.map((p) => p.file)).toEqual(['page-1.png', 'page-2.png', 'page-10.png'])
  })

  it('seeds the project JSON from a single accompanying .json file', async () => {
    const text = '{"schemaVersion":1,"project":{"name":"x"}}'
    const source = await projectSourceFromDrop(
      dropTransfer([], [png('a.png'), json(text, 'export-2024.json')]),
    )

    vi.mocked(idbGet).mockResolvedValue(text)
    expect(await source.readJson()).toBe(text)
  })

  it('refuses more than one .json file', async () => {
    await expect(
      projectSourceFromDrop(
        dropTransfer([], [png('a.png'), json('{}', 'one.json'), json('{}', 'two.json')]),
      ),
    ).rejects.toThrow(/one translation.json/)
  })
})

describe('nothing droppable', () => {
  it('throws instead of silently doing nothing', async () => {
    await expect(projectSourceFromDrop(dropTransfer([], []))).rejects.toThrow(
      /nothing to open/i,
    )
  })
})
