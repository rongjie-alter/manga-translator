/**
 * Folding a model response back into the project: line merging with sticky hand edits,
 * and glossary accumulation -- plus the user-driven counterpart, copying hand-picked
 * entries in from the notes store (`addGlossaryEntries`).
 *
 * All pure functions over plain data. The rules here decide whether a user's afternoon
 * of manual corrections survives a retranslate, so they are the part worth testing
 * hardest.
 */

import type { GlossaryEntry, Line, Page } from '../state/schema'
import type { ModelGlossaryEntry, ModelLine } from './contract'

/**
 * What to do with lines the user has hand-edited.
 *
 * `preserve` is the default everywhere automatic: a batch run, a repair pass, a retry.
 * `overwrite` only happens when the user has been shown the count and said yes.
 */
export type EditPolicy = 'preserve' | 'overwrite'

export interface MergeLinesResult {
  lines: Line[]
  /** Hand-edited lines that were kept (`preserve`) or replaced (`overwrite`). */
  editedTouched: number
}

/**
 * Merge a fresh translation into a page's existing lines.
 *
 * Line identity is the model-assigned `id`, which is the only handle available -- there
 * are no coordinates, and the text itself changes between runs. A retranslation that
 * returns a different number of lines will therefore not line up perfectly with the old
 * one; incoming lines are authoritative about which lines exist, and old edits are
 * matched onto them by id where they can be.
 */
export function mergeLines(
  existing: Line[],
  incoming: ModelLine[],
  policy: EditPolicy = 'preserve',
): MergeLinesResult {
  const previous = new Map(existing.map((line) => [line.id, line]))
  let editedTouched = 0

  const lines = incoming.map((model): Line => {
    const old = previous.get(model.id)
    const base: Line = {
      id: model.id,
      kind: model.kind,
      original: model.original,
      translation: model.translation,
      edited: false,
      previousTranslation: null,
    }

    if (!old?.edited) return base

    editedTouched++
    if (policy === 'preserve') {
      // Keep the human translation, but take the model's fresh transcription: the
      // original text is not what the user edited, and a better OCR pass helps review.
      return { ...base, translation: old.translation, edited: true, previousTranslation: old.previousTranslation }
    }
    return { ...base, previousTranslation: old.translation }
  })

  return { lines, editedTouched }
}

/** How many hand-edited lines a retranslate would replace, for the confirmation prompt. */
export function countEditedLines(page: Page): number {
  return page.lines.filter((line) => line.edited).length
}

/** Put a hand-edited translation back to what the model last said. */
export function revertLine(line: Line): Line {
  if (line.previousTranslation === null) return line
  return { ...line, translation: line.previousTranslation, edited: false, previousTranslation: null }
}

export function editLine(line: Line, translation: string): Line {
  if (translation === line.translation) return line
  return {
    ...line,
    translation,
    edited: true,
    // Only the first edit records what the model said; editing twice should still
    // revert to the model's text, not to the user's own earlier draft.
    previousTranslation: line.edited ? line.previousTranslation : line.translation,
  }
}

/**
 * The glossary exists to stop a name drifting over a long project, so the first
 * translation of a term wins and later suggestions for it are ignored. Locked entries
 * are the user's own decisions and are never touched.
 */
export const MAX_GLOSSARY_ENTRIES = 200

export interface MergeGlossaryResult {
  glossary: GlossaryEntry[]
  added: string[]
  /** Terms dropped because the glossary is at capacity. */
  skipped: string[]
}

export function mergeGlossary(
  existing: GlossaryEntry[],
  incoming: ModelGlossaryEntry[],
): MergeGlossaryResult {
  const byTerm = new Map(existing.map((entry) => [entry.term, entry]))
  const glossary = existing.slice()
  const added: string[] = []
  const skipped: string[] = []

  for (const suggestion of incoming) {
    const term = suggestion.term.trim()
    const translation = suggestion.translation.trim()
    if (term === '' || translation === '') continue

    const current = byTerm.get(term)
    if (current) {
      // Known term: keep the established translation, but let an empty note be filled in.
      if (current.note === '' && suggestion.note.trim() !== '' && !current.locked) {
        const at = glossary.indexOf(current)
        const updated = { ...current, note: suggestion.note.trim() }
        glossary[at] = updated
        byTerm.set(term, updated)
      }
      continue
    }

    if (glossary.length >= MAX_GLOSSARY_ENTRIES) {
      skipped.push(term)
      continue
    }
    const entry: GlossaryEntry = { term, translation, note: suggestion.note.trim(), locked: false }
    glossary.push(entry)
    byTerm.set(term, entry)
    added.push(term)
  }

  return { glossary, added, skipped }
}

/**
 * What to do with a term the project already has under a different translation.
 *
 * `keep` is the safe default. `replace` is what the user chooses when the notes store
 * holds the official rendering and the model invented its own -- and it is the point at
 * which the rename sweep (`api/rename.ts`) should be offered, since replacing the
 * glossary entry alone leaves every page already translated saying the old name.
 */
export type ConflictPolicy = 'keep' | 'replace'

export interface AddGlossaryResult {
  glossary: GlossaryEntry[]
  added: string[]
  /** Terms whose translation was changed to the incoming one. */
  replaced: string[]
  /** Terms already present, left alone under the `keep` policy. */
  conflicted: string[]
  /** Terms dropped because the project glossary is at capacity. */
  skipped: string[]
}

/**
 * Copy hand-picked entries into a project's glossary.
 *
 * Distinct from `mergeGlossary`, which folds in what the *model* proposed and therefore
 * never lets a later suggestion move a name. These entries come from the user ticking
 * boxes, so `replace` has to be available -- and a term that is already present is a
 * decision to report, not the same thing as one dropped at the cap.
 *
 * Entries arrive locked: the whole point of promoting a term to the notes store is that
 * its translation is settled, and an unlocked entry is one a later run can still edit.
 */
export function addGlossaryEntries(
  existing: GlossaryEntry[],
  incoming: GlossaryEntry[],
  onConflict: ConflictPolicy = 'keep',
): AddGlossaryResult {
  const byTerm = new Map(existing.map((entry) => [entry.term, entry]))
  const glossary = existing.slice()
  const added: string[] = []
  const replaced: string[] = []
  const conflicted: string[] = []
  const skipped: string[] = []

  for (const source of incoming) {
    const term = source.term.trim()
    const translation = source.translation.trim()
    if (term === '' || translation === '') continue

    const current = byTerm.get(term)
    if (current) {
      if (current.translation === translation) continue
      if (onConflict === 'keep') {
        conflicted.push(term)
        continue
      }
      const at = glossary.indexOf(current)
      const updated: GlossaryEntry = {
        ...current,
        translation,
        note: source.note.trim() === '' ? current.note : source.note.trim(),
        locked: true,
      }
      glossary[at] = updated
      byTerm.set(term, updated)
      replaced.push(term)
      continue
    }

    if (glossary.length >= MAX_GLOSSARY_ENTRIES) {
      skipped.push(term)
      continue
    }
    const entry: GlossaryEntry = { term, translation, note: source.note.trim(), locked: true }
    glossary.push(entry)
    byTerm.set(term, entry)
    added.push(term)
  }

  return { glossary, added, replaced, conflicted, skipped }
}
