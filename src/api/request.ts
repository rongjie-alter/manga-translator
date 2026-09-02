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
  const { endpoint, systemPrompt, pages, includeThoughts } = opts

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

  if (endpoint.kind === 'gemini') {
    const google: Record<string, unknown> = { safety_settings: SAFETY_SETTINGS }
    if (includeThoughts) google['thinking_config'] = { include_thoughts: true }
    body['extra_body'] = { google }
  }

  return body
}

/** Rough byte size of the serialised request, which is what a provider's size cap counts. */
export function requestSizeBytes(body: Record<string, unknown>): number {
  return new Blob([JSON.stringify(body)]).size
}
