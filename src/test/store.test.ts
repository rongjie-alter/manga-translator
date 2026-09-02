import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelRun,
  closeProject,
  installUnloadGuard,
  openSource,
  saveNow,
  startRun,
  store,
  updateProject,
  type RunState,
} from '../state/store'
import { loadProject, saveProject } from '../fs/project-file'
import { pendingFiles, runTranslation } from '../api/batcher'
import { newProjectFile, type ProjectFile } from '../state/schema'
import { defaultSettings } from '../state/settings'
import type { ProjectSource } from '../fs/source'

vi.mock('../fs/project-file', () => ({
  loadProject: vi.fn(),
  saveProject: vi.fn(),
}))

vi.mock('../api/batcher', () => ({
  pendingFiles: vi.fn(),
  runTranslation: vi.fn(),
}))

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

function resetStore(): void {
  store.set({
    settings: defaultSettings(),
    source: null,
    project: null,
    dirty: false,
    saving: false,
    report: null,
    error: null,
    run: idleRun(),
  })
}

function fakeSource(overrides: Partial<ProjectSource> = {}): ProjectSource {
  return {
    name: 'test project',
    jsonName: 'translation.json',
    writable: true,
    readJson: async () => null,
    writeJson: async () => {},
    listPages: async () => [],
    ...overrides,
  }
}

function project(files: string[] = ['a.jpg']): ProjectFile {
  return newProjectFile(
    'test',
    files.map((file) => ({ file, hash: 'h-' + file })),
  )
}

/** Deferred promise, for controlling when a mocked async op resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetStore()
  vi.mocked(loadProject).mockReset()
  vi.mocked(saveProject).mockReset()
  vi.mocked(pendingFiles).mockReset()
  vi.mocked(runTranslation).mockReset()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('openSource / closeProject', () => {
  it('loads a project and marks it dirty when it was just created', async () => {
    const p = project()
    vi.mocked(loadProject).mockResolvedValue({
      project: p,
      report: { added: ['a.jpg'], removed: [], changed: [] },
      created: true,
    })
    const source = fakeSource()

    await openSource(source)

    expect(store.get().source).toBe(source)
    expect(store.get().project).toBe(p)
    expect(store.get().dirty).toBe(true)
    expect(store.get().report).toEqual({ added: ['a.jpg'], removed: [], changed: [] })
    expect(store.get().run.running).toBe(false)
  })

  it('does not mark an existing project dirty on open', async () => {
    const p = project()
    vi.mocked(loadProject).mockResolvedValue({
      project: p,
      report: { added: [], removed: [], changed: [] },
      created: false,
    })

    await openSource(fakeSource())

    expect(store.get().dirty).toBe(false)
  })

  it('surfaces a load failure as an error without touching project state', async () => {
    vi.mocked(loadProject).mockRejectedValue(new Error('folder vanished'))

    await openSource(fakeSource())

    expect(store.get().error).toBe('folder vanished')
    expect(store.get().project).toBeNull()
  })

  it('flushes a pending save before closing a dirty project', async () => {
    vi.mocked(loadProject).mockResolvedValue({
      project: project(),
      report: { added: [], removed: [], changed: [] },
      created: false,
    })
    vi.mocked(saveProject).mockImplementation(async (_source, p) => p)
    await openSource(fakeSource())
    updateProject((p) => ({ ...p, glossary: [{ term: 'x', translation: 'y', note: '', locked: false }] }))

    await closeProject()

    expect(saveProject).toHaveBeenCalledTimes(1)
    expect(store.get().source).toBeNull()
    expect(store.get().project).toBeNull()
    expect(store.get().dirty).toBe(false)
  })

  it('does not save on close when nothing changed', async () => {
    vi.mocked(loadProject).mockResolvedValue({
      project: project(),
      report: { added: [], removed: [], changed: [] },
      created: false,
    })
    await openSource(fakeSource())

    await closeProject()

    expect(saveProject).not.toHaveBeenCalled()
  })
})

describe('updateProject / autosave', () => {
  beforeEach(async () => {
    vi.mocked(loadProject).mockResolvedValue({
      project: project(),
      report: { added: [], removed: [], changed: [] },
      created: false,
    })
    await openSource(fakeSource())
  })

  it('marks the project dirty immediately but delays the write', () => {
    updateProject((p) => ({ ...p, glossary: [{ term: 'x', translation: 'y', note: '', locked: false }] }))

    expect(store.get().dirty).toBe(true)
    expect(saveProject).not.toHaveBeenCalled()
  })

  it('saves 800ms after the last edit and clears the dirty flag', async () => {
    const stamped = { ...project(), project: { ...project().project, updatedAt: 'STAMPED' } }
    vi.mocked(saveProject).mockResolvedValue(stamped)

    updateProject((p) => ({ ...p, glossary: [{ term: 'x', translation: 'y', note: '', locked: false }] }))
    await vi.advanceTimersByTimeAsync(800)

    expect(saveProject).toHaveBeenCalledTimes(1)
    expect(store.get().dirty).toBe(false)
    expect(store.get().project).toBe(stamped)
  })

  it('collapses rapid edits into a single debounced write', async () => {
    vi.mocked(saveProject).mockImplementation(async (_source, p) => p)

    updateProject((p) => ({ ...p, glossary: [{ term: 'a', translation: 'a', note: '', locked: false }] }))
    await vi.advanceTimersByTimeAsync(400)
    updateProject((p) => ({ ...p, glossary: [{ term: 'b', translation: 'b', note: '', locked: false }] }))
    await vi.advanceTimersByTimeAsync(400)
    updateProject((p) => ({ ...p, glossary: [{ term: 'c', translation: 'c', note: '', locked: false }] }))
    await vi.advanceTimersByTimeAsync(800)

    expect(saveProject).toHaveBeenCalledTimes(1)
    expect(store.get().project?.glossary[0]?.term).toBe('c')
  })

  it('saveNow bypasses the debounce and cancels the pending timer', async () => {
    vi.mocked(saveProject).mockImplementation(async (_source, p) => p)

    updateProject((p) => ({ ...p, glossary: [{ term: 'x', translation: 'y', note: '', locked: false }] }))
    await saveNow()
    expect(saveProject).toHaveBeenCalledTimes(1)

    // The debounce timer that updateProject scheduled must have been cleared by
    // saveNow, or it would fire a redundant second write here.
    await vi.advanceTimersByTimeAsync(800)
    expect(saveProject).toHaveBeenCalledTimes(1)
  })

  it('does not clear dirty when the project changed again while the write was in flight', async () => {
    const gate = deferred<ProjectFile>()
    vi.mocked(saveProject).mockImplementation(async () => gate.promise)

    updateProject((p) => ({ ...p, glossary: [{ term: 'first', translation: '', note: '', locked: false }] }))
    const inFlight = store.get().project!
    const savePromise = saveNow()

    // A second edit lands before the in-flight write resolves.
    updateProject((p) => ({ ...p, glossary: [{ term: 'second', translation: '', note: '', locked: false }] }))
    const latest = store.get().project!

    gate.resolve({ ...inFlight, project: { ...inFlight.project, updatedAt: 'STAMPED' } })
    await savePromise

    expect(store.get().dirty).toBe(true)
    expect(store.get().project).toBe(latest)
    expect(store.get().project?.glossary[0]?.term).toBe('second')
  })

  it('records an error and keeps the dirty flag when the write fails', async () => {
    vi.mocked(saveProject).mockRejectedValue(new Error('disk full'))
    updateProject((p) => ({ ...p, glossary: [{ term: 'x', translation: 'y', note: '', locked: false }] }))

    await saveNow()

    expect(store.get().error).toBe('could not save the project: disk full')
    expect(store.get().saving).toBe(false)
    expect(store.get().dirty).toBe(true)
  })

  it('does not write when the source is read-only', async () => {
    // Reopen against a non-writable source.
    vi.mocked(loadProject).mockResolvedValue({
      project: project(),
      report: { added: [], removed: [], changed: [] },
      created: false,
    })
    await openSource(fakeSource({ writable: false }))
    updateProject((p) => ({ ...p, glossary: [{ term: 'x', translation: 'y', note: '', locked: false }] }))

    await saveNow()

    expect(saveProject).not.toHaveBeenCalled()
  })

  it('collapses overlapping saveNow calls into a single write', async () => {
    const gate = deferred<ProjectFile>()
    vi.mocked(saveProject).mockImplementation(async () => gate.promise)
    updateProject((p) => ({ ...p, glossary: [{ term: 'x', translation: 'y', note: '', locked: false }] }))

    const first = saveNow()
    const second = saveNow()
    gate.resolve(store.get().project!)
    await Promise.all([first, second])

    expect(saveProject).toHaveBeenCalledTimes(1)
  })
})

describe('startRun', () => {
  it('does nothing without an open project', async () => {
    await startRun()
    expect(store.get().run.running).toBe(false)
    expect(runTranslation).not.toHaveBeenCalled()
  })

  it('errors when no endpoint is configured', async () => {
    store.set({
      source: fakeSource(),
      project: project(),
      settings: { ...defaultSettings(), endpoints: [], activeEndpointId: '' },
    })

    await startRun()

    expect(store.get().error).toBe('no API endpoint is configured')
    expect(runTranslation).not.toHaveBeenCalled()
  })

  it('errors when the active endpoint has no API key', async () => {
    store.set({ source: fakeSource(), project: project(), settings: defaultSettings() })

    await startRun()

    expect(store.get().error).toBe('add an API key for Google AI Studio in settings first')
    expect(runTranslation).not.toHaveBeenCalled()
  })

  it('does nothing when there are no pending files', async () => {
    store.set({
      source: fakeSource(),
      project: project(),
      settings: { ...defaultSettings(), activeEndpointId: 'mock' },
    })
    vi.mocked(pendingFiles).mockReturnValue([])

    await startRun()

    expect(store.get().run.running).toBe(false)
    expect(runTranslation).not.toHaveBeenCalled()
  })

  it('reflects batch progress and usage as the run reports events, then finishes', async () => {
    const p = project(['a.jpg'])
    store.set({
      source: fakeSource(),
      project: p,
      settings: { ...defaultSettings(), activeEndpointId: 'mock' },
    })
    vi.mocked(pendingFiles).mockReturnValue(['a.jpg'])

    const seenBatchStarts: RunState[] = []
    vi.mocked(runTranslation).mockImplementation(async (proj, _deps, opts = {}) => {
      opts.onEvent?.({ type: 'batch-start', files: ['a.jpg'], batch: 1, batches: 1 })
      seenBatchStarts.push(store.get().run)
      opts.onEvent?.({
        type: 'batch-done',
        files: ['a.jpg'],
        translated: ['a.jpg'],
        usage: { calls: 1, promptTokens: 10, completionTokens: 5 },
      })
      return {
        project: proj,
        translated: ['a.jpg'],
        failed: [],
        blocked: [],
        usage: { calls: 1, promptTokens: 10, completionTokens: 5 },
        cancelled: false,
      }
    })

    await startRun()

    expect(seenBatchStarts[0]).toMatchObject({ batch: 1, batches: 1, current: ['a.jpg'], running: true })
    const finalRun = store.get().run
    expect(finalRun.running).toBe(false)
    expect(finalRun.current).toEqual([])
    expect(finalRun.controller).toBeNull()
    expect(finalRun.usage).toEqual({ calls: 1, promptTokens: 10, completionTokens: 5 })
    expect(finalRun.log.at(-1)?.text).toBe('Done. 1 translated, 0 failed, 0 blocked.')
  })

  it('logs a distinct message when the run is cancelled', async () => {
    store.set({
      source: fakeSource(),
      project: project(['a.jpg']),
      settings: { ...defaultSettings(), activeEndpointId: 'mock' },
    })
    vi.mocked(pendingFiles).mockReturnValue(['a.jpg'])
    vi.mocked(runTranslation).mockResolvedValue({
      project: project(['a.jpg']),
      translated: ['a.jpg'],
      failed: [],
      blocked: [],
      usage: { calls: 1, promptTokens: 0, completionTokens: 0 },
      cancelled: true,
    })

    await startRun()

    expect(store.get().run.log.at(-1)).toMatchObject({
      level: 'warn',
      text: 'Stopped. 1 page(s) translated.',
    })
  })

  it('logs waiting, blocked, failed and repair events', async () => {
    store.set({
      source: fakeSource(),
      project: project(['a.jpg']),
      settings: { ...defaultSettings(), activeEndpointId: 'mock' },
    })
    vi.mocked(pendingFiles).mockReturnValue(['a.jpg'])
    let waitingUntilDuringRun: number | null = null
    vi.mocked(runTranslation).mockImplementation(async (proj, _deps, opts = {}) => {
      opts.onEvent?.({ type: 'waiting', delayMs: 5000, attempt: 1, message: 'slow down' })
      waitingUntilDuringRun = store.get().run.waitingUntil
      opts.onEvent?.({ type: 'repair', files: ['a.jpg'], reason: 'missing' })
      opts.onEvent?.({ type: 'blocked', files: ['a.jpg'], message: 'refused' })
      opts.onEvent?.({ type: 'failed', files: ['b.jpg'], message: 'server error' })
      return {
        project: proj,
        translated: [],
        failed: ['b.jpg'],
        blocked: ['a.jpg'],
        usage: { calls: 1, promptTokens: 0, completionTokens: 0 },
        cancelled: false,
      }
    })

    await startRun()

    expect(waitingUntilDuringRun).toBeGreaterThan(Date.now() - 1)
    const texts = store.get().run.log.map((l) => l.text)
    expect(texts).toContain('Waiting 5s: slow down')
    expect(texts).toContain("Re-requesting 1 page(s) the model skipped")
    expect(texts).toContain('Blocked: a.jpg — refused')
    expect(texts).toContain('Failed: b.jpg — server error')
    // The run finishing clears the waiting indicator even though the log entry stays.
    expect(store.get().run.waitingUntil).toBeNull()
  })

  it('records an error and stops running when the run throws', async () => {
    store.set({
      source: fakeSource(),
      project: project(['a.jpg']),
      settings: { ...defaultSettings(), activeEndpointId: 'mock' },
    })
    vi.mocked(pendingFiles).mockReturnValue(['a.jpg'])
    vi.mocked(runTranslation).mockRejectedValue(new Error('network down'))

    await startRun()

    expect(store.get().error).toBe('network down')
    expect(store.get().run.running).toBe(false)
    expect(store.get().run.log.at(-1)).toMatchObject({ level: 'error', text: 'network down' })
  })

  it('saves through the real autosave path via the run save callback', async () => {
    store.set({
      source: fakeSource(),
      project: project(['a.jpg']),
      settings: { ...defaultSettings(), activeEndpointId: 'mock' },
    })
    vi.mocked(pendingFiles).mockReturnValue(['a.jpg'])
    vi.mocked(saveProject).mockImplementation(async (_source, p) => p)
    vi.mocked(runTranslation).mockImplementation(async (proj, _deps, opts = {}) => {
      const next = { ...proj, usage: { ...proj.usage, calls: 1 } }
      await opts.save?.(next)
      return {
        project: next,
        translated: ['a.jpg'],
        failed: [],
        blocked: [],
        usage: { calls: 1, promptTokens: 0, completionTokens: 0 },
        cancelled: false,
      }
    })

    await startRun()

    expect(saveProject).toHaveBeenCalledTimes(1)
    expect(store.get().project?.usage.calls).toBe(1)
  })
})

describe('cancelRun', () => {
  it('aborts the in-flight controller and logs, leaving the run to finish on its own', async () => {
    store.set({
      source: fakeSource(),
      project: project(['a.jpg']),
      settings: { ...defaultSettings(), activeEndpointId: 'mock' },
    })
    vi.mocked(pendingFiles).mockReturnValue(['a.jpg'])

    const gate = deferred<void>()
    vi.mocked(runTranslation).mockImplementation(async (proj, _deps, opts = {}) => {
      gate.resolve()
      await new Promise((r) => setTimeout(r, 10_000))
      return {
        project: proj,
        translated: [],
        failed: [],
        blocked: [],
        usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
        cancelled: true,
      }
    })

    const runPromise = startRun()
    await gate.promise

    expect(store.get().run.running).toBe(true)
    const controller = store.get().run.controller
    expect(controller).not.toBeNull()

    cancelRun()

    expect(controller!.signal.aborted).toBe(true)
    expect(store.get().run.waitingUntil).toBeNull()
    expect(store.get().run.log.at(-1)).toMatchObject({
      level: 'warn',
      text: 'Stopping after the current call…',
    })

    await vi.advanceTimersByTimeAsync(10_000)
    await runPromise
  })
})

describe('installUnloadGuard', () => {
  function dispatchBeforeUnload(): Event {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event
  }

  it('warns when there are unsaved changes', () => {
    const dispose = installUnloadGuard()
    store.set({ dirty: true })

    const event = dispatchBeforeUnload()

    expect(event.defaultPrevented).toBe(true)
    dispose()
  })

  it('warns while a run is active', () => {
    const dispose = installUnloadGuard()
    store.set({ run: { ...idleRun(), running: true } })

    const event = dispatchBeforeUnload()

    expect(event.defaultPrevented).toBe(true)
    dispose()
  })

  it('warns while a save is in flight', () => {
    const dispose = installUnloadGuard()
    store.set({ saving: true })

    const event = dispatchBeforeUnload()

    expect(event.defaultPrevented).toBe(true)
    dispose()
  })

  it('does not warn when the project is clean and idle', () => {
    const dispose = installUnloadGuard()
    store.set({ dirty: false, saving: false, run: idleRun() })

    const event = dispatchBeforeUnload()

    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  it('stops warning once disposed', () => {
    const dispose = installUnloadGuard()
    dispose()
    store.set({ dirty: true })

    const event = dispatchBeforeUnload()

    expect(event.defaultPrevented).toBe(false)
  })
})
