import { describe, expect, it } from 'vitest'
import {
  addGlossaryEntries,
  editLine,
  mergeGlossary,
  mergeLines,
  revertLine,
} from '../api/merge'
import type { ModelLine } from '../api/contract'
import type { GlossaryEntry, Line } from '../state/schema'

const line = (over: Partial<Line> = {}): Line => ({
  id: 1,
  kind: 'dialogue',
  original: 'あ',
  translation: 'Ah',
  edited: false,
  previousTranslation: null,
  ...over,
})

const model = (over: Partial<ModelLine> = {}): ModelLine => ({
  id: 1,
  kind: 'dialogue',
  original: 'あ！',
  translation: 'Ah!',
  ...over,
})

describe('mergeLines', () => {
  it('replaces untouched lines outright', () => {
    const { lines, editedTouched } = mergeLines([line()], [model()])
    expect(editedTouched).toBe(0)
    expect(lines[0]).toMatchObject({ translation: 'Ah!', edited: false })
  })

  it('keeps a hand-edited translation under the default policy', () => {
    const existing = [line({ translation: 'My version', edited: true, previousTranslation: 'Ah' })]
    const { lines, editedTouched } = mergeLines(existing, [model()])
    expect(editedTouched).toBe(1)
    expect(lines[0]!.translation).toBe('My version')
    expect(lines[0]!.edited).toBe(true)
    // The transcription is not what the user edited, so a better OCR pass still lands.
    expect(lines[0]!.original).toBe('あ！')
  })

  it('replaces a hand-edited translation when the user asked to overwrite', () => {
    const existing = [line({ translation: 'My version', edited: true })]
    const { lines, editedTouched } = mergeLines(existing, [model()], 'overwrite')
    expect(editedTouched).toBe(1)
    expect(lines[0]!.translation).toBe('Ah!')
    expect(lines[0]!.edited).toBe(false)
    // The overwritten edit is recoverable.
    expect(lines[0]!.previousTranslation).toBe('My version')
  })

  it('lets the model decide which lines exist', () => {
    const existing = [line({ id: 1 }), line({ id: 2, translation: 'Second' })]
    const { lines } = mergeLines(existing, [model({ id: 1 }), model({ id: 2 }), model({ id: 3 })])
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3])
  })

  it('drops an edit whose line the model no longer returns', () => {
    // Nothing better is available: without coordinates there is no way to re-anchor an
    // edit to a line the new transcription does not contain.
    const existing = [line({ id: 7, translation: 'Mine', edited: true })]
    const { lines, editedTouched } = mergeLines(existing, [model({ id: 1 })])
    expect(editedTouched).toBe(0)
    expect(lines.map((l) => l.id)).toEqual([1])
  })
})

describe('editLine', () => {
  it('records the model text on the first edit only', () => {
    const first = editLine(line(), 'Mine')
    expect(first).toMatchObject({ translation: 'Mine', edited: true, previousTranslation: 'Ah' })

    const second = editLine(first, 'Mine again')
    expect(second.previousTranslation).toBe('Ah')
  })

  it('is a no-op when nothing changed', () => {
    const l = line()
    expect(editLine(l, 'Ah')).toBe(l)
  })

  it('round-trips through revert', () => {
    expect(revertLine(editLine(line(), 'Mine'))).toEqual(line())
  })

  it('leaves a line with no history alone on revert', () => {
    const l = line()
    expect(revertLine(l)).toBe(l)
  })
})

describe('mergeGlossary', () => {
  const entry = (over: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
    term: 'リナ',
    translation: 'Rina',
    note: '',
    locked: false,
    ...over,
  })

  it('adds new terms', () => {
    const r = mergeGlossary([], [{ term: 'リナ', translation: 'Rina', note: 'lead' }])
    expect(r.added).toEqual(['リナ'])
    expect(r.glossary[0]).toEqual({ term: 'リナ', translation: 'Rina', note: 'lead', locked: false })
  })

  it('keeps the established translation so a name cannot drift mid-project', () => {
    const r = mergeGlossary([entry()], [{ term: 'リナ', translation: 'Lina', note: '' }])
    expect(r.added).toEqual([])
    expect(r.glossary[0]!.translation).toBe('Rina')
  })

  it('fills in a missing note without touching the translation', () => {
    const r = mergeGlossary([entry()], [{ term: 'リナ', translation: 'Lina', note: 'protagonist' }])
    expect(r.glossary[0]).toMatchObject({ translation: 'Rina', note: 'protagonist' })
  })

  it('never modifies a locked entry', () => {
    const locked = entry({ locked: true })
    const r = mergeGlossary([locked], [{ term: 'リナ', translation: 'Lina', note: 'protagonist' }])
    expect(r.glossary[0]).toEqual(locked)
  })

  it('ignores suggestions missing a term or a translation', () => {
    const r = mergeGlossary(
      [],
      [
        { term: '  ', translation: 'x', note: '' },
        { term: 'y', translation: '', note: '' },
      ],
    )
    expect(r.glossary).toEqual([])
  })

  it('stops growing at the cap and says what it dropped', () => {
    const full = Array.from({ length: 200 }, (_, i) => entry({ term: 't' + i }))
    const r = mergeGlossary(full, [{ term: 'new', translation: 'New', note: '' }])
    expect(r.glossary).toHaveLength(200)
    expect(r.skipped).toEqual(['new'])
  })

  it('does not mutate the glossary it was given', () => {
    const existing = [entry()]
    mergeGlossary(existing, [{ term: 'ケンジ', translation: 'Kenji', note: '' }])
    expect(existing).toHaveLength(1)
  })
})

describe('addGlossaryEntries', () => {
  const entry = (over: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
    term: 'リナ',
    translation: 'Rina',
    note: '',
    locked: false,
    ...over,
  })

  it('copies picked terms in, locked, because they are settled', () => {
    const r = addGlossaryEntries([], [entry({ note: 'lead' })])
    expect(r.added).toEqual(['リナ'])
    expect(r.glossary[0]).toEqual({
      term: 'リナ',
      translation: 'Rina',
      note: 'lead',
      locked: true,
    })
  })

  it('keeps the project term by default and reports the clash', () => {
    const r = addGlossaryEntries([entry({ translation: 'Lina' })], [entry()])
    expect(r.conflicted).toEqual(['リナ'])
    expect(r.replaced).toEqual([])
    expect(r.glossary[0]!.translation).toBe('Lina')
  })

  it('replaces and locks when the user says so', () => {
    const r = addGlossaryEntries([entry({ translation: 'Lina' })], [entry()], 'replace')
    expect(r.replaced).toEqual(['リナ'])
    expect(r.glossary[0]).toMatchObject({ translation: 'Rina', locked: true })
  })

  it('says nothing about a term that already agrees', () => {
    const r = addGlossaryEntries([entry()], [entry()])
    expect(r).toMatchObject({ added: [], replaced: [], conflicted: [], skipped: [] })
  })

  it('keeps the project note when the incoming one is blank', () => {
    const r = addGlossaryEntries([entry({ note: 'mine' })], [entry({ translation: 'Lina' })], 'replace')
    expect(r.glossary[0]!.note).toBe('mine')
  })

  it('separates hitting the cap from a clash', () => {
    const full = Array.from({ length: 200 }, (_, i) => entry({ term: 't' + i }))
    const r = addGlossaryEntries(full, [entry({ term: 'new', translation: 'New' })])
    expect(r.skipped).toEqual(['new'])
    expect(r.conflicted).toEqual([])
    expect(r.glossary).toHaveLength(200)
  })

  it('ignores entries missing a term or a translation', () => {
    const r = addGlossaryEntries([], [entry({ term: ' ' }), entry({ translation: '' })])
    expect(r.glossary).toEqual([])
  })

  it('does not mutate the glossary it was given', () => {
    const existing = [entry()]
    addGlossaryEntries(existing, [entry({ term: 'ケンジ', translation: 'Kenji' })])
    expect(existing).toHaveLength(1)
  })
})
