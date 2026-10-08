import { describe, expect, it } from 'vitest'
import { DEFAULT_4KOMA_PROMPT_TEMPLATE } from '../api/prompt'
import { pushRecent } from '../state/schema'
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

describe('languages', () => {
  it('starts a new user at Japanese -> English with nothing recent', () => {
    const s = defaultSettings()
    expect([s.sourceLang, s.targetLang]).toEqual(['ja', 'en'])
    expect(s.recentSourceLangs).toEqual([])
    expect(s.recentTargetLangs).toEqual([])
  })

  it('accepts any listed language as a default', () => {
    const merged = mergeSettings(defaultSettings(), { sourceLang: 'zh-Hans', targetLang: 'fr' })
    expect([merged.sourceLang, merged.targetLang]).toEqual(['zh-Hans', 'fr'])
  })

  it('falls back to ja/en for an unknown language code', () => {
    const merged = mergeSettings(defaultSettings(), { sourceLang: 'xx', targetLang: 7 })
    expect([merged.sourceLang, merged.targetLang]).toEqual(['ja', 'en'])
  })

  it('sanitises stored recents: unknown dropped, deduped, capped', () => {
    const merged = mergeSettings(defaultSettings(), {
      recentSourceLangs: ['ko', 'xx', 'ko', 'fr', 3],
      recentTargetLangs: ['en', 'fr', 'de', 'es', 'it', 'pt', 'ru'],
    })
    expect(merged.recentSourceLangs).toEqual(['ko', 'fr'])
    expect(merged.recentTargetLangs).toEqual(['en', 'fr', 'de', 'es', 'it'])
  })

  it('gives a blob saved before recents existed empty lists', () => {
    const merged = mergeSettings(defaultSettings(), { sourceLang: 'ko' })
    expect(merged.recentSourceLangs).toEqual([])
  })
})

describe('pushRecent', () => {
  it('puts a new pick first', () => {
    expect(pushRecent(['fr'], 'ko')).toEqual(['ko', 'fr'])
  })

  it('moves a repeated pick to the front without duplicating it', () => {
    expect(pushRecent(['fr', 'ko', 'de'], 'de')).toEqual(['de', 'fr', 'ko'])
  })

  it('drops the oldest past the cap', () => {
    expect(pushRecent(['a1', 'a2', 'a3', 'a4', 'a5'] as never, 'ko')).toEqual([
      'ko', 'a1', 'a2', 'a3', 'a4',
    ])
  })
})

describe('DEFAULT_4KOMA_PROMPT_TEMPLATE', () => {
  it('takes the same placeholders as the standard template, so nothing is silently dropped', () => {
    for (const placeholder of ['{sourceLanguage}', '{targetLanguage}', '{readingOrder}', '{glossary}', '{context}']) {
      expect(DEFAULT_4KOMA_PROMPT_TEMPLATE).toContain(placeholder)
    }
  })
})
