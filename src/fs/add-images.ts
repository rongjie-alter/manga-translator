/**
 * Turning arbitrary incoming images -- pasted, dropped, picked -- into pages.
 *
 * Two decisions live here, both pure and both easy to get subtly wrong:
 *
 * 1. *What extension the file gets.* `isImageName` decides what a later directory
 *    listing will even look at, so a page written as `.tiff` appears now and is
 *    reported as vanished on the next rescan, taking its translation with it.
 *    Anything outside the recognised set is re-encoded to JPEG instead.
 *
 * 2. *What the file is called.* A project with no JSON yet is ordered purely by
 *    `sortPageNames`, so a name like `pasted-20260903.png` lands wherever the
 *    collator puts it -- which is not where the user just added it. Names therefore
 *    continue the numeric series the project already uses, making append order and
 *    sort order the same thing.
 */

import { reencodeToJpeg } from './images'
import { isImageName } from './source'

/** Formats that can be stored as-is, mapped to the extension to write. */
const STORABLE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
}

/** The extension to store a blob of this MIME type under, or null if it needs converting. */
export function extensionFor(type: string): string | null {
  return STORABLE[type.toLowerCase().split(';')[0]!.trim()] ?? null
}

export interface StorableImage {
  blob: Blob
  extension: string
  /** True when the image had to be converted to be storable. */
  converted: boolean
}

export type Reencoder = (blob: Blob) => Promise<Blob>

/**
 * Get a blob into a form the project can hold, converting if necessary.
 *
 * The re-encoder is injectable because it is the only part that needs a canvas.
 */
export async function toStorableImage(
  blob: Blob,
  reencode: Reencoder = reencodeToJpeg,
): Promise<StorableImage> {
  const direct = extensionFor(blob.type)
  if (direct) return { blob, extension: direct, converted: false }

  const converted = await reencode(blob)
  const extension = extensionFor(converted.type)
  if (!extension) throw new Error('could not convert ' + (blob.type || 'this image') + ' to JPEG')
  return { blob: converted, extension, converted: true }
}

const NUMBERED = /^(.*?)(\d+)(\.[^.]*)$/

interface Series {
  prefix: string
  width: number
  next: number
}

const DEFAULT_SERIES: Series = { prefix: 'page-', width: 3, next: 1 }

/**
 * Work out how the project numbers its pages, so new names continue that series.
 *
 * The series is taken from the highest-numbered existing name rather than the most
 * common one: appended pages belong at the end, and it is the end of the sequence
 * whose shape they have to match.
 */
export function pageSeries(taken: Iterable<string>): Series {
  let best: Series | null = null
  for (const name of taken) {
    if (!isImageName(name)) continue
    const match = NUMBERED.exec(name)
    if (!match) continue
    const number = Number(match[2])
    if (!Number.isSafeInteger(number)) continue
    if (best && number < best.next - 1) continue
    best = { prefix: match[1]!, width: Math.max(match[2]!.length, 1), next: number + 1 }
  }
  if (best) return best

  // Nothing numbered to continue. Start a series past whatever is already there, so
  // the very first added page does not collide with an unnumbered `page.jpg`.
  let count = 0
  for (const name of taken) if (isImageName(name)) count++
  return { ...DEFAULT_SERIES, next: count + 1 }
}

/**
 * Pick a name for each incoming image: collision-free against `taken` and against
 * each other, in the order given.
 */
export function planNames(taken: Iterable<string>, extensions: string[]): string[] {
  const used = new Set(taken)
  const series = pageSeries(used)
  const names: string[] = []

  let n = series.next
  for (const extension of extensions) {
    let name = ''
    do {
      name = series.prefix + String(n).padStart(series.width, '0') + extension
      n++
    } while (used.has(name))
    used.add(name)
    names.push(name)
  }
  return names
}

/**
 * Make `name` unique against names already present, by suffixing before the extension.
 *
 * Used by a source at the moment of writing, where the authoritative list of what
 * exists is the directory itself rather than anything the project recorded.
 */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = base + '-' + n + extension
    if (!taken.has(candidate)) return candidate
  }
}
