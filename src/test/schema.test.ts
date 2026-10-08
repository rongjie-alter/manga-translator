import { describe, expect, it } from 'vitest'
import {
  MigrationError,
  SCHEMA_VERSION,
  effectiveStatus,
  migrate,
  newPage,
  newProjectFile,
  pageNeedsTranslation,
  translatablePages,
  type Page,
} from '../state/schema'
import { serializeProject } from '../fs/project-file'

const sample = () =>
  newProjectFile('nippon1', [
    { file: 'p1.jpeg', hash: 'aa' },
    { file: 'p2.jpeg', hash: 'bb' },
  ])

describe('migrate', () => {
  it('round-trips a project it just wrote', () => {
    const project = sample()
    project.pages[0]!.lines = [
      {
        id: 1,
        kind: 'dialogue',
        original: 'こんにちは',
        translation: 'Hello',
        edited: true,
        previousTranslation: 'Hi',
      },
    ]
    project.pages[0]!.status = 'translated'
    project.glossary = [{ term: 'リナ', translation: 'Rina', note: '', locked: true }]

    expect(migrate(JSON.parse(serializeProject(project)))).toEqual(project)
  })

  it('fills in defaults for a hand-written file with almost nothing in it', () => {
    const p = migrate({ pages: [{ file: 'a.png' }] })
    expect(p.schemaVersion).toBe(SCHEMA_VERSION)
    expect(p.project.sourceLang).toBe('ja')
    expect(p.project.targetLang).toBe('en')
    expect(p.project.readingDirection).toBe('rtl')
    expect(p.settings.batchSize).toBe(4)
    expect(p.pages).toHaveLength(1)
    expect(p.pages[0]).toMatchObject({ file: 'a.png', index: 0, status: 'pending', excluded: false })
  })

  it('defaults a page to the standard layout, and keeps a 4-koma mark', () => {
    expect(sample().pages[0]!.layout).toBe('standard')
    expect(migrate({ pages: [{ file: 'a.png' }] }).pages[0]!.layout).toBe('standard')

    const project = sample()
    project.pages[1]!.layout = '4koma'
    const back = migrate(JSON.parse(serializeProject(project)))
    expect(back.pages.map((p) => p.layout)).toEqual(['standard', '4koma'])
  })

  it('falls back to the standard layout for a layout it does not know', () => {
    expect(migrate({ pages: [{ file: 'a.png', layout: 'webtoon' }] }).pages[0]!.layout).toBe(
      'standard',
    )
  })

  it('assumes a page translated before translatedLayout existed was translated as standard', () => {
    const p = migrate({
      pages: [
        { file: 'a.png', status: 'translated', layout: '4koma', lines: [{ translation: 'hi' }] },
        { file: 'b.png' },
      ],
    })
    expect(p.pages[0]!.translatedLayout).toBe('standard')
    // So marking an already-translated page 4-koma queues it again.
    expect(pageNeedsTranslation(p.pages[0]!)).toBe(true)
    expect(p.pages[1]!.translatedLayout).toBeNull()
  })

  it('keeps an explicit translatedLayout, including null', () => {
    const p = migrate({
      pages: [
        { file: 'a.png', status: 'translated', translatedLayout: '4koma', layout: '4koma' },
        { file: 'b.png', status: 'translated', translatedLayout: null },
      ],
    })
    expect(p.pages.map((x) => x.translatedLayout)).toEqual(['4koma', null])
  })

  it('infers translated status from the presence of lines', () => {
    const p = migrate({ pages: [{ file: 'a.png', lines: [{ translation: 'hi' }] }] })
    expect(p.pages[0]!.status).toBe('translated')
    expect(p.pages[0]!.lines[0]).toMatchObject({ id: 1, kind: 'dialogue', translation: 'hi' })
  })

  it('strips a speaker field written by an older build', () => {
    const p = migrate({
      pages: [{ file: 'a.png', lines: [{ id: 1, speaker: 'リナ', original: 'あ', translation: 'Ah' }] }],
    })
    expect(p.pages[0]!.lines[0]).toEqual({
      id: 1,
      kind: 'dialogue',
      original: 'あ',
      translation: 'Ah',
      edited: false,
      previousTranslation: null,
    })
  })

  it('drops junk rather than propagating it', () => {
    const p = migrate({
      glossary: [{ term: '', translation: 'x' }, { term: 'ok', translation: 'y' }],
      pages: [{ index: 3 }, { file: 'a.png' }],
      settings: { batchSize: 9999 },
      usage: { calls: -5, promptTokens: 'lots' },
    })
    expect(p.glossary.map((g) => g.term)).toEqual(['ok'])
    expect(p.pages.map((x) => x.file)).toEqual(['a.png'])
    expect(p.settings.batchSize).toBe(20)
    expect(p.usage).toEqual({ calls: 0, promptTokens: 0, completionTokens: 0 })
  })

  it('coerces unknown enum values instead of throwing', () => {
    const p = migrate({
      project: { targetLang: 'klingon', readingDirection: 'sideways' },
      pages: [{ file: 'a.png', status: 'exploded', lines: [{ kind: 'poem' }] }],
    })
    expect(p.project.targetLang).toBe('en')
    expect(p.project.readingDirection).toBe('rtl')
    expect(p.pages[0]!.status).toBe('translated')
    expect(p.pages[0]!.lines[0]!.kind).toBe('dialogue')
  })

  it('refuses a file from a newer build rather than silently dropping its fields', () => {
    expect(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 })).toThrow(MigrationError)
  })

  it('refuses things that are not objects', () => {
    expect(() => migrate([])).toThrow(MigrationError)
    expect(() => migrate(null)).toThrow(MigrationError)
    expect(() => migrate('{}')).toThrow(MigrationError)
  })

  it('defaults the series link and context on a file written before they existed', () => {
    const old = JSON.parse(serializeProject(sample())) as Record<string, unknown>
    const meta = old['project'] as Record<string, unknown>
    delete meta['seriesId']
    delete meta['seriesName']
    delete meta['context']

    expect(migrate(old).project).toMatchObject({ seriesId: '', seriesName: '', context: '' })
  })

  it('keeps a series link and context it is given', () => {
    const project = sample()
    project.project.seriesId = 's1'
    project.project.seriesName = 'Blue Period'
    project.project.context = 'Keep honorifics'

    expect(migrate(JSON.parse(serializeProject(project)))).toEqual(project)
  })
})

describe('effectiveStatus', () => {
  const translated = (over: Partial<Page> = {}): Page => ({
    ...newPage('a.png', 0, 'h'),
    status: 'translated',
    translatedLayout: 'standard',
    ...over,
  })

  it('is stale while the layout differs from the one translated under', () => {
    const page = translated({ layout: '4koma' })
    expect(effectiveStatus(page)).toBe('stale')
    expect(pageNeedsTranslation(page)).toBe(true)
  })

  it('is translated again once the layout is put back -- nothing changed', () => {
    const flipped = translated({ layout: '4koma' })
    const back = { ...flipped, layout: 'standard' as const }
    expect(effectiveStatus(back)).toBe('translated')
    expect(pageNeedsTranslation(back)).toBe(false)
  })

  it('does not call a page stale when the layout it was translated under is unknown', () => {
    expect(effectiveStatus(translated({ translatedLayout: null, layout: '4koma' }))).toBe('translated')
  })

  it('leaves a page that is stale for its image stale, whatever the layout does', () => {
    const imageStale = translated({ status: 'stale' })
    expect(effectiveStatus(imageStale)).toBe('stale')
    expect(effectiveStatus({ ...imageStale, layout: '4koma' })).toBe('stale')
    expect(effectiveStatus({ ...imageStale, layout: 'standard' })).toBe('stale')
  })

  it('does not touch pages that were never translated', () => {
    expect(effectiveStatus({ ...newPage('a.png', 0, 'h'), layout: '4koma' })).toBe('pending')
  })
})

describe('translatablePages', () => {
  it('skips excluded pages and sorts by reading position', () => {
    const p = sample()
    p.pages[0]!.index = 5
    p.pages[1]!.index = 1
    expect(translatablePages(p).map((x) => x.file)).toEqual(['p2.jpeg', 'p1.jpeg'])

    p.pages[1]!.excluded = true
    expect(translatablePages(p).map((x) => x.file)).toEqual(['p1.jpeg'])
  })

  it('does not reorder the project it was given', () => {
    const p = sample()
    p.pages[0]!.index = 5
    p.pages[1]!.index = 1
    translatablePages(p)
    expect(p.pages.map((x) => x.file)).toEqual(['p1.jpeg', 'p2.jpeg'])
  })
})
