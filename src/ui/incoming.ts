/**
 * Pulling images out of a paste or a drop.
 *
 * Everything here is synchronous on purpose. `DataTransferItem` entries are only
 * valid during the event that carried them -- the moment the handler returns, or
 * awaits anything at all, `getAsFile()` starts returning null. So the extraction
 * happens up front and the async work happens on the results.
 */

export interface Incoming {
  /** Image blobs, in the order they appeared. */
  blobs: Blob[]
  /** A folder was dropped. Walking one is out of scope. */
  directories: number
  /** A PDF was dropped. It has to come in as its own project, not as a page. */
  pdfs: number
  /** There was content, but no image in it -- "Copy image address", plain text. */
  textOnly: boolean
}

const empty = (): Incoming => ({ blobs: [], directories: 0, pdfs: 0, textOnly: false })

export function imagesFrom(data: DataTransfer | null | undefined): Incoming {
  const result = empty()
  if (!data) return result

  // `files` is the richer source where it is populated: a file copied in the OS file
  // manager arrives with its real name and type, and a multi-selection arrives whole.
  // Screenshot and "Copy image" pastes populate `items` only.
  for (const file of Array.from(data.files ?? [])) {
    if (isPdf(file.type, file.name)) result.pdfs++
    else if (file.type.startsWith('image/')) result.blobs.push(file)
  }

  if (result.blobs.length === 0) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== 'file') continue
      if (entryOf(item)?.isDirectory) {
        result.directories++
        continue
      }
      if (isPdf(item.type, '')) {
        result.pdfs++
        continue
      }
      if (!item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (file) result.blobs.push(file)
    }
  }

  if (result.blobs.length === 0 && result.directories === 0 && result.pdfs === 0) {
    result.textOnly = Array.from(data.items ?? []).some((item) => item.kind === 'string')
  }
  return result
}

function isPdf(type: string, name: string): boolean {
  return type === 'application/pdf' || name.toLowerCase().endsWith('.pdf')
}

interface EntryItem {
  webkitGetAsEntry?: () => { isDirectory: boolean } | null
}

function entryOf(item: DataTransferItem): { isDirectory: boolean } | null {
  return (item as unknown as EntryItem).webkitGetAsEntry?.() ?? null
}

/**
 * Whether a paste landed in something the user is typing into.
 *
 * A global paste listener otherwise swallows ordinary text paste, and the review
 * editor's textareas are one navigation away.
 */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { tagName?: string }) | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return el.isContentEditable === true
}

/** Whether anything was found that is worth telling the user about. */
export function describeRejection(incoming: Incoming): string | null {
  if (incoming.pdfs > 0) {
    return 'PDFs open as their own project — use “Open image or PDF…” on the Projects page.'
  }
  if (incoming.directories > 0) {
    return 'Dropping a folder is not supported. Drop the image files themselves.'
  }
  if (incoming.textOnly) {
    return 'That was not an image. “Copy image address” copies a link — use “Copy image” instead.'
  }
  return null
}
