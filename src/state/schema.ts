/**
 * The on-disk project format and its migrations.
 *
 * A project file is the source of truth, and for a folder of images it lives beside
 * them as `translation.json`; IndexedDB caches only handles and run state, so clearing
 * the browser's storage loses nothing.
 *
 * A project imported from a single image or a PDF is the exception. There is no way to
 * write `<base>.json` next to a picked file -- the file picker grants no access to the
 * parent folder -- so that project's JSON is held in IndexedDB and *is* the only copy
 * until the user exports it. Same format either way; different durability.
 */

export const SCHEMA_VERSION = 1

/**
 * Every language the app can translate from or into. One list serves both directions: a
 * comic can be in any of them, and nothing about a target language is special.
 * Names are what the prompt is told, so they are English and unambiguous.
 */
export const LANGUAGES = [
  { code: 'ar', name: 'Arabic' },
  { code: 'zh-Hans', name: 'Simplified Chinese' },
  { code: 'zh-Hant', name: 'Traditional Chinese' },
  { code: 'cs', name: 'Czech' },
  { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' },
  { code: 'tl', name: 'Filipino' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ms', name: 'Malay' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'vi', name: 'Vietnamese' },
] as const

export type LangCode = (typeof LANGUAGES)[number]['code']
export type SourceLang = LangCode
export type TargetLang = LangCode

export const LANG_CODES: readonly LangCode[] = LANGUAGES.map((l) => l.code)

export const LANG_NAMES = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.name])) as Record<
  LangCode,
  string
>

export function isLangCode(v: unknown): v is LangCode {
  return typeof v === 'string' && (LANG_CODES as readonly string[]).includes(v)
}

export const MAX_RECENT_LANGS = 5

/** Put `code` at the front of a most-recent-first list, without duplicates, capped. */
export function pushRecent(list: readonly LangCode[], code: LangCode): LangCode[] {
  return [code, ...list.filter((c) => c !== code)].slice(0, MAX_RECENT_LANGS)
}

/** Clean a stored recents list: known codes only, no duplicates, capped. */
export function sanitizeRecents(v: unknown): LangCode[] {
  if (!Array.isArray(v)) return []
  const out: LangCode[] = []
  for (const c of v) if (isLangCode(c) && !out.includes(c)) out.push(c)
  return out.slice(0, MAX_RECENT_LANGS)
}

export type ReadingDirection = 'rtl' | 'ltr'

/** Whether a page is readable, and if not, why not. */
export type PageStatus =
  | 'pending' // never translated
  | 'translated'
  | 'failed' // transport or server error, retryable
  | 'blocked' // refused by the provider's safety filter
  | 'stale' // translated, but the image on disk changed since

/**
 * How a page's panels are laid out, which decides the reading order the model is told to
 * use. Marked by the user rather than detected by the model: small models do not detect
 * it reliably, and a wrong guess silently scrambles the order of every line on the page.
 */
export type PageLayout = 'standard' | '4koma'

export const PAGE_LAYOUTS: readonly PageLayout[] = ['standard', '4koma']

export type LineKind = 'dialogue' | 'narration' | 'sfx' | 'sign'

export const LINE_KINDS: readonly LineKind[] = ['dialogue', 'narration', 'sfx', 'sign']

export interface Line {
  /** Stable within a page. Assigned by the model in reading order. */
  id: number
  kind: LineKind
  original: string
  translation: string
  /** Set once a human touches `translation`; makes the line sticky across retranslation. */
  edited: boolean
  /** One level of history, so a clobbered hand edit can be put back. */
  previousTranslation: string | null
}

export interface RunInfo {
  model: string
  finishReason: string
  promptTokens: number
  completionTokens: number
  at: string
  error: string | null
}

export interface Page {
  /** Path relative to the project directory. */
  file: string
  /** Reading position. Contiguous from 0, including excluded pages. */
  index: number
  excluded: boolean
  /** Pages of one layout are batched together and sent with that layout's prompt. */
  layout: PageLayout
  /**
   * The layout the current translation was produced under; null if never translated, or
   * if that is unknown. Kept separately from `layout` so that a page flipped to 4-koma and
   * back is recognised as unchanged rather than needing a retranslation. See `effectiveStatus`.
   */
  translatedLayout: PageLayout | null
  /** Content hash of the image, so edits on disk can be detected. */
  hash: string
  status: PageStatus
  lines: Line[]
  lastRun: RunInfo | null
}

export interface GlossaryEntry {
  term: string
  translation: string
  note: string
  /** Locked entries are never overwritten by the model's suggestions. */
  locked: boolean
}

export interface ProjectMeta {
  name: string
  sourceLang: SourceLang
  targetLang: TargetLang
  readingDirection: ReadingDirection
  /** Series in the notes store this project draws terms from; '' when unassigned. */
  seriesId: string
  /**
   * The series' name at the time it was assigned.
   *
   * Denormalised on purpose: the notes store lives in this browser, the project file
   * travels with the folder. Without the name a project opened on another machine can
   * only report a dangling UUID, which tells the user nothing about what to import.
   */
  seriesName: string
  /** Extra instructions for the model, specific to this project. */
  context: string
  createdAt: string
  updatedAt: string
}

export interface ProjectSettings {
  endpointId: string
  model: string
  promptTemplateId: string
  batchSize: number
}

export interface Usage {
  calls: number
  promptTokens: number
  completionTokens: number
}

export interface ProjectFile {
  schemaVersion: number
  project: ProjectMeta
  settings: ProjectSettings
  glossary: GlossaryEntry[]
  pages: Page[]
  usage: Usage
}

export function emptyUsage(): Usage {
  return { calls: 0, promptTokens: 0, completionTokens: 0 }
}

export function newPage(file: string, index: number, hash: string): Page {
  return {
    file,
    index,
    excluded: false,
    layout: 'standard',
    translatedLayout: null,
    hash,
    status: 'pending',
    lines: [],
    lastRun: null,
  }
}

export function newProjectFile(
  name: string,
  files: { file: string; hash: string }[],
  opts: Partial<ProjectMeta & ProjectSettings> = {},
): ProjectFile {
  const now = new Date().toISOString()
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      name,
      sourceLang: opts.sourceLang ?? 'ja',
      targetLang: opts.targetLang ?? 'en',
      readingDirection: opts.readingDirection ?? 'rtl',
      seriesId: opts.seriesId ?? '',
      seriesName: opts.seriesName ?? '',
      context: opts.context ?? '',
      createdAt: now,
      updatedAt: now,
    },
    settings: {
      endpointId: opts.endpointId ?? 'default',
      model: opts.model ?? '',
      promptTemplateId: opts.promptTemplateId ?? 'default',
      batchSize: opts.batchSize ?? 4,
    },
    glossary: [],
    pages: files.map((f, i) => newPage(f.file, i, f.hash)),
    usage: emptyUsage(),
  }
}

/** Pages the translator should actually send, in reading order. */
export function translatablePages(p: ProjectFile): Page[] {
  return p.pages.filter((page) => !page.excluded).sort((a, b) => a.index - b.index)
}

/** Every page in reading order, including excluded ones -- what the reader displays. */
export function orderedPages(p: ProjectFile): Page[] {
  return p.pages.slice().sort((a, b) => a.index - b.index)
}

/**
 * What to show and act on, as opposed to what is stored.
 *
 * A translated page whose layout no longer matches the one it was translated under is
 * stale -- its lines were ordered for the wrong layout. That is derived here rather than
 * written into `status`, so flipping the layout back un-stales the page with nothing to
 * remember, and cannot be confused with a page that is stale because its image changed.
 */
export function effectiveStatus(page: Page): PageStatus {
  if (
    page.status === 'translated' &&
    page.translatedLayout !== null &&
    page.translatedLayout !== page.layout
  ) {
    return 'stale'
  }
  return page.status
}

export function pageNeedsTranslation(page: Page): boolean {
  const status = effectiveStatus(page)
  return status === 'pending' || status === 'failed' || status === 'stale'
}

export class MigrationError extends Error {}

/**
 * Coerce an unknown JSON blob into a `ProjectFile`.
 *
 * Deliberately forgiving about missing and malformed fields: a project file that a
 * user has hand-edited, or that an older build wrote, should still open. It is strict
 * about the two things that make a file genuinely unusable -- not being an object, and
 * coming from a schema version this build predates.
 */
export function migrate(raw: unknown): ProjectFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MigrationError('project file is not a JSON object')
  }
  const o = raw as Record<string, unknown>
  const version = typeof o['schemaVersion'] === 'number' ? o['schemaVersion'] : 0
  if (version > SCHEMA_VERSION) {
    throw new MigrationError(
      'project file is schema v' +
        version +
        ', this build understands up to v' +
        SCHEMA_VERSION,
    )
  }

  const meta = asRecord(o['project'])
  const settings = asRecord(o['settings'])
  const usage = asRecord(o['usage'])
  const now = new Date().toISOString()

  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      name: str(meta['name'], 'untitled'),
      sourceLang: oneOf(meta['sourceLang'], LANG_CODES, 'ja'),
      targetLang: oneOf(meta['targetLang'], LANG_CODES, 'en'),
      readingDirection: oneOf(meta['readingDirection'], ['rtl', 'ltr'], 'rtl'),
      seriesId: str(meta['seriesId'], ''),
      seriesName: str(meta['seriesName'], ''),
      context: str(meta['context'], ''),
      createdAt: str(meta['createdAt'], now),
      updatedAt: str(meta['updatedAt'], now),
    },
    settings: {
      endpointId: str(settings['endpointId'], 'default'),
      model: str(settings['model'], ''),
      promptTemplateId: str(settings['promptTemplateId'], 'default'),
      batchSize: clampInt(settings['batchSize'], 1, 20, 4),
    },
    glossary: arr(o['glossary'])
      .map(migrateGlossaryEntry)
      .filter((e) => e.term !== ''),
    pages: arr(o['pages'])
      .map(migratePage)
      .filter((p) => p.file !== ''),
    usage: {
      calls: clampInt(usage['calls'], 0, Number.MAX_SAFE_INTEGER, 0),
      promptTokens: clampInt(usage['promptTokens'], 0, Number.MAX_SAFE_INTEGER, 0),
      completionTokens: clampInt(usage['completionTokens'], 0, Number.MAX_SAFE_INTEGER, 0),
    },
  }
}

function migratePage(raw: unknown, i: number): Page {
  const o = asRecord(raw)
  const lines = arr(o['lines']).map(migrateLine)
  const status = oneOf(
    o['status'],
    ['pending', 'translated', 'failed', 'blocked', 'stale'] as const,
    lines.length > 0 ? 'translated' : 'pending',
  )
  // A file from before this field existed was translated by the standard prompt, whatever
  // `layout` says now -- that is what lets a project translated earlier be re-marked 4-koma
  // and picked up again. An explicit null is "unknown" and is kept as written.
  const translatedLayout =
    o['translatedLayout'] === null
      ? null
      : (PAGE_LAYOUTS as readonly unknown[]).includes(o['translatedLayout'])
        ? (o['translatedLayout'] as PageLayout)
        : status === 'translated' || status === 'stale'
          ? 'standard'
          : null
  return {
    file: str(o['file'], ''),
    index: clampInt(o['index'], 0, Number.MAX_SAFE_INTEGER, i),
    excluded: o['excluded'] === true,
    layout: oneOf(o['layout'], PAGE_LAYOUTS, 'standard'),
    translatedLayout,
    hash: str(o['hash'], ''),
    status,
    lines,
    lastRun: migrateRun(o['lastRun']),
  }
}

/**
 * `speaker` was dropped after v1; builds before 2026-09 wrote one per line. It is
 * deliberately not read here -- reconstructing from known keys normalises it away, so an
 * old file opens fine and the next save simply stops writing it. No version bump: an
 * older build reading a file without it falls back to its own default and nothing
 * downstream notices, so tolerating it in both directions is not worth spending the
 * version number on.
 */
function migrateLine(raw: unknown, i: number): Line {
  const o = asRecord(raw)
  const previous = o['previousTranslation']
  return {
    id: clampInt(o['id'], 0, Number.MAX_SAFE_INTEGER, i + 1),
    kind: oneOf(o['kind'], ['dialogue', 'narration', 'sfx', 'sign'], 'dialogue'),
    original: str(o['original'], ''),
    translation: str(o['translation'], ''),
    edited: o['edited'] === true,
    previousTranslation: typeof previous === 'string' ? previous : null,
  }
}

export function migrateGlossaryEntry(raw: unknown): GlossaryEntry {
  const o = asRecord(raw)
  return {
    term: str(o['term'], ''),
    translation: str(o['translation'], ''),
    note: str(o['note'], ''),
    locked: o['locked'] === true,
  }
}

function migrateRun(raw: unknown): RunInfo | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const error = o['error']
  return {
    model: str(o['model'], ''),
    finishReason: str(o['finishReason'], ''),
    promptTokens: clampInt(o['promptTokens'], 0, Number.MAX_SAFE_INTEGER, 0),
    completionTokens: clampInt(o['completionTokens'], 0, Number.MAX_SAFE_INTEGER, 0),
    at: str(o['at'], ''),
    error: typeof error === 'string' ? error : null,
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.round(v)))
}
