import { describe, expect, it } from 'vitest'
import { pendingFiles, planBatches, runTranslation, type RunDeps, type RunEvent } from '../api/batcher'
import { ApiError, type ChatResult } from '../api/client'
import { newProjectFile, type ProjectFile } from '../state/schema'
import type { Endpoint } from '../state/settings'
import { DEFAULT_PROMPT_TEMPLATE } from '../api/prompt'

const endpoint: Endpoint = {
  id: 'test',
  name: 'test',
  baseUrl: 'http://localhost/v1',
  apiKey: 'k',
  model: 'test-model',
  kind: 'openai',
  structuredOutput: false,
}

const FILES = ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg', 'p5.jpg']

function project(over: { batchSize?: number; files?: string[] } = {}): ProjectFile {
  const p = newProjectFile(
    'test',
    (over.files ?? FILES).map((file) => ({ file, hash: 'h-' + file })),
  )
  p.settings.batchSize = over.batchSize ?? 2
  return p
}

/** Pull the `[page N] file` markers back out of a request body. */
function requestedFiles(body: Record<string, unknown>): string[] {
  const messages = body['messages'] as { role: string; content: unknown }[]
  const user = messages.find((m) => m.role === 'user')
  const parts = user?.content as { type: string; text?: string }[]
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => /^\[page \d+\] (.+)$/.exec(p.text ?? '')?.[1] ?? '')
    .filter((f) => f !== '')
}

function reply(files: string[], glossary: { term: string; translation: string; note: string }[] = []): ChatResult {
  return {
    content: JSON.stringify({
      pages: files.map((file, i) => ({
        page: i + 1,
        file,
        lines: [
          { id: 1, kind: 'dialogue', original: 'あ', translation: 'Ah (' + file + ')' },
        ],
      })),
      glossary,
    }),
    finishReason: 'stop',
    model: 'test-model',
    promptTokens: 100,
    completionTokens: 20,
    reasoning: null,
  }
}

interface Harness {
  deps: RunDeps
  calls: string[][]
  events: RunEvent[]
  saves: ProjectFile[]
}

/** `respond` sees the files a call asked for and returns a result or throws an ApiError. */
function harness(respond: (files: string[], callIndex: number) => ChatResult | Promise<ChatResult>): Harness {
  const calls: string[][] = []
  const deps: RunDeps = {
    endpoint,
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    includeThoughts: false,
    maxEdge: 1600,
    loadImage: async () => new Blob(['x']),
    prepare: async () => ({
      dataUrl: 'data:image/jpeg;base64,AAAA',
      encodedBytes: 26,
      width: 800,
      height: 1200,
      resampled: true,
    }),
    chat: async (_endpoint, body) => {
      const files = requestedFiles(body)
      calls.push(files)
      return respond(files, calls.length - 1)
    },
    // No real waiting; the retry path is exercised, the clock is not.
    sleep: async () => undefined,
    baseDelayMs: 1,
  }
  return { deps, calls, events: [], saves: [] }
}

function run(p: ProjectFile, h: Harness, over: Parameters<typeof runTranslation>[2] = {}) {
  return runTranslation(p, h.deps, {
    onEvent: (e) => h.events.push(e),
    save: async (proj) => {
      h.saves.push(proj)
    },
    ...over,
  })
}

describe('planBatches', () => {
  it('splits into calls of at most batchSize', () => {
    expect(planBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('never produces an empty or infinite batch', () => {
    expect(planBatches([1, 2], 0)).toEqual([[1], [2]])
    expect(planBatches([], 4)).toEqual([])
  })
})

describe('runTranslation', () => {
  it('translates every page and saves after each batch', async () => {
    const h = harness((files) => reply(files))
    const summary = await run(project(), h)

    expect(h.calls).toEqual([['p1.jpg', 'p2.jpg'], ['p3.jpg', 'p4.jpg'], ['p5.jpg']])
    expect(summary.translated).toEqual(FILES)
    expect(summary.failed).toEqual([])
    expect(summary.project.pages.every((p) => p.status === 'translated')).toBe(true)
    expect(summary.project.pages[0]!.lines[0]!.translation).toBe('Ah (p1.jpg)')
    expect(h.saves).toHaveLength(3)
    expect(summary.usage).toEqual({ calls: 3, promptTokens: 300, completionTokens: 60 })
  })

  it('re-requests only the pages the model skipped', async () => {
    const h = harness((files, i) => (i === 0 ? reply(files.slice(0, 1)) : reply(files)))
    const summary = await run(project({ files: ['p1.jpg', 'p2.jpg'] }), h)

    expect(h.calls).toEqual([['p1.jpg', 'p2.jpg'], ['p2.jpg']])
    expect(summary.translated.sort()).toEqual(['p1.jpg', 'p2.jpg'])
    expect(h.events.some((e) => e.type === 'repair' && e.reason === 'missing')).toBe(true)
    // The repair call is a real call and shows up in the bill.
    expect(summary.usage.calls).toBe(2)
  })

  it('marks a page failed when even the repair pass does not return it', async () => {
    const h = harness((files, i) => (i === 0 ? reply(files.slice(0, 1)) : reply([])))
    const summary = await run(project({ files: ['p1.jpg', 'p2.jpg'] }), h)

    expect(summary.translated).toEqual(['p1.jpg'])
    expect(summary.failed).toEqual(['p2.jpg'])
    const failed = summary.project.pages.find((p) => p.file === 'p2.jpg')!
    expect(failed.status).toBe('failed')
    expect(failed.lastRun?.error).toBeTruthy()
    // Never silently empty: a page with no lines must carry a reason.
    expect(failed.lines).toEqual([])
  })

  it('marks a refused batch blocked and keeps going', async () => {
    const h = harness((files, i) => {
      if (i === 0) {
        return {
          content: '',
          finishReason: 'content_filter',
          model: 'test-model',
          promptTokens: 100,
          completionTokens: 0,
          reasoning: null,
        }
      }
      return reply(files)
    })
    const summary = await run(project({ files: ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg'] }), h)

    expect(summary.blocked).toEqual(['p1.jpg', 'p2.jpg'])
    expect(summary.translated).toEqual(['p3.jpg', 'p4.jpg'])
    expect(summary.project.pages[0]!.status).toBe('blocked')
    expect(h.events.some((e) => e.type === 'blocked')).toBe(true)
    // A block is not a gap, so no repair call was wasted on it.
    expect(h.calls).toEqual([['p1.jpg', 'p2.jpg'], ['p3.jpg', 'p4.jpg']])
  })

  it('waits out a rate limit and then succeeds', async () => {
    let hit = false
    const h = harness((files) => {
      if (!hit) {
        hit = true
        throw new ApiError('slow down', 'rate_limit', 429, 5000)
      }
      return reply(files)
    })
    const summary = await run(project({ files: ['p1.jpg'] }), h)

    const waited = h.events.find((e) => e.type === 'waiting')
    expect(waited).toMatchObject({ delayMs: 5000, attempt: 1 })
    expect(summary.translated).toEqual(['p1.jpg'])
  })

  it('gives up on a persistently failing batch without abandoning the rest', async () => {
    const h = harness((files) => {
      if (files.includes('p1.jpg')) throw new ApiError('boom', 'server', 503)
      return reply(files)
    })
    const summary = await run(project({ files: ['p1.jpg', 'p2.jpg'] }), h)

    // Three attempts on the failing batch, then the run moves on.
    expect(h.calls).toHaveLength(3)
    expect(summary.failed).toEqual(['p1.jpg', 'p2.jpg'])
    expect(summary.project.pages[0]!.lastRun?.error).toBe('boom')
  })

  it('does not retry an auth error', async () => {
    const h = harness(() => {
      throw new ApiError('bad key', 'auth', 401)
    })
    const summary = await run(project({ files: ['p1.jpg'] }), h)
    expect(h.calls).toHaveLength(1)
    expect(summary.failed).toEqual(['p1.jpg'])
  })

  it('stops on cancel and leaves untouched pages pending', async () => {
    const controller = new AbortController()
    const h = harness((files, i) => {
      if (i === 0) controller.abort()
      return reply(files)
    })
    const summary = await run(project({ batchSize: 2 }), h, { signal: controller.signal })

    expect(summary.cancelled).toBe(true)
    // The first batch completed before the abort was noticed, and was saved.
    expect(summary.translated).toEqual(['p1.jpg', 'p2.jpg'])
    expect(h.saves).toHaveLength(1)
    expect(summary.project.pages.slice(2).every((p) => p.status === 'pending')).toBe(true)
  })

  it('accumulates the glossary and feeds it into later calls', async () => {
    const prompts: string[] = []
    const h = harness((files, i) => {
      return i === 0
        ? reply(files, [{ term: 'リナ', translation: 'Rina', note: 'lead' }])
        : reply(files)
    })
    const chat = h.deps.chat!
    h.deps.chat = async (endpointArg, body, signal) => {
      const messages = body['messages'] as { role: string; content: unknown }[]
      prompts.push(String(messages[0]!.content))
      return chat(endpointArg, body, signal)
    }

    const summary = await run(project({ files: ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg'] }), h)

    expect(summary.project.glossary).toEqual([
      { term: 'リナ', translation: 'Rina', note: 'lead', locked: false },
    ])
    expect(prompts[0]).not.toContain('Rina')
    expect(prompts[1]).toContain('リナ → Rina')
  })

  it('preserves hand edits when retranslating a page', async () => {
    const h = harness((files) => reply(files))
    const first = await run(project({ files: ['p1.jpg'] }), h)

    const edited: ProjectFile = {
      ...first.project,
      pages: first.project.pages.map((p) => ({
        ...p,
        lines: p.lines.map((l) => ({ ...l, translation: 'My wording', edited: true })),
      })),
    }

    const second = await run(edited, h, { files: ['p1.jpg'] })
    expect(second.project.pages[0]!.lines[0]!.translation).toBe('My wording')

    const overwritten = await run(edited, h, { files: ['p1.jpg'], editPolicy: 'overwrite' })
    expect(overwritten.project.pages[0]!.lines[0]!.translation).toBe('Ah (p1.jpg)')
    expect(overwritten.project.pages[0]!.lines[0]!.previousTranslation).toBe('My wording')
  })

  it('skips pages that are already translated', async () => {
    const h = harness((files) => reply(files))
    const first = await run(project({ files: ['p1.jpg', 'p2.jpg'] }), h)
    expect(pendingFiles(first.project)).toEqual([])

    h.calls.length = 0
    await run(first.project, h)
    expect(h.calls).toEqual([])
  })

  it('retranslates stale and failed pages on a second run', async () => {
    const h = harness((files) => reply(files))
    const first = await run(project({ files: ['p1.jpg', 'p2.jpg'] }), h)
    const marked: ProjectFile = {
      ...first.project,
      pages: first.project.pages.map((p, i) => (i === 0 ? { ...p, status: 'stale' as const } : p)),
    }
    expect(pendingFiles(marked)).toEqual(['p1.jpg'])
  })

  it('leaves excluded pages out of the run', async () => {
    const p = project({ files: ['p1.jpg', 'p2.jpg'] })
    p.pages[0]!.excluded = true
    const h = harness((files) => reply(files))
    await run(p, h)
    expect(h.calls).toEqual([['p2.jpg']])
  })
})
