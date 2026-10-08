/**
 * The run loop: pages in, translated project out.
 *
 * Two invariants drive the design.
 *
 * Every page ends in a state the user can act on -- `translated`, `failed` or `blocked`,
 * never silently empty. A page that vanishes from a response is not a page that has no
 * text; it is a page we still owe the user.
 *
 * And progress is never lost. The project is handed back to the caller to save after
 * every batch, so closing the tab mid-run costs at most the batch in flight.
 */

import { prepareImage } from '../fs/images'
import {
  pageNeedsTranslation,
  translatablePages,
  type GlossaryEntry,
  type Page,
  type PageLayout,
  type ProjectFile,
  type RunInfo,
} from '../state/schema'
import type { Endpoint } from '../state/settings'
import { ApiError, chat as defaultChat, withRetry, type ChatResult } from './client'
import type { ModelPage } from './contract'
import { mergeGlossary, mergeLines, type EditPolicy } from './merge'
import { parseResponse } from './parse'
import { DEFAULT_4KOMA_PROMPT_TEMPLATE, renderPrompt } from './prompt'
import { buildRequestBody, requestSizeBytes } from './request'

/**
 * Google AI Studio rejects requests over 20MB. Budgeting to 15MB leaves room for the
 * prompt and for base64 being larger than the caller measured.
 */
export const MAX_REQUEST_BYTES = 15 * 1024 * 1024

export type RunEvent =
  | { type: 'batch-start'; files: string[]; batch: number; batches: number }
  | { type: 'batch-done'; files: string[]; translated: string[]; usage: CallUsage }
  | { type: 'repair'; files: string[]; reason: 'missing' | 'oversize' }
  | { type: 'waiting'; delayMs: number; attempt: number; message: string }
  | { type: 'blocked'; files: string[]; message: string }
  | { type: 'failed'; files: string[]; message: string }
  | { type: 'saved'; project: ProjectFile }

export interface CallUsage {
  calls: number
  promptTokens: number
  completionTokens: number
}

export interface RunDeps {
  endpoint: Endpoint
  promptTemplate: string
  /** For pages marked 4-koma. Defaults to `DEFAULT_4KOMA_PROMPT_TEMPLATE`. */
  fourKomaPromptTemplate?: string
  /** Series and project instructions, already composed. See `state/notes.ts`. */
  context: string
  includeThoughts: boolean
  maxEdge: number
  /** Reads a page image by its project-relative file name. */
  loadImage: (file: string) => Promise<Blob>
  /** Injectable for tests. */
  chat?: typeof defaultChat
  /** Injectable for tests: happy-dom has no canvas to resample images with. */
  prepare?: typeof prepareImage
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  attempts?: number
  baseDelayMs?: number
  rateLimitDelayMs?: number
  serverErrorDelayMs?: number
}

export interface RunOptions {
  /** Restrict the run to these files. Defaults to every page needing translation. */
  files?: string[]
  editPolicy?: EditPolicy
  signal?: AbortSignal
  onEvent?: (event: RunEvent) => void
  /** Persist after each batch. Failures here abort the run: silent data loss is worse. */
  save?: (project: ProjectFile) => Promise<void>
}

export interface RunSummary {
  project: ProjectFile
  translated: string[]
  failed: string[]
  blocked: string[]
  usage: CallUsage
  /** Set when the run stopped early because it was cancelled. */
  cancelled: boolean
}

/** Split pages into calls. Pure, so the estimate and the run agree on the call count. */
export function planBatches<T>(items: T[], batchSize: number): T[][] {
  const size = Math.max(1, Math.floor(batchSize))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export interface PlannedBatch {
  layout: PageLayout
  files: string[]
}

/**
 * Split files into calls, never mixing page layouts: each layout is sent with its own
 * system prompt, so a batch has to be homogeneous. Standard pages go first, then 4-koma;
 * reading order is kept within each group. Pure, like `planBatches`, so the estimate and
 * the run agree on the call count.
 */
export function planRun(project: ProjectFile, files: string[], batchSize: number): PlannedBatch[] {
  const layoutOf = new Map(project.pages.map((p) => [p.file, p.layout]))
  const out: PlannedBatch[] = []
  for (const layout of ['standard', '4koma'] as const) {
    const group = files.filter((file) => (layoutOf.get(file) ?? 'standard') === layout)
    for (const batch of planBatches(group, batchSize)) out.push({ layout, files: batch })
  }
  return out
}

/** Files the run would translate, in reading order. */
export function pendingFiles(project: ProjectFile): string[] {
  return translatablePages(project).filter(pageNeedsTranslation).map((p) => p.file)
}

export async function runTranslation(
  initial: ProjectFile,
  deps: RunDeps,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const emit = (event: RunEvent) => opts.onEvent?.(event)
  const editPolicy = opts.editPolicy ?? 'preserve'

  let project = initial
  const targets = opts.files ?? pendingFiles(project)
  const batches = planRun(project, targets, project.settings.batchSize)

  const summary: RunSummary = {
    project,
    translated: [],
    failed: [],
    blocked: [],
    usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    cancelled: false,
  }

  for (const [index, { layout, files: batch }] of batches.entries()) {
    if (opts.signal?.aborted) {
      summary.cancelled = true
      break
    }
    emit({ type: 'batch-start', files: batch, batch: index + 1, batches: batches.length })

    // Usage is accumulated per batch rather than per call, so repairs and splits -- which
    // are extra calls the user did not ask for -- still show up in the project total.
    const batchUsage: CallUsage = { calls: 0, promptTokens: 0, completionTokens: 0 }
    // The glossary grows as the run goes, so it is read fresh for every call rather
    // than captured once at the start.
    const outcome = await translateBatch(batch, layout, project, deps, opts, emit, batchUsage)

    addUsage(summary.usage, batchUsage)

    if (outcome.cancelled) {
      // Leave the batch's pages as they were: cancelling should not turn a page the
      // user might yet translate into a failure they have to clear.
      summary.cancelled = true
      break
    }

    project = applyOutcome(project, batch, layout, outcome, editPolicy, batchUsage, summary, emit)

    if (opts.save) {
      await opts.save(project)
      emit({ type: 'saved', project })
    }
  }

  summary.project = project
  return summary
}

interface BatchOutcome {
  pages: ModelPage[]
  glossary: { term: string; translation: string; note: string }[]
  runInfo: Omit<RunInfo, 'error'>
  /** Set when the whole call failed or was refused. */
  error: string | null
  blocked: boolean
  cancelled: boolean
}

const emptyOutcome = (): BatchOutcome => ({
  pages: [],
  glossary: [],
  runInfo: { model: '', finishReason: '', promptTokens: 0, completionTokens: 0, at: '' },
  error: null,
  blocked: false,
  cancelled: false,
})

/**
 * One call for a set of pages, plus the two recoveries that do not need the caller's help:
 * splitting a batch that turned out to be too big to send, and re-requesting pages the
 * model simply did not mention.
 */
async function translateBatch(
  files: string[],
  layout: PageLayout,
  project: ProjectFile,
  deps: RunDeps,
  opts: RunOptions,
  emit: (event: RunEvent) => void,
  usage: CallUsage,
  isRepair = false,
): Promise<BatchOutcome> {
  const call = deps.chat ?? defaultChat
  const template =
    layout === '4koma'
      ? (deps.fourKomaPromptTemplate ?? DEFAULT_4KOMA_PROMPT_TEMPLATE)
      : deps.promptTemplate
  const systemPrompt = renderPrompt(template, {
    meta: project.project,
    glossary: project.glossary,
    context: deps.context,
  })

  const prepare = deps.prepare ?? prepareImage
  const prepared: { file: string; dataUrl: string }[] = []
  for (const file of files) {
    const image = await prepare(await deps.loadImage(file), { maxEdge: deps.maxEdge })
    prepared.push({ file, dataUrl: image.dataUrl })
  }

  const body = buildRequestBody({
    endpoint: deps.endpoint,
    systemPrompt,
    pages: prepared,
    includeThoughts: deps.includeThoughts,
  })

  if (requestSizeBytes(body) > MAX_REQUEST_BYTES && files.length > 1) {
    emit({ type: 'repair', files, reason: 'oversize' })
    return splitAndTranslate(files, layout, project, deps, opts, emit, usage, isRepair)
  }

  let result: ChatResult
  try {
    result = await withRetry(() => call(deps.endpoint, body, opts.signal), {
      attempts: deps.attempts ?? 3,
      baseDelayMs: deps.baseDelayMs,
      rateLimitDelayMs: deps.rateLimitDelayMs,
      serverErrorDelayMs: deps.serverErrorDelayMs,
      signal: opts.signal,
      sleep: deps.sleep,
      onWait: ({ attempt, delayMs, error }) =>
        emit({ type: 'waiting', delayMs, attempt, message: error.message }),
    })
  } catch (err) {
    const outcome = emptyOutcome()
    if (err instanceof ApiError && err.kind === 'aborted') {
      outcome.cancelled = true
      return outcome
    }
    if (err instanceof ApiError && err.kind === 'too_large' && files.length > 1) {
      emit({ type: 'repair', files, reason: 'oversize' })
      return splitAndTranslate(files, layout, project, deps, opts, emit, usage, isRepair)
    }
    outcome.error = err instanceof Error ? err.message : String(err)
    return outcome
  }

  usage.calls++
  usage.promptTokens += result.promptTokens
  usage.completionTokens += result.completionTokens

  const parsed = parseResponse(result)
  const outcome: BatchOutcome = {
    pages: parsed.pages,
    glossary: parsed.glossary,
    runInfo: {
      model: result.model || deps.endpoint.model,
      finishReason: result.finishReason,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      at: new Date().toISOString(),
    },
    error: parsed.error,
    blocked: parsed.blocked,
    cancelled: false,
  }

  if (parsed.blocked) return outcome

  // Anything the model did not mention is still owed. Ask for exactly those pages
  // once more rather than re-sending -- and re-paying for -- the whole batch.
  const missing = files.filter((file) => !matchPage(parsed.pages, file, files))
  if (missing.length > 0 && !isRepair && !opts.signal?.aborted) {
    emit({ type: 'repair', files: missing, reason: 'missing' })
    const repair = await translateBatch(missing, layout, project, deps, opts, emit, usage, true)
    outcome.pages = outcome.pages.concat(repair.pages)
    outcome.glossary = outcome.glossary.concat(repair.glossary)
    outcome.cancelled = repair.cancelled
    // A repair that came back blocked does not make the pages that succeeded blocked.
    if (repair.blocked && outcome.pages.length === 0) outcome.blocked = true
    if (outcome.error === null) outcome.error = repair.error
  }

  return outcome
}

async function splitAndTranslate(
  files: string[],
  layout: PageLayout,
  project: ProjectFile,
  deps: RunDeps,
  opts: RunOptions,
  emit: (event: RunEvent) => void,
  usage: CallUsage,
  isRepair: boolean,
): Promise<BatchOutcome> {
  const mid = Math.ceil(files.length / 2)
  const left = await translateBatch(files.slice(0, mid), layout, project, deps, opts, emit, usage, isRepair)
  if (left.cancelled) return left
  const right = await translateBatch(files.slice(mid), layout, project, deps, opts, emit, usage, isRepair)
  return {
    pages: left.pages.concat(right.pages),
    glossary: left.glossary.concat(right.glossary),
    runInfo: left.runInfo.at !== '' ? left.runInfo : right.runInfo,
    error: left.error ?? right.error,
    blocked: left.blocked && right.blocked,
    cancelled: right.cancelled,
  }
}

/**
 * Match a response entry to the page we asked about.
 *
 * The file name is authoritative; the `[page N]` position is the fallback for models
 * that echo the marker index but paraphrase or drop the file name.
 */
export function matchPage(pages: ModelPage[], file: string, batch: string[]): ModelPage | null {
  const byFile = pages.find((p) => p.file === file)
  if (byFile) return byFile
  const position = batch.indexOf(file) + 1
  const byPosition = pages.find((p) => p.page === position && p.file === '')
  return byPosition ?? null
}

function addUsage(target: CallUsage, delta: CallUsage): void {
  target.calls += delta.calls
  target.promptTokens += delta.promptTokens
  target.completionTokens += delta.completionTokens
}

function applyOutcome(
  project: ProjectFile,
  batch: string[],
  layout: PageLayout,
  outcome: BatchOutcome,
  editPolicy: EditPolicy,
  batchUsage: CallUsage,
  summary: RunSummary,
  emit: (event: RunEvent) => void,
): ProjectFile {
  const translated: string[] = []
  const failed: string[] = []
  const blocked: string[] = []

  const pages = project.pages.map((page): Page => {
    if (!batch.includes(page.file)) return page
    const model = matchPage(outcome.pages, page.file, batch)

    if (!model) {
      const reason = outcome.blocked
        ? outcome.error ?? 'refused by the provider'
        : outcome.error ?? 'the model did not return this page'
      ;(outcome.blocked ? blocked : failed).push(page.file)
      return {
        ...page,
        status: outcome.blocked ? 'blocked' : 'failed',
        lastRun: { ...outcome.runInfo, error: reason },
      }
    }

    translated.push(page.file)
    const merged = mergeLines(page.lines, model.lines, editPolicy)
    return {
      ...page,
      status: 'translated',
      // What the batch was sent as, not what the page says now: the user may have flipped
      // it while the call was in flight, and then it is stale and should read as such.
      translatedLayout: layout,
      lines: merged.lines,
      lastRun: { ...outcome.runInfo, error: null },
    }
  })

  if (blocked.length > 0) {
    emit({ type: 'blocked', files: blocked, message: outcome.error ?? 'refused by the provider' })
  }
  if (failed.length > 0) {
    emit({
      type: 'failed',
      files: failed,
      message: outcome.error ?? 'the model did not return this page',
    })
  }
  emit({ type: 'batch-done', files: batch, translated, usage: batchUsage })

  summary.translated.push(...translated)
  summary.failed.push(...failed)
  summary.blocked.push(...blocked)

  const glossary: GlossaryEntry[] = mergeGlossary(project.glossary, outcome.glossary).glossary

  return {
    ...project,
    pages,
    glossary,
    usage: {
      calls: project.usage.calls + batchUsage.calls,
      promptTokens: project.usage.promptTokens + batchUsage.promptTokens,
      completionTokens: project.usage.completionTokens + batchUsage.completionTokens,
    },
  }
}
