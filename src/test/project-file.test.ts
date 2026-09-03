import { describe, expect, it, vi } from 'vitest'
import { readDiskPages, reconcile, type DiskPage } from '../fs/project-file'
import type { PageSource, ProjectSource } from '../fs/source'
import { newProjectFile, type ProjectFile } from '../state/schema'

function translated(project: ProjectFile, file: string): ProjectFile {
  return {
    ...project,
    pages: project.pages.map((p) =>
      p.file === file
        ? {
            ...p,
            status: 'translated' as const,
            lines: [
              {
                id: 1,
                kind: 'dialogue' as const,
                original: 'あ',
                translation: 'Ah',
                edited: false,
                previousTranslation: null,
              },
            ],
          }
        : p,
    ),
  }
}

const disk = (...entries: [string, string][]): DiskPage[] =>
  entries.map(([file, hash]) => ({ file, hash }))

const base = () => newProjectFile('t', disk(['a.jpg', 'h1'], ['b.jpg', 'h2']))

describe('reconcile', () => {
  it('reports no change when the folder matches the project', () => {
    const { report, dirty } = reconcile(base(), disk(['a.jpg', 'h1'], ['b.jpg', 'h2']))
    expect(report).toEqual({ added: [], removed: [], changed: [] })
    expect(dirty).toBe(false)
  })

  it('appends new files at the end as pending pages', () => {
    const { project, report, dirty } = reconcile(
      base(),
      disk(['a.jpg', 'h1'], ['b.jpg', 'h2'], ['c.jpg', 'h3']),
    )
    expect(report.added).toEqual(['c.jpg'])
    expect(dirty).toBe(true)
    expect(project.pages.map((p) => p.file)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(project.pages[2]).toMatchObject({ index: 2, status: 'pending', hash: 'h3' })
  })

  it('keeps a user-chosen page order when a file is added', () => {
    const p = base()
    p.pages[0]!.index = 1
    p.pages[1]!.index = 0
    const { project } = reconcile(p, disk(['a.jpg', 'h1'], ['b.jpg', 'h2'], ['c.jpg', 'h3']))
    // Positions are renumbered contiguously but the stored sequence is untouched,
    // so the scan view's manual ordering survives a rescan.
    expect(project.pages.map((x) => x.file)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(project.pages.map((x) => x.index)).toEqual([0, 1, 2])
  })

  it('drops pages whose image is gone and renumbers what is left', () => {
    const { project, report } = reconcile(base(), disk(['b.jpg', 'h2']))
    expect(report.removed).toEqual(['a.jpg'])
    expect(project.pages.map((x) => x.file)).toEqual(['b.jpg'])
    expect(project.pages[0]!.index).toBe(0)
  })

  it('marks a translated page stale when its image changed, keeping the translation', () => {
    const { project, report } = reconcile(
      translated(base(), 'a.jpg'),
      disk(['a.jpg', 'DIFFERENT'], ['b.jpg', 'h2']),
    )
    expect(report.changed).toEqual(['a.jpg'])
    expect(project.pages[0]!.status).toBe('stale')
    expect(project.pages[0]!.hash).toBe('DIFFERENT')
    expect(project.pages[0]!.lines).toHaveLength(1)
  })

  it('leaves an untranslated page pending rather than calling it stale', () => {
    const { project } = reconcile(base(), disk(['a.jpg', 'DIFFERENT'], ['b.jpg', 'h2']))
    expect(project.pages[0]!.status).toBe('pending')
  })

  it('adopts the disk hash for pages written before hashing existed', () => {
    const p = translated(base(), 'a.jpg')
    p.pages[0]!.hash = ''
    const { project, report } = reconcile(p, disk(['a.jpg', 'h1'], ['b.jpg', 'h2']))
    expect(report.changed).toEqual([])
    expect(project.pages[0]!.status).toBe('translated')
    expect(project.pages[0]!.hash).toBe('h1')
  })

  it('does not mutate the project it was given', () => {
    const p = base()
    reconcile(p, disk(['a.jpg', 'CHANGED']))
    expect(p.pages).toHaveLength(2)
    expect(p.pages[0]!.hash).toBe('h1')
  })
})

describe('readDiskPages', () => {
  const sourceOf = (pages: PageSource[]): ProjectSource => ({
    name: 't',
    jsonName: 'translation.json',
    writable: true,
    readJson: async () => null,
    writeJson: async () => {},
    listPages: async () => pages,
  })

  it('uses the hash the source offers and never reads the file', async () => {
    const getFile = vi.fn()
    const hash = vi.fn(async () => 'cheap')
    const { disk } = await readDiskPages(sourceOf([{ file: 'a.jpg', getFile, hash }]))

    expect(disk).toEqual([{ file: 'a.jpg', hash: 'cheap' }])
    expect(hash).toHaveBeenCalledOnce()
    expect(getFile).not.toHaveBeenCalled()
  })

  it('falls back to hashing the file when the source offers no hash', async () => {
    const getFile = vi.fn(async () => new File([new Uint8Array([1, 2, 3])], 'a.jpg'))
    const { disk } = await readDiskPages(sourceOf([{ file: 'a.jpg', getFile }]))

    expect(getFile).toHaveBeenCalledOnce()
    expect(disk[0]!.hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns the page handles alongside the hashes so callers need not re-list', async () => {
    const pages: PageSource[] = [
      { file: 'a.jpg', getFile: async () => new File([], 'a.jpg'), hash: async () => 'h1' },
      { file: 'b.jpg', getFile: async () => new File([], 'b.jpg'), hash: async () => 'h2' },
    ]
    const listPages = vi.fn(async () => pages)
    const result = await readDiskPages({ ...sourceOf(pages), listPages })

    expect(listPages).toHaveBeenCalledOnce()
    expect(result.pages).toBe(pages)
    expect(result.disk.map((d) => d.file)).toEqual(['a.jpg', 'b.jpg'])
  })
})
