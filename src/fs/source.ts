/**
 * The seam between "where the images and the project JSON live" and everything above it.
 *
 * The real implementation is File System Access (see `handles.ts`). A dev-only
 * implementation backed by `fetch` (see `dev-source.ts`) exists because
 * `showDirectoryPicker()` opens an OS dialog that browser automation cannot click,
 * which would otherwise make the whole pipeline untestable end to end.
 */

export interface PageSource {
  /** Path relative to the project root. Used as the page's identity. */
  file: string
  getFile(): Promise<File>
  /**
   * A content hash the source can produce *without* materialising the file.
   *
   * Opening a project hashes every page (see `readDiskPages`). For a source whose
   * pages are cheap to enumerate but expensive to produce -- a PDF, where every
   * page has to be rasterised -- that turns opening into rendering the whole book.
   * Such a source derives the hash from something it already knows instead.
   */
  hash?(): Promise<string>
}

export interface ProjectSource {
  /** Human-readable project name, defaulted from the folder or file name. */
  name: string
  /** File name the project JSON is stored under, relative to the project root. */
  jsonName: string
  /** Whether this source can write back. The dev source cannot. */
  readonly writable: boolean
  /** `null` when no project file exists yet. */
  readJson(): Promise<string | null>
  writeJson(text: string): Promise<void>
  listPages(): Promise<PageSource[]>
  /**
   * Add an image to the project, returning the name it actually got.
   *
   * Absent when the source cannot accept new pages, which is how the UI decides
   * whether to offer pasting and dropping at all. The name is a request, not a
   * promise: the source owns collision resolution because only it can see what is
   * already there.
   */
  addImage?(name: string, blob: Blob): Promise<AddedImage>
}

export interface AddedImage {
  name: string
  page: PageSource
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']

export function isImageName(name: string): boolean {
  const lower = name.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Sort file names the way a reader expects: page 2 before page 10.
 * Plain lexicographic order puts `p10` before `p2`, which silently scrambles
 * reading order -- and therefore the translation context -- for any project
 * whose pages are not zero-padded.
 */
export function sortPageNames(names: string[]): string[] {
  return names.slice().sort(collator.compare)
}

/** `foo.pdf` -> `foo.json`; a folder gets a fixed name inside it. */
export function jsonNameForFile(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  return base + '.json'
}

export const FOLDER_JSON_NAME = 'translation.json'
