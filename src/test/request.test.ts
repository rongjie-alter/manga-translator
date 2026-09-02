import { describe, expect, it } from 'vitest'
import { buildRequestBody, requestSizeBytes } from '../api/request'
import type { Endpoint } from '../state/settings'

const page = { file: 'p1.jpg', dataUrl: 'data:image/jpeg;base64,Zm9v' }

const openaiEndpoint: Endpoint = {
  id: 'e',
  name: 'e',
  baseUrl: 'http://localhost/v1',
  apiKey: 'k',
  model: 'gpt-x',
  kind: 'openai',
  structuredOutput: true,
}

const geminiEndpoint: Endpoint = { ...openaiEndpoint, kind: 'gemini', model: 'gemini-x' }

describe('buildRequestBody', () => {
  it('builds an OpenAI-style body for kind "openai"', () => {
    const body = buildRequestBody({
      endpoint: openaiEndpoint,
      systemPrompt: 'system',
      pages: [page],
      includeThoughts: false,
    })
    expect(body['model']).toBe('gpt-x')
    expect(body['messages']).toEqual([
      { role: 'system', content: 'system' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[page 1] p1.jpg' },
          { type: 'image_url', image_url: { url: page.dataUrl } },
        ],
      },
    ])
    expect(body['response_format']).toMatchObject({ type: 'json_schema' })
    expect(body).not.toHaveProperty('contents')
    expect(body).not.toHaveProperty('safetySettings')
  })

  it('builds a native Gemini body for kind "gemini", with safetySettings as a top-level field', () => {
    const body = buildRequestBody({
      endpoint: geminiEndpoint,
      systemPrompt: 'system',
      pages: [page],
      includeThoughts: true,
    })
    expect(body['contents']).toEqual([
      {
        role: 'user',
        parts: [{ text: '[page 1] p1.jpg' }, { inlineData: { mimeType: 'image/jpeg', data: 'Zm9v' } }],
      },
    ])
    expect(body['systemInstruction']).toEqual({ parts: [{ text: 'system' }] })
    expect(Array.isArray(body['safetySettings'])).toBe(true)
    expect(body['safetySettings']).toEqual(
      expect.arrayContaining([{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }]),
    )
    expect(body['generationConfig']).toMatchObject({
      responseMimeType: 'application/json',
      thinkingConfig: { includeThoughts: true },
    })
    expect(body).not.toHaveProperty('messages')
    expect(body).not.toHaveProperty('extra_body')
    expect(body).not.toHaveProperty('response_format')
  })

  it('omits generationConfig for a Gemini endpoint that wants neither structured output nor thoughts', () => {
    const body = buildRequestBody({
      endpoint: { ...geminiEndpoint, structuredOutput: false },
      systemPrompt: 'system',
      pages: [page],
      includeThoughts: false,
    })
    expect(body).not.toHaveProperty('generationConfig')
  })
})

describe('requestSizeBytes', () => {
  it('measures the serialised body', () => {
    expect(requestSizeBytes({ a: '1234' })).toBe(new Blob([JSON.stringify({ a: '1234' })]).size)
  })
})
