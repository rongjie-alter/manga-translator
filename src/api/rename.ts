/**
 * Sweeping a corrected term through translations that were already written.
 *
 * Noticing on page 90 that the model called her "Lina" when the official rendering is
 * "Rina" used to mean hand-editing the JSON: the glossary entry, and every line that
 * mentions her. This module is the other half of that fix -- the glossary change keeps
 * future runs right, the sweep repairs the pages already translated.
 *
 * Pure functions over plain data, like `merge.ts`. Every replacement is routed through
 * `editLine`, so a swept line is indistinguishable from one the user typed: it counts
 * as a hand edit, it survives a retranslate under the `preserve` policy, and the
 * per-line revert button still puts the model's own words back.
 */

import type { GlossaryEntry, ProjectFile } from '../state/schema'
import { editLine } from './merge'

export interface Occurrence {
  file: string
  lineId: number
  before: string
  after: string
  /** Replacements made on this line, which is often more than one. */
  count: number
}

export interface RenamePlan {
  from: string
  to: string
  wholeWord: boolean
  occurrences: Occurrence[]
}

/** Stable identity for an occurrence, so the UI can track which ones are unchecked. */
export function occurrenceKey(file: string, lineId: number): string {
  return file + ':' + lineId
}

/**
 * Whether to default to word-boundary matching.
 *
 * `\b` is only meaningful next to a word character, so it helps for a Latin name
 * ("Rin" should not match inside "Ring") and does nothing at all for CJK, where it
 * would simply never match. Defaulting off the term itself keeps both target languages
 * working without asking the user to understand regexes.
 */
export function suggestWholeWord(from: string): boolean {
  return /^[A-Za-z0-9_]/.test(from) && /[A-Za-z0-9_]$/.test(from)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matcher(from: string, wholeWord: boolean): RegExp {
  const body = escapeRegExp(from)
  return new RegExp(wholeWord ? '\\b' + body + '\\b' : body, 'g')
}

function replaceAll(text: string, re: RegExp, to: string): { text: string; count: number } {
  let count = 0
  // `$&` and friends in the replacement are the user's literal text, not a backreference.
  const next = text.replace(re, () => {
    count++
    return to
  })
  return { text: next, count }
}

/**
 * Find every line whose translation would change.
 *
 * Excluded pages are searched too: they are still the user's text, and a page excluded
 * from the next run is exactly the kind of thing a sweep would otherwise leave stale.
 */
export function planRename(
  project: ProjectFile,
  from: string,
  to: string,
  wholeWord: boolean,
): RenamePlan {
  const occurrences: Occurrence[] = []
  if (from !== '' && from !== to) {
    const re = matcher(from, wholeWord)
    for (const page of project.pages) {
      for (const line of page.lines) {
        re.lastIndex = 0
        const { text, count } = replaceAll(line.translation, re, to)
        if (count > 0 && text !== line.translation) {
          occurrences.push({
            file: page.file,
            lineId: line.id,
            before: line.translation,
            after: text,
            count,
          })
        }
      }
    }
  }
  return { from, to, wholeWord, occurrences }
}

/**
 * Apply a plan, minus the occurrences the user unchecked.
 *
 * Returns the project unchanged (same reference) when nothing is left to do, which is
 * what `updateProject` looks for to skip a needless save.
 */
export function applyRename(
  project: ProjectFile,
  plan: RenamePlan,
  skip: ReadonlySet<string> = new Set(),
): ProjectFile {
  const wanted = new Map<string, string>()
  for (const o of plan.occurrences) {
    const key = occurrenceKey(o.file, o.lineId)
    if (!skip.has(key)) wanted.set(key, o.after)
  }
  if (wanted.size === 0) return project

  return {
    ...project,
    pages: project.pages.map((page) => {
      if (!page.lines.some((line) => wanted.has(occurrenceKey(page.file, line.id)))) return page
      return {
        ...page,
        lines: page.lines.map((line) => {
          const next = wanted.get(occurrenceKey(page.file, line.id))
          return next === undefined ? line : editLine(line, next)
        }),
      }
    }),
  }
}

/** How many lines a plan would touch, for the confirm button's label. */
export function affectedLines(plan: RenamePlan, skip: ReadonlySet<string> = new Set()): number {
  return plan.occurrences.filter((o) => !skip.has(occurrenceKey(o.file, o.lineId))).length
}

/**
 * Other glossary entries whose translation contains the old text.
 *
 * Reported to the user rather than rewritten: "Rina" appearing inside "Rina's father"
 * usually should follow the rename, but the sweep has no way to know, and silently
 * editing a second glossary entry is the sort of surprise this feature exists to undo.
 */
export function glossaryHits(
  glossary: GlossaryEntry[],
  from: string,
  exceptTerm: string,
): GlossaryEntry[] {
  if (from === '') return []
  return glossary.filter((e) => e.term !== exceptTerm && e.translation.includes(from))
}
