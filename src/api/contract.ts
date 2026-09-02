/**
 * The contract between the app and the model: what we ask for, and the JSON schema we
 * hand to providers that support structured output.
 *
 * Deliberately flat. Every field the model has to invent is a field it can get wrong,
 * and the reader only needs reading order, so there are no coordinates here.
 */

import type { LineKind } from '../state/schema'

export interface ModelLine {
  id: number
  kind: LineKind
  speaker: string
  original: string
  translation: string
}

export interface ModelPage {
  /** 1-based position within the batch, matching the `[page N]` marker. */
  page: number
  /** File name from the marker. Primary key for matching a response back to a page. */
  file: string
  lines: ModelLine[]
}

export interface ModelGlossaryEntry {
  term: string
  translation: string
  note: string
}

export interface ModelResponse {
  pages: ModelPage[]
  glossary: ModelGlossaryEntry[]
}

/** Marker that ties an image part to a page. The mock server parses the same shape. */
export function pageMarker(position: number, file: string): string {
  return '[page ' + position + '] ' + file
}

export const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          file: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                kind: { type: 'string', enum: ['dialogue', 'narration', 'sfx', 'sign'] },
                speaker: { type: 'string' },
                original: { type: 'string' },
                translation: { type: 'string' },
              },
              required: ['id', 'kind', 'speaker', 'original', 'translation'],
            },
          },
        },
        required: ['page', 'file', 'lines'],
      },
    },
    glossary: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          translation: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['term', 'translation', 'note'],
      },
    },
  },
  required: ['pages', 'glossary'],
} as const
