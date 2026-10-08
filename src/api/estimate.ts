/**
 * "What is this going to cost me?" answered before the first call goes out.
 *
 * The numbers are estimates and are labelled as such in the UI. What matters is that the
 * call count is exact -- that is the one that runs into Google's free-tier daily cap and
 * turns a 200-page project into a three-day project.
 */

import { fitWithin, imageTokens, type Dimensions } from '../fs/images'

/**
 * Guesses, calibrated on the sample pages in test-img/. A dense page runs to twenty-odd
 * lines and a splash page to none; the average is what makes an estimate useful.
 */
const DEFAULT_LINES_PER_PAGE = 12
/** One line of response JSON: keys, the source text, and the translation. */
const TOKENS_PER_LINE = 60
/** Rough characters-per-token for the mostly-ASCII system prompt. */
const PROMPT_CHARS_PER_TOKEN = 4
/** `[page N] filename` markers and JSON scaffolding around the page array. */
const OVERHEAD_TOKENS_PER_CALL = 80

export interface EstimateInput {
  /** Total pages that will be sent. */
  pageCount: number
  /** Natural dimensions of however many pages have been measured. May be a subset. */
  sampled: Dimensions[]
  maxEdge: number
  batchSize: number
  systemPrompt: string
  linesPerPage?: number
}

export interface Estimate {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Average encoded image tokens per page, after downscaling. */
  imageTokensPerPage: number
  /** True when no page was measured and a default page size was assumed. */
  assumedPageSize: boolean
}

/** Fallback page geometry when nothing has been measured yet: a typical scan. */
const TYPICAL_PAGE: Dimensions = { width: 846, height: 1200 }

export function estimateRun(input: EstimateInput): Estimate {
  const { pageCount, sampled, maxEdge, systemPrompt } = input
  const batchSize = Math.max(1, input.batchSize)
  const linesPerPage = input.linesPerPage ?? DEFAULT_LINES_PER_PAGE

  if (pageCount <= 0) {
    return {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      imageTokensPerPage: 0,
      assumedPageSize: sampled.length === 0,
    }
  }

  const measured = sampled.length > 0 ? sampled : [TYPICAL_PAGE]
  const perPage =
    measured.reduce((sum, size) => sum + imageTokens(fitWithin(size, maxEdge)), 0) / measured.length

  const calls = Math.ceil(pageCount / batchSize)
  const systemTokens = Math.ceil(systemPrompt.length / PROMPT_CHARS_PER_TOKEN)
  const promptTokens = Math.round(
    calls * (systemTokens + OVERHEAD_TOKENS_PER_CALL) + pageCount * perPage,
  )
  const completionTokens = pageCount * linesPerPage * TOKENS_PER_LINE

  return {
    calls,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    imageTokensPerPage: Math.round(perPage),
    assumedPageSize: sampled.length === 0,
  }
}

/**
 * Add up estimates made separately, e.g. one per page layout since each layout has its own
 * system prompt. Page size is "assumed" only if every part assumed it.
 */
export function sumEstimates(parts: Estimate[]): Estimate {
  const withPages = parts.filter((p) => p.calls > 0)
  const total = parts.reduce(
    (sum, p) => ({
      calls: sum.calls + p.calls,
      promptTokens: sum.promptTokens + p.promptTokens,
      completionTokens: sum.completionTokens + p.completionTokens,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0 },
  )
  return {
    ...total,
    totalTokens: total.promptTokens + total.completionTokens,
    imageTokensPerPage: withPages[0]?.imageTokensPerPage ?? 0,
    assumedPageSize: parts.every((p) => p.assumedPageSize),
  }
}

/**
 * Free-tier request caps, for the "this will take N days" warning.
 * Source: Google AI Studio's published free-tier limits, which do change.
 */
export const FREE_TIER_DAILY_REQUESTS: Record<string, number> = {
  'gemini-flash-lite-latest': 500,
  'gemini-flash-latest': 20,
}

export function dailyCapFor(model: string): number | null {
  for (const [prefix, cap] of Object.entries(FREE_TIER_DAILY_REQUESTS)) {
    if (model.startsWith(prefix.replace('-latest', ''))) return cap
  }
  return null
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}
