import { describe, expect, it } from 'vitest'
import { extractCompleteObjects, parseResponse, stripCodeFence } from '../api/parse'

const good = {
  pages: [
    {
      page: 1,
      file: 'a.jpg',
      lines: [
        { id: 1, kind: 'dialogue', speaker: 'リナ', original: 'あ', translation: 'Ah' },
        { id: 2, kind: 'sfx', speaker: '', original: 'ドン', translation: 'THUD' },
      ],
    },
    { page: 2, file: 'b.jpg', lines: [{ id: 1, kind: 'narration', speaker: '', original: 'い', translation: 'And so' }] },
  ],
  glossary: [{ term: 'リナ', translation: 'Rina', note: 'lead' }],
}

const parse = (content: string, finishReason = 'stop') => parseResponse({ content, finishReason })

describe('parseResponse', () => {
  it('reads a clean response', () => {
    const r = parse(JSON.stringify(good))
    expect(r.error).toBeNull()
    expect(r.recovered).toBe(false)
    expect(r.blocked).toBe(false)
    expect(r.pages.map((p) => p.file)).toEqual(['a.jpg', 'b.jpg'])
    expect(r.pages[0]!.lines).toHaveLength(2)
    expect(r.glossary[0]).toEqual({ term: 'リナ', translation: 'Rina', note: 'lead' })
  })

  it('unwraps a markdown code fence', () => {
    const r = parse('```json\n' + JSON.stringify(good) + '\n```')
    expect(r.pages).toHaveLength(2)
  })

  it('salvages whole pages from a response cut off mid-array', () => {
    const full = JSON.stringify(good, null, 2)
    // Cut inside the second page's lines, after the first page has closed.
    const cut = full.slice(0, full.indexOf('"b.jpg"') + 30)
    const r = parse(cut, 'length')
    expect(r.recovered).toBe(true)
    expect(r.blocked).toBe(false)
    expect(r.error).toBeNull()
    expect(r.pages.map((p) => p.file)).toEqual(['a.jpg'])
    expect(r.pages[0]!.lines).toHaveLength(2)
  })

  it('reports an error when truncation left nothing complete', () => {
    const full = JSON.stringify(good, null, 2)
    const r = parse(full.slice(0, full.indexOf('"a.jpg"')), 'length')
    expect(r.pages).toEqual([])
    expect(r.error).toMatch(/no complete page/)
    expect(r.blocked).toBe(false)
  })

  it('treats a content_filter finish reason as a block, not a parse failure', () => {
    const r = parse('', 'content_filter')
    expect(r.blocked).toBe(true)
    expect(r.error).toMatch(/refused/)
  })

  it('treats an empty body as a block even when the finish reason says stop', () => {
    // Gemini reports some refusals this way, and an empty page set is otherwise
    // indistinguishable from "this batch genuinely had no text".
    expect(parse('   ').blocked).toBe(true)
  })

  it('does not confuse braces inside dialogue for structure', () => {
    const tricky = {
      pages: [
        {
          page: 1,
          file: 'a.jpg',
          lines: [{ id: 1, kind: 'sign', speaker: '', original: '{変}', translation: 'he said "}" and [left]' }],
        },
      ],
      glossary: [],
    }
    const full = JSON.stringify(tricky, null, 2)
    const r = parse(full.slice(0, full.length - 4), 'length')
    expect(r.pages).toHaveLength(1)
    expect(r.pages[0]!.lines[0]!.translation).toBe('he said "}" and [left]')
  })

  it('drops malformed lines but keeps the page', () => {
    const r = parse(
      JSON.stringify({
        pages: [{ page: 1, file: 'a.jpg', lines: [{ id: 1 }, null, { translation: 'ok' }] }],
        glossary: [{ term: '', translation: 'x' }],
      }),
    )
    expect(r.pages[0]!.lines).toHaveLength(1)
    expect(r.pages[0]!.lines[0]).toMatchObject({ translation: 'ok', kind: 'dialogue', id: 1 })
    expect(r.glossary).toEqual([])
  })

  it('keeps a page that genuinely has no text', () => {
    const r = parse(JSON.stringify({ pages: [{ page: 1, file: 'a.jpg', lines: [] }], glossary: [] }))
    expect(r.pages).toHaveLength(1)
    expect(r.pages[0]!.lines).toEqual([])
    expect(r.blocked).toBe(false)
  })
})

describe('extractCompleteObjects', () => {
  it('returns nothing when the array is not there', () => {
    expect(extractCompleteObjects('{"other": []}', 'pages')).toEqual([])
  })

  it('ignores the key appearing inside a string value', () => {
    const text = '{"note": "the word \\"pages\\" appears here", "pages": [{"page": 1}]}'
    expect(extractCompleteObjects(text, 'pages')).toEqual([{ page: 1 }])
  })

  it('stops at the end of the array rather than eating later objects', () => {
    const text = '{"pages": [{"page": 1}], "glossary": [{"term": "x"}]}'
    expect(extractCompleteObjects(text, 'pages')).toEqual([{ page: 1 }])
  })
})

describe('stripCodeFence', () => {
  it('leaves bare JSON alone', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}')
  })

  it('handles a fence whose closing marker was truncated away', () => {
    expect(stripCodeFence('```json\n{"a":1}')).toBe('{"a":1}')
  })
})
