import { describe, expect, it } from 'vitest'
import {
  affectedLines,
  applyRename,
  glossaryHits,
  occurrenceKey,
  planRename,
  suggestWholeWord,
} from '../api/rename'
import { revertLine } from '../api/merge'
import { newProjectFile, type Line, type ProjectFile } from '../state/schema'

const line = (id: number, translation: string, over: Partial<Line> = {}): Line => ({
  id,
  kind: 'dialogue',
  original: 'リナ',
  translation,
  edited: false,
  previousTranslation: null,
  ...over,
})

/** Two pages, whose lines the caller supplies. */
const sample = (p1: Line[], p2: Line[] = []): ProjectFile => {
  const project = newProjectFile('vol1', [
    { file: 'p1.jpeg', hash: 'aa' },
    { file: 'p2.jpeg', hash: 'bb' },
  ])
  project.pages[0]!.lines = p1
  project.pages[1]!.lines = p2
  return project
}

describe('suggestWholeWord', () => {
  it('is on for a Latin name, where a word boundary means something', () => {
    expect(suggestWholeWord('Rina')).toBe(true)
    expect(suggestWholeWord('Rina2')).toBe(true)
  })

  it('is off for CJK, where a word boundary would never match', () => {
    expect(suggestWholeWord('リナ')).toBe(false)
    expect(suggestWholeWord('凛')).toBe(false)
  })

  it('is off for text that starts or ends on punctuation', () => {
    expect(suggestWholeWord('-chan')).toBe(false)
    expect(suggestWholeWord('Mr.')).toBe(false)
  })
})

describe('planRename', () => {
  it('finds every line that would change, across pages', () => {
    const project = sample([line(1, 'Lina waved.')], [line(1, 'Where is Lina?')])
    const plan = planRename(project, 'Lina', 'Rina', true)

    expect(plan.occurrences).toHaveLength(2)
    expect(plan.occurrences[0]).toMatchObject({
      file: 'p1.jpeg',
      lineId: 1,
      before: 'Lina waved.',
      after: 'Rina waved.',
      count: 1,
    })
    expect(plan.occurrences[1]!.after).toBe('Where is Rina?')
  })

  it('counts repeats within one line', () => {
    const plan = planRename(sample([line(1, 'Lina, Lina, Lina!')]), 'Lina', 'Rina', true)
    expect(plan.occurrences[0]!.count).toBe(3)
    expect(plan.occurrences[0]!.after).toBe('Rina, Rina, Rina!')
  })

  it('respects word boundaries when asked', () => {
    const project = sample([line(1, 'Rin held the ring.')])
    expect(planRename(project, 'Rin', 'Lin', true).occurrences).toHaveLength(1)
    expect(planRename(project, 'Rin', 'Lin', true).occurrences[0]!.after).toBe(
      'Lin held the ring.',
    )
  })

  it('matches substrings when whole-word is off, which is the CJK case', () => {
    const project = sample([line(1, 'Rin held the Ring.')])
    expect(planRename(project, 'Rin', 'Lin', false).occurrences[0]!.after).toBe(
      'Lin held the Ling.',
    )
  })

  it('matches case-sensitively', () => {
    const project = sample([line(1, 'Rin held the ring.')])
    expect(planRename(project, 'Rin', 'Lin', false).occurrences[0]!.after).toBe(
      'Lin held the ring.',
    )
  })

  it('sweeps excluded pages too -- they are still the user’s text', () => {
    const project = sample([line(1, 'Lina')], [line(1, 'Lina')])
    project.pages[1]!.excluded = true
    expect(planRename(project, 'Lina', 'Rina', true).occurrences).toHaveLength(2)
  })

  it('treats the search text as literal, not as a regex', () => {
    const project = sample([line(1, 'a.c and abc')])
    const plan = planRename(project, 'a.c', 'X', false)
    expect(plan.occurrences[0]!.after).toBe('X and abc')
  })

  it('treats replacement text as literal, including $&', () => {
    const plan = planRename(sample([line(1, 'cost: 5')]), '5', '$& 5', false)
    expect(plan.occurrences[0]!.after).toBe('cost: $& 5')
  })

  it('finds nothing for an empty search or a no-op rename', () => {
    const project = sample([line(1, 'Lina')])
    expect(planRename(project, '', 'Rina', false).occurrences).toEqual([])
    expect(planRename(project, 'Lina', 'Lina', false).occurrences).toEqual([])
  })
})

describe('applyRename', () => {
  it('rewrites the lines and marks them as hand edits', () => {
    const project = sample([line(1, 'Lina waved.')])
    const next = applyRename(project, planRename(project, 'Lina', 'Rina', true))

    expect(next.pages[0]!.lines[0]).toMatchObject({
      translation: 'Rina waved.',
      edited: true,
      previousTranslation: 'Lina waved.',
    })
  })

  it('leaves the swept line revertible to what the model said', () => {
    const project = sample([line(1, 'Lina waved.')])
    const next = applyRename(project, planRename(project, 'Lina', 'Rina', true))

    expect(revertLine(next.pages[0]!.lines[0]!).translation).toBe('Lina waved.')
  })

  it('reverts a previously hand-edited line to the model text, not the earlier draft', () => {
    const project = sample([
      line(1, 'Lina waved.', { edited: true, previousTranslation: 'She waved.' }),
    ])
    const next = applyRename(project, planRename(project, 'Lina', 'Rina', true))

    expect(next.pages[0]!.lines[0]!.previousTranslation).toBe('She waved.')
  })

  it('skips the occurrences the user unchecked', () => {
    const project = sample([line(1, 'Lina')], [line(1, 'Lina')])
    const plan = planRename(project, 'Lina', 'Rina', true)
    const next = applyRename(project, plan, new Set([occurrenceKey('p2.jpeg', 1)]))

    expect(next.pages[0]!.lines[0]!.translation).toBe('Rina')
    expect(next.pages[1]!.lines[0]!.translation).toBe('Lina')
    expect(next.pages[1]!.lines[0]!.edited).toBe(false)
  })

  it('returns the project untouched when everything is skipped', () => {
    const project = sample([line(1, 'Lina')])
    const plan = planRename(project, 'Lina', 'Rina', true)
    const skip = new Set(plan.occurrences.map((o) => occurrenceKey(o.file, o.lineId)))

    expect(applyRename(project, plan, skip)).toBe(project)
    expect(applyRename(project, planRename(project, 'nobody', 'x', false))).toBe(project)
  })

  it('does not mutate the project it was given', () => {
    const project = sample([line(1, 'Lina')])
    applyRename(project, planRename(project, 'Lina', 'Rina', true))
    expect(project.pages[0]!.lines[0]!.translation).toBe('Lina')
  })
})

describe('affectedLines', () => {
  it('counts what is still checked', () => {
    const project = sample([line(1, 'Lina')], [line(1, 'Lina')])
    const plan = planRename(project, 'Lina', 'Rina', true)

    expect(affectedLines(plan)).toBe(2)
    expect(affectedLines(plan, new Set([occurrenceKey('p1.jpeg', 1)]))).toBe(1)
  })
})

describe('glossaryHits', () => {
  it('reports other entries carrying the old text, excluding the one being renamed', () => {
    const glossary = [
      { term: 'リナ', translation: 'Lina', note: '', locked: false },
      { term: 'リナの父', translation: "Lina's father", note: '', locked: false },
      { term: '先輩', translation: 'senpai', note: '', locked: false },
    ]

    expect(glossaryHits(glossary, 'Lina', 'リナ').map((e) => e.term)).toEqual(['リナの父'])
    expect(glossaryHits(glossary, '', 'リナ')).toEqual([])
  })
})
