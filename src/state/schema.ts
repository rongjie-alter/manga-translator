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

export type SourceLang = 'ja' | 'ko'
export type TargetLang = 'en' | 'zh-Hans' | 'zh-Hant'
export type ReadingDirection = 'rtl' | 'ltr'

/** Whether a page is readable, and if not, why not. */
export type PageStatus =
  | 'pending' // never translated
  | 'translated'
  | 'failed' // transport or server error, retryable
  | 'blocked' // refused by the provider's safety filter
  | 'stale' // translated, but the image on disk changed since

export type LineKind = 'dialogue' | 'narration' | 'sfx' | 'sign'

export const LINE_KINDS: readonly LineKind[] = ['dialogue', 'narration', 'sfx', 'sign']

export const TARGET_LANG_NAMES: Record<TargetLang, string> = {
  en: 'English',
  'zh-Hans': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese',
}

export const SOURCE_LANG_NAMES: Record<SourceLang, string> = {
  ja: 'Japanese',
  ko: 'Korean',
}

export interface Line {
  /** Stable within a page. Assigned by the model in reading order. */
  id: number
  kind: LineKind
  /** Who is speaking, when the model can tell. Empty string when it cannot. */
  speaker: string
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
  return { file, index, excluded: false, hash, status: 'pending', lines: [], lastRun: null }
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

export function pageNeedsTranslation(page: Page): boolean {
  return page.status === 'pending' || page.status === 'failed' || page.status === 'stale'
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
      sourceLang: oneOf(meta['sourceLang'], ['ja', 'ko'], 'ja'),
      targetLang: oneOf(meta['targetLang'], ['en', 'zh-Hans', 'zh-Hant'], 'en'),
      readingDirection: oneOf(meta['readingDirection'], ['rtl', 'ltr'], 'rtl'),
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
  return {
    file: str(o['file'], ''),
    index: clampInt(o['index'], 0, Number.MAX_SAFE_INTEGER, i),
    excluded: o['excluded'] === true,
    hash: str(o['hash'], ''),
    status: oneOf(
      o['status'],
      ['pending', 'translated', 'failed', 'blocked', 'stale'],
      lines.length > 0 ? 'translated' : 'pending',
    ),
    lines,
    lastRun: migrateRun(o['lastRun']),
  }
}

function migrateLine(raw: unknown, i: number): Line {
  const o = asRecord(raw)
  const previous = o['previousTranslation']
  return {
    id: clampInt(o['id'], 0, Number.MAX_SAFE_INTEGER, i + 1),
    kind: oneOf(o['kind'], ['dialogue', 'narration', 'sfx', 'sign'], 'dialogue'),
    speaker: str(o['speaker'], ''),
    original: str(o['original'], ''),
    translation: str(o['translation'], ''),
    edited: o['edited'] === true,
    previousTranslation: typeof previous === 'string' ? previous : null,
  }
}

function migrateGlossaryEntry(raw: unknown): GlossaryEntry {
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
