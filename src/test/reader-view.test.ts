import { describe, expect, it } from 'vitest'
import { currentPageFrom } from '../ui/ReaderView'

describe('currentPageFrom', () => {
  it('is undefined when nothing is intersecting', () => {
    expect(currentPageFrom(new Set())).toBeUndefined()
  })

  it('picks the only intersecting page', () => {
    expect(currentPageFrom(new Set([3]))).toBe(3)
  })

  it('picks the topmost page when several intersect at once', () => {
    // e.g. the first observer callback after mount, which can report every spread
    // within the lead-in margin as intersecting in one batch.
    expect(currentPageFrom(new Set([2, 0, 1]))).toBe(0)
  })
})
