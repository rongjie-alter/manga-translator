import { describe, expect, it } from 'vitest'
import { dailyCapFor, estimateRun, formatTokens, sumEstimates } from '../api/estimate'
import { fitWithin, imageTokens } from '../fs/images'
import {
  DEFAULT_PROMPT_TEMPLATE,
  renderContext,
  renderGlossary,
  renderPrompt,
} from '../api/prompt'

const PAGE = { width: 846, height: 1200 }

describe('fitWithin', () => {
  it('scales the long edge down and keeps the aspect ratio', () => {
    expect(fitWithin({ width: 2000, height: 3000 }, 1500)).toEqual({ width: 1000, height: 1500 })
  })

  it('never scales a small page up', () => {
    expect(fitWithin(PAGE, 4000)).toEqual(PAGE)
  })
})

describe('imageTokens', () => {
  it('charges a single tile for a thumbnail', () => {
    expect(imageTokens({ width: 300, height: 380 })).toBe(258)
  })

  it('charges per 768px tile for a full page', () => {
    // 846x1200 is 2 tiles across by 2 down.
    expect(imageTokens(PAGE)).toBe(4 * 258)
  })
})

describe('estimateRun', () => {
  const base = {
    pageCount: 100,
    sampled: [PAGE],
    maxEdge: 1600,
    batchSize: 4,
    systemPrompt: DEFAULT_PROMPT_TEMPLATE,
  }

  it('reports the exact call count, which is the number that hits the daily cap', () => {
    expect(estimateRun({ ...base, pageCount: 100, batchSize: 4 }).calls).toBe(25)
    expect(estimateRun({ ...base, pageCount: 101, batchSize: 4 }).calls).toBe(26)
    expect(estimateRun({ ...base, pageCount: 7, batchSize: 1 }).calls).toBe(7)
  })

  it('costs images at the downscaled size, not the original', () => {
    const huge = { width: 3000, height: 4200 }
    const big = estimateRun({ ...base, sampled: [huge], maxEdge: 4096 })
    const small = estimateRun({ ...base, sampled: [huge], maxEdge: 1600 })
    expect(small.imageTokensPerPage).toBeLessThan(big.imageTokensPerPage)
  })

  it('charges the system prompt once per call, not once per page', () => {
    const few = estimateRun({ ...base, batchSize: 10 })
    const many = estimateRun({ ...base, batchSize: 1 })
    expect(many.promptTokens).toBeGreaterThan(few.promptTokens)
    // Image tokens are per page either way, so the gap is only the repeated prompt.
    expect(many.completionTokens).toBe(few.completionTokens)
  })

  it('flags that it guessed the page size when nothing was measured', () => {
    const e = estimateRun({ ...base, sampled: [] })
    expect(e.assumedPageSize).toBe(true)
    expect(e.imageTokensPerPage).toBeGreaterThan(0)
  })

  it('is zero for an empty run', () => {
    expect(estimateRun({ ...base, pageCount: 0 })).toMatchObject({ calls: 0, totalTokens: 0 })
  })
})

describe('sumEstimates', () => {
  const part = { sampled: [PAGE], maxEdge: 1600, batchSize: 4, systemPrompt: DEFAULT_PROMPT_TEMPLATE }

  it('adds calls and tokens across layouts', () => {
    const a = estimateRun({ ...part, pageCount: 9 })
    const b = estimateRun({ ...part, pageCount: 3 })
    const sum = sumEstimates([a, b])
    expect(sum.calls).toBe(a.calls + b.calls)
    expect(sum.promptTokens).toBe(a.promptTokens + b.promptTokens)
    expect(sum.totalTokens).toBe(a.totalTokens + b.totalTokens)
  })

  it('ignores a part with no pages, but still reports the image cost of the other', () => {
    const real = estimateRun({ ...part, pageCount: 5 })
    const sum = sumEstimates([estimateRun({ ...part, pageCount: 0 }), real])
    expect(sum.calls).toBe(real.calls)
    expect(sum.imageTokensPerPage).toBe(real.imageTokensPerPage)
  })

  it('is zero for nothing to sum', () => {
    expect(sumEstimates([])).toMatchObject({ calls: 0, totalTokens: 0 })
  })
})

describe('dailyCapFor', () => {
  it('recognises the free-tier models by prefix', () => {
    expect(dailyCapFor('gemini-flash-lite-latest')).toBe(500)
    expect(dailyCapFor('gemini-flash-lite-preview-09-2025')).toBe(500)
    expect(dailyCapFor('gpt-4o')).toBeNull()
  })
})

describe('formatTokens', () => {
  it('stays readable across magnitudes', () => {
    expect(formatTokens(42)).toBe('42')
    expect(formatTokens(4200)).toBe('4.2k')
    expect(formatTokens(420_000)).toBe('420k')
    expect(formatTokens(4_200_000)).toBe('4.2M')
  })
})

describe('renderPrompt', () => {
  const meta = { sourceLang: 'ja', targetLang: 'zh-Hant', readingDirection: 'rtl' } as const

  it('substitutes languages and reading order', () => {
    const text = renderPrompt(DEFAULT_PROMPT_TEMPLATE, { meta, glossary: [], context: '' })
    expect(text).toContain('Japanese')
    expect(text).toContain('Traditional Chinese')
    expect(text).toContain('right to left')
    expect(text).not.toContain('{')
  })

  it('inlines the glossary as settled decisions', () => {
    const text = renderPrompt(DEFAULT_PROMPT_TEMPLATE, {
      meta,
      glossary: [{ term: 'リナ', translation: 'Rina', note: 'lead', locked: true }],
      context: '',
    })
    expect(text).toContain('リナ → Rina  (lead)')
  })

  it('leaves no gap where an empty glossary would have gone', () => {
    const text = renderPrompt(DEFAULT_PROMPT_TEMPLATE, { meta, glossary: [], context: '' })
    expect(text).not.toMatch(/\n\n\n/)
  })

  it('works with a user template that drops placeholders', () => {
    expect(renderPrompt('Just translate it.', { meta, glossary: [], context: '' })).toBe('Just translate it.')
  })

  it('renders nothing for an empty glossary', () => {
    expect(renderGlossary([])).toBe('')
  })
})

describe('renderContext', () => {
  const meta = { sourceLang: 'ja', targetLang: 'zh-Hant', readingDirection: 'rtl' } as const

  it('labels the context so the model knows what it is reading', () => {
    const text = renderPrompt(DEFAULT_PROMPT_TEMPLATE, {
      meta,
      glossary: [],
      context: 'Set in 1920s Tokyo. Keep honorifics.',
    })
    expect(text).toContain('Additional context for this work:')
    expect(text).toContain('Set in 1920s Tokyo. Keep honorifics.')
  })

  it('leaves no gap where an empty context would have gone', () => {
    const text = renderPrompt(DEFAULT_PROMPT_TEMPLATE, { meta, glossary: [], context: '   ' })
    expect(text).not.toMatch(/\n\n\n/)
    expect(text).not.toContain('Additional context')
  })

  it('renders nothing for an empty context', () => {
    expect(renderContext('')).toBe('')
    expect(renderContext(' \n ')).toBe('')
  })

  it('drops the context when the template has no placeholder for it', () => {
    // Deliberate: a template that omits a placeholder loses that feature. The settings
    // and scan views warn about it rather than smuggling the text in anyway.
    const text = renderPrompt('Translate it.', { meta, glossary: [], context: 'Keep honorifics' })
    expect(text).toBe('Translate it.')
  })
})
