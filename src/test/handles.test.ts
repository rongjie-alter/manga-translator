import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fs/idb', () => ({
  idbGet: vi.fn(),
  idbSet: vi.fn(),
  idbDelete: vi.fn(),
  idbKeys: vi.fn(),
}))

vi.mock('../fs/file-source', () => ({
  openFileProject: vi.fn(),
  fileProjectId: (name: string) => 'file:' + name.toLowerCase(),
  isPdfFile: () => false,
}))

import { listRememberedProjects, reviveProject } from '../fs/handles'
import { idbGet, idbKeys } from '../fs/idb'
import { openFileProject } from '../fs/file-source'
import type { ProjectSource } from '../fs/source'

/**
 * A directory handle as older builds stored it: the bare handle, no wrapper.
 *
 * `FileSystemHandle.kind` is native, which is why files and folders can share one
 * store with no record format to migrate.
 */
function dirHandle(name: string, granted = true): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    queryPermission: async () => (granted ? 'granted' : 'prompt') as PermissionState,
    requestPermission: async () => (granted ? 'granted' : 'denied') as PermissionState,
    entries: () => (async function* () {})(),
  } as unknown as FileSystemDirectoryHandle
}

function fileHandle(name: string, granted = true): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    queryPermission: async () => (granted ? 'granted' : 'prompt') as PermissionState,
    requestPermission: async () => (granted ? 'granted' : 'denied') as PermissionState,
    getFile: async () => new File(['bytes'], name, { type: 'image/png' }),
  } as unknown as FileSystemFileHandle
}

beforeEach(() => {
  vi.mocked(idbGet).mockReset()
  vi.mocked(idbKeys).mockReset().mockResolvedValue([])
  vi.mocked(openFileProject).mockReset()
})

describe('reviveProject', () => {
  it('revives a handle written by an older build as a folder project', async () => {
    vi.mocked(idbGet).mockResolvedValue(dirHandle('vol1'))

    const source = await reviveProject('vol1')

    expect(source?.name).toBe('vol1')
    expect(source?.jsonName).toBe('translation.json')
    expect(openFileProject).not.toHaveBeenCalled()
  })

  it('revives a file handle as a single-file project', async () => {
    const handle = fileHandle('cover.png')
    vi.mocked(idbGet).mockResolvedValue(handle)
    vi.mocked(openFileProject).mockResolvedValue({ name: 'cover.png' } as ProjectSource)

    const source = await reviveProject('cover.png')

    expect(source).toEqual({ name: 'cover.png' })
    const passed = vi.mocked(openFileProject).mock.calls[0]![0]
    expect(passed.name).toBe('cover.png')
  })

  it('returns null when nothing was remembered under that key', async () => {
    vi.mocked(idbGet).mockResolvedValue(undefined)
    expect(await reviveProject('gone')).toBeNull()
  })

  it('returns null when permission for a folder is refused', async () => {
    vi.mocked(idbGet).mockResolvedValue(dirHandle('vol1', false))
    expect(await reviveProject('vol1')).toBeNull()
  })

  it('returns null when permission for a file is refused', async () => {
    vi.mocked(idbGet).mockResolvedValue(fileHandle('cover.png', false))

    expect(await reviveProject('cover.png')).toBeNull()
    expect(openFileProject).not.toHaveBeenCalled()
  })
})

describe('listRememberedProjects', () => {
  it('lists only remembered handles, without their key prefix', async () => {
    vi.mocked(idbKeys).mockResolvedValue([
      'handle:vol1',
      'project:file:book.pdf',
      'pageblob:file:book.pdf/page-1.png',
      'handle:cover.png',
    ])
    vi.mocked(idbGet).mockImplementation(async (key: string) =>
      key === 'handle:cover.png' ? fileHandle('cover.png') : dirHandle('vol1'),
    )

    const remembered = await listRememberedProjects()

    expect(remembered).toEqual([
      { key: 'vol1', kind: 'folder' },
      { key: 'cover.png', kind: 'file' },
    ])
  })

  it('reports a folder for a handle it cannot read back', async () => {
    vi.mocked(idbKeys).mockResolvedValue(['handle:vol1'])
    vi.mocked(idbGet).mockRejectedValue(new Error('store closed'))

    expect(await listRememberedProjects()).toEqual([{ key: 'vol1', kind: 'folder' }])
  })

  it('degrades to an empty list when IndexedDB is unavailable', async () => {
    vi.mocked(idbKeys).mockRejectedValue(new Error('no IndexedDB'))
    expect(await listRememberedProjects()).toEqual([])
  })
})
