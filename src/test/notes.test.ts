import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fs/idb', () => ({
  idbGet: vi.fn(),
  idbSet: vi.fn(),
  idbDelete: vi.fn(),
  idbKeys: vi.fn(),
}))

import {
  NOTES_FILE_KIND,
  addSeriesTerms,
  createSeries,
  deleteSeries,
  emptyNotes,
  findSeries,
  getNotes,
  importNotes,
  initNotes,
  mergeNotes,
  migrateNotes,
  parseImport,
  removeSeriesTerm,
  renameSeries,
  resetNotesForTest,
  getNotesState,
  resolveContext,
  serializeNotes,
  setSeriesContext,
  updateSeriesTerm,
  type Series,
} from '../state/notes'
import { idbGet, idbSet } from '../fs/idb'
import { newProjectFile, type GlossaryEntry, type ProjectFile } from '../state/schema'

const term = (over: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
  term: 'リナ',
  translation: 'Rina',
  note: '',
  locked: true,
  ...over,
})

const series = (over: Partial<Series> = {}): Series => ({
  id: 's1',
  name: 'Blue Period',
  context: '',
  terms: [],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...over,
})

const project = (over: Partial<ProjectFile['project']> = {}): ProjectFile => {
  const p = newProjectFile('vol1', [{ file: 'p1.jpeg', hash: 'aa' }])
  p.project = { ...p.project, ...over }
  return p
}

/** Load the store with a known record, as a fresh session would. */
async function load(stored: unknown): Promise<void> {
  resetNotesForTest()
  vi.mocked(idbGet).mockReset().mockResolvedValue(stored)
  vi.mocked(idbSet).mockReset().mockResolvedValue(undefined)
  await initNotes()
}

beforeEach(() => {
  resetNotesForTest()
  vi.mocked(idbGet).mockReset().mockResolvedValue(undefined)
  vi.mocked(idbSet).mockReset().mockResolvedValue(undefined)
})

describe('migrateNotes', () => {
  it('reads back what it wrote', () => {
    const notes = { version: 1, series: [series({ terms: [term()], context: 'Set in 1920s Tokyo' })] }
    expect(migrateNotes(JSON.parse(JSON.stringify(notes)))).toEqual(notes)
  })

  it('degrades a blob it cannot understand to empty rather than throwing', () => {
    expect(migrateNotes(null).series).toEqual([])
    expect(migrateNotes('nope').series).toEqual([])
    expect(migrateNotes({ series: 'not an array' }).series).toEqual([])
  })

  it('drops series with no name and terms with no term', () => {
    const notes = migrateNotes({
      series: [
        { id: 'a', name: '', terms: [] },
        { id: 'b', name: 'Real', terms: [term(), { translation: 'orphan' }] },
      ],
    })
    expect(notes.series).toHaveLength(1)
    expect(notes.series[0]!.terms).toHaveLength(1)
  })

  it('keeps stored ids, because projects point at them', () => {
    expect(migrateNotes({ series: [{ id: 'keep-me', name: 'X' }] }).series[0]!.id).toBe('keep-me')
  })

  it('mints an id only when one is missing', () => {
    const id = migrateNotes({ series: [{ name: 'X' }] }).series[0]!.id
    expect(id).not.toBe('')
  })

  it('dedupes repeated terms from a hand-edited file', () => {
    const notes = migrateNotes({
      series: [{ id: 'a', name: 'X', terms: [term(), term({ translation: 'Lina' })] }],
    })
    expect(notes.series[0]!.terms).toEqual([term()])
  })
})

describe('parseImport', () => {
  it('recognises its own export', () => {
    const notes = { version: 1, series: [series({ terms: [term()] })] }
    const parsed = parseImport(JSON.parse(serializeNotes(notes)))

    expect(parsed.kind).toBe('notes')
    if (parsed.kind !== 'notes') throw new Error('unreachable')
    expect(parsed.series[0]!.id).toBe('s1')
    expect(parsed.series[0]!.terms).toEqual([term()])
  })

  it('names its own export format', () => {
    expect(JSON.parse(serializeNotes(emptyNotes())).kind).toBe(NOTES_FILE_KIND)
  })

  it('recognises a project file, so old volumes can be harvested', () => {
    const p = project()
    p.glossary = [term({ locked: false }), term({ term: '', translation: 'x' })]
    const parsed = parseImport(JSON.parse(JSON.stringify(p)))

    expect(parsed.kind).toBe('project')
    if (parsed.kind !== 'project') throw new Error('unreachable')
    expect(parsed.name).toBe('vol1')
    expect(parsed.terms).toHaveLength(1)
  })

  it('reads a project from a schema version this build predates', () => {
    // `migrate` would throw here; harvesting the glossary does not need to.
    const parsed = parseImport({ schemaVersion: 99, project: { name: 'future' }, glossary: [term()] })
    expect(parsed.kind).toBe('project')
  })

  it('rejects anything else', () => {
    expect(parseImport({ hello: 'world' }).kind).toBe('unknown')
    expect(parseImport([]).kind).toBe('unknown')
  })
})

describe('mergeNotes', () => {
  it('matches an existing series by id even when it was renamed', () => {
    const existing = { version: 1, series: [series({ name: 'Old Title' })] }
    const merged = mergeNotes(existing, [series({ name: 'Also Old', terms: [term()] })])

    expect(merged.series).toHaveLength(1)
    expect(merged.series[0]!.id).toBe('s1')
    expect(merged.series[0]!.terms).toEqual([term()])
  })

  it('falls back to matching by name when the id is new', () => {
    const existing = { version: 1, series: [series({ id: 'local', name: 'Blue Period' })] }
    const merged = mergeNotes(existing, [series({ id: 'remote', name: 'blue period' })])

    expect(merged.series).toHaveLength(1)
    expect(merged.series[0]!.id).toBe('local')
  })

  it('never re-mints an incoming id, so project links survive a round trip', () => {
    const merged = mergeNotes(emptyNotes(), [series({ id: 'from-file' })])
    expect(merged.series[0]!.id).toBe('from-file')
  })

  it('lets the imported term win, since importing is the user saying so', () => {
    const existing = { version: 1, series: [series({ terms: [term({ translation: 'Lina' })] })] }
    const merged = mergeNotes(existing, [series({ terms: [term({ translation: 'Rina' })] })])

    expect(merged.series[0]!.terms).toEqual([term({ translation: 'Rina' })])
  })

  it('keeps the local context when the incoming one is blank', () => {
    const existing = { version: 1, series: [series({ context: 'mine' })] }
    expect(mergeNotes(existing, [series({ context: '  ' })]).series[0]!.context).toBe('mine')
  })

  it('appends series it has never seen', () => {
    const merged = mergeNotes({ version: 1, series: [series()] }, [series({ id: 's2', name: 'Other' })])
    expect(merged.series.map((s) => s.name)).toEqual(['Blue Period', 'Other'])
  })
})

describe('resolveContext', () => {
  it('puts the series instructions before the volume’s own', () => {
    const notes = { version: 1, series: [series({ context: 'Set in 1920s Tokyo' })] }
    const p = project({ seriesId: 's1', context: 'This volume is a flashback' })

    expect(resolveContext(p, notes)).toBe('Set in 1920s Tokyo\n\nThis volume is a flashback')
  })

  it('returns just one side when the other is empty', () => {
    const notes = { version: 1, series: [series({ context: 'Series-wide' })] }
    expect(resolveContext(project({ seriesId: 's1' }), notes)).toBe('Series-wide')
    expect(resolveContext(project({ context: 'Volume-only' }), notes)).toBe('Volume-only')
  })

  it('falls back to the project alone when the series link dangles', () => {
    const p = project({ seriesId: 'gone', seriesName: 'Blue Period', context: 'mine' })
    expect(resolveContext(p, emptyNotes())).toBe('mine')
  })

  it('is empty when there is nothing to say', () => {
    expect(resolveContext(project(), emptyNotes())).toBe('')
  })
})

describe('the notes store', () => {
  it('refuses to write before the stored record has been read', () => {
    // The clobber this guards against: a mutation landing on the empty placeholder
    // would persist it straight over the user's real notes.
    expect(createSeries('Too Early')).toBe('')
    expect(getNotes().series).toEqual([])
    expect(idbSet).not.toHaveBeenCalled()
  })

  it('loads what was stored', async () => {
    await load({ version: 1, series: [series({ terms: [term()] })] })
    expect(getNotes().series[0]!.name).toBe('Blue Period')
  })

  it('stays usable when IndexedDB is unavailable', async () => {
    resetNotesForTest()
    vi.mocked(idbGet).mockReset().mockRejectedValue(new Error('IndexedDB is not available'))
    await initNotes()

    expect(createSeries('Works Anyway')).not.toBe('')
    expect(getNotes().series).toHaveLength(1)
  })

  it('writes through on every change, under the versioned key', async () => {
    await load(undefined)
    const id = createSeries('Blue Period')

    expect(id).not.toBe('')
    const [key, value] = vi.mocked(idbSet).mock.calls[0]!
    expect(key).toBe('notes:v1')
    expect((value as { series: Series[] }).series[0]!.name).toBe('Blue Period')
  })

  it('reports a failed write instead of swallowing it', async () => {
    await load(undefined)
    vi.mocked(idbSet).mockRejectedValue(new Error('quota exceeded'))
    createSeries('Blue Period')
    await vi.waitFor(() => expect(getNotesState().error).not.toBeNull())

    // Unlike settings, which are cheap to retype, these are the only copy.
    expect(getNotesState().error).toContain('quota exceeded')
    expect(getNotesState().error).toContain('Export')
  })

  it('clears the error once a write succeeds again', async () => {
    await load(undefined)
    vi.mocked(idbSet).mockRejectedValue(new Error('quota exceeded'))
    createSeries('One')
    await vi.waitFor(() => expect(getNotesState().error).not.toBeNull())

    vi.mocked(idbSet).mockResolvedValue(undefined)
    createSeries('Two')
    await vi.waitFor(() => expect(getNotesState().error).toBeNull())
  })

  it('ignores a blank series name', async () => {
    await load(undefined)
    expect(createSeries('   ')).toBe('')
    expect(getNotes().series).toEqual([])
  })

  it('renames, re-contexts and deletes a series', async () => {
    await load({ version: 1, series: [series()] })

    renameSeries('s1', 'Blue Period 2')
    expect(findSeries(getNotes(), 's1')!.name).toBe('Blue Period 2')

    setSeriesContext('s1', 'Keep honorifics')
    expect(findSeries(getNotes(), 's1')!.context).toBe('Keep honorifics')

    deleteSeries('s1')
    expect(getNotes().series).toEqual([])
  })

  it('adds, updates and removes terms', async () => {
    await load({ version: 1, series: [series()] })

    expect(addSeriesTerms('s1', [term(), term({ term: '先輩', translation: 'senpai' })])).toEqual({
      added: 2,
      replaced: 0,
      skipped: 0,
    })

    // A second push of a known term updates it -- unlike the model's suggestions,
    // which never move an established translation.
    expect(addSeriesTerms('s1', [term({ translation: 'Lina' })])).toMatchObject({ replaced: 1 })
    expect(findSeries(getNotes(), 's1')!.terms[0]!.translation).toBe('Lina')

    updateSeriesTerm('s1', 'リナ', { note: 'lead' })
    expect(findSeries(getNotes(), 's1')!.terms[0]!.note).toBe('lead')

    removeSeriesTerm('s1', '先輩')
    expect(findSeries(getNotes(), 's1')!.terms.map((t) => t.term)).toEqual(['リナ'])
  })

  it('drops incomplete terms on the way in', async () => {
    await load({ version: 1, series: [series()] })
    addSeriesTerms('s1', [term({ term: '  ' }), term({ translation: '' })])
    expect(findSeries(getNotes(), 's1')!.terms).toEqual([])
  })

  it('merges an import into what is already there', async () => {
    await load({ version: 1, series: [series()] })
    importNotes([series({ id: 's2', name: 'Other' })])
    expect(getNotes().series).toHaveLength(2)
  })
})
