import { describe, expect, it } from 'vitest'
import { reconcile, type DiskPage } from '../fs/project-file'
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
                speaker: '',
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
