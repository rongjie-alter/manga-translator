import { describe, expect, it } from 'vitest'
import { DEFAULT_4KOMA_PROMPT_TEMPLATE } from '../api/prompt'
import { defaultSettings, mergeSettings } from '../state/settings'

describe('mergeSettings: 4-koma prompt', () => {
  it('gives a blob saved before the 4-koma prompt existed the default one', () => {
    const merged = mergeSettings(defaultSettings(), { promptTemplate: 'my own prompt {context}' })
    expect(merged.promptTemplate).toBe('my own prompt {context}')
    expect(merged.fourKomaPromptTemplate).toBe(DEFAULT_4KOMA_PROMPT_TEMPLATE)
  })

  it('keeps an edited 4-koma prompt', () => {
    const merged = mergeSettings(defaultSettings(), { fourKomaPromptTemplate: 'columns {context}' })
    expect(merged.fourKomaPromptTemplate).toBe('columns {context}')
  })

  it('falls back to the default for an empty or non-string 4-koma prompt', () => {
    for (const junk of ['', '   \n', 7, null]) {
      const merged = mergeSettings(defaultSettings(), { fourKomaPromptTemplate: junk })
      expect(merged.fourKomaPromptTemplate).toBe(DEFAULT_4KOMA_PROMPT_TEMPLATE)
    }
  })
})

describe('DEFAULT_4KOMA_PROMPT_TEMPLATE', () => {
  it('takes the same placeholders as the standard template, so nothing is silently dropped', () => {
    for (const placeholder of ['{sourceLanguage}', '{targetLanguage}', '{readingOrder}', '{glossary}', '{context}']) {
      expect(DEFAULT_4KOMA_PROMPT_TEMPLATE).toContain(placeholder)
    }
  })
})
