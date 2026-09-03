import { describe, expect, it, vi } from 'vitest'
import { describeRejection, imagesFrom, isEditable } from '../ui/incoming'

interface FakeItem {
  kind: 'file' | 'string'
  type: string
  file?: File | null
  directory?: boolean
}

/**
 * Stand-in for the `DataTransfer` a paste or drop carries.
 *
 * Real ones cannot be constructed with contents outside a browser event, and the
 * shapes that matter here are the ones different sources actually produce.
 */
function transfer(items: FakeItem[], files: File[] = []): DataTransfer {
  return {
    files,
    items: items.map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file ?? null,
      webkitGetAsEntry: () => (item.directory ? { isDirectory: true } : null),
    })),
    types: items.map((item) => (item.kind === 'file' ? 'Files' : item.type)),
  } as unknown as DataTransfer
}

const image = (name: string, type = 'image/png') => new File(['bytes'], name, { type })

describe('imagesFrom', () => {
  it('finds nothing in an empty transfer', () => {
    expect(imagesFrom(transfer([]))).toEqual({
      blobs: [],
      directories: 0,
      pdfs: 0,
      textOnly: false,
    })
  })

  it('tolerates a missing transfer', () => {
    expect(imagesFrom(null).blobs).toEqual([])
    expect(imagesFrom(undefined).blobs).toEqual([])
  })

  it('takes a screenshot paste, which arrives only as an item', () => {
    const snip = image('image.png')
    const result = imagesFrom(transfer([{ kind: 'file', type: 'image/png', file: snip }]))

    expect(result.blobs).toEqual([snip])
  })

  it('prefers the file list, which carries real names and multi-selections', () => {
    const a = image('a.jpg', 'image/jpeg')
    const b = image('b.jpg', 'image/jpeg')
    const result = imagesFrom(transfer([{ kind: 'file', type: 'image/jpeg' }], [a, b]))

    expect(result.blobs).toEqual([a, b])
  })

  it('ignores the text/html and text/plain a "Copy image" also puts on the clipboard', () => {
    const copied = image('image.png')
    const result = imagesFrom(
      transfer([
        { kind: 'string', type: 'text/html' },
        { kind: 'string', type: 'text/plain' },
        { kind: 'file', type: 'image/png', file: copied },
      ]),
    )

    expect(result.blobs).toEqual([copied])
    expect(result.textOnly).toBe(false)
  })

  it('reports a "Copy image address" paste as text rather than silently doing nothing', () => {
    const result = imagesFrom(transfer([{ kind: 'string', type: 'text/plain' }]))

    expect(result.blobs).toEqual([])
    expect(result.textOnly).toBe(true)
  })

  it('reads every item before returning, so none are neutered', () => {
    const first = vi.fn(() => image('a.png'))
    const second = vi.fn(() => image('b.png'))
    const data = {
      files: [],
      items: [
        { kind: 'file', type: 'image/png', getAsFile: first },
        { kind: 'file', type: 'image/png', getAsFile: second },
      ],
      types: ['Files'],
    } as unknown as DataTransfer

    expect(imagesFrom(data).blobs).toHaveLength(2)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('skips an item whose file has already gone', () => {
    const result = imagesFrom(transfer([{ kind: 'file', type: 'image/png', file: null }]))

    expect(result.blobs).toEqual([])
  })

  it('counts a dropped folder instead of treating it as a page', () => {
    const result = imagesFrom(transfer([{ kind: 'file', type: '', directory: true }]))

    expect(result).toMatchObject({ blobs: [], directories: 1 })
  })

  it('counts a dropped PDF, by type or by extension', () => {
    expect(imagesFrom(transfer([], [image('book.pdf', 'application/pdf')])).pdfs).toBe(1)
    expect(imagesFrom(transfer([], [image('book.pdf', '')])).pdfs).toBe(1)
  })

  it('ignores a non-image file rather than adding it as a page', () => {
    const result = imagesFrom(transfer([], [image('notes.txt', 'text/plain')]))

    expect(result.blobs).toEqual([])
  })
})

describe('describeRejection', () => {
  const base = { blobs: [], directories: 0, pdfs: 0, textOnly: false }

  it('says nothing when images were found', () => {
    expect(describeRejection({ ...base, blobs: [image('a.png')] })).toBeNull()
  })

  it('points a PDF at the project importer', () => {
    expect(describeRejection({ ...base, pdfs: 1 })).toMatch(/Open image or PDF/)
  })

  it('explains a folder drop', () => {
    expect(describeRejection({ ...base, directories: 1 })).toMatch(/folder/i)
  })

  it('explains a link paste', () => {
    expect(describeRejection({ ...base, textOnly: true })).toMatch(/not an image/i)
  })
})

describe('isEditable', () => {
  it('is true for the fields a user types into', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isEditable(document.createElement(tag))).toBe(true)
    }
  })

  it('is false for ordinary elements', () => {
    expect(isEditable(document.createElement('div'))).toBe(false)
    expect(isEditable(document.createElement('button'))).toBe(false)
  })

  it('is true for a contenteditable element', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'isContentEditable', { value: true })
    expect(isEditable(el)).toBe(true)
  })

  it('is false for a missing or non-element target', () => {
    expect(isEditable(null)).toBe(false)
    expect(isEditable(document)).toBe(false)
  })
})
