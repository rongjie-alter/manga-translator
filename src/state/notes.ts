/**
 * Notes: glossary terms and translation instructions shared across projects, grouped
 * by series.
 *
 * A user translating volume 5 already knows how volume 1 rendered every character's
 * name, but that knowledge lives inside volume 1's `translation.json` and nothing can
 * reach it. This module is where it goes instead -- per series, and independent of any
 * one project's lifetime.
 *
 * **This is the second thing in IndexedDB that is not a cache.** Like a single-file
 * project's JSON (see `fs/file-source.ts`), hand-curated official translations exist
 * nowhere else, so clearing site data destroys them. Three consequences run through the
 * code below: `navigator.storage.persist()` is requested once there is something worth
 * keeping, write failures are surfaced rather than swallowed the way `settings.ts`
 * swallows its own, and export is the documented way out.
 *
 * Its own module-level store rather than a slice of `AppState`: notes outlive the open
 * project, and `Store.set` notifies every listener unconditionally, so folding them in
 * would re-render the whole page grid on each keystroke in a series' context box.
 */

import { idbGet, idbSet } from '../fs/idb'
import { Store, useStoreValue } from './observable'
import { migrateGlossaryEntry, type GlossaryEntry, type ProjectFile } from './schema'

export const NOTES_VERSION = 1

const STORAGE_KEY = 'notes:v1'

/** The export's self-identification, so an import can tell a notes file from a project. */
export const NOTES_FILE_KIND = 'comic-translator-notes'

export const NOTES_FILE_NAME = 'glossary-notes.json'

/**
 * A ceiling far above `MAX_GLOSSARY_ENTRIES`, which is a prompt-size guard and belongs
 * only to the project side. A series' terms are a store to pick from, never sent whole.
 */
export const MAX_SERIES_TERMS = 5000

/** A series' context *is* sent with every request, so an overlong one costs real tokens. */
export const CONTEXT_WARN_CHARS = 1500

export interface Series {
  id: string
  name: string
  /** Shared instructions every project in the series inherits. */
  context: string
  terms: GlossaryEntry[]
  createdAt: string
  updatedAt: string
}

export interface Notes {
  version: number
  series: Series[]
}

export interface NotesState {
  notes: Notes
  /** False until IndexedDB has answered. Mutations are refused before then. */
  loaded: boolean
  error: string | null
}

export function emptyNotes(): Notes {
  return { version: NOTES_VERSION, series: [] }
}

const store = new Store<NotesState>({ notes: emptyNotes(), loaded: false, error: null })

export function useNotes(): NotesState {
  return useStoreValue(store)
}

/** The whole state, for callers outside the component tree (the run loop, tests). */
export function getNotesState(): NotesState {
  return store.get()
}

export function getNotes(): Notes {
  return store.get().notes
}

export function notesLoaded(): boolean {
  return store.get().loaded
}

export function clearNotesError(): void {
  if (store.get().error !== null) store.set({ error: null })
}

// -- persistence ------------------------------------------------------------

let loading: Promise<void> | null = null

/**
 * Read the stored notes. Called once at startup from `main.tsx`.
 *
 * Until this resolves the store is empty *and knows it*, because a mutation landing on
 * the placeholder would write it straight back over the real record -- and hash-route
 * navigation is instant, so reaching the notes view before the read settles is not a
 * hypothetical.
 */
export function initNotes(): Promise<void> {
  if (!loading) {
    loading = idbGet<unknown>(STORAGE_KEY).then(
      (raw) => {
        store.set({ notes: migrateNotes(raw), loaded: true })
      },
      () => {
        // No IndexedDB at all (private mode, or happy-dom under test). Stay usable in
        // memory; a write will fail loudly on its own rather than losing anything,
        // since a read that failed this way means there was nothing to lose.
        store.set({ loaded: true })
      },
    )
  }
  return loading
}

/** Test seam: drop the cached load so a fresh `initNotes` re-reads. */
export function resetNotesForTest(): void {
  loading = null
  store.set({ notes: emptyNotes(), loaded: false, error: null })
}

function persist(notes: Notes): void {
  idbSet(STORAGE_KEY, notes).then(
    () => clearNotesError(),
    (e: unknown) => {
      store.set({
        error:
          'Could not save notes: ' +
          (e instanceof Error ? e.message : String(e)) +
          '. Export them before closing the tab.',
      })
    },
  )
}

/**
 * Apply a change, then write it through.
 *
 * Write-through rather than debounced, matching `settings.ts`: the writes are small and
 * IndexedDB serialises them, and a debounce is one more window in which a closed tab
 * loses an edit.
 */
function mutate(fn: (notes: Notes) => Notes): void {
  const state = store.get()
  if (!state.loaded) return
  const next = fn(state.notes)
  if (next === state.notes) return
  store.set({ notes: next })
  persist(next)
  if (next.series.length > 0) requestDurableStorage()
}

let askedForDurability = false

function requestDurableStorage(): void {
  if (askedForDurability) return
  askedForDurability = true
  void navigator.storage?.persist?.().catch(() => undefined)
}

// -- migration --------------------------------------------------------------

/**
 * Coerce an unknown blob into `Notes`, field by field.
 *
 * Same forgiving contract as `schema.ts`'s `migrate`, minus the throwing: there is no
 * user action that can recover a notes record, so a future version's file degrades to
 * whatever this build can read rather than refusing to open the view at all.
 */
export function migrateNotes(raw: unknown): Notes {
  const o = asRecord(raw)
  const series = Array.isArray(o['series']) ? o['series'] : []
  return {
    version: NOTES_VERSION,
    series: series.map(migrateSeries).filter((s) => s.name !== ''),
  }
}

function migrateSeries(raw: unknown): Series {
  const o = asRecord(raw)
  const now = new Date().toISOString()
  const terms = Array.isArray(o['terms']) ? o['terms'] : []
  return {
    id: str(o['id'], '') || newId(),
    name: str(o['name'], '').trim(),
    context: str(o['context'], ''),
    terms: dedupeTerms(terms.map(migrateGlossaryEntry).filter((t) => t.term !== '')),
    createdAt: str(o['createdAt'], now),
    updatedAt: str(o['updatedAt'], now),
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function str(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback
}

function dedupeTerms(terms: GlossaryEntry[]): GlossaryEntry[] {
  const seen = new Set<string>()
  return terms.filter((t) => (seen.has(t.term) ? false : (seen.add(t.term), true)))
}

function newId(): string {
  return crypto.randomUUID()
}

// -- lookups ----------------------------------------------------------------

export function findSeries(notes: Notes, id: string): Series | undefined {
  return id === '' ? undefined : notes.series.find((s) => s.id === id)
}

export function sortedSeries(notes: Notes): Series[] {
  return notes.series.slice().sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The context string the prompt's `{context}` placeholder receives.
 *
 * Series instructions first, then the project's own: the general setting before the
 * specifics of this volume. Resolved at render time rather than copied into the
 * project, so correcting a series-wide instruction once corrects every volume.
 */
export function resolveContext(project: ProjectFile, notes: Notes): string {
  const series = findSeries(notes, project.project.seriesId)
  const parts = [series?.context ?? '', project.project.context]
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join('\n\n')
}

// -- mutations --------------------------------------------------------------

function touch(series: Series): Series {
  return { ...series, updatedAt: new Date().toISOString() }
}

function replaceSeries(notes: Notes, id: string, fn: (s: Series) => Series): Notes {
  const at = notes.series.findIndex((s) => s.id === id)
  if (at === -1) return notes
  const next = notes.series.slice()
  next[at] = touch(fn(notes.series[at]!))
  return { ...notes, series: next }
}

/** Returns the new series' id, or '' if the store was not ready or the name was blank. */
export function createSeries(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || !notesLoaded()) return ''
  const now = new Date().toISOString()
  const series: Series = {
    id: newId(),
    name: trimmed,
    context: '',
    terms: [],
    createdAt: now,
    updatedAt: now,
  }
  mutate((notes) => ({ ...notes, series: [...notes.series, series] }))
  return series.id
}

export function renameSeries(id: string, name: string): void {
  const trimmed = name.trim()
  if (trimmed === '') return
  mutate((notes) => replaceSeries(notes, id, (s) => ({ ...s, name: trimmed })))
}

export function setSeriesContext(id: string, context: string): void {
  mutate((notes) => replaceSeries(notes, id, (s) => ({ ...s, context })))
}

export function deleteSeries(id: string): void {
  mutate((notes) => ({ ...notes, series: notes.series.filter((s) => s.id !== id) }))
}

export interface AddTermsResult {
  added: number
  replaced: number
  skipped: number
}

/**
 * Push terms into a series. Later pushes update a term rather than being ignored --
 * the opposite of `mergeGlossary`, because every push here is a deliberate act.
 */
export function addSeriesTerms(id: string, incoming: GlossaryEntry[]): AddTermsResult {
  const result: AddTermsResult = { added: 0, replaced: 0, skipped: 0 }
  mutate((notes) =>
    replaceSeries(notes, id, (series) => {
      const terms = series.terms.slice()
      const index = new Map(terms.map((t, i) => [t.term, i]))
      for (const raw of incoming) {
        const term = raw.term.trim()
        const translation = raw.translation.trim()
        if (term === '' || translation === '') continue
        const at = index.get(term)
        if (at !== undefined) {
          const current = terms[at]!
          if (current.translation === translation && current.note === raw.note.trim()) continue
          terms[at] = { ...current, translation, note: raw.note.trim() }
          result.replaced++
          continue
        }
        if (terms.length >= MAX_SERIES_TERMS) {
          result.skipped++
          continue
        }
        index.set(term, terms.length)
        terms.push({ term, translation, note: raw.note.trim(), locked: true })
        result.added++
      }
      return { ...series, terms }
    }),
  )
  return result
}

export function updateSeriesTerm(id: string, term: string, patch: Partial<GlossaryEntry>): void {
  mutate((notes) =>
    replaceSeries(notes, id, (s) => ({
      ...s,
      terms: s.terms.map((t) => (t.term === term ? { ...t, ...patch } : t)),
    })),
  )
}

export function removeSeriesTerm(id: string, term: string): void {
  mutate((notes) =>
    replaceSeries(notes, id, (s) => ({ ...s, terms: s.terms.filter((t) => t.term !== term) })),
  )
}

// -- import / export --------------------------------------------------------

export function serializeNotes(notes: Notes): string {
  return (
    JSON.stringify({ kind: NOTES_FILE_KIND, version: NOTES_VERSION, series: notes.series }, null, 2) +
    '\n'
  )
}

export type ParsedImport =
  | { kind: 'notes'; series: Series[] }
  /** A project file, whose glossary the user can file under a series of their choosing. */
  | { kind: 'project'; name: string; terms: GlossaryEntry[] }
  | { kind: 'unknown' }

/**
 * Work out what a dropped file is.
 *
 * A `translation.json` is accepted on purpose: it is the only migration path for the
 * volumes a user already translated before any of this existed. Its glossary is read
 * directly rather than through `schema.ts`'s `migrate`, which would throw on a file
 * written by a newer build when all that is wanted here is the terms.
 */
export function parseImport(raw: unknown): ParsedImport {
  const o = asRecord(raw)
  if (o['kind'] === NOTES_FILE_KIND || Array.isArray(o['series'])) {
    return { kind: 'notes', series: migrateNotes(o).series }
  }
  if (typeof o['schemaVersion'] === 'number' && Array.isArray(o['glossary'])) {
    const meta = asRecord(o['project'])
    return {
      kind: 'project',
      name: str(meta['name'], 'imported'),
      terms: dedupeTerms(
        o['glossary'].map(migrateGlossaryEntry).filter((t) => t.term !== '' && t.translation !== ''),
      ),
    }
  }
  return { kind: 'unknown' }
}

export type ImportConflictPolicy = 'overwrite' | 'keep' | 'replace'

export interface TermConflict {
  term: string
  localTranslation: string
  importedTranslation: string
  localNote: string
  importedNote: string
}

export interface SeriesConflictInfo {
  seriesId: string
  seriesName: string
  matchingByNameOnly: boolean
  termConflicts: TermConflict[]
  newTermsCount: number
  existingTermsCount: number
}

export interface NotesImportInspection {
  totalSeriesCount: number
  totalTermsCount: number
  conflicts: SeriesConflictInfo[]
  hasConflicts: boolean
}

export function inspectNotesImport(existing: Notes, incoming: Series[]): NotesImportInspection {
  let totalTermsCount = 0
  const conflictsBySeriesId = new Map<string, SeriesConflictInfo>()

  const byId = new Map(existing.series.map((s) => [s.id, s]))
  const byName = new Map(existing.series.map((s) => [s.name.toLowerCase(), s]))

  for (const source of incoming) {
    totalTermsCount += source.terms.length
    const current = byId.get(source.id) ?? byName.get(source.name.toLowerCase())
    if (current) {
      const existingTermMap = new Map(current.terms.map((t) => [t.term, t]))
      const termConflicts: TermConflict[] = []
      let newTermsCount = 0

      for (const term of source.terms) {
        const existingTerm = existingTermMap.get(term.term)
        if (existingTerm) {
          if (existingTerm.translation !== term.translation || existingTerm.note !== term.note) {
            termConflicts.push({
              term: term.term,
              localTranslation: existingTerm.translation,
              importedTranslation: term.translation,
              localNote: existingTerm.note,
              importedNote: term.note,
            })
          }
        } else {
          newTermsCount++
        }
      }

      const matchingByNameOnly = !byId.has(source.id) && byName.has(source.name.toLowerCase())
      const prior = conflictsBySeriesId.get(current.id)
      if (prior) {
        prior.termConflicts.push(...termConflicts)
        prior.newTermsCount += newTermsCount
        prior.matchingByNameOnly = prior.matchingByNameOnly || matchingByNameOnly
      } else {
        conflictsBySeriesId.set(current.id, {
          seriesId: current.id,
          seriesName: current.name,
          matchingByNameOnly,
          termConflicts,
          newTermsCount,
          existingTermsCount: current.terms.length,
        })
      }
    }
  }

  const conflicts = [...conflictsBySeriesId.values()]

  return {
    totalSeriesCount: incoming.length,
    totalTermsCount,
    conflicts,
    hasConflicts: conflicts.length > 0,
  }
}

/**
 * Fold imported series into the existing ones.
 *
 * Matched by `id` first and name second, and incoming ids are never re-minted: a
 * project's `seriesId` points into this store, so a re-import that invented fresh ids
 * would dangle every link the user has.
 */
export function mergeNotes(
  existing: Notes,
  incoming: Series[],
  policy: ImportConflictPolicy = 'overwrite',
): Notes {
  if (policy === 'replace') {
    return { version: NOTES_VERSION, series: incoming }
  }

  const series = existing.series.slice()
  const byId = new Map(series.map((s, i) => [s.id, i]))
  const byName = new Map(series.map((s, i) => [s.name.toLowerCase(), i]))

  for (const source of incoming) {
    const at = byId.get(source.id) ?? byName.get(source.name.toLowerCase())
    if (at === undefined) {
      byId.set(source.id, series.length)
      byName.set(source.name.toLowerCase(), series.length)
      series.push(source)
      continue
    }
    const current = series[at]!
    const terms = current.terms.slice()
    const index = new Map(terms.map((t, i) => [t.term, i]))
    for (const term of source.terms) {
      const pos = index.get(term.term)
      if (pos === undefined) {
        index.set(term.term, terms.length)
        terms.push(term)
      } else if (policy === 'overwrite') {
        terms[pos] = term
      }
    }
    const nextContext =
      policy === 'overwrite'
        ? source.context.trim() === ''
          ? current.context
          : source.context
        : current.context.trim() === ''
          ? source.context
          : current.context

    series[at] = {
      ...current,
      context: nextContext,
      terms,
      updatedAt: new Date().toISOString(),
    }
  }

  return { ...existing, series }
}

export function importNotes(series: Series[], policy: ImportConflictPolicy = 'overwrite'): void {
  mutate((notes) => mergeNotes(notes, series, policy))
}

