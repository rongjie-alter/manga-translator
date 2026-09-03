import { describe, expect, it, vi } from 'vitest'
import { planCopy, saveCopyToFolder } from '../fs/export'
import { FOLDER_JSON_NAME, type PageSource, type ProjectSource } from '../fs/source'
import { newProjectFile, type ProjectFile } from '../state/schema'

function project(files: string[]): ProjectFile {
  return newProjectFile(
    'my project',
    files.map((file) => ({ file, hash: 'h-' + file })),
  )
}

/** Reverse the reading order without touching the names. */
function reversed(p: ProjectFile): ProjectFile {
  const last = p.pages.length - 1
  return { ...p, pages: p.pages.map((page) => ({ ...page, index: last - page.index })) }
}

describe('planCopy', () => {
  it('keeps the original names when they already sort into reading order', () => {
    const plan = planCopy(project(['p1.jpg', 'p2.jpg', 'p10.jpg']))
    expect(plan.entries).toEqual([
      { from: 'p1.jpg', to: 'p1.jpg' },
      { from: 'p2.jpg', to: 'p2.jpg' },
      { from: 'p10.jpg', to: 'p10.jpg' },
    ])
  })

  it('prefixes a zero-padded index when the names would sort out of order', () => {
    const plan = planCopy(reversed(project(['a.jpg', 'b.jpg', 'c.jpg'])))
    expect(plan.entries).toEqual([
      { from: 'c.jpg', to: '0001-c.jpg' },
      { from: 'b.jpg', to: '0002-b.jpg' },
      { from: 'a.jpg', to: '0003-a.jpg' },
    ])
  })

  it('rewrites page.file in the copied project to match what is written', () => {
    const plan = planCopy(reversed(project(['a.jpg', 'b.jpg'])))
    const ordered = plan.project.pages.slice().sort((x, y) => x.index - y.index)
    expect(ordered.map((p) => p.file)).toEqual(['0001-b.jpg', '0002-a.jpg'])
  })

  it('names the JSON so the copy opens as a folder project', () => {
    expect(planCopy(project(['a.jpg'])).jsonName).toBe(FOLDER_JSON_NAME)
  })

  it('leaves hashes alone so a translated page does not open stale', () => {
    const plan = planCopy(reversed(project(['a.jpg', 'b.jpg'])))
    expect(plan.project.pages.map((p) => p.hash)).toEqual(['h-a.jpg', 'h-b.jpg'])
  })

  it('keeps excluded pages, with the flag intact', () => {
    const p = project(['a.jpg', 'b.jpg'])
    p.pages[1]!.excluded = true
    const plan = planCopy(p)
    expect(plan.entries).toHaveLength(2)
    expect(plan.project.pages[1]!.excluded).toBe(true)
  })

  it('does not mutate the project it was given', () => {
    const p = reversed(project(['a.jpg', 'b.jpg']))
    planCopy(p)
    expect(p.pages.map((x) => x.file)).toEqual(['a.jpg', 'b.jpg'])
  })
})

// -- the write side, against a fake directory handle --------------------------

interface FakeDir {
  handle: FileSystemDirectoryHandle
  written: Map<string, string>
  removed: string[]
}

function fakeDir(name = 'dest'): FakeDir {
  const written = new Map<string, string>()
  const removed: string[] = []
  const files = new Map<string, { size: number }>()

  const getFileHandle = async (fileName: string) => ({
    createWritable: async () => ({
      write: async (data: Blob | ArrayBuffer | Uint8Array) => {
        const text =
          data instanceof Blob
            ? await data.text()
            : new TextDecoder().decode(data as ArrayBuffer)
        written.set(fileName, text)
        files.set(fileName, { size: new TextEncoder().encode(text).byteLength })
      },
      close: async () => {},
      abort: async () => {},
    }),
    getFile: async () => {
      const text = written.get(fileName) ?? ''
      return {
        size: files.get(fileName)?.size ?? 0,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      }
    },
  })

  const handle = {
    name,
    getFileHandle,
    removeEntry: async (fileName: string) => {
      removed.push(fileName)
      written.delete(fileName)
    },
    queryPermission: async () => 'granted' as PermissionState,
  } as unknown as FileSystemDirectoryHandle

  return { handle, written, removed }
}

function sourceOf(files: string[]): ProjectSource {
  const pages: PageSource[] = files.map((file) => ({
    file,
    getFile: async () => new File(['bytes of ' + file], file),
  }))
  return {
    name: 'src',
    jsonName: FOLDER_JSON_NAME,
    writable: true,
    readJson: async () => null,
    writeJson: async () => {},
    listPages: async () => pages,
  }
}

describe('saveCopyToFolder', () => {
  function withPicker(dir: FileSystemDirectoryHandle | null) {
    const picker = vi.fn(async () => {
      if (!dir) throw new DOMException('cancelled', 'AbortError')
      return dir
    })
    ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = picker
    return picker
  }

  it('writes one file per page plus the project JSON', async () => {
    const dest = fakeDir()
    withPicker(dest.handle)

    const result = await saveCopyToFolder(sourceOf(['a.jpg', 'b.jpg']), project(['a.jpg', 'b.jpg']))

    expect(result).toEqual({ folder: 'dest', pages: 2 })
    expect(dest.written.get('a.jpg')).toBe('bytes of a.jpg')
    expect(dest.written.get('b.jpg')).toBe('bytes of b.jpg')
    expect(JSON.parse(dest.written.get(FOLDER_JSON_NAME)!).pages).toHaveLength(2)
  })

  it('writes the renamed pages when the project was reordered', async () => {
    const dest = fakeDir()
    withPicker(dest.handle)

    await saveCopyToFolder(sourceOf(['a.jpg', 'b.jpg']), reversed(project(['a.jpg', 'b.jpg'])))

    expect([...dest.written.keys()].sort()).toEqual([
      '0001-b.jpg',
      '0002-a.jpg',
      FOLDER_JSON_NAME,
    ])
  })

  it('returns null when the user dismisses the picker', async () => {
    withPicker(null)
    expect(await saveCopyToFolder(sourceOf(['a.jpg']), project(['a.jpg']))).toBeNull()
  })

  it('skips a page the source no longer has rather than failing the export', async () => {
    const dest = fakeDir()
    withPicker(dest.handle)

    await saveCopyToFolder(sourceOf(['a.jpg']), project(['a.jpg', 'gone.jpg']))

    expect(dest.written.has('a.jpg')).toBe(true)
    expect(dest.written.has('gone.jpg')).toBe(false)
    expect(dest.written.has(FOLDER_JSON_NAME)).toBe(true)
  })

  it('reports progress for every page and the JSON', async () => {
    const dest = fakeDir()
    withPicker(dest.handle)
    const seen: string[] = []

    await saveCopyToFolder(sourceOf(['a.jpg', 'b.jpg']), project(['a.jpg', 'b.jpg']), (p) =>
      seen.push(p.name),
    )

    expect(seen).toEqual(['a.jpg', 'b.jpg', FOLDER_JSON_NAME])
  })
})
