import { describe, expect, it, vi } from 'vitest'
import { saveImagesToFolder } from '../fs/export'
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

describe('saveImagesToFolder', () => {
  function withPicker(dir: FileSystemDirectoryHandle | null) {
    const picker = vi.fn(async () => {
      if (!dir) throw new DOMException('cancelled', 'AbortError')
      return dir
    })
    ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = picker
    return picker
  }

  it('writes one file per page, under its original name, with no JSON alongside', async () => {
    const dest = fakeDir()
    withPicker(dest.handle)

    const result = await saveImagesToFolder(sourceOf(['a.jpg', 'b.jpg']), project(['a.jpg', 'b.jpg']))

    expect(result).toEqual({ folder: 'dest', pages: 2 })
    expect(dest.written.get('a.jpg')).toBe('bytes of a.jpg')
    expect(dest.written.get('b.jpg')).toBe('bytes of b.jpg')
    expect(dest.written.has(FOLDER_JSON_NAME)).toBe(false)
  })

  it('does not rename pages when the project was reordered', async () => {
    const dest = fakeDir()
    withPicker(dest.handle)

    await saveImagesToFolder(sourceOf(['a.jpg', 'b.jpg']), reversed(project(['a.jpg', 'b.jpg'])))

    expect([...dest.written.keys()].sort()).toEqual(['a.jpg', 'b.jpg'])
  })

  it('returns null when the user dismisses the picker', async () => {
    withPicker(null)
    expect(await saveImagesToFolder(sourceOf(['a.jpg']), project(['a.jpg']))).toBeNull()
  })

  it('skips a page the source no longer has rather than failing the export', async () => {
    const dest = fakeDir()
    withPicker(dest.handle)

    await saveImagesToFolder(sourceOf(['a.jpg']), project(['a.jpg', 'gone.jpg']))

    expect(dest.written.has('a.jpg')).toBe(true)
    expect(dest.written.has('gone.jpg')).toBe(false)
  })

  it('reports progress for every page', async () => {
    const dest = fakeDir()
    withPicker(dest.handle)
    const seen: string[] = []

    await saveImagesToFolder(sourceOf(['a.jpg', 'b.jpg']), project(['a.jpg', 'b.jpg']), (p) =>
      seen.push(p.name),
    )

    expect(seen).toEqual(['a.jpg', 'b.jpg'])
  })
})
