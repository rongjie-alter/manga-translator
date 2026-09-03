import { describe, expect, it, vi } from 'vitest'
import {
  extensionFor,
  pageSeries,
  planNames,
  toStorableImage,
  uniqueName,
} from '../fs/add-images'
import { FOLDER_JSON_NAME, isImageName, sortPageNames } from '../fs/source'

describe('extensionFor', () => {
  it('maps the formats a project can store', () => {
    expect(extensionFor('image/jpeg')).toBe('.jpg')
    expect(extensionFor('image/png')).toBe('.png')
    expect(extensionFor('image/webp')).toBe('.webp')
    expect(extensionFor('image/avif')).toBe('.avif')
  })

  it('tolerates a parameterised or upper-case type', () => {
    expect(extensionFor('IMAGE/PNG')).toBe('.png')
    expect(extensionFor('image/jpeg; charset=binary')).toBe('.jpg')
  })

  it('refuses formats a later directory listing would not recognise', () => {
    expect(extensionFor('image/tiff')).toBeNull()
    expect(extensionFor('image/svg+xml')).toBeNull()
    expect(extensionFor('image/heic')).toBeNull()
    expect(extensionFor('')).toBeNull()
  })
})

describe('toStorableImage', () => {
  const blobOf = (type: string) => new Blob(['x'], { type })

  it('passes a storable format straight through', async () => {
    const reencode = vi.fn()
    const blob = blobOf('image/png')

    const result = await toStorableImage(blob, reencode)

    expect(result).toEqual({ blob, extension: '.png', converted: false })
    expect(reencode).not.toHaveBeenCalled()
  })

  it('converts a format that could not be stored', async () => {
    const jpeg = blobOf('image/jpeg')
    const reencode = vi.fn(async () => jpeg)

    const result = await toStorableImage(blobOf('image/tiff'), reencode)

    expect(result).toEqual({ blob: jpeg, extension: '.jpg', converted: true })
    expect(reencode).toHaveBeenCalledOnce()
  })

  it('reports the failure when conversion cannot happen', async () => {
    const reencode = vi.fn(async () => {
      throw new Error('createImageBitmap failed')
    })

    await expect(toStorableImage(blobOf('image/svg+xml'), reencode)).rejects.toThrow(
      'createImageBitmap failed',
    )
  })
})

describe('pageSeries', () => {
  it('continues the numbering the project already uses', () => {
    expect(pageSeries(['ch1-001.jpeg', 'ch1-002.jpeg'])).toEqual({
      prefix: 'ch1-',
      width: 3,
      next: 3,
    })
  })

  it('continues from the highest number, not the last listed', () => {
    expect(pageSeries(['p10.jpg', 'p2.jpg']).next).toBe(11)
  })

  it('ignores the project JSON and other non-images', () => {
    expect(pageSeries([FOLDER_JSON_NAME, 'notes2.txt', 'p7.jpg']).next).toBe(8)
  })

  it('starts a fresh series when nothing is numbered', () => {
    expect(pageSeries(['cover.jpg', 'back.jpg'])).toEqual({
      prefix: 'page-',
      width: 3,
      next: 3,
    })
  })

  it('starts at one for an empty project', () => {
    expect(pageSeries([])).toEqual({ prefix: 'page-', width: 3, next: 1 })
  })
})

describe('planNames', () => {
  it('names a batch in order, continuing the existing series', () => {
    expect(planNames(['ch1-001.jpeg', 'ch1-002.jpeg'], ['.png', '.jpg', '.png'])).toEqual([
      'ch1-003.png',
      'ch1-004.jpg',
      'ch1-005.png',
    ])
  })

  it('gives a batch of three distinct names', () => {
    const names = planNames(['a.jpg'], ['.png', '.png', '.png'])
    expect(new Set(names).size).toBe(3)
  })

  it('never collides with a name already taken', () => {
    const names = planNames(['p1.jpg', 'p2.jpg', 'p3.png'], ['.png', '.png'])
    expect(names).not.toContain('p3.png')
    expect(names).toEqual(['p4.png', 'p5.png'])
  })

  it('never generates the project JSON or its temp file', () => {
    const names = planNames([FOLDER_JSON_NAME, FOLDER_JSON_NAME + '.tmp'], ['.png', '.jpg'])
    expect(names).not.toContain(FOLDER_JSON_NAME)
    expect(names).not.toContain(FOLDER_JSON_NAME + '.tmp')
  })

  it('generates names a directory listing will recognise as pages', () => {
    for (const name of planNames(['a.jpg'], ['.png', '.jpg', '.webp', '.avif'])) {
      expect(isImageName(name)).toBe(true)
    }
  })

  it('generates names that sort into the order they were added', () => {
    const taken = ['p008.jpg', 'p009.jpg']
    const names = planNames(taken, ['.jpg', '.jpg', '.jpg'])
    // The invariant that matters: opening the folder with no JSON yet, and therefore
    // ordering purely by name, reproduces the order the pages were appended in.
    expect(sortPageNames([...taken, ...names])).toEqual([...taken, ...names])
  })

  it('zero-pads to the existing width so ten does not sort before two', () => {
    expect(planNames(['p001.jpg'], ['.jpg'])).toEqual(['p002.jpg'])
  })
})

describe('uniqueName', () => {
  it('leaves a free name alone', () => {
    expect(uniqueName('p1.jpg', new Set(['p2.jpg']))).toBe('p1.jpg')
  })

  it('suffixes before the extension', () => {
    expect(uniqueName('p1.jpg', new Set(['p1.jpg']))).toBe('p1-2.jpg')
  })

  it('keeps counting past several collisions', () => {
    expect(uniqueName('p1.jpg', new Set(['p1.jpg', 'p1-2.jpg', 'p1-3.jpg']))).toBe('p1-4.jpg')
  })

  it('handles a name with no extension', () => {
    expect(uniqueName('page', new Set(['page']))).toBe('page-2')
  })
})
