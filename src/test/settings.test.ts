import { describe, expect, it } from 'vitest'
import { DEFAULT_4KOMA_PROMPT_TEMPLATE, DEFAULT_PROMPT_TEMPLATE } from '../api/prompt'
import { pushRecent } from '../state/schema'
import {
  defaultSettings,
  loadSettings,
  mergeSettings,
  saveSettings,
  STORAGE_KEY,
} from '../state/settings'

describe('mergeSettings: system prompts are session-only', () => {
  it('always resets promptTemplate and fourKomaPromptTemplate to defaults', () => {
    const merged = mergeSettings(defaultSettings(), {
      promptTemplate: 'custom prompt {context}',
      fourKomaPromptTemplate: 'custom 4-koma {context}',
    })
    expect(merged.promptTemplate).toBe(DEFAULT_PROMPT_TEMPLATE)
    expect(merged.fourKomaPromptTemplate).toBe(DEFAULT_4KOMA_PROMPT_TEMPLATE)
  })

  it('saveSettings strips promptTemplate and fourKomaPromptTemplate from localStorage', () => {
    const settings = {
      ...defaultSettings(),
      promptTemplate: 'session edit {context}',
      fourKomaPromptTemplate: 'session 4koma {context}',
    }
    saveSettings(settings)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.promptTemplate).toBeUndefined()
    expect(stored.fourKomaPromptTemplate).toBeUndefined()
  })

  it('loadSettings resets prompt templates to latest defaults even if localStorage has legacy values', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...defaultSettings(),
        promptTemplate: 'legacy prompt {context}',
        fourKomaPromptTemplate: 'legacy 4koma {context}',
      }),
    )
    const loaded = loadSettings()
    expect(loaded.promptTemplate).toBe(DEFAULT_PROMPT_TEMPLATE)
    expect(loaded.fourKomaPromptTemplate).toBe(DEFAULT_4KOMA_PROMPT_TEMPLATE)
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
