/**
 * App-level settings: endpoints, keys, defaults for new projects, and the prompt template.
 *
 * Kept in localStorage rather than the project file, because the API key must not end up
 * in a JSON file that a user might share along with their translated folder.
 */

import { DEFAULT_PROMPT_TEMPLATE } from '../api/prompt'
import type { ReadingDirection, SourceLang, TargetLang } from './schema'

/**
 * `gemini` calls Google's native Generative Language REST API (`:generateContent`),
 * not an OpenAI-compatible endpoint -- that is what lets safety settings and thinking
 * config actually take effect. `openai` speaks the plain OpenAI chat-completions shape.
 */
export type EndpointKind = 'gemini' | 'openai'

export interface Endpoint {
  id: string
  name: string
  /** Base URL including the version segment, e.g. `https://.../v1beta`. */
  baseUrl: string
  apiKey: string
  model: string
  kind: EndpointKind
  /** Ask for JSON via `response_format`. Off for servers that do not support it. */
  structuredOutput: boolean
}

export interface AppSettings {
  endpoints: Endpoint[]
  activeEndpointId: string
  sourceLang: SourceLang
  targetLang: TargetLang
  readingDirection: ReadingDirection
  batchSize: number
  /** Longest edge in pixels for uploaded pages. */
  maxEdge: number
  /** Longest edge in pixels to rasterize PDF pages at, independent of `maxEdge`. */
  pdfRenderEdge: number
  promptTemplate: string
  /** Request the model's reasoning trace, for the per-call debug view. */
  includeThoughts: boolean
}

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export function defaultSettings(): AppSettings {
  return {
    endpoints: [
      {
        id: 'gemini',
        name: 'Google AI Studio',
        baseUrl: GEMINI_BASE_URL,
        apiKey: '',
        model: 'gemini-flash-lite-latest',
        kind: 'gemini',
        structuredOutput: true,
      },
      {
        id: 'mock',
        name: 'Local mock server',
        baseUrl: 'http://127.0.0.1:8787/v1',
        apiKey: 'mock-key',
        model: 'mock-translate-1',
        kind: 'openai',
        structuredOutput: false,
      },
    ],
    activeEndpointId: 'gemini',
    sourceLang: 'ja',
    targetLang: 'en',
    readingDirection: 'rtl',
    batchSize: 4,
    maxEdge: 1600,
    pdfRenderEdge: 2400,
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    includeThoughts: false,
  }
}

const STORAGE_KEY = 'comic-translator:settings'

export function loadSettings(): AppSettings {
  const fallback = defaultSettings()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    return mergeSettings(fallback, JSON.parse(raw) as unknown)
  } catch {
    return fallback
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // A full or disabled localStorage should not take the app down; the user just
    // has to re-enter settings next session.
  }
}

/** Field-by-field merge so a settings blob from an older build keeps working. */
export function mergeSettings(base: AppSettings, raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) return base
  const o = raw as Record<string, unknown>
  const endpoints = Array.isArray(o['endpoints'])
    ? o['endpoints'].map((e) => mergeEndpoint(e)).filter((e): e is Endpoint => e !== null)
    : base.endpoints
  const active = typeof o['activeEndpointId'] === 'string' ? o['activeEndpointId'] : ''
  return {
    endpoints: endpoints.length > 0 ? endpoints : base.endpoints,
    activeEndpointId: endpoints.some((e) => e.id === active) ? active : (endpoints[0]?.id ?? ''),
    sourceLang: pick(o['sourceLang'], ['ja', 'ko'], base.sourceLang),
    targetLang: pick(o['targetLang'], ['en', 'zh-Hans', 'zh-Hant'], base.targetLang),
    readingDirection: pick(o['readingDirection'], ['rtl', 'ltr'], base.readingDirection),
    batchSize: int(o['batchSize'], 1, 20, base.batchSize),
    maxEdge: int(o['maxEdge'], 512, 4096, base.maxEdge),
    pdfRenderEdge: int(o['pdfRenderEdge'], 800, 4096, base.pdfRenderEdge),
    promptTemplate:
      typeof o['promptTemplate'] === 'string' && o['promptTemplate'].trim() !== ''
        ? o['promptTemplate']
        : base.promptTemplate,
    includeThoughts: o['includeThoughts'] === true,
  }
}

function mergeEndpoint(raw: unknown): Endpoint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const id = typeof o['id'] === 'string' ? o['id'] : ''
  const baseUrl = typeof o['baseUrl'] === 'string' ? o['baseUrl'] : ''
  if (id === '' || baseUrl === '') return null
  return {
    id,
    name: typeof o['name'] === 'string' ? o['name'] : id,
    baseUrl,
    apiKey: typeof o['apiKey'] === 'string' ? o['apiKey'] : '',
    model: typeof o['model'] === 'string' ? o['model'] : '',
    kind: pick(o['kind'], ['gemini', 'openai'], 'openai'),
    structuredOutput: o['structuredOutput'] === true,
  }
}

export function activeEndpoint(settings: AppSettings): Endpoint | null {
  return settings.endpoints.find((e) => e.id === settings.activeEndpointId) ?? null
}

export function endpointById(settings: AppSettings, id: string): Endpoint | null {
  return settings.endpoints.find((e) => e.id === id) ?? null
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.round(v)))
}
