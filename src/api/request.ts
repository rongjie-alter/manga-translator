/**
 * Building the chat completion request for one batch of pages.
 */

import type { Endpoint } from '../state/settings'
import { RESPONSE_JSON_SCHEMA, pageMarker } from './contract'

export interface RequestPage {
  file: string
  /** `data:image/jpeg;base64,...` from `prepareImage`. */
  dataUrl: string
}

export interface BuildRequestOptions {
  endpoint: Endpoint
  systemPrompt: string
  pages: RequestPage[]
  includeThoughts: boolean
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * Safety categories set to OFF.
 *
 * Comics routinely contain violence and sexual content that trips the default
 * thresholds, and a blocked page is a page the user cannot read at all. The user has
 * chosen to translate this material; the filter has no useful judgement to add.
 */
const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'OFF' }))

export function buildRequestBody(opts: BuildRequestOptions): Record<string, unknown> {
  return opts.endpoint.kind === 'gemini' ? buildGeminiRequestBody(opts) : buildOpenAiRequestBody(opts)
}

function buildOpenAiRequestBody(opts: BuildRequestOptions): Record<string, unknown> {
  const { endpoint, systemPrompt, pages } = opts

  const content: ContentPart[] = []
  pages.forEach((page, i) => {
    content.push({ type: 'text', text: pageMarker(i + 1, page.file) })
    content.push({ type: 'image_url', image_url: { url: page.dataUrl } })
  })

  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
  }

  if (endpoint.structuredOutput) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: 'comic_translation', strict: true, schema: RESPONSE_JSON_SCHEMA },
    }
  }

  return body
}

/**
 * Native Generative Language API request, used instead of Google AI Studio's
 * OpenAI-compatibility shim -- the shim silently drops `safety_settings`, so a request
 * built for it never actually turns Gemini's filters off. `safetySettings` here is a
 * real, documented top-level field.
 */
function buildGeminiRequestBody(opts: BuildRequestOptions): Record<string, unknown> {
  const { pages, systemPrompt, includeThoughts, endpoint } = opts

  const parts: Record<string, unknown>[] = []
  pages.forEach((page, i) => {
    parts.push({ text: pageMarker(i + 1, page.file) })
    parts.push({ inlineData: dataUrlToInlineData(page.dataUrl) })
  })

  const generationConfig: Record<string, unknown> = {}
  if (endpoint.structuredOutput) {
    generationConfig['responseMimeType'] = 'application/json'
    generationConfig['responseSchema'] = RESPONSE_JSON_SCHEMA
  }
  if (includeThoughts) generationConfig['thinkingConfig'] = { includeThoughts: true }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    safetySettings: SAFETY_SETTINGS,
  }
  if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig

  return body
}

/** Splits a `data:<mime>;base64,<data>` URL into Gemini's `inlineData` shape. */
function dataUrlToInlineData(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('expected a base64 data URL, got: ' + dataUrl.slice(0, 32))
  return { mimeType: match[1]!, data: match[2]! }
}

/** Rough byte size of the serialised request, which is what a provider's size cap counts. */
export function requestSizeBytes(body: Record<string, unknown>): number {
  return new Blob([JSON.stringify(body)]).size
}
