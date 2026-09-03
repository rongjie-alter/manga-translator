/**
 * Application state, autosave, and the run lifecycle.
 *
 * A module-level store rather than context plumbing: the run loop needs to write
 * progress from outside the component tree, and every view needs to see the same
 * project. Views subscribe with `useStore`.
 */

import { useEffect, useState } from 'preact/hooks'
import {
  pendingFiles,
  runTranslation,
  type CallUsage,
  type RunEvent,
  type RunDeps,
} from '../api/batcher'
import type { EditPolicy } from '../api/merge'
import { planNames, toStorableImage } from '../fs/add-images'
import { hashFile } from '../fs/images'
import { loadProject, saveProject, type ReconcileReport } from '../fs/project-file'
import type { PageSource, ProjectSource } from '../fs/source'
import { newPage, type ProjectFile } from './schema'
import { activeEndpoint, loadSettings, saveSettings, type AppSettings } from './settings'

class Store<T extends object> {
  private listeners = new Set<() => void>()

  constructor(private state: T) {}

  get(): T {
    return this.state
  }

  set(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export interface RunState {
  running: boolean
  batch: number
  batches: number
  /** Files in the call currently in flight. */
  current: string[]
  /** Epoch ms the current rate-limit wait ends, or null. */
  waitingUntil: number | null
  waitingMessage: string
  usage: CallUsage
  log: LogEntry[]
  controller: AbortController | null
}

export interface LogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface AppState {
  settings: AppSettings
  source: ProjectSource | null
  project: ProjectFile | null
  /** Unsaved changes are pending. */
  dirty: boolean
  saving: boolean
  /** What the last open or rescan found on disk. */
  report: ReconcileReport | null
  error: string | null
  run: RunState
}

const idleRun = (): RunState => ({
  running: false,
  batch: 0,
  batches: 0,
  current: [],
  waitingUntil: null,
  waitingMessage: '',
  usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
  log: [],
  controller: null,
})

export const store = new Store<AppState>({
  settings: typeof localStorage === 'undefined' ? ({} as AppSettings) : loadSettings(),
  source: null,
  project: null,
  dirty: false,
  saving: false,
  report: null,
  error: null,
  run: idleRun(),
})

export function useStore(): AppState {
  const [state, setState] = useState(store.get())
  useEffect(() => store.subscribe(() => setState(store.get())), [])
  return state
}

// -- settings ---------------------------------------------------------------

export function updateSettings(patch: Partial<AppSettings>): void {
  const settings = { ...store.get().settings, ...patch }
  saveSettings(settings)
  store.set({ settings })
}

// -- project lifecycle ------------------------------------------------------

let pageSources = new Map<string, PageSource>()

/** Returns false when the project could not be opened; the reason is in `state.error`. */
export async function openSource(source: ProjectSource): Promise<boolean> {
  const { settings } = store.get()
  store.set({ error: null })
  try {
    const { project, report, created, pages } = await loadProject(source, {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      readingDirection: settings.readingDirection,
      endpointId: settings.activeEndpointId,
      model: activeEndpoint(settings)?.model ?? '',
      batchSize: settings.batchSize,
    })
    pageSources = new Map(pages.map((p) => [p.file, p]))
    store.set({ source, project, report, dirty: created, run: idleRun() })
    return true
  } catch (err) {
    store.set({ error: describe(err) })
    return false
  }
}

export async function closeProject(): Promise<void> {
  if (store.get().dirty) await saveNow()
  pageSources = new Map()
  inFlightBlobs.clear()
  store.set({ source: null, project: null, report: null, dirty: false, run: idleRun() })
}

/**
 * Read a page image from the source.
 *
 * Deliberately not cached -- a 200-page project held as blobs will not fit -- but
 * concurrent reads of the *same* page are collapsed, and reads overall are capped.
 * Two views can ask for one page at once (the scan grid and the review sidebar), and
 * for a source that renders its pages rather than reading them, doing that twice, or
 * doing two hundred of them at once, is the difference between usable and hung.
 */
export function loadPageBlob(file: string): Promise<Blob> {
  const pending = inFlightBlobs.get(file)
  if (pending) return pending

  const page = pageSources.get(file)
  if (!page) return Promise.reject(new Error('no image on disk for ' + file))

  const read = withReadSlot(() => page.getFile())
  inFlightBlobs.set(file, read)
  void read
    .catch(() => undefined)
    .finally(() => {
      if (inFlightBlobs.get(file) === read) inFlightBlobs.delete(file)
    })
  return read
}

const inFlightBlobs = new Map<string, Promise<Blob>>()

/**
 * Enough to keep a scrolling grid filled without letting it stampede. Page reads can
 * be genuine work (a PDF render), so this is a small number on purpose.
 */
const MAX_CONCURRENT_READS = 3

let activeReads = 0
const waitingReaders: (() => void)[] = []

async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  // `while`, not `if`: several readers can be woken before any of them takes its slot.
  while (activeReads >= MAX_CONCURRENT_READS) {
    await new Promise<void>((resolve) => waitingReaders.push(resolve))
  }
  activeReads++
  try {
    return await fn()
  } finally {
    activeReads--
    waitingReaders.shift()?.()
  }
}

export function hasPageBlob(file: string): boolean {
  return pageSources.has(file)
}

// -- adding pages -----------------------------------------------------------

export interface AddImagesResult {
  /** Names actually written, in the order they were added. */
  added: string[]
  /** Images that could not be added, with the reason. */
  skipped: { type: string; reason: string }[]
}

/**
 * Serialises `addImages` calls.
 *
 * Two pastes in quick succession would otherwise both read the same set of taken
 * names, pick the same one, and have the second write overwrite the first.
 */
let addQueue: Promise<unknown> = Promise.resolve()

/** Whether the open project can accept new pages at all. */
export function canAddImages(): boolean {
  const { source, project } = store.get()
  return Boolean(source?.addImage && project)
}

/**
 * Add images to the open project: write them through the source, then append them as
 * pending pages.
 *
 * In that order deliberately -- the project must never name a page that does not
 * exist, because reconcile would report it missing and drop it.
 */
export function addImages(blobs: Blob[]): Promise<AddImagesResult> {
  const run = addQueue.then(
    () => addImagesNow(blobs),
    () => addImagesNow(blobs),
  )
  addQueue = run.catch(() => undefined)
  return run
}

async function addImagesNow(blobs: Blob[]): Promise<AddImagesResult> {
  const { source, project } = store.get()
  if (!source?.addImage || !project) return { added: [], skipped: [] }

  const skipped: AddImagesResult['skipped'] = []
  const storable: { blob: Blob }[] = []
  const extensions: string[] = []
  for (const blob of blobs) {
    try {
      const ready = await toStorableImage(blob)
      storable.push({ blob: ready.blob })
      extensions.push(ready.extension)
    } catch (err) {
      skipped.push({ type: blob.type || 'unknown', reason: describe(err) })
    }
  }
  if (storable.length === 0) return { added: [], skipped }

  // Read the taken names now, after the awaits above, so a concurrent rescan cannot
  // leave us planning against a stale list.
  const current = store.get().project ?? project
  const names = planNames(
    [...current.pages.map((p) => p.file), source.jsonName, source.jsonName + '.tmp'],
    extensions,
  )

  const written: { name: string; hash: string; page: PageSource }[] = []
  for (const [i, ready] of storable.entries()) {
    try {
      const { name, page } = await source.addImage(names[i]!, ready.blob)
      // Hash what was written, not what came in: a mismatch makes the next
      // reconcile call a brand-new page `stale`.
      written.push({ name, hash: await hashFile(ready.blob), page })
    } catch (err) {
      skipped.push({ type: ready.blob.type || 'unknown', reason: describe(err) })
    }
  }
  if (written.length === 0) return { added: [], skipped }

  for (const entry of written) pageSources.set(entry.name, entry.page)

  updateProject((live) => {
    // Compare inside the updater: a rescan between the write and here may already
    // have discovered these files, and appending again would duplicate them.
    const known = new Set(live.pages.map((p) => p.file))
    const fresh = written.filter((entry) => !known.has(entry.name))
    if (fresh.length === 0) return live

    const pages = live.pages.slice().sort((a, b) => a.index - b.index)
    for (const entry of fresh) pages.push(newPage(entry.name, 0, entry.hash))
    return { ...live, pages: pages.map((page, i) => ({ ...page, index: i })) }
  })
  await saveNow()

  return { added: written.map((entry) => entry.name), skipped }
}

/** Apply a change to the project and schedule a save. */
export function updateProject(fn: (project: ProjectFile) => ProjectFile): void {
  const { project } = store.get()
  if (!project) return
  const next = fn(project)
  if (next === project) return
  store.set({ project: next, dirty: true })
  scheduleSave()
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Debounced so that typing in the review editor does not write the whole project on
 * every keystroke, but short enough that a user who closes the tab after an edit
 * almost certainly keeps it.
 */
const SAVE_DELAY_MS = 800

export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveNow()
  }, SAVE_DELAY_MS)
}

export async function saveNow(): Promise<void> {
  const { source, project, saving } = store.get()
  if (!source || !project || !source.writable || saving) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  store.set({ saving: true })
  try {
    const stamped = await saveProject(source, project)
    // Only clear the dirty flag if nothing changed while the write was in flight.
    const current = store.get()
    const clean = current.project === project
    store.set({
      saving: false,
      dirty: !clean,
      project: clean ? stamped : current.project,
      error: null,
    })
  } catch (err) {
    store.set({ saving: false, error: 'could not save the project: ' + describe(err) })
  }
}

// -- translation run --------------------------------------------------------

export interface StartRunOptions {
  files?: string[]
  editPolicy?: EditPolicy
}

export async function startRun(opts: StartRunOptions = {}): Promise<void> {
  const state = store.get()
  const { project, source, settings } = state
  if (!project || !source || state.run.running) return

  const endpoint = activeEndpoint(settings)
  if (!endpoint) {
    store.set({ error: 'no API endpoint is configured' })
    return
  }
  if (endpoint.apiKey.trim() === '') {
    store.set({ error: 'add an API key for ' + endpoint.name + ' in settings first' })
    return
  }

  const files = opts.files ?? pendingFiles(project)
  if (files.length === 0) return

  const controller = new AbortController()
  store.set({
    error: null,
    run: { ...idleRun(), running: true, controller, batches: 0 },
  })

  const deps: RunDeps = {
    endpoint,
    promptTemplate: settings.promptTemplate,
    includeThoughts: settings.includeThoughts,
    maxEdge: settings.maxEdge,
    loadImage: loadPageBlob,
  }

  try {
    const summary = await runTranslation(project, deps, {
      files,
      editPolicy: opts.editPolicy,
      signal: controller.signal,
      onEvent: handleRunEvent,
      save: async (next) => {
        store.set({ project: next, dirty: true })
        await saveNow()
      },
    })
    store.set({ project: summary.project })
    log(
      summary.cancelled ? 'warn' : 'info',
      summary.cancelled
        ? 'Stopped. ' + summary.translated.length + ' page(s) translated.'
        : 'Done. ' +
            summary.translated.length +
            ' translated, ' +
            summary.failed.length +
            ' failed, ' +
            summary.blocked.length +
            ' blocked.',
    )
  } catch (err) {
    store.set({ error: describe(err) })
    log('error', describe(err))
  } finally {
    const run = store.get().run
    store.set({ run: { ...run, running: false, current: [], controller: null, waitingUntil: null } })
  }
}

export function cancelRun(): void {
  const { run } = store.get()
  run.controller?.abort()
  store.set({ run: { ...run, waitingUntil: null, waitingMessage: '' } })
  log('warn', 'Stopping after the current call…')
}

function handleRunEvent(event: RunEvent): void {
  const run = store.get().run
  switch (event.type) {
    case 'batch-start':
      store.set({
        run: {
          ...run,
          batch: event.batch,
          batches: event.batches,
          current: event.files,
          waitingUntil: null,
          waitingMessage: '',
        },
      })
      break
    case 'batch-done':
      store.set({
        run: {
          ...run,
          current: [],
          usage: {
            calls: run.usage.calls + event.usage.calls,
            promptTokens: run.usage.promptTokens + event.usage.promptTokens,
            completionTokens: run.usage.completionTokens + event.usage.completionTokens,
          },
        },
      })
      break
    case 'repair':
      log(
        'warn',
        event.reason === 'missing'
          ? 'Re-requesting ' + event.files.length + ' page(s) the model skipped'
          : 'Batch too large to send; splitting it',
      )
      break
    case 'waiting':
      store.set({
        run: {
          ...run,
          waitingUntil: Date.now() + event.delayMs,
          waitingMessage: event.message,
        },
      })
      log('warn', 'Waiting ' + Math.ceil(event.delayMs / 1000) + 's: ' + event.message)
      break
    case 'blocked':
      log('error', 'Blocked: ' + event.files.join(', ') + ' — ' + event.message)
      break
    case 'failed':
      log('error', 'Failed: ' + event.files.join(', ') + ' — ' + event.message)
      break
    case 'saved':
      break
  }
}

const MAX_LOG_ENTRIES = 200

export function log(level: LogEntry['level'], text: string): void {
  const run = store.get().run
  const entries = [...run.log, { at: Date.now(), level, text }]
  store.set({ run: { ...run, log: entries.slice(-MAX_LOG_ENTRIES) } })
}

// -- unload guard -----------------------------------------------------------

/**
 * A run in progress is API quota already spent; an unsaved edit is work already done.
 * Both are worth an "are you sure" that the browser will only show if the user has
 * interacted with the page, which by this point they always have.
 */
export function installUnloadGuard(): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    const { run, dirty, saving } = store.get()
    if (!run.running && !dirty && !saving) return
    event.preventDefault()
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  return () => window.removeEventListener('beforeunload', onBeforeUnload)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
