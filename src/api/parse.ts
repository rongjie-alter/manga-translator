/**
 * Turning whatever the model actually returned into pages.
 *
 * The happy path is `JSON.parse`. The interesting path is truncation: a response cut off
 * mid-array is not valid JSON, but the pages that closed before the cut are perfectly
 * good translations, and re-requesting them would burn quota for nothing. So a failed
 * parse falls back to scanning out the complete objects and keeping those.
 */

import { LINE_KINDS, type LineKind } from '../state/schema'
import type { ModelGlossaryEntry, ModelLine, ModelPage } from './contract'

export interface ParsedResponse {
  pages: ModelPage[]
  glossary: ModelGlossaryEntry[]
  /** The response did not parse as a whole and pages were recovered piecemeal. */
  recovered: boolean
  /** The provider refused to answer. Distinct from "answered with nothing useful". */
  blocked: boolean
  /** Set when nothing at all could be salvaged. */
  error: string | null
}

const BLOCKED_FINISH_REASONS = new Set(['content_filter', 'safety', 'blocklist', 'prohibited_content'])

export interface ParseInput {
  content: string
  finishReason: string
}

export function parseResponse({ content, finishReason }: ParseInput): ParsedResponse {
  const empty: ParsedResponse = {
    pages: [],
    glossary: [],
    recovered: false,
    blocked: false,
    error: null,
  }

  if (BLOCKED_FINISH_REASONS.has(finishReason)) {
    return { ...empty, blocked: true, error: 'refused by the provider (' + finishReason + ')' }
  }

  const text = stripCodeFence(content).trim()
  if (text === '') {
    // Gemini reports some safety refusals as an ordinary stop with no content, so an
    // empty body is treated as a block rather than as an empty-but-valid page set.
    return { ...empty, blocked: true, error: 'the provider returned an empty response' }
  }

  try {
    const whole = JSON.parse(text) as unknown
    return {
      pages: coercePages(readArray(whole, 'pages')),
      glossary: coerceGlossary(readArray(whole, 'glossary')),
      recovered: false,
      blocked: false,
      error: null,
    }
  } catch {
    // fall through to salvage
  }

  const pages = coercePages(extractCompleteObjects(text, 'pages'))
  const glossary = coerceGlossary(extractCompleteObjects(text, 'glossary'))
  if (pages.length === 0) {
    return { ...empty, error: 'response was not valid JSON and no complete page survived' }
  }
  return { pages, glossary, recovered: true, blocked: false, error: null }
}

/** Models like to wrap JSON in ```json fences even when told not to. */
export function stripCodeFence(text: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)(?:\n\s*```\s*)?$/.exec(text)
  return match ? match[1]! : text
}

/**
 * Pull every complete `{...}` out of the array at `key`, ignoring an incomplete tail.
 *
 * Hand-written rather than a JSON streaming library because it has exactly one job:
 * find the array, then walk it tracking string/escape state so that braces inside
 * dialogue text do not confuse the depth count.
 */
export function extractCompleteObjects(text: string, key: string): unknown[] {
  const start = findArrayStart(text, key)
  if (start < 0) return []

  const out: unknown[] = []
  let depth = 0
  let objectStart = -1
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (depth === 0) objectStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && objectStart >= 0) {
        try {
          out.push(JSON.parse(text.slice(objectStart, i + 1)))
        } catch {
          // A complete-looking object that will not parse is not worth guessing at.
        }
        objectStart = -1
      }
    } else if (ch === ']' && depth === 0) {
      break
    }
  }
  return out
}

/** Index just past the `[` of `"key": [`, or -1. */
function findArrayStart(text: string, key: string): number {
  const needle = '"' + key + '"'
  const at = text.indexOf(needle)
  if (at < 0) return -1
  const bracket = text.indexOf('[', at + needle.length)
  if (bracket < 0) return -1
  // Guard against `"pages"` appearing inside dialogue before the real key: if a `{`
  // shows up before the `[`, this was not the array header we wanted.
  const between = text.slice(at + needle.length, bracket)
  if (/[{}\]]/.test(between)) return -1
  return bracket + 1
}

function readArray(whole: unknown, key: string): unknown[] {
  if (typeof whole !== 'object' || whole === null) return []
  const value = (whole as Record<string, unknown>)[key]
  return Array.isArray(value) ? value : []
}

function coercePages(raw: unknown[]): ModelPage[] {
  const out: ModelPage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const file = typeof o['file'] === 'string' ? o['file'] : ''
    const page = typeof o['page'] === 'number' ? Math.round(o['page']) : 0
    if (file === '' && page === 0) continue
    if (!Array.isArray(o['lines'])) continue
    out.push({ page, file, lines: coerceLines(o['lines']) })
  }
  return out
}

function coerceLines(raw: unknown[]): ModelLine[] {
  const out: ModelLine[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const translation = typeof o['translation'] === 'string' ? o['translation'] : ''
    const original = typeof o['original'] === 'string' ? o['original'] : ''
    if (translation === '' && original === '') continue
    const kind = o['kind']
    out.push({
      id: typeof o['id'] === 'number' ? Math.round(o['id']) : out.length + 1,
      kind:
        typeof kind === 'string' && (LINE_KINDS as readonly string[]).includes(kind)
          ? (kind as LineKind)
          : 'dialogue',
      speaker: typeof o['speaker'] === 'string' ? o['speaker'] : '',
      original,
      translation,
    })
  }
  return out
}

function coerceGlossary(raw: unknown[]): ModelGlossaryEntry[] {
  const out: ModelGlossaryEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const term = typeof o['term'] === 'string' ? o['term'].trim() : ''
    const translation = typeof o['translation'] === 'string' ? o['translation'].trim() : ''
    if (term === '' || translation === '') continue
    out.push({ term, translation, note: typeof o['note'] === 'string' ? o['note'] : '' })
  }
  return out
}
