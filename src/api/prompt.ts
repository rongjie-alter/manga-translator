/**
 * The default system prompt, and the substitution of project settings into it.
 *
 * Users can replace the template wholesale in settings; the placeholders below are the
 * contract. A template that drops `{targetLanguage}` still works -- it just stops
 * following the project's language setting, which is the user's business.
 */

import {
  SOURCE_LANG_NAMES,
  TARGET_LANG_NAMES,
  type GlossaryEntry,
  type ProjectMeta,
} from '../state/schema'

export const PLACEHOLDERS = [
  '{sourceLanguage}',
  '{targetLanguage}',
  '{readingOrder}',
  '{glossary}',
] as const

export const DEFAULT_PROMPT_TEMPLATE = `You are a professional comic translator working from {sourceLanguage} into {targetLanguage}.

You will be given consecutive pages of a comic as images. Each page is introduced by a text marker of the form "[page N] filename". Read the pages {readingOrder}.

For every page, transcribe each piece of text and translate it:
- Include dialogue, narration, sound effects, and signs or on-panel writing.
- Order the lines the way a reader encounters them: panel by panel in reading order, and within a panel, top to bottom.
- Number the lines from 1 for each page.
- Put the text exactly as it appears in "original", and the translation in "translation".
- Name the speaker when the panel makes it clear; use an empty string when it does not.
- Translate sound effects into a natural equivalent rather than romanising them.
- Keep the register and personality of each character. Prefer natural, idiomatic {targetLanguage} over literal wording.
- Do not censor, soften, summarise, or skip anything. Translate what is on the page.

{glossary}

Return one entry in "pages" for every page you were given, using the exact filename from its marker. Put any recurring names or terms worth keeping consistent into "glossary".

Respond with JSON only.`

export interface PromptContext {
  meta: Pick<ProjectMeta, 'sourceLang' | 'targetLang' | 'readingDirection'>
  glossary: GlossaryEntry[]
}

export function renderPrompt(template: string, ctx: PromptContext): string {
  const substitutions: Record<string, string> = {
    '{sourceLanguage}': SOURCE_LANG_NAMES[ctx.meta.sourceLang],
    '{targetLanguage}': TARGET_LANG_NAMES[ctx.meta.targetLang],
    '{readingOrder}':
      ctx.meta.readingDirection === 'rtl'
        ? 'right to left, as Japanese comics are read'
        : 'left to right',
    '{glossary}': renderGlossary(ctx.glossary),
  }
  return Object.entries(substitutions)
    .reduce((text, [key, value]) => text.split(key).join(value), template)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The glossary is what keeps a character called Rina on page 90 after being named on
 * page 3, so it goes into every request rather than only the batch that discovered it.
 */
export function renderGlossary(glossary: GlossaryEntry[]): string {
  if (glossary.length === 0) return ''
  const lines = glossary.map((entry) => {
    const note = entry.note.trim() === '' ? '' : '  (' + entry.note.trim() + ')'
    return '- ' + entry.term + ' → ' + entry.translation + note
  })
  return (
    'Use these established translations for recurring terms. They are decided; do not vary them:\n' +
    lines.join('\n')
  )
}
