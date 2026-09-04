import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, chat, withRetry } from '../api/client'
import type { Endpoint } from '../state/settings'

/** Collects the delays `withRetry` asks for, without ever really waiting. */
function recorder() {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms)
    },
  }
}

const fail = (error: ApiError, succeedOnAttempt = Infinity) => {
  let attempt = 0
  return async () => {
    attempt++
    if (attempt < succeedOnAttempt) throw error
    return 'ok'
  }
}

describe('withRetry', () => {
  it('obeys Retry-After over its own backoff', async () => {
    const r = recorder()
    const result = await withRetry(
      fail(new ApiError('slow down', 'rate_limit', 429, 42_000), 2),
      { sleep: r.sleep },
    )
    expect(result).toBe('ok')
    expect(r.delays).toEqual([42_000])
  })

  it('waits patiently on a rate limit that gave no Retry-After', async () => {
    // The header is invisible cross-origin unless the provider exposes it, so this
    // fallback is the common case, not the rare one. Four seconds of retries would
    // just fail the page against a per-minute quota.
    const r = recorder()
    await withRetry(fail(new ApiError('quota', 'rate_limit', 429, null), 3), {
      sleep: r.sleep,
    }).catch(() => undefined)
    expect(r.delays).toEqual([20_000, 40_000])
  })

  it('waits patiently on a server error, not the fast network-blip curve', async () => {
    // A "high demand" / overloaded-model response does not clear in a second --
    // retrying on the ~1s curve used for a one-off network blip just re-hits the
    // same overloaded model in quick succession.
    const r = recorder()
    await withRetry(fail(new ApiError('boom', 'server', 503, null), 3), {
      sleep: r.sleep,
      baseDelayMs: 1000,
    })
    expect(r.delays).toEqual([5000, 10_000])
  })

  it('honors an explicit serverErrorDelayMs override', async () => {
    const r = recorder()
    await withRetry(fail(new ApiError('boom', 'server', 503, null), 2), {
      sleep: r.sleep,
      serverErrorDelayMs: 500,
    })
    expect(r.delays).toEqual([500])
  })

  it('never waits longer than maxDelayMs', async () => {
    const r = recorder()
    await withRetry(fail(new ApiError('slow', 'rate_limit', 429, 999_999), 2), {
      sleep: r.sleep,
      maxDelayMs: 60_000,
    })
    expect(r.delays).toEqual([60_000])
  })

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const r = recorder()
    await expect(
      withRetry(fail(new ApiError('boom', 'server', 503)), { attempts: 3, sleep: r.sleep }),
    ).rejects.toThrow('boom')
    expect(r.delays).toHaveLength(2)
  })

  it('does not retry errors that retrying cannot fix', async () => {
    const r = recorder()
    await expect(
      withRetry(fail(new ApiError('bad key', 'auth', 401)), { sleep: r.sleep }),
    ).rejects.toThrow('bad key')
    expect(r.delays).toEqual([])
  })

  it('stops immediately when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(withRetry(async () => 'ok', { signal: controller.signal })).rejects.toThrow(
      'cancelled',
    )
  })
})

const geminiEndpoint: Endpoint = {
  id: 'g',
  name: 'g',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: 'test-key',
  model: 'gemini-x',
  kind: 'gemini',
  structuredOutput: false,
}

function stubFetch(response: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('chat (gemini)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('calls the native generateContent endpoint with the api key as a header', async () => {
    const fetchMock = stubFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
      modelVersion: 'gemini-x-001',
    })

    const result = await chat(geminiEndpoint, { contents: [] })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key')
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(result).toEqual({
      content: 'hi',
      finishReason: 'stop',
      model: 'gemini-x-001',
      promptTokens: 3,
      completionTokens: 1,
      reasoning: null,
    })
  })

  it('strips a trailing /openai from a baseUrl saved before the native switch', async () => {
    const fetchMock = stubFetch({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] })
    await chat({ ...geminiEndpoint, baseUrl: geminiEndpoint.baseUrl + '/openai/' }, {})
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent')
  })

  it('treats an empty candidates array as a prompt-level block', async () => {
    stubFetch({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 5 } })
    const result = await chat(geminiEndpoint, {})
    expect(result.content).toBe('')
    expect(result.finishReason).toBe('content_filter')
    expect(result.promptTokens).toBe(5)
  })

  it('separates thought parts into reasoning and lowercases the finish reason', async () => {
    stubFetch({
      candidates: [
        {
          content: {
            parts: [
              { text: 'thinking...', thought: true },
              { text: 'the answer' },
            ],
          },
          finishReason: 'SAFETY',
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    })
    const result = await chat(geminiEndpoint, {})
    expect(result.content).toBe('the answer')
    expect(result.reasoning).toBe('thinking...')
    expect(result.finishReason).toBe('safety')
  })
})

describe('ApiError', () => {
  it('classifies which failures are worth retrying', () => {
    expect(new ApiError('', 'rate_limit').retryable).toBe(true)
    expect(new ApiError('', 'server').retryable).toBe(true)
    expect(new ApiError('', 'network').retryable).toBe(true)
    expect(new ApiError('', 'auth').retryable).toBe(false)
    expect(new ApiError('', 'request').retryable).toBe(false)
    expect(new ApiError('', 'too_large').retryable).toBe(false)
    expect(new ApiError('', 'aborted').retryable).toBe(false)
  })
})
