/**
 * The HTTP layer: one call, one classified outcome.
 *
 * Retry policy deliberately lives in `withRetry` rather than inside `chat`, so the
 * batcher can decide -- and so the UI can be told how long it is waiting and why,
 * instead of appearing frozen through a two-minute rate-limit backoff.
 */

import type { Endpoint } from '../state/settings'

export type ApiErrorKind =
  | 'auth' // bad or missing key; retrying will not help
  | 'request' // we sent something the server rejected
  | 'too_large' // payload over the provider's size cap
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'aborted'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network'
  }
}

export interface ChatResult {
  content: string
  finishReason: string
  model: string
  promptTokens: number
  completionTokens: number
  /** Present only when the provider was asked for, and returned, a reasoning trace. */
  reasoning: string | null
}

export async function chat(
  endpoint: Endpoint,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const isGemini = endpoint.kind === 'gemini'
  const url = isGemini ? geminiUrl(endpoint) : endpoint.baseUrl.replace(/\/+$/, '') + '/chat/completions'

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.apiKey
          ? isGemini
            ? { 'x-goog-api-key': endpoint.apiKey }
            : { Authorization: 'Bearer ' + endpoint.apiKey }
          : {}),
      },
      body: JSON.stringify(body),
      signal: signal ?? null,
    })
  } catch (err) {
    if (signal?.aborted) throw new ApiError('request cancelled', 'aborted')
    throw new ApiError(
      'could not reach ' + url + ': ' + describe(err),
      'network',
    )
  }

  if (!response.ok) throw await errorFromResponse(response, url)

  const json = (await response.json().catch(() => null)) as unknown
  return isGemini ? readGeminiResult(json) : readChatResult(json)
}

/**
 * Native endpoint, not Google AI Studio's OpenAI-compatibility shim -- the shim drops
 * `safety_settings`, so a request built for it never actually reaches Gemini with its
 * filters off. A trailing `/openai` is stripped so a `baseUrl` saved before this change
 * keeps working without a manual settings edit.
 */
function geminiUrl(endpoint: Endpoint): string {
  const base = endpoint.baseUrl.replace(/\/+$/, '').replace(/\/openai$/i, '')
  return base + '/models/' + encodeURIComponent(endpoint.model) + ':generateContent'
}

async function errorFromResponse(response: Response, url: string): Promise<ApiError> {
  const text = await response.text().catch(() => '')
  const message = extractErrorMessage(text) ?? response.statusText ?? 'request failed'
  const status = response.status

  if (status === 401 || status === 403) {
    return new ApiError('authentication failed for ' + url + ': ' + message, 'auth', status)
  }
  if (status === 413) {
    return new ApiError('request too large: ' + message, 'too_large', status)
  }
  if (status === 429) {
    return new ApiError(message, 'rate_limit', status, retryAfterMs(response))
  }
  if (status >= 500) {
    return new ApiError(message, 'server', status, retryAfterMs(response))
  }
  return new ApiError(message, 'request', status)
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('Retry-After')
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

function extractErrorMessage(text: string): string | null {
  if (text.trim() === '') return null
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown }
    const message = Array.isArray(json) ? json[0].error?.message : json.error?.message ?? json.message
    if (typeof message === 'string' && message.trim() !== '') return message
  } catch {
    // Not JSON; the raw body is still the most informative thing available.
  }
  return text.slice(0, 300)
}

function readChatResult(json: unknown): ChatResult {
  if (typeof json !== 'object' || json === null) {
    throw new ApiError('provider returned a body that was not JSON', 'server')
  }
  const o = json as Record<string, unknown>
  const choices = Array.isArray(o['choices']) ? o['choices'] : []
  const choice = (choices[0] ?? {}) as Record<string, unknown>
  const message = (choice['message'] ?? {}) as Record<string, unknown>
  const usage = (o['usage'] ?? {}) as Record<string, unknown>

  if (choices.length === 0) {
    // Gemini drops `choices` entirely on a prompt-level block, so this is a refusal,
    // not a malformed response. Reported as an empty content_filter result and
    // classified downstream by the parser, which owns the blocked/empty distinction.
    return {
      content: '',
      finishReason: 'content_filter',
      model: str(o['model']),
      promptTokens: num(usage['prompt_tokens']),
      completionTokens: num(usage['completion_tokens']),
      reasoning: null,
    }
  }

  const reasoning = message['reasoning_content']
  return {
    content: typeof message['content'] === 'string' ? message['content'] : '',
    finishReason: str(choice['finish_reason']),
    model: str(o['model']),
    promptTokens: num(usage['prompt_tokens']),
    completionTokens: num(usage['completion_tokens']),
    reasoning: typeof reasoning === 'string' && reasoning !== '' ? reasoning : null,
  }
}

function readGeminiResult(json: unknown): ChatResult {
  if (typeof json !== 'object' || json === null) {
    throw new ApiError('provider returned a body that was not JSON', 'server')
  }
  const o = json as Record<string, unknown>
  const candidates = Array.isArray(o['candidates']) ? o['candidates'] : []
  const usage = (o['usageMetadata'] ?? {}) as Record<string, unknown>
  const model = str(o['modelVersion'])
  const promptTokens = num(usage['promptTokenCount'])
  const completionTokens = num(usage['candidatesTokenCount'])

  if (candidates.length === 0) {
    // A prompt-level block drops `candidates` entirely (reported in `promptFeedback`
    // instead), mirroring the OpenAI-compat empty-`choices` case above.
    return { content: '', finishReason: 'content_filter', model, promptTokens, completionTokens, reasoning: null }
  }

  const candidate = candidates[0] as Record<string, unknown>
  const candidateContent = (candidate['content'] ?? {}) as Record<string, unknown>
  const parts = Array.isArray(candidateContent['parts']) ? candidateContent['parts'] : []

  let content = ''
  let reasoning = ''
  for (const raw of parts) {
    if (typeof raw !== 'object' || raw === null) continue
    const part = raw as Record<string, unknown>
    const text = typeof part['text'] === 'string' ? part['text'] : ''
    if (part['thought'] === true) reasoning += text
    else content += text
  }

  return {
    content,
    // Gemini's `SAFETY`/`BLOCKLIST`/`PROHIBITED_CONTENT` lowercase to exactly the
    // strings `parseResponse` already treats as blocked.
    finishReason: str(candidate['finishReason']).toLowerCase(),
    model,
    promptTokens,
    completionTokens,
    reasoning: reasoning !== '' ? reasoning : null,
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * How long to wait after a 429 that came with no usable `Retry-After`.
 *
 * `Retry-After` is not a CORS-safelisted response header, so unless the provider sends
 * `Access-Control-Expose-Headers` the browser hides it and this fallback is what
 * actually runs. A per-minute quota does not clear in a second, and retrying into it
 * three times in four seconds just burns the attempt budget and fails the page --
 * so rate limits get their own, much more patient curve.
 */
const RATE_LIMIT_BASE_DELAY_MS = 20_000

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number
  /** Base delay for exponential backoff, in ms. */
  baseDelayMs?: number
  /** Base delay for rate limits with no `Retry-After`. */
  rateLimitDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
  /** Called before each wait, so the UI can show what it is waiting for. */
  onWait?: (info: { attempt: number; delayMs: number; error: ApiError }) => void
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3
  const base = opts.baseDelayMs ?? 1000
  const max = opts.maxDelayMs ?? 60_000
  const nap = opts.sleep ?? sleep

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new ApiError('cancelled', 'aborted')
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const apiError = err instanceof ApiError ? err : null
      if (!apiError || !apiError.retryable || attempt === attempts) throw err

      // A server that says when to come back knows better than our backoff curve does.
      const floor =
        apiError.kind === 'rate_limit' ? (opts.rateLimitDelayMs ?? RATE_LIMIT_BASE_DELAY_MS) : base
      const backoff = Math.min(max, floor * 2 ** (attempt - 1))
      const delayMs = Math.min(max, apiError.retryAfterMs ?? backoff)
      opts.onWait?.({ attempt, delayMs, error: apiError })
      await nap(delayMs, opts.signal)
    }
  }
  throw lastError
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError('cancelled', 'aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new ApiError('cancelled', 'aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
