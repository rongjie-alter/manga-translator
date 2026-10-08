/**
 * The default system prompt, and the substitution of project settings into it.
 *
 * Users can replace the template wholesale in settings; the placeholders below are the
 * contract. A template that drops `{targetLanguage}` still works -- it just stops
 * following the project's language setting, which is the user's business.
 */

import {
  LANG_NAMES,
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

/**
 * Used for pages the user marked as 4-koma. The model is told the layout rather than asked
 * to detect it, so this prompt can state the reading order outright. Everything else --
 * placeholders, the JSON contract -- matches `DEFAULT_PROMPT_TEMPLATE`.
 */
export const DEFAULT_4KOMA_PROMPT_TEMPLATE = `You are a professional comic translator working from {sourceLanguage} into {targetLanguage}.

You will be given consecutive pages of a comic as images. Each page is introduced by a text marker of the form "[page N] filename".

EVERY PAGE IN THIS REQUEST IS A 4-KOMA PAGE. A 4-koma is a short, self-contained gag strip drawn as a vertical stack of panels (setup, development, twist, punchline). A page holds one or more strips side by side, each strip being one column of panels.

Reading order, for every page. Work panel by panel, not text by text:
1. Find the panel frames (the bordered boxes) and group them into columns. The panel frame, not the height of a piece of text on the page, decides what belongs together: every bubble, caption, sound effect and sign inside a frame is part of that panel.
2. Take the columns in {readingOrder}: on a right-to-left page the rightmost column is read first, then the one to its left.
3. Within a column, go from the top panel to the bottom panel, one panel at a time.
4. Output ALL of a panel's text before any text from the next panel. Finish a panel completely, including its sound effects and any bubble at its bottom edge, then move to the one directly below it. Never jump past a panel and come back to it, and never read a column from the bottom up.
5. Within a single panel, start at the top and follow {readingOrder} across bubbles at a similar height.
6. A title or header banner (such as おまけ) comes before the panels.

NEVER read across a row. Panels side by side in the same row belong to different strips, so a row is not a sequence even though it looks like one. The panels down a column form one continuous gag; the panels across a row do not connect.

Example: a right-to-left page with two columns of three panels. Call the right column R1, R2, R3 from top to bottom and the left column L1, L2, L3. The lines must come in exactly this order: all of R1, all of R2, all of R3, all of L1, all of L2, all of L3. Text from L1 never appears before text from R3, and text from R3 never appears before text from R2.

Before you answer, check your lines against the panels: the panel they come from must only ever step down one panel within a column, and may move to the next column only after the bottom panel of the current one.

For every page, transcribe each piece of text and translate it:
- Include dialogue, narration, sound effects, and signs or on-panel writing.
- Number the lines from 1 for each page, in the reading order above.
- Put the text exactly as it appears in "original", and the translation in "translation".
- Translate sound effects into a natural equivalent rather than romanising them.
- Keep the register and personality of each character. Prefer natural, idiomatic {targetLanguage} over literal wording. Each strip is a gag, so keep the timing of its punchline.
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
    '{sourceLanguage}': LANG_NAMES[ctx.meta.sourceLang],
    '{targetLanguage}': LANG_NAMES[ctx.meta.targetLang],
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
