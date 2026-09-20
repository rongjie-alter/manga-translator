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
  '{context}',
] as const

/** Required by the one placeholder that carries text the user typed. See `renderContext`. */
export const CONTEXT_PLACEHOLDER = '{context}'

export const DEFAULT_PROMPT_TEMPLATE = `You are a professional comic translator working from {sourceLanguage} into {targetLanguage}.

You will be given consecutive pages of a comic as images. Each page is introduced by a text marker of the form "[page N] filename". Read the pages {readingOrder}.

For every page, transcribe each piece of text and translate it:
- Include dialogue, narration, sound effects, and signs or on-panel writing.
- Order the lines the way a reader encounters them: panel by panel in reading order, and within a panel, top to bottom.
- Number the lines from 1 for each page.
- Put the text exactly as it appears in "original", and the translation in "translation".
- Translate sound effects into a natural equivalent rather than romanising them.
- Keep the register and personality of each character. Prefer natural, idiomatic {targetLanguage} over literal wording.
- Do not censor, soften, summarise, or skip anything. Translate what is on the page.

{glossary}

{context}

Return one entry in "pages" for every page you were given, using the exact filename from its marker. Put character names and any other recurring terms worth keeping consistent into "glossary".

Respond with JSON only.`

export interface PromptContext {
  meta: Pick<ProjectMeta, 'sourceLang' | 'targetLang' | 'readingDirection'>
  glossary: GlossaryEntry[]
  /**
   * The series' shared instructions plus the project's own, already composed --
   * see `resolveContext` in `state/notes.ts`.
   *
   * Required rather than optional so that adding a caller which forgets it is a
   * compile error: the cost estimate and the actual run have to render the same
   * prompt, and an implicit `''` is exactly how those two quietly drift apart.
   */
  context: string
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
    '{context}': renderContext(ctx.context),
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

/**
 * The free-text notes about this series and this volume -- setting, tone, honorific
 * policy, anything the glossary cannot express as a term pair.
 *
 * Unlike the other placeholders this one carries text the user typed by hand, so a
 * template that omits `{context}` silently throws that text away. `renderPrompt` does
 * not compensate for that -- dropping a placeholder is the user's business, per this
 * module's contract -- but the settings and scan views both warn when it happens.
 */
export function renderContext(context: string): string {
  const text = context.trim()
  if (text === '') return ''
  return 'Additional context for this work:\n' + text
}
