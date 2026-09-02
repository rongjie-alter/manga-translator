import { describe, expect, it } from 'vitest'
import { ApiError, withRetry } from '../api/client'

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

  it('backs off quickly on an ordinary server error', async () => {
    const r = recorder()
    await withRetry(fail(new ApiError('boom', 'server', 503, null), 3), {
      sleep: r.sleep,
      baseDelayMs: 1000,
    })
    expect(r.delays).toEqual([1000, 2000])
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
